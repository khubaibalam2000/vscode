/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action, IAction } from 'vs/base/common/actions';
import { coalesce } from 'vs/base/common/arrays';
import { findFirstIdxMonotonousOrArrLen } from 'vs/base/common/arraysFind';
import { CancelablePromise, createCancelablePromise, Delayer } from 'vs/base/common/async';
import { onUnexpectedError } from 'vs/base/common/errors';
import { DisposableStore, dispose, IDisposable } from 'vs/base/common/lifecycle';
import 'vs/css!./media/review';
import { ICodeEditor, IEditorMouseEvent } from 'vs/editor/browser/editorBrowser';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { IRange, Range } from 'vs/editor/common/core/range';
import { EditorType, IDiffEditor, IEditorContribution } from 'vs/editor/common/editorCommon';
import { IModelDecorationOptions, IModelDeltaDecoration } from 'vs/editor/common/model';
import { ModelDecorationOptions } from 'vs/editor/common/model/textModel';
import * as languages from 'vs/editor/common/languages';
import * as nls from 'vs/nls';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IQuickInputService, IQuickPickItem, QuickPickInput } from 'vs/platform/quickinput/common/quickInput';
import { CommentGlyphWidget } from 'vs/workbench/contrib/comments/browser/commentGlyphWidget';
import { ICommentInfo, ICommentService } from 'vs/workbench/contrib/comments/browser/commentService';
import { isMouseUpEventDragFromMouseDown, parseMouseDownInfoFromEvent, ReviewZoneWidget } from 'vs/workbench/contrib/comments/browser/commentThreadZoneWidget';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { EmbeddedCodeEditorWidget } from 'vs/editor/browser/widget/embeddedCodeEditorWidget';
import { EditorOption } from 'vs/editor/common/config/editorOptions';
import { IViewsService } from 'vs/workbench/common/views';
import { COMMENTS_VIEW_ID } from 'vs/workbench/contrib/comments/browser/commentsTreeViewer';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { COMMENTS_SECTION, ICommentsConfiguration } from 'vs/workbench/contrib/comments/common/commentsConfiguration';
import { COMMENTEDITOR_DECORATION_KEY } from 'vs/workbench/contrib/comments/browser/commentReply';
import { Emitter } from 'vs/base/common/event';
import { IContextKey, IContextKeyService, RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { Position } from 'vs/editor/common/core/position';
import { CommentThreadRangeDecorator } from 'vs/workbench/contrib/comments/browser/commentThreadRangeDecorator';
import { ICursorSelectionChangedEvent } from 'vs/editor/common/cursorEvents';
import { CommentsPanel } from 'vs/workbench/contrib/comments/browser/commentsView';
import { status } from 'vs/base/browser/ui/aria/aria';

export const ID = 'editor.contrib.review';

interface CommentRangeAction {
	ownerId: string;
	extensionId: string | undefined;
	label: string | undefined;
	commentingRangesInfo: languages.CommentingRanges;
}

class CommentingRangeDecoration implements IModelDeltaDecoration {
	private _decorationId: string | undefined;
	private _startLineNumber: number;
	private _endLineNumber: number;

	public get id(): string | undefined {
		return this._decorationId;
	}

	public set id(id: string | undefined) {
		this._decorationId = id;
	}

	public get range(): IRange {
		return {
			startLineNumber: this._startLineNumber, startColumn: 1,
			endLineNumber: this._endLineNumber, endColumn: 1
		};
	}

	constructor(private _editor: ICodeEditor, private _ownerId: string, private _extensionId: string | undefined, private _label: string | undefined, private _range: IRange, public readonly options: ModelDecorationOptions, private commentingRangesInfo: languages.CommentingRanges, public readonly isHover: boolean = false) {
		this._startLineNumber = _range.startLineNumber;
		this._endLineNumber = _range.endLineNumber;
	}

	public getCommentAction(): CommentRangeAction {
		return {
			extensionId: this._extensionId,
			label: this._label,
			ownerId: this._ownerId,
			commentingRangesInfo: this.commentingRangesInfo
		};
	}

	public getOriginalRange() {
		return this._range;
	}

	public getActiveRange() {
		return this.id ? this._editor.getModel()!.getDecorationRange(this.id) : undefined;
	}
}

class CommentingRangeDecorator {
	public static description = 'commenting-range-decorator';
	private decorationOptions: ModelDecorationOptions;
	private hoverDecorationOptions: ModelDecorationOptions;
	private multilineDecorationOptions: ModelDecorationOptions;
	private commentingRangeDecorations: CommentingRangeDecoration[] = [];
	private decorationIds: string[] = [];
	private _editor: ICodeEditor | undefined;
	private _infos: ICommentInfo[] | undefined;
	private _lastHover: number = -1;
	private _lastSelection: Range | undefined;
	private _lastSelectionCursor: number | undefined;
	private _onDidChangeDecorationsCount: Emitter<number> = new Emitter();
	public readonly onDidChangeDecorationsCount = this._onDidChangeDecorationsCount.event;

	constructor() {
		const decorationOptions: IModelDecorationOptions = {
			description: CommentingRangeDecorator.description,
			isWholeLine: true,
			linesDecorationsClassName: 'comment-range-glyph comment-diff-added'
		};

		this.decorationOptions = ModelDecorationOptions.createDynamic(decorationOptions);

		const hoverDecorationOptions: IModelDecorationOptions = {
			description: CommentingRangeDecorator.description,
			isWholeLine: true,
			linesDecorationsClassName: `comment-range-glyph line-hover`
		};

		this.hoverDecorationOptions = ModelDecorationOptions.createDynamic(hoverDecorationOptions);

		const multilineDecorationOptions: IModelDecorationOptions = {
			description: CommentingRangeDecorator.description,
			isWholeLine: true,
			linesDecorationsClassName: `comment-range-glyph multiline-add`
		};

		this.multilineDecorationOptions = ModelDecorationOptions.createDynamic(multilineDecorationOptions);
	}

	public updateHover(hoverLine?: number) {
		if (this._editor && this._infos && (hoverLine !== this._lastHover)) {
			this._doUpdate(this._editor, this._infos, hoverLine);
		}
		this._lastHover = hoverLine ?? -1;
	}

	public updateSelection(cursorLine: number, range: Range = new Range(0, 0, 0, 0)) {
		this._lastSelection = range.isEmpty() ? undefined : range;
		this._lastSelectionCursor = range.isEmpty() ? undefined : cursorLine;
		// Some scenarios:
		// Selection is made. Emphasis should show on the drag/selection end location.
		// Selection is made, then user clicks elsewhere. We should still show the decoration.
		if (this._editor && this._infos) {
			this._doUpdate(this._editor, this._infos, cursorLine, range);
		}
	}

	public update(editor: ICodeEditor | undefined, commentInfos: ICommentInfo[], cursorLine?: number, range?: Range) {
		if (editor) {
			this._editor = editor;
			this._infos = commentInfos;
			this._doUpdate(editor, commentInfos, cursorLine, range);
		}
	}

	private _lineHasThread(editor: ICodeEditor, lineRange: Range) {
		return editor.getDecorationsInRange(lineRange)?.find(decoration => decoration.options.description === CommentGlyphWidget.description);
	}

	private _doUpdate(editor: ICodeEditor, commentInfos: ICommentInfo[], emphasisLine: number = -1, selectionRange: Range | undefined = this._lastSelection) {
		const model = editor.getModel();
		if (!model) {
			return;
		}

		// If there's still a selection, use that.
		emphasisLine = this._lastSelectionCursor ?? emphasisLine;

		const commentingRangeDecorations: CommentingRangeDecoration[] = [];
		for (const info of commentInfos) {
			info.commentingRanges.ranges.forEach(range => {
				const rangeObject = new Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
				let intersectingSelectionRange = selectionRange ? rangeObject.intersectRanges(selectionRange) : undefined;
				if ((selectionRange && (emphasisLine >= 0) && intersectingSelectionRange)
					// If there's only one selection line, then just drop into the else if and show an emphasis line.
					&& !((intersectingSelectionRange.startLineNumber === intersectingSelectionRange.endLineNumber)
						&& (emphasisLine === intersectingSelectionRange.startLineNumber))) {
					// The emphasisLine should be within the commenting range, even if the selection range stretches
					// outside of the commenting range.
					// Clip the emphasis and selection ranges to the commenting range
					let intersectingEmphasisRange: Range;
					if (emphasisLine <= intersectingSelectionRange.startLineNumber) {
						intersectingEmphasisRange = intersectingSelectionRange.collapseToStart();
						intersectingSelectionRange = new Range(intersectingSelectionRange.startLineNumber + 1, 1, intersectingSelectionRange.endLineNumber, 1);
					} else {
						intersectingEmphasisRange = new Range(intersectingSelectionRange.endLineNumber, 1, intersectingSelectionRange.endLineNumber, 1);
						intersectingSelectionRange = new Range(intersectingSelectionRange.startLineNumber, 1, intersectingSelectionRange.endLineNumber - 1, 1);
					}
					commentingRangeDecorations.push(new CommentingRangeDecoration(editor, info.owner, info.extensionId, info.label, intersectingSelectionRange, this.multilineDecorationOptions, info.commentingRanges, true));

					if (!this._lineHasThread(editor, intersectingEmphasisRange)) {
						commentingRangeDecorations.push(new CommentingRangeDecoration(editor, info.owner, info.extensionId, info.label, intersectingEmphasisRange, this.hoverDecorationOptions, info.commentingRanges, true));
					}

					const beforeRangeEndLine = Math.min(intersectingEmphasisRange.startLineNumber, intersectingSelectionRange.startLineNumber) - 1;
					const hasBeforeRange = rangeObject.startLineNumber <= beforeRangeEndLine;
					const afterRangeStartLine = Math.max(intersectingEmphasisRange.endLineNumber, intersectingSelectionRange.endLineNumber) + 1;
					const hasAfterRange = rangeObject.endLineNumber >= afterRangeStartLine;
					if (hasBeforeRange) {
						const beforeRange = new Range(range.startLineNumber, 1, beforeRangeEndLine, 1);
						commentingRangeDecorations.push(new CommentingRangeDecoration(editor, info.owner, info.extensionId, info.label, beforeRange, this.decorationOptions, info.commentingRanges, true));
					}
					if (hasAfterRange) {
						const afterRange = new Range(afterRangeStartLine, 1, range.endLineNumber, 1);
						commentingRangeDecorations.push(new CommentingRangeDecoration(editor, info.owner, info.extensionId, info.label, afterRange, this.decorationOptions, info.commentingRanges, true));
					}
				} else if ((rangeObject.startLineNumber <= emphasisLine) && (emphasisLine <= rangeObject.endLineNumber)) {
					if (rangeObject.startLineNumber < emphasisLine) {
						const beforeRange = new Range(range.startLineNumber, 1, emphasisLine - 1, 1);
						commentingRangeDecorations.push(new CommentingRangeDecoration(editor, info.owner, info.extensionId, info.label, beforeRange, this.decorationOptions, info.commentingRanges, true));
					}
					const emphasisRange = new Range(emphasisLine, 1, emphasisLine, 1);
					if (!this._lineHasThread(editor, emphasisRange)) {
						commentingRangeDecorations.push(new CommentingRangeDecoration(editor, info.owner, info.extensionId, info.label, emphasisRange, this.hoverDecorationOptions, info.commentingRanges, true));
					}
					if (emphasisLine < rangeObject.endLineNumber) {
						const afterRange = new Range(emphasisLine + 1, 1, range.endLineNumber, 1);
						commentingRangeDecorations.push(new CommentingRangeDecoration(editor, info.owner, info.extensionId, info.label, afterRange, this.decorationOptions, info.commentingRanges, true));
					}
				} else {
					commentingRangeDecorations.push(new CommentingRangeDecoration(editor, info.owner, info.extensionId, info.label, range, this.decorationOptions, info.commentingRanges));
				}
			});
		}

		editor.changeDecorations((accessor) => {
			this.decorationIds = accessor.deltaDecorations(this.decorationIds, commentingRangeDecorations);
			commentingRangeDecorations.forEach((decoration, index) => decoration.id = this.decorationIds[index]);
		});

		const rangesDifference = this.commentingRangeDecorations.length - commentingRangeDecorations.length;
		this.commentingRangeDecorations = commentingRangeDecorations;
		if (rangesDifference) {
			this._onDidChangeDecorationsCount.fire(this.commentingRangeDecorations.length);
		}
	}

	private areRangesIntersectingOrTouchingByLine(a: Range, b: Range) {
		// Check if `a` is before `b`
		if (a.endLineNumber < (b.startLineNumber - 1)) {
			return false;
		}

		// Check if `b` is before `a`
		if ((b.endLineNumber + 1) < a.startLineNumber) {
			return false;
		}

		// These ranges must intersect
		return true;
	}

	public getMatchedCommentAction(commentRange: Range | undefined): CommentRangeAction[] {
		if (commentRange === undefined) {
			const foundInfos = this._infos?.filter(info => info.commentingRanges.fileComments);
			if (foundInfos) {
				return foundInfos.map(foundInfo => {
					return {
						ownerId: foundInfo.owner,
						extensionId: foundInfo.extensionId,
						label: foundInfo.label,
						commentingRangesInfo: foundInfo.commentingRanges
					};
				});
			}
			return [];
		}

		// keys is ownerId
		const foundHoverActions = new Map<string, { range: Range; action: CommentRangeAction }>();
		for (const decoration of this.commentingRangeDecorations) {
			const range = decoration.getActiveRange();
			if (range && this.areRangesIntersectingOrTouchingByLine(range, commentRange)) {
				// We can have several commenting ranges that match from the same owner because of how
				// the line hover and selection decoration is done.
				// The ranges must be merged so that we can see if the new commentRange fits within them.
				const action = decoration.getCommentAction();
				const alreadyFoundInfo = foundHoverActions.get(action.ownerId);
				if (alreadyFoundInfo?.action.commentingRangesInfo === action.commentingRangesInfo) {
					// Merge ranges.
					const newRange = new Range(
						range.startLineNumber < alreadyFoundInfo.range.startLineNumber ? range.startLineNumber : alreadyFoundInfo.range.startLineNumber,
						range.startColumn < alreadyFoundInfo.range.startColumn ? range.startColumn : alreadyFoundInfo.range.startColumn,
						range.endLineNumber > alreadyFoundInfo.range.endLineNumber ? range.endLineNumber : alreadyFoundInfo.range.endLineNumber,
						range.endColumn > alreadyFoundInfo.range.endColumn ? range.endColumn : alreadyFoundInfo.range.endColumn
					);
					foundHoverActions.set(action.ownerId, { range: newRange, action });
				} else {
					foundHoverActions.set(action.ownerId, { range, action });
				}
			}
		}

		return Array.from(foundHoverActions.values()).filter(action => {
			return (action.range.startLineNumber <= commentRange.startLineNumber) && (commentRange.endLineNumber <= action.range.endLineNumber);
		}).map(actions => actions.action);
	}

	public getNearestCommentingRange(findPosition: Position, reverse?: boolean): Range | undefined {
		let findPositionContainedWithin: Range | undefined;
		let decorations: CommentingRangeDecoration[];
		if (reverse) {
			decorations = [];
			for (let i = this.commentingRangeDecorations.length - 1; i >= 0; i--) {
				decorations.push(this.commentingRangeDecorations[i]);
			}
		} else {
			decorations = this.commentingRangeDecorations;
		}
		for (const decoration of decorations) {
			const range = decoration.getActiveRange();
			if (!range) {
				continue;
			}

			if (findPositionContainedWithin && this.areRangesIntersectingOrTouchingByLine(range, findPositionContainedWithin)) {
				findPositionContainedWithin = Range.plusRange(findPositionContainedWithin, range);
				continue;
			}

			if (range.startLineNumber <= findPosition.lineNumber && findPosition.lineNumber <= range.endLineNumber) {
				findPositionContainedWithin = new Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
				continue;
			}

			if (!reverse && range.endLineNumber < findPosition.lineNumber) {
				continue;
			}

			if (reverse && range.startLineNumber > findPosition.lineNumber) {
				continue;
			}

			return range;
		}
		return decorations[0].getActiveRange() ?? undefined;
	}

	public dispose(): void {
		this.commentingRangeDecorations = [];
	}
}

export const ActiveCursorHasCommentingRange = new RawContextKey<boolean>('activeCursorHasCommentingRange', false, {
	description: nls.localize('hasCommentingRange', "Whether the position at the active cursor has a commenting range"),
	type: 'boolean'
});

export class CommentController implements IEditorContribution {
	private readonly globalToDispose = new DisposableStore();
	private readonly localToDispose = new DisposableStore();
	private editor: ICodeEditor | undefined;
	private _commentWidgets: ReviewZoneWidget[];
	private _commentInfos: ICommentInfo[];
	private _commentingRangeDecorator!: CommentingRangeDecorator;
	private _commentThreadRangeDecorator!: CommentThreadRangeDecorator;
	private mouseDownInfo: { lineNumber: number } | null = null;
	private _commentingRangeSpaceReserved = false;
	private _computePromise: CancelablePromise<Array<ICommentInfo | null>> | null;
	private _addInProgress!: boolean;
	private _emptyThreadsToAddQueue: [Range | undefined, IEditorMouseEvent | undefined][] = [];
	private _computeCommentingRangePromise!: CancelablePromise<ICommentInfo[]> | null;
	private _computeCommentingRangeScheduler!: Delayer<Array<ICommentInfo | null>> | null;
	private _pendingNewCommentCache: { [key: string]: { [key: string]: string } };
	private _pendingEditsCache: { [key: string]: { [key: string]: { [key: number]: string } } }; // owner -> threadId -> uniqueIdInThread -> pending comment
	private _editorDisposables: IDisposable[] = [];
	private _activeCursorHasCommentingRange: IContextKey<boolean>;
	private _hasProvidedAriaStatus: boolean = false;

	constructor(
		editor: ICodeEditor,
		@ICommentService private readonly commentService: ICommentService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IViewsService private readonly viewsService: IViewsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorService private readonly editorService: IEditorService
	) {
		this._commentInfos = [];
		this._commentWidgets = [];
		this._pendingNewCommentCache = {};
		this._pendingEditsCache = {};
		this._computePromise = null;
		this._activeCursorHasCommentingRange = ActiveCursorHasCommentingRange.bindTo(contextKeyService);

		if (editor instanceof EmbeddedCodeEditorWidget) {
			return;
		}

		this.editor = editor;

		this._commentingRangeDecorator = new CommentingRangeDecorator();
		this.globalToDispose.add(this._commentingRangeDecorator.onDidChangeDecorationsCount(count => {
			if (count === 0) {
				this.clearEditorListeners();
			} else if (this._editorDisposables.length === 0) {
				this.registerEditorListeners();
			}
		}));

		this.globalToDispose.add(this._commentThreadRangeDecorator = new CommentThreadRangeDecorator(this.commentService));

		this.globalToDispose.add(this.commentService.onDidDeleteDataProvider(ownerId => {
			if (ownerId) {
				delete this._pendingNewCommentCache[ownerId];
				delete this._pendingEditsCache[ownerId];
			} else {
				this._pendingNewCommentCache = {};
				this._pendingEditsCache = {};
			}
			this.beginCompute();
		}));
		this.globalToDispose.add(this.commentService.onDidSetDataProvider(_ => this.beginComputeAndProvideStatus()));
		this.globalToDispose.add(this.commentService.onDidUpdateCommentingRanges(_ => this.beginComputeAndProvideStatus()));

		this.globalToDispose.add(this.commentService.onDidSetResourceCommentInfos(e => {
			const editorURI = this.editor && this.editor.hasModel() && this.editor.getModel().uri;
			if (editorURI && editorURI.toString() === e.resource.toString()) {
				this.setComments(e.commentInfos.filter(commentInfo => commentInfo !== null));
			}
		}));

		this.globalToDispose.add(this.commentService.onDidChangeCommentingEnabled(e => {
			if (e) {
				this.registerEditorListeners();
				this.beginCompute();
			} else {
				this.tryUpdateReservedSpace();
				this.clearEditorListeners();
				this._commentingRangeDecorator.update(this.editor, []);
				this._commentThreadRangeDecorator.update(this.editor, []);
				dispose(this._commentWidgets);
				this._commentWidgets = [];
			}
		}));

		this.globalToDispose.add(this.editor.onDidChangeModel(_ => this.onModelChanged()));
		this.globalToDispose.add(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('diffEditor.renderSideBySide')) {
				this.beginCompute();
			}
		}));

		this.onModelChanged();
		this.codeEditorService.registerDecorationType('comment-controller', COMMENTEDITOR_DECORATION_KEY, {});
		this.commentService.registerContinueOnCommentProvider({
			provideContinueOnComments: () => {
				const pendingComments: languages.PendingCommentThread[] = [];
				if (this._commentWidgets) {
					for (const zone of this._commentWidgets) {
						const zonePendingComments = zone.getPendingComments();
						const pendingNewComment = zonePendingComments.newComment;
						if (!pendingNewComment || !zone.commentThread.range) {
							continue;
						}
						let lastCommentBody;
						if (zone.commentThread.comments && zone.commentThread.comments.length) {
							const lastComment = zone.commentThread.comments[zone.commentThread.comments.length - 1];
							if (typeof lastComment.body === 'string') {
								lastCommentBody = lastComment.body;
							} else {
								lastCommentBody = lastComment.body.value;
							}
						}

						if (pendingNewComment !== lastCommentBody) {
							pendingComments.push({
								owner: zone.owner,
								uri: zone.editor.getModel()!.uri,
								range: zone.commentThread.range,
								body: pendingNewComment
							});
						}
					}
				}
				return pendingComments;
			}
		});
	}

	private registerEditorListeners() {
		this._editorDisposables = [];
		if (!this.editor) {
			return;
		}
		this._editorDisposables.push(this.editor.onMouseMove(e => this.onEditorMouseMove(e)));
		this._editorDisposables.push(this.editor.onDidChangeCursorPosition(e => this.onEditorChangeCursorPosition(e.position)));
		this._editorDisposables.push(this.editor.onDidFocusEditorWidget(() => this.onEditorChangeCursorPosition(this.editor?.getPosition() ?? null)));
		this._editorDisposables.push(this.editor.onDidChangeCursorSelection(e => this.onEditorChangeCursorSelection(e)));
		this._editorDisposables.push(this.editor.onDidBlurEditorWidget(() => this.onEditorChangeCursorSelection()));
	}

	private clearEditorListeners() {
		dispose(this._editorDisposables);
		this._editorDisposables = [];
	}

	private onEditorMouseMove(e: IEditorMouseEvent): void {
		const position = e.target.position?.lineNumber;
		if (e.event.leftButton.valueOf() && position && this.mouseDownInfo) {
			this._commentingRangeDecorator.updateSelection(position, new Range(this.mouseDownInfo.lineNumber, 1, position, 1));
		} else {
			this._commentingRangeDecorator.updateHover(position);
		}
	}

	private onEditorChangeCursorSelection(e?: ICursorSelectionChangedEvent): void {
		const position = this.editor?.getPosition()?.lineNumber;
		if (position) {
			this._commentingRangeDecorator.updateSelection(position, e?.selection);
		}
	}

	private onEditorChangeCursorPosition(e: Position | null) {
		const decorations = e ? this.editor?.getDecorationsInRange(Range.fromPositions(e, { column: -1, lineNumber: e.lineNumber })) : undefined;
		let hasCommentingRange = false;
		if (decorations) {
			for (const decoration of decorations) {
				if (decoration.options.description === CommentGlyphWidget.description) {
					// We don't allow multiple comments on the same line.
					hasCommentingRange = false;
					break;
				} else if (decoration.options.description === CommentingRangeDecorator.description) {
					hasCommentingRange = true;
				}
			}
		}
		this._activeCursorHasCommentingRange.set(hasCommentingRange);
	}

	private isEditorInlineOriginal(testEditor: ICodeEditor): boolean {
		if (this.configurationService.getValue<boolean>('diffEditor.renderSideBySide')) {
			return false;
		}

		const foundEditor = this.editorService.visibleTextEditorControls.find(editor => {
			if (editor.getEditorType() === EditorType.IDiffEditor) {
				const diffEditor = editor as IDiffEditor;
				return diffEditor.getOriginalEditor() === testEditor;
			}
			return false;
		});
		return !!foundEditor;
	}

	private beginCompute(): Promise<void> {
		this._computePromise = createCancelablePromise(token => {
			const editorURI = this.editor && this.editor.hasModel() && this.editor.getModel().uri;

			if (editorURI) {
				return this.commentService.getDocumentComments(editorURI);
			}

			return Promise.resolve([]);
		});

		return this._computePromise.then(commentInfos => {
			this.setComments(coalesce(commentInfos));
			this._computePromise = null;
		}, error => console.log(error));
	}

	private beginComputeCommentingRanges() {
		if (this._computeCommentingRangeScheduler) {
			if (this._computeCommentingRangePromise) {
				this._computeCommentingRangePromise.cancel();
				this._computeCommentingRangePromise = null;
			}

			this._computeCommentingRangeScheduler.trigger(() => {
				const editorURI = this.editor && this.editor.hasModel() && this.editor.getModel().uri;

				if (editorURI) {
					return this.commentService.getDocumentComments(editorURI);
				}

				return Promise.resolve([]);
			}).then(commentInfos => {
				if (this.commentService.isCommentingEnabled) {
					const meaningfulCommentInfos = coalesce(commentInfos);
					this._commentingRangeDecorator.update(this.editor, meaningfulCommentInfos, this.editor?.getPosition()?.lineNumber, this.editor?.getSelection() ?? undefined);
				}
			}, (err) => {
				onUnexpectedError(err);
				return null;
			});
		}
	}

	public static get(editor: ICodeEditor): CommentController | null {
		return editor.getContribution<CommentController>(ID);
	}

	public revealCommentThread(threadId: string, commentUniqueId: number, fetchOnceIfNotExist: boolean): void {
		const commentThreadWidget = this._commentWidgets.filter(widget => widget.commentThread.threadId === threadId);
		if (commentThreadWidget.length === 1) {
			commentThreadWidget[0].reveal(commentUniqueId);
		} else if (fetchOnceIfNotExist) {
			if (this._computePromise) {
				this._computePromise.then(_ => {
					this.revealCommentThread(threadId, commentUniqueId, false);
				});
			} else {
				this.beginCompute().then(_ => {
					this.revealCommentThread(threadId, commentUniqueId, false);
				});
			}
		}
	}

	public collapseAll(): void {
		for (const widget of this._commentWidgets) {
			widget.collapse();
		}
	}

	public expandAll(): void {
		for (const widget of this._commentWidgets) {
			widget.expand();
		}
	}

	public expandUnresolved(): void {
		for (const widget of this._commentWidgets) {
			if (widget.commentThread.state === languages.CommentThreadState.Unresolved) {
				widget.expand();
			}
		}
	}

	public nextCommentThread(): void {
		this._findNearestCommentThread();
	}

	private _findNearestCommentThread(reverse?: boolean): void {
		if (!this._commentWidgets.length || !this.editor?.hasModel()) {
			return;
		}

		const after = this.editor.getSelection().getEndPosition();
		const sortedWidgets = this._commentWidgets.sort((a, b) => {
			if (reverse) {
				const temp = a;
				a = b;
				b = temp;
			}
			if (a.commentThread.range === undefined) {
				return -1;
			}
			if (b.commentThread.range === undefined) {
				return 1;
			}
			if (a.commentThread.range.startLineNumber < b.commentThread.range.startLineNumber) {
				return -1;
			}

			if (a.commentThread.range.startLineNumber > b.commentThread.range.startLineNumber) {
				return 1;
			}

			if (a.commentThread.range.startColumn < b.commentThread.range.startColumn) {
				return -1;
			}

			if (a.commentThread.range.startColumn > b.commentThread.range.startColumn) {
				return 1;
			}

			return 0;
		});

		const idx = findFirstIdxMonotonousOrArrLen(sortedWidgets, widget => {
			const lineValueOne = reverse ? after.lineNumber : (widget.commentThread.range?.startLineNumber ?? 0);
			const lineValueTwo = reverse ? (widget.commentThread.range?.startLineNumber ?? 0) : after.lineNumber;
			const columnValueOne = reverse ? after.column : (widget.commentThread.range?.startColumn ?? 0);
			const columnValueTwo = reverse ? (widget.commentThread.range?.startColumn ?? 0) : after.column;
			if (lineValueOne > lineValueTwo) {
				return true;
			}

			if (lineValueOne < lineValueTwo) {
				return false;
			}

			if (columnValueOne > columnValueTwo) {
				return true;
			}
			return false;
		});

		let nextWidget: ReviewZoneWidget;
		if (idx === this._commentWidgets.length) {
			nextWidget = this._commentWidgets[0];
		} else {
			nextWidget = sortedWidgets[idx];
		}
		this.editor.setSelection(nextWidget.commentThread.range ?? new Range(1, 1, 1, 1));
		nextWidget.reveal(undefined, true);
	}

	public previousCommentThread(): void {
		this._findNearestCommentThread(true);
	}

	private _findNearestCommentingRange(reverse?: boolean): void {
		if (!this.editor?.hasModel()) {
			return;
		}

		const after = this.editor.getSelection().getEndPosition();
		const range = this._commentingRangeDecorator.getNearestCommentingRange(after, reverse);
		if (range) {
			const position = reverse ? range.getEndPosition() : range.getStartPosition();
			this.editor.setPosition(position);
			this.editor.revealLineInCenterIfOutsideViewport(position.lineNumber);
		}
	}

	public nextCommentingRange(): void {
		this._findNearestCommentingRange();
	}

	public previousCommentingRange(): void {
		this._findNearestCommentingRange(true);
	}

	public dispose(): void {
		this.globalToDispose.dispose();
		this.localToDispose.dispose();
		dispose(this._editorDisposables);
		dispose(this._commentWidgets);

		this.editor = null!; // Strict null override - nulling out in dispose
	}

	public onModelChanged(): void {
		this.localToDispose.clear();

		this.removeCommentWidgetsAndStoreCache();
		if (!this.editor) {
			return;
		}

		this._hasProvidedAriaStatus = false;

		this.localToDispose.add(this.editor.onMouseDown(e => this.onEditorMouseDown(e)));
		this.localToDispose.add(this.editor.onMouseUp(e => this.onEditorMouseUp(e)));
		if (this._editorDisposables.length) {
			this.clearEditorListeners();
			this.registerEditorListeners();
		}

		this._computeCommentingRangeScheduler = new Delayer<ICommentInfo[]>(200);
		this.localToDispose.add({
			dispose: () => {
				this._computeCommentingRangeScheduler?.cancel();
				this._computeCommentingRangeScheduler = null;
			}
		});
		this.localToDispose.add(this.editor.onDidChangeModelContent(async () => {
			this.beginComputeCommentingRanges();
		}));
		this.localToDispose.add(this.commentService.onDidUpdateCommentThreads(async e => {
			const editorURI = this.editor && this.editor.hasModel() && this.editor.getModel().uri;
			if (!editorURI || !this.commentService.isCommentingEnabled) {
				return;
			}

			if (this._computePromise) {
				await this._computePromise;
			}

			const commentInfo = this._commentInfos.filter(info => info.owner === e.owner);
			if (!commentInfo || !commentInfo.length) {
				return;
			}

			const added = e.added.filter(thread => thread.resource && thread.resource === editorURI.toString());
			const removed = e.removed.filter(thread => thread.resource && thread.resource === editorURI.toString());
			const changed = e.changed.filter(thread => thread.resource && thread.resource === editorURI.toString());
			const pending = e.pending.filter(pending => pending.uri.toString() === editorURI.toString());

			removed.forEach(thread => {
				const matchedZones = this._commentWidgets.filter(zoneWidget => zoneWidget.owner === e.owner && zoneWidget.commentThread.threadId === thread.threadId && zoneWidget.commentThread.threadId !== '');
				if (matchedZones.length) {
					const matchedZone = matchedZones[0];
					const index = this._commentWidgets.indexOf(matchedZone);
					this._commentWidgets.splice(index, 1);
					matchedZone.dispose();
				}
				const infosThreads = this._commentInfos.filter(info => info.owner === e.owner)[0].threads;
				for (let i = 0; i < infosThreads.length; i++) {
					if (infosThreads[i] === thread) {
						infosThreads.splice(i, 1);
						i--;
					}
				}
			});

			changed.forEach(thread => {
				const matchedZones = this._commentWidgets.filter(zoneWidget => zoneWidget.owner === e.owner && zoneWidget.commentThread.threadId === thread.threadId);
				if (matchedZones.length) {
					const matchedZone = matchedZones[0];
					matchedZone.update(thread);
					this.openCommentsView(thread);
				}
			});
			added.forEach(thread => {
				const matchedZones = this._commentWidgets.filter(zoneWidget => zoneWidget.owner === e.owner && zoneWidget.commentThread.threadId === thread.threadId);
				if (matchedZones.length) {
					return;
				}

				const matchedNewCommentThreadZones = this._commentWidgets.filter(zoneWidget => zoneWidget.owner === e.owner && zoneWidget.commentThread.commentThreadHandle === -1 && Range.equalsRange(zoneWidget.commentThread.range, thread.range));

				if (matchedNewCommentThreadZones.length) {
					matchedNewCommentThreadZones[0].update(thread);
					return;
				}

				const continueOnCommentText = (thread.range ? this.commentService.removeContinueOnComment({ owner: e.owner, uri: editorURI, range: thread.range })?.body : undefined);
				const pendingCommentText = (this._pendingNewCommentCache[e.owner] && this._pendingNewCommentCache[e.owner][thread.threadId!])
					?? continueOnCommentText;
				const pendingEdits = this._pendingEditsCache[e.owner] && this._pendingEditsCache[e.owner][thread.threadId!];
				this.displayCommentThread(e.owner, thread, pendingCommentText, pendingEdits);
				this._commentInfos.filter(info => info.owner === e.owner)[0].threads.push(thread);
				this.tryUpdateReservedSpace();
			});
			pending.forEach(thread => {
				this.commentService.createCommentThreadTemplate(thread.owner, thread.uri, Range.lift(thread.range));
			});
			this._commentThreadRangeDecorator.update(this.editor, commentInfo);
		}));

		this.beginComputeAndProvideStatus();
	}

	private beginComputeAndProvideStatus(): void {
		this.beginCompute().then(() => {
			if (!this._hasProvidedAriaStatus && this._commentInfos.some(commentInfo => commentInfo.commentingRanges.ranges.length > 0 || commentInfo.commentingRanges.fileComments)) {
				this._hasProvidedAriaStatus = true;
				status(nls.localize('hasCommentRanges', "Editor has commenting ranges."));
			}
		});
	}

	private async openCommentsView(thread: languages.CommentThread) {
		if (thread.comments && (thread.comments.length > 0)) {
			const openViewState = this.configurationService.getValue<ICommentsConfiguration>(COMMENTS_SECTION).openView;
			if (openViewState === 'file') {
				return this.viewsService.openView(COMMENTS_VIEW_ID);
			} else if (openViewState === 'firstFile' || (openViewState === 'firstFileUnresolved' && thread.state === languages.CommentThreadState.Unresolved)) {
				const hasShownView = this.viewsService.getViewWithId<CommentsPanel>(COMMENTS_VIEW_ID)?.hasRendered;
				if (!hasShownView) {
					return this.viewsService.openView(COMMENTS_VIEW_ID);
				}
			}
		}
		return undefined;
	}

	private displayCommentThread(owner: string, thread: languages.CommentThread, pendingComment: string | undefined, pendingEdits: { [key: number]: string } | undefined): void {
		if (!this.editor?.getModel()) {
			return;
		}
		if (this.isEditorInlineOriginal(this.editor)) {
			return;
		}
		const zoneWidget = this.instantiationService.createInstance(ReviewZoneWidget, this.editor, owner, thread, pendingComment, pendingEdits);
		zoneWidget.display(thread.range);
		this._commentWidgets.push(zoneWidget);
		this.openCommentsView(thread);
	}

	private onEditorMouseDown(e: IEditorMouseEvent): void {
		this.mouseDownInfo = parseMouseDownInfoFromEvent(e);
	}

	private onEditorMouseUp(e: IEditorMouseEvent): void {
		const matchedLineNumber = isMouseUpEventDragFromMouseDown(this.mouseDownInfo, e);
		this.mouseDownInfo = null;

		if (!this.editor || matchedLineNumber === null || !e.target.element) {
			return;
		}
		const mouseUpIsOnDecorator = (e.target.element.className.indexOf('comment-range-glyph') >= 0);

		const lineNumber = e.target.position!.lineNumber;
		let range: Range | undefined;
		let selection: Range | null | undefined;
		// Check for drag along gutter decoration
		if ((matchedLineNumber !== lineNumber)) {
			if (matchedLineNumber > lineNumber) {
				selection = new Range(matchedLineNumber, this.editor.getModel()!.getLineLength(matchedLineNumber) + 1, lineNumber, 1);
			} else {
				selection = new Range(matchedLineNumber, 1, lineNumber, this.editor.getModel()!.getLineLength(lineNumber) + 1);
			}
		} else if (mouseUpIsOnDecorator) {
			selection = this.editor.getSelection();
		}

		// Check for selection at line number.
		if (selection && (selection.startLineNumber <= lineNumber) && (lineNumber <= selection.endLineNumber)) {
			range = selection;
			this.editor.setSelection(new Range(selection.endLineNumber, 1, selection.endLineNumber, 1));
		} else if (mouseUpIsOnDecorator) {
			range = new Range(lineNumber, 1, lineNumber, 1);
		}

		if (range) {
			this.addOrToggleCommentAtLine(range, e);
		}
	}

	public async addOrToggleCommentAtLine(commentRange: Range | undefined, e: IEditorMouseEvent | undefined): Promise<void> {
		// If an add is already in progress, queue the next add and process it after the current one finishes to
		// prevent empty comment threads from being added to the same line.
		if (!this._addInProgress) {
			this._addInProgress = true;
			// The widget's position is undefined until the widget has been displayed, so rely on the glyph position instead
			const existingCommentsAtLine = this._commentWidgets.filter(widget => widget.getGlyphPosition() === (commentRange ? commentRange.endLineNumber : 0));
			if (existingCommentsAtLine.length) {
				const allExpanded = existingCommentsAtLine.every(widget => widget.expanded);
				existingCommentsAtLine.forEach(allExpanded ? widget => widget.collapse() : widget => widget.expand());
				this.processNextThreadToAdd();
				return;
			} else {
				this.addCommentAtLine(commentRange, e);
			}
		} else {
			this._emptyThreadsToAddQueue.push([commentRange, e]);
		}
	}

	private processNextThreadToAdd(): void {
		this._addInProgress = false;
		const info = this._emptyThreadsToAddQueue.shift();
		if (info) {
			this.addOrToggleCommentAtLine(info[0], info[1]);
		}
	}

	public addCommentAtLine(range: Range | undefined, e: IEditorMouseEvent | undefined): Promise<void> {
		const newCommentInfos = this._commentingRangeDecorator.getMatchedCommentAction(range);
		if (!newCommentInfos.length || !this.editor?.hasModel()) {
			this._addInProgress = false;
			if (!newCommentInfos.length) {
				throw new Error('There are no commenting ranges at the current position.');
			}
			return Promise.resolve();
		}

		if (newCommentInfos.length > 1) {
			if (e && range) {
				this.contextMenuService.showContextMenu({
					getAnchor: () => e.event,
					getActions: () => this.getContextMenuActions(newCommentInfos, range),
					getActionsContext: () => newCommentInfos.length ? newCommentInfos[0] : undefined,
					onHide: () => { this._addInProgress = false; }
				});

				return Promise.resolve();
			} else {
				const picks = this.getCommentProvidersQuickPicks(newCommentInfos);
				return this.quickInputService.pick(picks, { placeHolder: nls.localize('pickCommentService', "Select Comment Provider"), matchOnDescription: true }).then(pick => {
					if (!pick) {
						return;
					}

					const commentInfos = newCommentInfos.filter(info => info.ownerId === pick.id);

					if (commentInfos.length) {
						const { ownerId } = commentInfos[0];
						this.addCommentAtLine2(range, ownerId);
					}
				}).then(() => {
					this._addInProgress = false;
				});
			}
		} else {
			const { ownerId } = newCommentInfos[0]!;
			this.addCommentAtLine2(range, ownerId);
		}

		return Promise.resolve();
	}

	private getCommentProvidersQuickPicks(commentInfos: { ownerId: string; extensionId: string | undefined; label: string | undefined; commentingRangesInfo: languages.CommentingRanges | undefined }[]) {
		const picks: QuickPickInput[] = commentInfos.map((commentInfo) => {
			const { ownerId, extensionId, label } = commentInfo;

			return <IQuickPickItem>{
				label: label || extensionId,
				id: ownerId
			};
		});

		return picks;
	}

	private getContextMenuActions(commentInfos: { ownerId: string; extensionId: string | undefined; label: string | undefined; commentingRangesInfo: languages.CommentingRanges }[], commentRange: Range): IAction[] {
		const actions: IAction[] = [];

		commentInfos.forEach(commentInfo => {
			const { ownerId, extensionId, label } = commentInfo;

			actions.push(new Action(
				'addCommentThread',
				`${label || extensionId}`,
				undefined,
				true,
				() => {
					this.addCommentAtLine2(commentRange, ownerId);
					return Promise.resolve();
				}
			));
		});
		return actions;
	}

	public addCommentAtLine2(range: Range | undefined, ownerId: string) {
		if (!this.editor) {
			return;
		}
		this.commentService.createCommentThreadTemplate(ownerId, this.editor.getModel()!.uri, range);
		this.processNextThreadToAdd();
		return;
	}

	private getExistingCommentEditorOptions(editor: ICodeEditor) {
		const lineDecorationsWidth: number = editor.getOption(EditorOption.lineDecorationsWidth);
		let extraEditorClassName: string[] = [];
		const configuredExtraClassName = editor.getRawOptions().extraEditorClassName;
		if (configuredExtraClassName) {
			extraEditorClassName = configuredExtraClassName.split(' ');
		}
		return { lineDecorationsWidth, extraEditorClassName };
	}

	private getWithoutCommentsEditorOptions(editor: ICodeEditor, extraEditorClassName: string[], startingLineDecorationsWidth: number) {
		let lineDecorationsWidth = startingLineDecorationsWidth;
		const inlineCommentPos = extraEditorClassName.findIndex(name => name === 'inline-comment');
		if (inlineCommentPos >= 0) {
			extraEditorClassName.splice(inlineCommentPos, 1);
		}

		const options = editor.getOptions();
		if (options.get(EditorOption.folding) && options.get(EditorOption.showFoldingControls) !== 'never') {
			lineDecorationsWidth += 11; // 11 comes from https://github.com/microsoft/vscode/blob/94ee5f58619d59170983f453fe78f156c0cc73a3/src/vs/workbench/contrib/comments/browser/media/review.css#L485
		}
		lineDecorationsWidth -= 24;
		return { extraEditorClassName, lineDecorationsWidth };
	}

	private getWithCommentsEditorOptions(editor: ICodeEditor, extraEditorClassName: string[], startingLineDecorationsWidth: number) {
		let lineDecorationsWidth = startingLineDecorationsWidth;
		const options = editor.getOptions();
		if (options.get(EditorOption.folding) && options.get(EditorOption.showFoldingControls) !== 'never') {
			lineDecorationsWidth -= 11;
		}
		lineDecorationsWidth += 24;
		extraEditorClassName.push('inline-comment');
		return { lineDecorationsWidth, extraEditorClassName };
	}

	private updateEditorLayoutOptions(editor: ICodeEditor, extraEditorClassName: string[], lineDecorationsWidth: number) {
		editor.updateOptions({
			extraEditorClassName: extraEditorClassName.join(' '),
			lineDecorationsWidth: lineDecorationsWidth
		});
	}

	private tryUpdateReservedSpace() {
		if (!this.editor) {
			return;
		}

		const hasCommentsOrRanges = this._commentInfos.some(info => {
			const hasRanges = Boolean(info.commentingRanges && (Array.isArray(info.commentingRanges) ? info.commentingRanges : info.commentingRanges.ranges).length);
			return hasRanges || (info.threads.length > 0);
		});

		if (hasCommentsOrRanges && !this._commentingRangeSpaceReserved && this.commentService.isCommentingEnabled) {
			this._commentingRangeSpaceReserved = true;
			const { lineDecorationsWidth, extraEditorClassName } = this.getExistingCommentEditorOptions(this.editor);
			const newOptions = this.getWithCommentsEditorOptions(this.editor, extraEditorClassName, lineDecorationsWidth);
			this.updateEditorLayoutOptions(this.editor, newOptions.extraEditorClassName, newOptions.lineDecorationsWidth);
		} else if ((!hasCommentsOrRanges || !this.commentService.isCommentingEnabled) && this._commentingRangeSpaceReserved) {
			this._commentingRangeSpaceReserved = false;
			const { lineDecorationsWidth, extraEditorClassName } = this.getExistingCommentEditorOptions(this.editor);
			const newOptions = this.getWithoutCommentsEditorOptions(this.editor, extraEditorClassName, lineDecorationsWidth);
			this.updateEditorLayoutOptions(this.editor, newOptions.extraEditorClassName, newOptions.lineDecorationsWidth);
		}
	}

	private setComments(commentInfos: ICommentInfo[]): void {
		if (!this.editor || !this.commentService.isCommentingEnabled) {
			return;
		}

		this._commentInfos = commentInfos;
		this.tryUpdateReservedSpace();
		// create viewzones
		this.removeCommentWidgetsAndStoreCache();

		this._commentInfos.forEach(info => {
			const providerCacheStore = this._pendingNewCommentCache[info.owner];
			const providerEditsCacheStore = this._pendingEditsCache[info.owner];
			info.threads = info.threads.filter(thread => !thread.isDisposed);
			info.threads.forEach(thread => {
				let pendingComment: string | undefined = undefined;
				if (providerCacheStore) {
					pendingComment = providerCacheStore[thread.threadId!];
				}

				let pendingEdits: { [key: number]: string } | undefined = undefined;
				if (providerEditsCacheStore) {
					pendingEdits = providerEditsCacheStore[thread.threadId!];
				}

				if (pendingComment || pendingEdits) {
					thread.collapsibleState = languages.CommentThreadCollapsibleState.Expanded;
				}

				this.displayCommentThread(info.owner, thread, pendingComment, pendingEdits);
			});
			info.pendingCommentThreads?.forEach(thread => {
				this.commentService.createCommentThreadTemplate(thread.owner, thread.uri, Range.lift(thread.range));
			});
		});

		this._commentingRangeDecorator.update(this.editor, this._commentInfos);
		this._commentThreadRangeDecorator.update(this.editor, this._commentInfos);
	}

	public closeWidget(): void {
		this._commentWidgets?.forEach(widget => widget.hide());
		if (this.editor) {
			this.editor.focus();
			this.editor.revealRangeInCenter(this.editor.getSelection()!);
		}
	}

	private removeCommentWidgetsAndStoreCache() {
		if (this._commentWidgets) {
			this._commentWidgets.forEach(zone => {
				const pendingComments = zone.getPendingComments();
				const pendingNewComment = pendingComments.newComment;
				const providerNewCommentCacheStore = this._pendingNewCommentCache[zone.owner];

				let lastCommentBody;
				if (zone.commentThread.comments && zone.commentThread.comments.length) {
					const lastComment = zone.commentThread.comments[zone.commentThread.comments.length - 1];
					if (typeof lastComment.body === 'string') {
						lastCommentBody = lastComment.body;
					} else {
						lastCommentBody = lastComment.body.value;
					}
				}
				if (pendingNewComment && (pendingNewComment !== lastCommentBody)) {
					if (!providerNewCommentCacheStore) {
						this._pendingNewCommentCache[zone.owner] = {};
					}

					this._pendingNewCommentCache[zone.owner][zone.commentThread.threadId!] = pendingNewComment;
				} else {
					if (providerNewCommentCacheStore) {
						delete providerNewCommentCacheStore[zone.commentThread.threadId!];
					}
				}

				const pendingEdits = pendingComments.edits;
				const providerEditsCacheStore = this._pendingEditsCache[zone.owner];
				if (Object.keys(pendingEdits).length > 0) {
					if (!providerEditsCacheStore) {
						this._pendingEditsCache[zone.owner] = {};
					}
					this._pendingEditsCache[zone.owner][zone.commentThread.threadId!] = pendingEdits;
				} else if (providerEditsCacheStore) {
					delete providerEditsCacheStore[zone.commentThread.threadId!];
				}

				zone.dispose();
			});
		}

		this._commentWidgets = [];
	}
}
