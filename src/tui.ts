import type { ReadStream, WriteStream } from "node:tty";
import { randomUUID } from "node:crypto";

import { Chalk, type ChalkInstance } from "chalk";
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";

import {
  DeskApiError,
  type DeskApiClient,
} from "./api-client.js";
import {
  documentStorageLabel,
  type BulkDocumentAction,
  type FeedbackSubmissionRegistration,
  type DocumentAction,
  type PublicDocument,
  type PublicFeedbackSubmission,
  type PublicReviewRequest,
  type PublicSpace,
  type PublicWorkspace,
  type ReadingStatus,
  type ReviewOutcome,
  type ReviewFeedbackItem,
} from "./api-types.js";
import type { MarkdownSourceMapV1 } from "mdmaid";
import { sanitizeTerminalText } from "./terminal-text.js";
import {
  changedSegments,
  type ChangeReviewDiff,
  type ChangeReviewFile,
  type ChangeReviewHunk,
  type ChangeReviewLine,
} from "./change-review.js";
import {
  feedbackAnchorLabel,
  feedbackEndingAtLine,
  highlightDiffLine,
  type WebSyntaxKind,
} from "./web-client.js";

type TuiMode = "queue" | "reader";
type StatusFilter = "all" | ReadingStatus;
export type TuiQueueGrouping = "project" | "tag" | "all";
export type TuiContentMode = "docs" | "change-reviews" | "archive";

interface TuiConfirmation {
  action: "archive" | "purge";
  documentIds: string[];
}

export interface TuiDocumentGroup {
  key: string;
  label?: string;
  documents: PublicDocument[];
}

interface TuiReader {
  backend: string;
  content: string;
  document: PublicDocument;
  warnings: string[];
  changeReview?: ChangeReviewDiff;
  changeView: "document" | "diff";
  changeLayout: "unified" | "side-by-side";
  changeFileIndex: number;
  changeHunkIndex: number;
  changeLineIndex: number;
  changeRangeStartIndex?: number | undefined;
  feedbackItems: ReviewFeedbackItem[];
  markdownFeedbackItems: FeedbackSubmissionRegistration["comments"];
  feedbackGeneralMessage: string;
  feedbackHistory: PublicFeedbackSubmission[];
  sourceWitness?: string;
  sourceLineIndex: number;
  sourceMap?: MarkdownSourceMapV1;
}

interface TuiReviewComposer {
  requestId: string;
  outcome: ReviewOutcome;
  message: string;
  items: ReviewFeedbackItem[];
}

interface TuiFeedbackComposer {
  message: string;
}

interface TuiAnnotationComposer {
  kind: "feedback" | "todo";
  path?: string;
  hunkId?: string;
  line?: number;
  endLine?: number;
  side?: "old" | "new";
  markdownAnchor?: Extract<
    FeedbackSubmissionRegistration["comments"][number]["anchor"],
    { kind: "markdown-selection-v1" }
  >;
  label?: string;
  message: string;
}

export interface TuiState {
  documents: PublicDocument[];
  reviewRequests: PublicReviewRequest[];
  reviewComposer?: TuiReviewComposer | undefined;
  feedbackComposer?: TuiFeedbackComposer | undefined;
  annotationComposer?: TuiAnnotationComposer | undefined;
  actionsOnly: boolean;
  changeReviewsOnly: boolean;
  contentMode: TuiContentMode;
  confirmation?: TuiConfirmation | undefined;
  grouping: TuiQueueGrouping;
  mode: TuiMode;
  reader?: TuiReader | undefined;
  search: string;
  searching: boolean;
  selectedIndex: number;
  selectedDocumentIds: string[];
  selectedSpace?: string | undefined;
  scopeGeneration: number;
  spaces: PublicSpace[];
  statusFilter: StatusFilter;
  queueGroups: TuiDocumentGroup[];
  visibleDocuments: PublicDocument[];
  workspaceFilter?: string | undefined;
  workspaces: PublicWorkspace[];
  scroll: number;
  message?: string | undefined;
}

export type TuiEffect =
  | { type: "open"; documentId: string }
  | { type: "reload" }
  | { type: "action"; documentId: string; action: DocumentAction }
  | {
      type: "bulk-action";
      action: BulkDocumentAction;
      documentIds: string[];
    }
  | {
      type: "review-response";
      requestId: string;
      outcome: ReviewOutcome;
      message: string;
      items?: ReviewFeedbackItem[];
      feedback?: FeedbackSubmissionRegistration;
    }
  | { type: "feedback-submit"; input: FeedbackSubmissionRegistration }
  | { type: "quit" };

export interface TuiTransition {
  state: TuiState;
  effects: TuiEffect[];
}

export interface TuiIo {
  color?: boolean;
  env?: NodeJS.ProcessEnv;
  input?: ReadStream;
  output?: WriteStream;
  unicode?: boolean;
}

export interface TuiRenderOptions {
  color?: boolean;
  unicode?: boolean;
}

export interface TuiMouseEvent {
  button: "left" | "wheel-down" | "wheel-up";
  x: number;
  y: number;
}

export function createTuiState(
  documents: PublicDocument[],
  workspaces: PublicWorkspace[],
  reviewRequests: PublicReviewRequest[] = [],
  spaces: PublicSpace[] = [],
): TuiState {
  const visibleWorkspaces = workspacesForDocuments(documents, workspaces);
  const state: TuiState = {
    documents,
    reviewRequests,
    actionsOnly: false,
    changeReviewsOnly: false,
    contentMode: "docs",
    grouping: "project",
    mode: "queue",
    search: "",
    searching: false,
    selectedIndex: 0,
    selectedDocumentIds: [],
    scopeGeneration: 0,
    spaces,
    statusFilter: "all",
    queueGroups: [],
    visibleDocuments: [],
    workspaces: visibleWorkspaces,
    scroll: 0,
  };
  return applyFilters(state);
}

export function applyTuiReader(
  state: TuiState,
  document: PublicDocument,
  content: string,
  backend: string,
  warnings: string[],
  changeReview?: ChangeReviewDiff,
  sourceMap?: MarkdownSourceMapV1,
  sourceWitness?: string,
): TuiState {
  return {
    ...state,
    mode: "reader",
    reader: {
      backend,
      content,
      document,
      warnings,
      ...(changeReview === undefined ? {} : { changeReview }),
      ...(sourceMap === undefined ? {} : { sourceMap }),
      ...(sourceWitness === undefined ? {} : { sourceWitness }),
      changeView: changeReview && changeReview.files.length > 0 ? "diff" : "document",
      changeLayout: "unified",
      changeFileIndex: 0,
      changeHunkIndex: 0,
      changeLineIndex: 0,
      feedbackItems: [],
      markdownFeedbackItems: [],
      feedbackGeneralMessage: "",
      feedbackHistory: [],
      sourceLineIndex: 0,
    },
    reviewComposer: undefined,
    annotationComposer: undefined,
    feedbackComposer: undefined,
    scroll: 0,
    searching: false,
    message: undefined,
  };
}

export function applyTuiMissingReader(
  state: TuiState,
  document: PublicDocument,
): TuiState {
  return applyTuiReader(
    state,
    document,
    [
      "Source file is missing.",
      "",
      "This catalog record can still be archived from the queue.",
      "Restore the source file and open it again to resume reading.",
    ].join("\n"),
    "unavailable",
    [],
  );
}

export function refreshTuiReader(
  state: TuiState,
  document: PublicDocument,
  content: string,
  backend: string,
  warnings: string[],
  changeReview?: ChangeReviewDiff,
  sourceMap?: MarkdownSourceMapV1,
  sourceWitness?: string,
): TuiState {
  const previous = state.reader;
  const next = applyTuiReader(
    state,
    document,
    content,
    backend,
    warnings,
    changeReview,
    sourceMap,
    sourceWitness,
  );
  if (
    !previous ||
    previous.document.id !== document.id ||
    previous.document.revision !== document.revision ||
    !next.reader
  ) {
    return next;
  }
  const fileCount = next.reader.changeReview?.files.length ?? 0;
  const changeFileIndex = clamp(previous.changeFileIndex, 0, Math.max(0, fileCount - 1));
  const hunkCount = next.reader.changeReview?.files[changeFileIndex]?.hunks.length ?? 0;
  return {
    ...next,
    reader: {
      ...next.reader,
      changeView: previous.changeView === "diff" && fileCount === 0
        ? "document"
        : previous.changeView,
      changeLayout: previous.changeLayout,
      changeFileIndex,
      changeHunkIndex: clamp(previous.changeHunkIndex, 0, Math.max(0, hunkCount - 1)),
      changeLineIndex: clamp(
        previous.changeLineIndex,
        0,
        Math.max(
          0,
          (next.reader.changeReview?.files[changeFileIndex]
            ?.hunks[clamp(previous.changeHunkIndex, 0, Math.max(0, hunkCount - 1))]
            ?.lines.length ?? 0) - 1,
        ),
      ),
      feedbackItems: previous.feedbackItems,
      markdownFeedbackItems: previous.markdownFeedbackItems,
      feedbackGeneralMessage: previous.feedbackGeneralMessage,
      feedbackHistory: previous.feedbackHistory,
      sourceLineIndex: clamp(
        previous.sourceLineIndex,
        0,
        Math.max(0, (sourceMap?.logicalLines.length ?? 1) - 1),
      ),
    },
  };
}

export function shouldRefreshTuiReader(
  event: {
    action: string;
    documentId?: string;
    revision?: number;
  },
  readerDocumentId: string | undefined,
  renderedRevision: number | undefined,
): boolean {
  const liveSourceAction =
    event.action === "source-changed" ||
    event.action === "source-missing" ||
    event.action === "source-restored";
  return Boolean(
    liveSourceAction &&
      event.documentId === readerDocumentId &&
      (event.action !== "source-changed" ||
        renderedRevision === undefined ||
        (event.revision !== undefined && event.revision > renderedRevision)),
  );
}

export function completeTuiReviewResponse(state: TuiState): TuiState {
  return {
    ...state,
    reviewComposer: undefined,
    reader: state.reader
      ? {
          ...state.reader,
          feedbackItems: [],
          markdownFeedbackItems: [],
          feedbackGeneralMessage: "",
        }
      : undefined,
  };
}

export function replaceTuiDocuments(
  state: TuiState,
  documents: PublicDocument[],
  workspaces: PublicWorkspace[] = state.workspaces,
  reviewRequests: PublicReviewRequest[] = state.reviewRequests,
): TuiState {
  const selectedId = state.visibleDocuments[state.selectedIndex]?.id;
  const visibleWorkspaces = workspacesForDocuments(documents, workspaces);
  const workspaceFilter = visibleWorkspaces.some(
    ({ id }) => id === state.workspaceFilter,
  )
    ? state.workspaceFilter
    : undefined;
  let next = applyFilters({
    ...state,
    documents,
    reviewRequests,
    workspaces: visibleWorkspaces,
    workspaceFilter,
  });
  const selectedIndex = selectedId
    ? next.visibleDocuments.findIndex(({ id }) => id === selectedId)
    : -1;
  next = {
    ...next,
    selectedDocumentIds: next.selectedDocumentIds.filter((id) =>
      next.visibleDocuments.some((document) => document.id === id)
    ),
    selectedIndex:
      selectedIndex >= 0
        ? selectedIndex
        : clamp(next.selectedIndex, 0, Math.max(0, next.visibleDocuments.length - 1)),
  };
  if (next.reader) {
    const readerDocumentId = next.reader.document.id;
    const previousPendingId = pendingReviewForDocument(
      state.reviewRequests,
      readerDocumentId,
    )?.id;
    const nextPendingId = pendingReviewForDocument(
      reviewRequests,
      readerDocumentId,
    )?.id;
    const updated = documents.find(({ id }) => id === readerDocumentId);
    if (updated) {
      next = { ...next, reader: { ...next.reader, document: updated } };
    } else {
      next = {
        ...next,
        annotationComposer: undefined,
        mode: "queue",
        reader: undefined,
        reviewComposer: undefined,
        scroll: 0,
      };
    }
    if (next.reader && (nextPendingId === undefined || previousPendingId !== nextPendingId)) {
      next = {
        ...next,
        annotationComposer: undefined,
        reviewComposer: undefined,
        reader: { ...next.reader!, feedbackItems: [] },
      };
    }
  }
  return next;
}

export function handleTuiKey(state: TuiState, key: string): TuiTransition {
  if (key === "ctrl-c") {
    return { state, effects: [{ type: "quit" }] };
  }
  if (state.confirmation) {
    if (key === "y") {
      return {
        state: { ...state, confirmation: undefined, message: undefined },
        effects: [{
          type: "bulk-action",
          action: state.confirmation.action,
          documentIds: state.confirmation.documentIds,
        }],
      };
    }
    if (key === "n" || key === "escape") {
      return {
        state: { ...state, confirmation: undefined, message: undefined },
        effects: [],
      };
    }
    return { state, effects: [] };
  }
  if (state.searching) {
    return handleSearchKey(state, key);
  }
  if (state.annotationComposer) {
    return handleAnnotationComposerKey(state, key);
  }
  if (state.feedbackComposer) {
    return handleFeedbackComposerKey(state, key);
  }
  if (state.reviewComposer) {
    return handleReviewComposerKey(state, key);
  }
  if (key === "q") {
    return { state, effects: [{ type: "quit" }] };
  }
  if (state.mode === "reader") {
    return handleReaderKey(state, key);
  }
  return handleQueueKey(state, key);
}

export function handleTuiMouse(
  state: TuiState,
  event: TuiMouseEvent,
  width: number,
  height: number,
): TuiTransition {
  if (
    !Number.isSafeInteger(event.x) ||
    !Number.isSafeInteger(event.y) ||
    event.x < 1 ||
    event.y < 1
  ) {
    return { state, effects: [] };
  }
  if (event.button === "wheel-down") {
    return state.mode === "reader"
      ? {
          state: clampReaderScroll(
            { ...state, scroll: state.scroll + 3 },
            height,
          ),
          effects: [],
        }
      : moveQueueSelection(state, 3);
  }
  if (event.button === "wheel-up") {
    return state.mode === "reader"
      ? {
          state: clampReaderScroll(
            { ...state, scroll: Math.max(0, state.scroll - 3) },
            height,
          ),
          effects: [],
        }
      : moveQueueSelection(state, -3);
  }

  const safeWidth = clamp(Math.floor(width), 40, 1_000);
  const safeHeight = clamp(Math.floor(height), 8, 500);
  if (event.y === safeHeight - 1) {
    const key = footerKeyAt(state, event.x);
    return key ? handleTuiKey(state, key) : { state, effects: [] };
  }
  if (state.mode === "reader") {
    return { state, effects: [] };
  }
  return handleQueueMouse(state, event, safeWidth, safeHeight);
}

export function renderTui(
  state: TuiState,
  width: number,
  height: number,
  options: TuiRenderOptions = {},
): string {
  const safeWidth = clamp(Math.floor(width), 40, 1_000);
  const safeHeight = clamp(Math.floor(height), 8, 500);
  const innerWidth = safeWidth - 2;
  const borders = createBorders(options.unicode !== false);
  const theme = createTuiTheme(options.color === true);
  const top = theme.line(
    `${borders.topLeft}${borders.horizontal.repeat(innerWidth)}${borders.topRight}`,
  );
  const bottom = theme.line(
    `${borders.bottomLeft}${borders.horizontal.repeat(innerWidth)}${borders.bottomRight}`,
  );
  const divider = theme.line(
    `${borders.middleLeft}${borders.horizontal.repeat(innerWidth)}${borders.middleRight}`,
  );
  const title = renderWorkspaceTitle(state, innerWidth, theme, options.unicode !== false);
  const footer = state.confirmation
    ? `${theme.accent(theme.styles.bold("CONFIRM"))} ${theme.ink(confirmationMessage(state.confirmation))}  ${theme.accent("y")} yes  ${theme.accent("n")} no`
    : state.annotationComposer
    ? renderShortcutBar(
        [["enter", "newline"], ["ctrl-d", "save note"], ["esc", "cancel"]],
        theme,
      )
    : state.feedbackComposer
    ? renderShortcutBar(
        [["enter", "newline"], ["ctrl-d", "save general feedback"], ["esc", "cancel"]],
        theme,
      )
    : state.reviewComposer
    ? renderShortcutBar(
        [["enter", "newline"], ["ctrl-d", "submit"], ["esc", "cancel"]],
        theme,
      )
    : state.mode === "reader"
      ? renderShortcutBar(
          state.reader?.document.missingAt
            ? [["a", "archive"], ["X", "purge"], ["b", "queue"], ["q", "quit"]]
            : state.reader?.changeView === "diff"
              ? pendingReviewForDocument(
                    state.reviewRequests,
                    state.reader.document.id,
                  )
                ? [["p/n", "file"], ["j/k", "line"], ["v", "range"], ["m", "layout"], ["d", "document"], ["f", "line feedback"], ["t", "file feedback"], ["g", "general"], ["s", "send"], ["z", "undo"], ["y/c/x/o", "decide"], ["b", "queue"]]
                : [["p/n", "file"], ["j/k", "line"], ["m", "layout"], ["d", "document"], ["f", "line feedback"], ["t", "file feedback"], ["g", "general"], ["s", "send"], ["z", "undo"], ["b", "queue"]]
            : pendingReviewForDocument(
                  state.reviewRequests,
                  state.reader?.document.id ?? "",
                )
              ? [["y", "approve"], ["c", "changes"], ["x", "reject"], ["o", "supersede"], ["[/]", "source row"], ["f", "comment row"], ["g", "general"], ["s", "send"], ["j/k", "scroll"], ["b", "queue"]]
              : state.contentMode === "archive"
                ? [["j/k", "scroll"], ["u", "restore"], ["X", "purge"], ["b", "queue"], ["q", "quit"]]
                : [["[/]", "source row"], ["f", "comment row"], ["g", "general"], ["s", "send"], ["j/k", "scroll"], ["m", "read"], ["u", "unread"], ["a", "archive"], ["X", "purge"], ["b", "queue"]],
          theme,
        )
    : state.searching
      ? `${theme.accent("SEARCH")} ${theme.ink(`${sanitizeTerminalText(state.search)}_`)}  ${theme.muted("enter apply  esc clear")}`
      : renderShortcutBar(
          state.contentMode === "archive"
            ? [["j/k", "move"], ["space", "select"], ["A", "select all"], ["u", "restore"], ["X", "purge"], ["v", "documents"], ["q", "quit"]]
            : [["j/k", "move"], ["enter", "open"], ["a", "archive"], ["X", "purge"], ["space", "select"], ["A", "all"], ["c", "content"], ["v", "archive"], ["p", "project"], ["x", "space"], ["/", "search"], ["q", "quit"]],
          theme,
        );
  const bodyHeight = safeHeight - 6;
  const body = state.mode === "reader"
    ? readerLines(state, innerWidth, bodyHeight, theme, borders)
    : queueLines(state, innerWidth, bodyHeight, theme, borders);
  const lines = [top, boxLine(title, innerWidth, borders, theme), divider];
  for (let index = 0; index < bodyHeight; index += 1) {
    lines.push(boxLine(body[index] ?? "", innerWidth, borders, theme));
  }
  lines.push(divider, boxLine(footer, innerWidth, borders, theme), bottom);
  return lines.join("\n");
}

export async function runTui(
  client: DeskApiClient,
  io: TuiIo = {},
): Promise<void> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const env = io.env ?? process.env;
  const color = !("NO_COLOR" in env) &&
    (io.color ?? Boolean(output.isTTY && env.TERM !== "dumb"));
  const unicode = io.unicode ?? env.TERM !== "dumb";
  if (typeof client.requireCapabilities === "function") {
    await client.requireCapabilities("spaces-v1", "scoped-content-v1");
  }
  const [initialDocuments, initialWorkspaces, initialReviewRequests, spaces] =
    await Promise.all([
      client.listDocuments(),
      client.listWorkspaces(),
      client.listReviewRequests(),
      typeof client.listSpaces === "function"
        ? client.listSpaces()
        : Promise.resolve([]),
    ]);
  let state = createTuiState(
    initialDocuments,
    initialWorkspaces,
    initialReviewRequests,
    spaces,
  );
  const wasRaw = input.isRaw;
  const eventController = new AbortController();
  let finished = false;
  let processing = Promise.resolve();
  let refreshing = Promise.resolve();
  let resizeTimer: NodeJS.Timeout | undefined;
  let renderedWidth = readerRenderWidth(output.columns ?? 100);
  let renderedRevision: number | undefined;
  let inputBuffer = "";
  let previousFrame: string[] | undefined;
  const currentScope = (): { spaceId?: string } =>
    state.selectedSpace === undefined ? {} : { spaceId: state.selectedSpace };
  const documentFilters = (): { archived?: boolean } =>
    state.contentMode === "archive" ? { archived: true } : {};
  type ScopeContext = {
    generation: number;
    scope: { spaceId?: string };
  };
  const scopeContext = (): ScopeContext => ({
    generation: state.scopeGeneration,
    scope: currentScope(),
  });
  const scopeContextMatches = (context: ScopeContext): boolean =>
    context.generation === state.scopeGeneration &&
    context.scope.spaceId === state.selectedSpace;

  const draw = (): void => {
    const width = output.columns ?? 100;
    const height = output.rows ?? 30;
    const frame = renderTui(state, width, height, { color, unicode });
    const lines = frame.split("\n");
    if (!previousFrame) {
      output.write(`\u001b[H\u001b[2J${frame}`);
    } else {
      const updates: string[] = [];
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index] !== previousFrame[index]) {
          updates.push(`\u001b[${index + 1};1H${lines[index] ?? ""}\u001b[K`);
        }
      }
      if (updates.length > 0) {
        output.write(updates.join(""));
      }
    }
    previousFrame = lines;
  };
  const cleanup = (): void => {
    if (finished) {
      return;
    }
    finished = true;
    input.off("data", onData);
    process.off("SIGWINCH", onResize);
    eventController.abort();
    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }
    if (input.isTTY) {
      input.setRawMode(Boolean(wasRaw));
    }
    input.pause();
    output.write("\u001b[?1006l\u001b[?1000l\u001b[?25h\u001b[?1049l");
  };

  const execute = async (
    effect: TuiEffect,
    context: ScopeContext,
  ): Promise<void> => {
    if (effect.type === "quit") {
      cleanup();
      return;
    }
    if (!scopeContextMatches(context)) {
      return;
    }
    const scope = context.scope;
    try {
      if (effect.type === "reload") {
        const [documents, workspaces, reviewRequests, nextSpaces] =
          await Promise.all([
            client.listDocuments(scope, documentFilters()),
            client.listWorkspaces(scope),
            client.listReviewRequests({}, scope),
            typeof client.listSpaces === "function"
              ? client.listSpaces()
              : Promise.resolve(state.spaces),
          ]);
        if (!scopeContextMatches(context)) {
          return;
        }
        state = replaceTuiDocuments(
          { ...state, spaces: nextSpaces, message: undefined },
          documents,
          workspaces,
          reviewRequests,
        );
        draw();
        return;
      }
      if (effect.type === "open") {
        const rendered = await client.renderDocument(
          effect.documentId,
          "terminal",
          readerRenderWidth(output.columns ?? 100),
          { color, unicode },
          scope,
        );
        if (!scopeContextMatches(context)) {
          return;
        }
        renderedWidth = readerRenderWidth(output.columns ?? 100);
        renderedRevision = rendered.document.revision;
        state = applyTuiReader(
          state,
          rendered.document,
          rendered.content,
          rendered.backend,
          rendered.warnings,
          rendered.changeReview,
          rendered.sourceMap,
          rendered.sourceWitness,
        );
        draw();
        await client.act(effect.documentId, "opened", scope);
        if (!scopeContextMatches(context)) {
          return;
        }
      } else if (effect.type === "action") {
        await client.act(effect.documentId, effect.action, scope);
        if (!scopeContextMatches(context)) {
          return;
        }
        if (effect.action === "archive") {
          state = { ...state, mode: "queue", reader: undefined, scroll: 0 };
        }
      } else if (effect.type === "bulk-action") {
        if (effect.action === "purge") {
          await client.bulkAct("purge", effect.documentIds, scope);
        } else {
          await client.bulkAct(effect.action, effect.documentIds, scope);
        }
        if (!scopeContextMatches(context)) {
          return;
        }
        state = {
          ...state,
          confirmation: undefined,
          mode: "queue",
          reader: undefined,
          scroll: 0,
          selectedDocumentIds: [],
          message: effect.action === "archive"
            ? `${effect.documentIds.length} archived · open Archive with v to restore`
            : effect.action === "restore"
              ? `${effect.documentIds.length} restored`
              : `${effect.documentIds.length} purged forever`,
        };
      } else if (effect.type === "feedback-submit") {
        const submission = await client.createFeedback(effect.input, scope);
        if (!scopeContextMatches(context)) return;
        state = {
          ...state,
          reader: state.reader
            ? {
                ...state.reader,
                feedbackItems: [],
                markdownFeedbackItems: [],
                feedbackGeneralMessage: "",
                feedbackHistory: [submission, ...state.reader.feedbackHistory],
              }
            : undefined,
          feedbackComposer: undefined,
          message: `Feedback saved: ${submission.id} · ${submission.route}`,
        };
      } else {
        await client.respondToReviewRequest(effect.requestId, {
          outcome: effect.outcome,
          message: effect.message,
          ...(effect.items === undefined ? {} : { items: effect.items }),
          ...(effect.feedback === undefined ? {} : { feedback: effect.feedback }),
        }, scope);
        if (!scopeContextMatches(context)) {
          return;
        }
        state = completeTuiReviewResponse(state);
      }
      const [documents, workspaces, reviewRequests] = await Promise.all([
        client.listDocuments(scope, documentFilters()),
        client.listWorkspaces(scope),
        client.listReviewRequests({}, scope),
      ]);
      if (!scopeContextMatches(context)) {
        return;
      }
      state = replaceTuiDocuments(
        state,
        documents,
        workspaces,
        reviewRequests,
      );
      if (state.reader && typeof client.listFeedback === "function") {
        const feedbackItems = await listAllFeedback(
          client,
          state.reader.document.id,
          scope,
        );
        if (!scopeContextMatches(context)) return;
        state = {
          ...state,
          reader: { ...state.reader, feedbackHistory: feedbackItems },
        };
      }
      draw();
    } catch (error) {
      if (
        effect.type === "open" &&
        error instanceof DeskApiError &&
        error.code === "source_missing"
      ) {
        try {
          const [documents, reviewRequests] = await Promise.all([
            client.listDocuments(scope, documentFilters()),
            client.listReviewRequests({}, scope),
          ]);
          if (!scopeContextMatches(context)) {
            return;
          }
          state = replaceTuiDocuments(
            state,
            documents,
            state.workspaces,
            reviewRequests,
          );
          const missing = documents.find(({ id }) => id === effect.documentId);
          if (missing) {
            renderedRevision = missing.revision;
            state = applyTuiMissingReader(state, missing);
            draw();
            return;
          }
        } catch {
          // Fall through to a safe message; queue archive remains available.
        }
      }
      if (scopeContextMatches(context)) {
        state = effect.type === "reload"
          ? applyFilters({
              ...state,
              documents: [],
              workspaces: [],
              reviewRequests: [],
              reader: undefined,
              mode: "queue",
              message: error instanceof Error ? error.message : "TUI request failed",
            })
          : {
              ...state,
              message: error instanceof Error ? error.message : "TUI request failed",
            };
        draw();
      }
    }
  };

  const onData = (chunk: Buffer | string): void => {
    inputBuffer += chunk.toString();
    const decoded = decodeInput(inputBuffer);
    inputBuffer = decoded.remainder;
    let changed = false;
    for (const inputEvent of decoded.events) {
      if (finished) {
        return;
      }
      const transition = inputEvent.type === "mouse"
        ? handleTuiMouse(
            state,
            inputEvent.event,
            output.columns ?? 100,
            output.rows ?? 30,
          )
        : handleTuiKey(state, inputEvent.key);
      state = clampReaderScroll(transition.state, output.rows ?? 30);
      changed = true;
      const context = scopeContext();
      for (const effect of transition.effects) {
        processing = processing.then(() => execute(effect, context));
      }
    }
    if (changed) {
      draw();
    }
  };

  const onResize = (): void => {
    draw();
    if (!state.reader) {
      return;
    }
    const nextWidth = readerRenderWidth(output.columns ?? 100);
    if (nextWidth === renderedWidth) {
      return;
    }
    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }
    resizeTimer = setTimeout(() => {
      const documentId = state.reader?.document.id;
      if (!documentId || finished) {
        return;
      }
      const context = scopeContext();
      processing = processing.then(async () => {
        try {
          const rendered = await client.renderDocument(
            documentId,
            "terminal",
            nextWidth,
            { color, unicode },
            context.scope,
          );
          if (!scopeContextMatches(context)) {
            return;
          }
          renderedWidth = nextWidth;
          renderedRevision = rendered.document.revision;
          const scroll = state.scroll;
          state = refreshTuiReader(
            state,
            rendered.document,
            rendered.content,
            rendered.backend,
            rendered.warnings,
            rendered.changeReview,
            rendered.sourceMap,
          );
          state = { ...state, scroll };
          draw();
        } catch (error) {
          if (!scopeContextMatches(context)) {
            return;
          }
          state = {
            ...state,
            message: error instanceof Error ? error.message : "Resize render failed",
          };
          draw();
        }
      });
    }, 80);
  };

  output.write("\u001b[?1049h\u001b[?25l\u001b[?1000h\u001b[?1006h");
  if (input.isTTY) {
    input.setRawMode(true);
  }
  input.resume();
  input.on("data", onData);
  process.on("SIGWINCH", onResize);
  draw();
  const scheduleCatalogRefresh = (): void => {
    const context = scopeContext();
    refreshing = refreshing
      .then(async () => {
          if (!scopeContextMatches(context)) {
            return;
          }
          const readerDocumentId = state.reader?.document.id;
          const refreshReader = readerDocumentId !== undefined;
          const scroll = state.scroll;
          const [documents, workspaces, reviewRequests, spaces] = await Promise.all([
            client.listDocuments(context.scope, documentFilters()),
            client.listWorkspaces(context.scope),
            client.listReviewRequests({}, context.scope),
            client.listSpaces(),
          ]);
          if (!scopeContextMatches(context)) {
            return;
          }
          state = replaceTuiDocuments(
            { ...state, spaces },
            documents,
            workspaces,
            reviewRequests,
          );
          if (refreshReader && readerDocumentId) {
            const document = documents.find(({ id }) => id === readerDocumentId);
            if (document?.missingAt) {
              renderedRevision = document.revision;
              state = applyTuiMissingReader(state, document);
              state = clampReaderScroll(
                { ...state, scroll },
                output.rows ?? 30,
              );
            } else if (document) {
              const width = readerRenderWidth(output.columns ?? 100);
              const rendered = await client.renderDocument(
                readerDocumentId,
                "terminal",
                width,
                { color, unicode },
                context.scope,
              );
              if (!scopeContextMatches(context)) {
                return;
              }
              renderedWidth = width;
              renderedRevision = rendered.document.revision;
              state = refreshTuiReader(
                state,
                rendered.document,
                rendered.content,
                rendered.backend,
                rendered.warnings,
                rendered.changeReview,
                rendered.sourceMap,
                rendered.sourceWitness,
              );
              if (typeof client.listFeedback === "function") {
                const feedbackItems = await listAllFeedback(
                  client,
                  rendered.document.id,
                  context.scope,
                );
                if (state.reader?.document.id === rendered.document.id) {
                  state = {
                    ...state,
                    reader: { ...state.reader, feedbackHistory: feedbackItems },
                  };
                }
              }
              state = clampReaderScroll(
                { ...state, scroll },
                output.rows ?? 30,
              );
            }
          }
          draw();
        })
      .catch(async (error: unknown) => {
          if (finished || !scopeContextMatches(context)) {
            return;
          }
          let spaces = state.spaces;
          try {
            spaces = await client.listSpaces();
          } catch {
            // Preserve the last trusted inventory when its refresh also fails.
          }
          if (!finished && scopeContextMatches(context)) {
            state = applyFilters({
              ...state,
              spaces,
              documents: [],
              workspaces: [],
              reviewRequests: [],
              reader: undefined,
              mode: "queue",
              message: error instanceof Error ? error.message : "Live refresh failed",
            });
            draw();
          }
        });
  };
  const waitForReconnect = (): Promise<void> =>
    new Promise((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        eventController.signal.removeEventListener("abort", onAbort);
        resolve();
      }, 250);
      eventController.signal.addEventListener("abort", onAbort, { once: true });
    });
  const subscribeCatalog = async (): Promise<void> => {
    while (!finished) {
      try {
        await client.subscribeCatalog(scheduleCatalogRefresh, {
          signal: eventController.signal,
          onReady: scheduleCatalogRefresh,
        });
      } catch (error) {
        if (!finished) {
          state = {
            ...state,
            message: error instanceof Error ? error.message : "Live events failed",
          };
          draw();
        }
      }
      if (!finished) {
        await waitForReconnect();
      }
    }
  };
  void subscribeCatalog();

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (finished) {
        clearInterval(interval);
        void processing.finally(resolve);
      }
    }, 25);
  });
}

function handleSearchKey(state: TuiState, key: string): TuiTransition {
  if (key === "enter") {
    return { state: { ...state, searching: false }, effects: [] };
  }
  if (key === "escape") {
    return {
      state: applyFilters({ ...state, search: "", searching: false }),
      effects: [],
    };
  }
  if (key === "backspace") {
    return {
      state: applyFilters({ ...state, search: state.search.slice(0, -1) }),
      effects: [],
    };
  }
  if (key.length === 1 && key >= " " && key <= "~") {
    return {
      state: applyFilters({ ...state, search: `${state.search}${key}` }),
      effects: [],
    };
  }
  return { state, effects: [] };
}

function handleQueueKey(state: TuiState, key: string): TuiTransition {
  if (key === "j" || key === "down") {
    return moveQueueSelection(state, 1);
  }
  if (key === "k" || key === "up") {
    return moveQueueSelection(state, -1);
  }
  if (key === "enter") {
    const document = state.visibleDocuments[state.selectedIndex];
    return {
      state,
      effects: document ? [{ type: "open", documentId: document.id }] : [],
    };
  }
  if (key === " ") {
    const document = state.visibleDocuments[state.selectedIndex];
    if (!document) {
      return { state, effects: [] };
    }
    const selected = new Set(state.selectedDocumentIds);
    if (selected.has(document.id)) {
      selected.delete(document.id);
    } else {
      selected.add(document.id);
    }
    return {
      state: { ...state, selectedDocumentIds: [...selected], message: undefined },
      effects: [],
    };
  }
  if (key === "A") {
    const ids = [...new Set(state.visibleDocuments.map(({ id }) => id))];
    const allSelected = ids.length > 0 &&
      ids.every((id) => state.selectedDocumentIds.includes(id));
    return {
      state: {
        ...state,
        selectedDocumentIds: allSelected ? [] : ids,
        message: undefined,
      },
      effects: [],
    };
  }
  if (key === "a") {
    if (state.contentMode === "archive") {
      return { state, effects: [] };
    }
    const documentIds = selectedOrCurrentDocumentIds(state);
    return {
      state: documentIds.length === 0
        ? state
        : {
            ...state,
            confirmation: { action: "archive", documentIds },
            message: undefined,
          },
      effects: [],
    };
  }
  if (key === "X") {
    const documentIds = selectedOrCurrentDocumentIds(state);
    return {
      state: documentIds.length === 0
        ? state
        : {
            ...state,
            confirmation: { action: "purge", documentIds },
            message: undefined,
          },
      effects: [],
    };
  }
  if (key === "u" && state.contentMode === "archive") {
    const documentIds = selectedOrCurrentDocumentIds(state);
    return {
      state,
      effects: documentIds.length === 0
        ? []
        : [{ type: "bulk-action", action: "restore", documentIds }],
    };
  }
  if (key === "v") {
    const contentMode = state.contentMode === "archive" ? "docs" : "archive";
    return {
      state: applyFilters({
        ...state,
        contentMode,
        changeReviewsOnly: false,
        actionsOnly: false,
        statusFilter: "all",
        documents: [],
        selectedDocumentIds: [],
        selectedIndex: 0,
        message: contentMode === "archive" ? "Loading Archive…" : "Loading documents…",
      }),
      effects: [{ type: "reload" }],
    };
  }
  if (key === "r") {
    return {
      state: applyFilters({
        ...state,
        actionsOnly: !state.actionsOnly,
        statusFilter: "all",
        selectedIndex: 0,
      }),
      effects: [],
    };
  }
  if (key === "c") {
    if (state.contentMode === "archive") {
      return { state, effects: [] };
    }
    const contentMode = state.contentMode === "docs" ? "change-reviews" : "docs";
    return {
      state: applyFilters({
        ...state,
        contentMode,
        changeReviewsOnly: contentMode === "change-reviews",
        selectedIndex: 0,
      }),
      effects: [],
    };
  }
  if (key === "x") {
    const spaceIds = [undefined, ...state.spaces.map(({ id }) => id)];
    const index = spaceIds.indexOf(state.selectedSpace);
    const selectedSpace = spaceIds[(index + 1) % spaceIds.length];
    return {
      state: applyFilters({
        ...state,
        selectedSpace,
        scopeGeneration: state.scopeGeneration + 1,
        documents: [],
        workspaces: [],
        reviewRequests: [],
        reader: undefined,
        mode: "queue",
        selectedIndex: 0,
        message: "Loading Space…",
      }),
      effects: [{ type: "reload" }],
    };
  }
  if (key === "s") {
    const filters = ["all", "actions", "unread", "reading", "done"] as const;
    const current = state.actionsOnly ? "actions" : state.statusFilter;
    const index = filters.indexOf(current);
    const next = filters[(index + 1) % filters.length] ?? "all";
    return {
      state: applyFilters({
        ...state,
        actionsOnly: next === "actions",
        statusFilter: next === "actions" ? "all" : next,
      }),
      effects: [],
    };
  }
  if (key === "p") {
    const workspaceIds = [undefined, ...state.workspaces.map(({ id }) => id)];
    const index = workspaceIds.indexOf(state.workspaceFilter);
    const workspaceFilter = workspaceIds[(index + 1) % workspaceIds.length];
    return {
      state: applyFilters({ ...state, workspaceFilter }),
      effects: [],
    };
  }
  if (key === "g") {
    const groupings: TuiQueueGrouping[] = ["project", "tag", "all"];
    const index = groupings.indexOf(state.grouping);
    return {
      state: applyFilters({
        ...state,
        grouping: groupings[(index + 1) % groupings.length] ?? "project",
        selectedIndex: 0,
      }),
      effects: [],
    };
  }
  if (key === "/") {
    return { state: { ...state, searching: true }, effects: [] };
  }
  return { state, effects: [] };
}

function handleReaderKey(state: TuiState, key: string): TuiTransition {
  if (key === "b" || key === "escape") {
    return {
      state: { ...state, mode: "queue", reader: undefined, scroll: 0 },
      effects: [],
    };
  }
  if ((key === "a" || key === "X") && state.reader) {
    return {
      state: {
        ...state,
        confirmation: {
          action: key === "a" ? "archive" : "purge",
          documentIds: [state.reader.document.id],
        },
        message: undefined,
      },
      effects: [],
    };
  }
  if (key === "u" && state.contentMode === "archive" && state.reader) {
    return {
      state,
      effects: [{
        type: "bulk-action",
        action: "restore",
        documentIds: [state.reader.document.id],
      }],
    };
  }
  if (key === "d" && state.reader?.changeReview) {
    return {
      state: {
        ...state,
        reader: {
          ...state.reader,
          changeView: state.reader.changeView === "diff" ? "document" : "diff",
        },
        scroll: 0,
      },
      effects: [],
    };
  }
  if (state.reader?.changeView === "diff" && state.reader.changeReview) {
    const reader = state.reader;
    const files = reader.changeReview?.files ?? [];
    if (
      (key === "p" || key === "[" || key === "left" || key === "pageup") &&
      files.length > 0
    ) {
      return moveChangeFile(state, -1);
    }
    if (
      (key === "n" || key === "]" || key === "right" || key === "pagedown") &&
      files.length > 0
    ) {
      return moveChangeFile(state, 1);
    }
    const file = files[reader.changeFileIndex];
    const hunk = file?.hunks[reader.changeHunkIndex];
    if ((key === "j" || key === "down") && hunk && hunk.lines.length > 0) {
      return moveChangeLine(state, 1);
    }
    if ((key === "k" || key === "up") && hunk && hunk.lines.length > 0) {
      return moveChangeLine(state, -1);
    }
    if (key === "m") {
      return {
        state: {
          ...state,
          reader: {
            ...reader,
            changeLayout: reader.changeLayout === "unified"
              ? "side-by-side"
              : "unified",
          },
          scroll: 0,
        },
        effects: [],
      };
    }
    if (key === "v" && hunk && hunk.lines.length > 0) {
      return {
        state: {
          ...state,
          reader: {
            ...reader,
            changeRangeStartIndex: reader.changeRangeStartIndex === undefined
              ? reader.changeLineIndex
              : undefined,
          },
          message: undefined,
        },
        effects: [],
      };
    }
    if ((key === "f" || key === "t") && file) {
      if (key === "f" && !hunk) {
        return { state, effects: [] };
      }
      const line = key === "f" ? hunk?.lines[reader.changeLineIndex] : undefined;
      if (key === "f" && !line) {
        return { state, effects: [] };
      }
      const selectedLines = key === "f" && hunk && line
        ? hunk.lines.slice(
            Math.min(reader.changeRangeStartIndex ?? reader.changeLineIndex, reader.changeLineIndex),
            Math.max(reader.changeRangeStartIndex ?? reader.changeLineIndex, reader.changeLineIndex) + 1,
          )
        : [];
      const anchors = selectedLines.map(changeLineAnchor);
      const side = anchors[0]?.side;
      if (
        key === "f" &&
        (anchors.some((anchor) => anchor.line === null) ||
          anchors.some((anchor) => anchor.side !== side))
      ) {
        return {
          state: { ...state, message: "A feedback range must stay on one diff side." },
          effects: [],
        };
      }
      const lineNumbers = anchors.flatMap(({ line: value }) =>
        value === null ? [] : [value]
      );
      const lineNumber = lineNumbers.length === 0 ? undefined : Math.min(...lineNumbers);
      const endLine = lineNumbers.length === 0 ? undefined : Math.max(...lineNumbers);
      return {
        state: {
          ...state,
          reader: { ...reader, changeRangeStartIndex: undefined },
          annotationComposer: {
            kind: "feedback",
            path: file.path,
            ...(key === "f" && hunk ? { hunkId: hunk.id } : {}),
            ...(line && lineNumber !== null && lineNumber !== undefined
              ? {
                  line: lineNumber,
                  ...(endLine !== undefined && endLine > lineNumber ? { endLine } : {}),
                  side: side ?? (line.kind === "deletion" ? "old" as const : "new" as const),
                }
              : {}),
            message: "",
          },
          message: undefined,
        },
        effects: [],
      };
    }
    if (key === "z" && reader.feedbackItems.length > 0) {
      return {
        state: {
          ...state,
          reader: {
            ...reader,
            feedbackItems: reader.feedbackItems.slice(0, -1),
          },
          message: undefined,
        },
        effects: [],
      };
    }
  }
  if (state.reader?.changeView === "document") {
    const reader = state.reader;
    const logicalLines = reader.sourceMap?.logicalLines ?? [];
    if ((key === "[" || key === "]") && logicalLines.length > 0) {
      return {
        state: {
          ...state,
          reader: {
            ...reader,
            sourceLineIndex: clamp(
              reader.sourceLineIndex + (key === "]" ? 1 : -1),
              0,
              logicalLines.length - 1,
            ),
          },
          message: undefined,
        },
        effects: [],
      };
    }
    if (key === "f") {
      const logicalLine = logicalLines[reader.sourceLineIndex];
      const firstRef = logicalLine?.segmentRefs[0];
      const lastRef = logicalLine?.segmentRefs.at(-1);
      const lastSegment = reader.sourceMap?.segments.find(({ ref }) => ref === lastRef);
      if (!logicalLine || !firstRef || !lastRef || !lastSegment) {
        return {
          state: { ...state, message: "This document row is not commentable." },
          effects: [],
        };
      }
      return {
        state: {
          ...state,
          annotationComposer: {
            kind: "feedback",
            markdownAnchor: {
              kind: "markdown-selection-v1",
              start: { ref: firstRef, offset: 0 },
              end: { ref: lastRef, offset: lastSegment.text.length },
            },
            label: `source row ${logicalLine.sourceStart.line}: ${logicalLine.text.slice(0, 80)}`,
            message: "",
          },
          message: undefined,
        },
        effects: [],
      };
    }
  }
  if (key === "g" && state.reader) {
    return {
      state: {
        ...state,
        feedbackComposer: { message: state.reader.feedbackGeneralMessage },
        message: undefined,
      },
      effects: [],
    };
  }
  if (key === "s" && state.reader) {
    const input = tuiFeedbackRegistration(state.reader);
    if (!input) {
      return {
        state: { ...state, message: "Add general feedback or a specific comment first." },
        effects: [],
      };
    }
    return { state: { ...state, message: undefined }, effects: [{ type: "feedback-submit", input }] };
  }
  if (
    key === "z" &&
    state.reader &&
    state.reader.changeView === "document" &&
    state.reader.markdownFeedbackItems.length > 0
  ) {
    return {
      state: {
        ...state,
        reader: {
          ...state.reader,
          markdownFeedbackItems: state.reader.markdownFeedbackItems.slice(0, -1),
        },
        message: undefined,
      },
      effects: [],
    };
  }
  if (key === "j" || key === "down") {
    return { state: { ...state, scroll: state.scroll + 1 }, effects: [] };
  }
  if (key === "k" || key === "up") {
    return {
      state: { ...state, scroll: Math.max(0, state.scroll - 1) },
      effects: [],
    };
  }
  if (key === "pagedown") {
    return { state: { ...state, scroll: state.scroll + 10 }, effects: [] };
  }
  if (key === "pageup") {
    return {
      state: { ...state, scroll: Math.max(0, state.scroll - 10) },
      effects: [],
    };
  }
  const pending = state.reader
    ? pendingReviewForDocument(
        state.reviewRequests,
        state.reader.document.id,
      )
    : undefined;
  const reviewOutcomes: Partial<Record<string, ReviewOutcome>> = {
    y: "approved",
    c: "changes_requested",
    x: "rejected",
    o: "superseded",
  };
  const reviewOutcome = reviewOutcomes[key];
  if (pending && reviewOutcome) {
    if (
      reviewOutcome === "approved" &&
      state.reader?.document.kind === "change-review" &&
      (!state.reader.changeReview || state.reader.changeReview.files.length === 0)
    ) {
      return {
        state: {
          ...state,
          message: "Approval requires a complete native diff for this change review.",
        },
        effects: [],
      };
    }
    if (
      reviewOutcome === "approved" &&
      (state.reader?.changeReview?.warnings.length ?? 0) > 0
    ) {
      return {
        state: {
          ...state,
          message: "This native diff is incomplete; request changes or reject it.",
        },
        effects: [],
      };
    }
    const items = reviewOutcome === "changes_requested" ||
        reviewOutcome === "approved"
      ? state.reader?.feedbackItems ?? []
      : [];
    return {
      state: {
        ...state,
        reviewComposer: {
          requestId: pending.id,
          outcome: reviewOutcome,
          message: "",
          items,
        },
        message: undefined,
      },
      effects: [],
    };
  }
  const actions: Partial<Record<string, DocumentAction>> = {
    m: "read",
    u: "unread",
  };
  const action = actions[key];
  if (
    action &&
    state.reader &&
    state.reader.document.missingAt === null
  ) {
    return {
      state,
      effects: [
        { type: "action", action, documentId: state.reader.document.id },
      ],
    };
  }
  return { state, effects: [] };
}

function handleReviewComposerKey(
  state: TuiState,
  key: string,
): TuiTransition {
  const composer = state.reviewComposer;
  if (!composer) {
    return { state, effects: [] };
  }
  if (key === "escape") {
    return {
      state: { ...state, reviewComposer: undefined, message: undefined },
      effects: [],
    };
  }
  if (key === "backspace") {
    return {
      state: {
        ...state,
        reviewComposer: {
          ...composer,
          message: Array.from(composer.message).slice(0, -1).join(""),
        },
      },
      effects: [],
    };
  }
  if (key === "enter") {
    if (composer.message.length >= 16 * 1024) {
      return { state, effects: [] };
    }
    return {
      state: {
        ...state,
        reviewComposer: { ...composer, message: `${composer.message}\n` },
      },
      effects: [],
    };
  }
  if (key === "ctrl-d") {
    const reader = state.reader;
    const generalFeedback = reader?.feedbackGeneralMessage.trim() ?? "";
    const decisionMessage = composer.message.trim();
    const combinedMessage = decisionMessage === ""
      ? generalFeedback
      : generalFeedback === "" || generalFeedback === decisionMessage
        ? decisionMessage
        : `Feedback:\n${generalFeedback}\n\nDecision:\n${decisionMessage}`;
    const hasStructuredFeedback = Boolean(
      reader &&
        (reader.feedbackGeneralMessage.trim() !== "" ||
          reader.markdownFeedbackItems.length > 0),
    );
    const feedback = reader && hasStructuredFeedback
      ? tuiFeedbackRegistration(reader, combinedMessage)
      : undefined;
    if (
      composer.outcome === "changes_requested" &&
      combinedMessage === "" &&
      composer.items.length === 0 &&
      (reader?.markdownFeedbackItems.length ?? 0) === 0
    ) {
      return {
        state: { ...state, message: "Explain what needs to change." },
        effects: [],
      };
    }
    return {
      state: { ...state, message: undefined },
      effects: [
        {
          type: "review-response",
          requestId: composer.requestId,
          outcome: composer.outcome,
          message: combinedMessage,
          ...(feedback === undefined
            ? composer.items.length === 0 ? {} : { items: composer.items }
            : { feedback }),
        },
      ],
    };
  }
  if (key.length === 1 && key >= " " && composer.message.length < 16 * 1024) {
    return {
      state: {
        ...state,
        reviewComposer: { ...composer, message: composer.message + key },
      },
      effects: [],
    };
  }
  return { state, effects: [] };
}

function tuiFeedbackRegistration(
  reader: TuiReader,
  generalMessage = reader.feedbackGeneralMessage.trim(),
): FeedbackSubmissionRegistration | undefined {
  const comments: FeedbackSubmissionRegistration["comments"] = [
    ...reader.markdownFeedbackItems,
    ...reader.feedbackItems.map((item) => ({
      id: item.id.replace(/^feedback-/, "comment-"),
      intent: item.kind,
      anchor: item.line === undefined
        ? { kind: "diff-file-v1" as const, path: item.path }
        : {
            kind: "diff-lines-v1" as const,
            path: item.path,
            hunkId: item.hunkId!,
            side: item.side!,
            line: item.line,
            ...(item.endLine === undefined ? {} : { endLine: item.endLine }),
          },
      message: item.message,
    })),
  ];
  if (generalMessage === "" && comments.length === 0) return undefined;
  return {
    id: `feedback-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    documentId: reader.document.id,
    documentRevision: reader.document.revision,
    ...(comments.length === 0 ? {} : { sourceWitness: reader.sourceWitness }),
    ...(generalMessage === "" ? {} : { generalMessage }),
    comments,
  };
}

async function listAllFeedback(
  client: DeskApiClient,
  documentId: string,
  scope: { spaceId?: string },
): Promise<PublicFeedbackSubmission[]> {
  const items: PublicFeedbackSubmission[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await client.listFeedback({
      documentId,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    }, scope);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== undefined && seenCursors.has(cursor)) {
      throw new Error("Feedback history returned a repeated cursor.");
    }
    if (cursor !== undefined) seenCursors.add(cursor);
  } while (cursor !== undefined);
  return items;
}

function handleFeedbackComposerKey(
  state: TuiState,
  key: string,
): TuiTransition {
  const composer = state.feedbackComposer;
  if (!composer || !state.reader) return { state, effects: [] };
  if (key === "escape") {
    return { state: { ...state, feedbackComposer: undefined }, effects: [] };
  }
  if (key === "backspace") {
    return {
      state: {
        ...state,
        feedbackComposer: {
          message: Array.from(composer.message).slice(0, -1).join(""),
        },
      },
      effects: [],
    };
  }
  if (key === "enter" && composer.message.length < 16 * 1024) {
    return {
      state: {
        ...state,
        feedbackComposer: { message: `${composer.message}\n` },
      },
      effects: [],
    };
  }
  if (key === "ctrl-d") {
    return {
      state: {
        ...state,
        reader: { ...state.reader, feedbackGeneralMessage: composer.message.trim() },
        feedbackComposer: undefined,
        message: undefined,
      },
      effects: [],
    };
  }
  if (key.length === 1 && key >= " " && composer.message.length < 16 * 1024) {
    return {
      state: {
        ...state,
        feedbackComposer: { message: composer.message + key },
      },
      effects: [],
    };
  }
  return { state, effects: [] };
}

function handleAnnotationComposerKey(
  state: TuiState,
  key: string,
): TuiTransition {
  const composer = state.annotationComposer;
  if (!composer || !state.reader) {
    return { state, effects: [] };
  }
  if (key === "escape") {
    return {
      state: { ...state, annotationComposer: undefined, message: undefined },
      effects: [],
    };
  }
  if (key === "backspace") {
    return {
      state: {
        ...state,
        annotationComposer: {
          ...composer,
          message: Array.from(composer.message).slice(0, -1).join(""),
        },
      },
      effects: [],
    };
  }
  if (key === "enter" && composer.message.length < 512) {
    return {
      state: {
        ...state,
        annotationComposer: { ...composer, message: `${composer.message}\n` },
      },
      effects: [],
    };
  }
  if (key === "ctrl-d") {
    if (composer.message.trim() === "") {
      return {
        state: { ...state, message: "Feedback text is required." },
        effects: [],
      };
    }
    if (
      state.reader.feedbackItems.length + state.reader.markdownFeedbackItems.length >= 32
    ) {
      return {
        state: { ...state, message: "A feedback submission can contain at most 32 comments." },
        effects: [],
      };
    }
    if (composer.markdownAnchor) {
      const item: FeedbackSubmissionRegistration["comments"][number] = {
        id: `comment-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
        intent: composer.kind,
        anchor: composer.markdownAnchor,
        message: composer.message.replaceAll("\r", "").trim(),
      };
      return {
        state: {
          ...state,
          reader: {
            ...state.reader,
            markdownFeedbackItems: [...state.reader.markdownFeedbackItems, item],
          },
          annotationComposer: undefined,
          message: undefined,
        },
        effects: [],
      };
    }
    if (!composer.path) return { state, effects: [] };
    const item: ReviewFeedbackItem = {
      id: `feedback-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      kind: composer.kind,
      path: composer.path,
      ...(composer.hunkId === undefined ? {} : { hunkId: composer.hunkId }),
      ...(composer.line === undefined ? {} : { line: composer.line }),
      ...(composer.endLine === undefined ? {} : { endLine: composer.endLine }),
      ...(composer.side === undefined ? {} : { side: composer.side }),
      message: composer.message.replaceAll("\r", "").trim(),
    };
    return {
      state: {
        ...state,
        reader: {
          ...state.reader,
          feedbackItems: [...state.reader.feedbackItems, item],
        },
        annotationComposer: undefined,
        message: undefined,
      },
      effects: [],
    };
  }
  if (key.length === 1 && key >= " " && composer.message.length < 512) {
    return {
      state: {
        ...state,
        annotationComposer: {
          ...composer,
          message: composer.message + key,
        },
      },
      effects: [],
    };
  }
  return { state, effects: [] };
}

function moveChangeFile(state: TuiState, amount: number): TuiTransition {
  const reader = state.reader;
  const files = reader?.changeReview?.files ?? [];
  if (!reader || files.length === 0) {
    return { state, effects: [] };
  }
  const changeFileIndex = clamp(reader.changeFileIndex + amount, 0, files.length - 1);
  return {
    state: {
      ...state,
      reader: {
        ...reader,
        changeFileIndex,
        changeHunkIndex: 0,
        changeLineIndex: 0,
        changeRangeStartIndex: undefined,
      },
      scroll: 0,
    },
    effects: [],
  };
}

function moveChangeLine(state: TuiState, amount: number): TuiTransition {
  const reader = state.reader;
  const file = reader?.changeReview?.files[reader.changeFileIndex];
  if (!reader || !file || file.hunks.length === 0 || amount === 0) {
    return { state, effects: [] };
  }
  let hunkIndex = clamp(
    reader.changeHunkIndex,
    0,
    file.hunks.length - 1,
  );
  let lineIndex = reader.changeLineIndex;
  const direction = amount < 0 ? -1 : 1;
  const steps = Math.abs(amount);
  for (let step = 0; step < steps; step += 1) {
    const hunk = file.hunks[hunkIndex]!;
    if (direction > 0 && lineIndex < hunk.lines.length - 1) {
      lineIndex += 1;
      continue;
    }
    if (direction < 0 && lineIndex > 0) {
      lineIndex -= 1;
      continue;
    }
    let nextHunkIndex = hunkIndex + direction;
    while (
      nextHunkIndex >= 0 &&
      nextHunkIndex < file.hunks.length &&
      file.hunks[nextHunkIndex]!.lines.length === 0
    ) {
      nextHunkIndex += direction;
    }
    const nextHunk = file.hunks[nextHunkIndex];
    if (!nextHunk || nextHunk.lines.length === 0) {
      break;
    }
    hunkIndex = nextHunkIndex;
    lineIndex = direction > 0 ? 0 : nextHunk.lines.length - 1;
  }
  return {
    state: {
      ...state,
      reader: {
        ...reader,
        changeHunkIndex: hunkIndex,
        changeLineIndex: lineIndex,
        changeRangeStartIndex: hunkIndex === reader.changeHunkIndex
          ? reader.changeRangeStartIndex
          : undefined,
      },
      scroll: 0,
    },
    effects: [],
  };
}

function moveQueueSelection(state: TuiState, amount: number): TuiTransition {
  return {
    state: {
      ...state,
      selectedIndex: clamp(
        state.selectedIndex + amount,
        0,
        Math.max(0, state.visibleDocuments.length - 1),
      ),
    },
    effects: [],
  };
}

function selectedOrCurrentDocumentIds(state: TuiState): string[] {
  if (state.selectedDocumentIds.length > 0) {
    const visibleIds = new Set(state.visibleDocuments.map(({ id }) => id));
    return state.selectedDocumentIds.filter((id) => visibleIds.has(id));
  }
  const current = state.visibleDocuments[state.selectedIndex];
  return current ? [current.id] : [];
}

function confirmationMessage(confirmation: TuiConfirmation): string {
  const count = confirmation.documentIds.length;
  if (confirmation.action === "archive") {
    return count === 1
      ? "Archive this document? You can restore it later."
      : `Archive ${count} documents? You can restore them later.`;
  }
  return count === 1
    ? "Purge this document forever? This cannot be undone."
    : `Purge ${count} documents forever? This cannot be undone.`;
}

function clampReaderScroll(state: TuiState, terminalHeight: number): TuiState {
  if (!state.reader) {
    return state;
  }
  const safeHeight = clamp(Math.floor(terminalHeight), 8, 500);
  const bodyHeight = safeHeight - 6;
  const headerLength = state.message ? 4 : 3;
  const available = Math.max(1, bodyHeight - headerLength);
  const contentLines = sanitizeTerminalText(state.reader.content).split("\n").length;
  const warningLines = state.reader.warnings.length > 0
    ? state.reader.warnings.length + 1
    : 0;
  const maximum = Math.max(0, contentLines + warningLines - available);
  return { ...state, scroll: clamp(state.scroll, 0, maximum) };
}

export function groupTuiQueue(
  documents: PublicDocument[],
  grouping: TuiQueueGrouping,
  workspaces: PublicWorkspace[],
): TuiDocumentGroup[] {
  if (grouping === "all") {
    return documents.length === 0 ? [] : [{ key: "all", documents }];
  }

  const groups = new Map<string, TuiDocumentGroup>();
  const add = (key: string, label: string, document: PublicDocument): void => {
    const current = groups.get(key);
    if (current) current.documents.push(document);
    else groups.set(key, { key, label, documents: [document] });
  };
  if (grouping === "project") {
    const workspaceNames = new Map(workspaces.map(({ id, name }) => [id, name]));
    for (const document of documents) {
      const projectId = document.projectId ?? document.workspaceId;
      add(
        `project:${projectId}`,
        document.projectName ??
          workspaceNames.get(document.workspaceId) ??
          document.workspaceId,
        document,
      );
    }
  } else {
    for (const document of documents) {
      const tags = document.tags.length === 0 ? ["untagged"] : document.tags;
      for (const tag of tags) add(`tag:${tag}`, tag, document);
    }
  }
  return [...groups.values()];
}

function applyFilters(state: TuiState): TuiState {
  const terms = state.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filteredDocuments = state.documents.filter((document) => {
    const changeReviews = state.changeReviewsOnly ||
      state.contentMode === "change-reviews";
    if (
      state.contentMode !== "archive" &&
      (!changeReviews && document.kind === "change-review") ||
      state.contentMode !== "archive" &&
        (changeReviews && document.kind !== "change-review")
    ) {
      return false;
    }
    if (
      state.actionsOnly &&
      pendingReviewForDocument(state.reviewRequests, document.id) === undefined
    ) {
      return false;
    }
    if (state.statusFilter !== "all" && document.status !== state.statusFilter) {
      return false;
    }
    if (
      state.workspaceFilter !== undefined &&
      (document.projectId ?? document.workspaceId) !== state.workspaceFilter &&
      document.workspaceId !== state.workspaceFilter
    ) {
      return false;
    }
    const searchable = [
      document.title,
      document.projectName ?? "",
      document.workspaceId,
      document.taskId ?? "",
      document.producer ?? "",
      document.kind,
      document.storage,
      document.attention,
      ...document.tags,
    ].join(" ").toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
  const queueGroups = groupTuiQueue(
    filteredDocuments,
    state.grouping,
    state.workspaces,
  );
  const visibleDocuments = queueGroups.flatMap(({ documents }) => documents);
  return {
    ...state,
    selectedIndex: clamp(
      state.selectedIndex,
      0,
      Math.max(0, visibleDocuments.length - 1),
    ),
    queueGroups,
    visibleDocuments,
  };
}

function pendingReviewForDocument(
  reviewRequests: PublicReviewRequest[],
  documentId: string,
): PublicReviewRequest | undefined {
  return reviewRequests.find(
    (request) =>
      request.documentId === documentId && request.status === "pending",
  );
}

function workspacesForDocuments(
  documents: PublicDocument[],
  workspaces: PublicWorkspace[],
): PublicWorkspace[] {
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  const workspaceNames = new Map(workspaces.map(({ id, name }) => [id, name]));
  for (const document of documents) {
    const projectId = document.projectId ?? document.workspaceId;
    counts.set(
      projectId,
      (counts.get(projectId) ?? 0) + 1,
    );
    labels.set(
      projectId,
      document.projectName ??
        workspaceNames.get(document.workspaceId) ??
        document.workspaceId,
    );
  }
  return [...counts].map(([id, documentCount]) => ({
    id,
    name: labels.get(id) ?? id,
    documentCount,
    route: documents.some(({ projectId }) => projectId === id)
      ? `/p/${id}`
      : `/w/${id}`,
  }));
}

interface TuiBorders {
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  middleLeft: string;
  middleRight: string;
  topLeft: string;
  topRight: string;
  vertical: string;
}

interface TuiTheme {
  accent: ChalkInstance;
  addition: ChalkInstance;
  additionLine: ChalkInstance;
  brand: ChalkInstance;
  color: boolean;
  done: ChalkInstance;
  ink: ChalkInstance;
  line: ChalkInstance;
  muted: ChalkInstance;
  deletion: ChalkInstance;
  deletionLine: ChalkInstance;
  reading: ChalkInstance;
  syntax: Record<WebSyntaxKind, ChalkInstance>;
  styles: ChalkInstance;
}

function createBorders(unicode: boolean): TuiBorders {
  return unicode
    ? {
        bottomLeft: "└",
        bottomRight: "┘",
        horizontal: "─",
        middleLeft: "├",
        middleRight: "┤",
        topLeft: "┌",
        topRight: "┐",
        vertical: "│",
      }
    : {
        bottomLeft: "+",
        bottomRight: "+",
        horizontal: "-",
        middleLeft: "+",
        middleRight: "+",
        topLeft: "+",
        topRight: "+",
        vertical: "|",
      };
}

function createTuiTheme(color: boolean): TuiTheme {
  const styles = new Chalk({ level: color ? 3 : 0 });
  return {
    accent: styles.rgb(255, 119, 88),
    addition: styles.rgb(105, 198, 154),
    additionLine: styles.rgb(246, 241, 229).bgRgb(30, 82, 57),
    brand: styles.rgb(255, 119, 88).bold,
    color,
    done: styles.rgb(105, 198, 154),
    ink: styles,
    line: styles.rgb(143, 181, 175),
    muted: styles.rgb(170, 166, 154),
    deletion: styles.rgb(255, 111, 111),
    deletionLine: styles.rgb(246, 241, 229).bgRgb(92, 38, 42),
    reading: styles.rgb(124, 160, 255),
    syntax: {
      plain: styles,
      comment: styles.rgb(166, 180, 156).italic,
      function: styles.rgb(125, 211, 232),
      keyword: styles.rgb(227, 166, 239).bold,
      literal: styles.rgb(255, 159, 198).bold,
      number: styles.rgb(255, 178, 133),
      operator: styles.rgb(209, 213, 219),
      property: styles.rgb(145, 201, 255),
      string: styles.rgb(255, 209, 138),
      type: styles.rgb(142, 203, 255),
    },
    styles,
  };
}

function renderWorkspaceTitle(
  state: TuiState,
  width: number,
  theme: TuiTheme,
  unicode: boolean,
): string {
  const section = state.mode === "reader"
    ? state.reader?.document.kind === "change-review"
      ? "CHANGE REVIEW"
      : "DOCUMENT READER"
    : state.contentMode === "archive"
      ? "ARCHIVE"
    : state.changeReviewsOnly || state.contentMode === "change-reviews"
      ? "CHANGE REVIEWS"
      : "DOCUMENT INBOX";
  const left = `${theme.brand("mdmaid.desk")} ${theme.muted("/")} ${theme.styles.bold(section)}`;
  const right = theme.done(`${unicode ? "●" : "*"} LIVE`);
  return spread(left, right, width);
}

function renderShortcutBar(
  shortcuts: readonly (readonly [string, string])[],
  theme: TuiTheme,
): string {
  return shortcuts
    .map(([key, action]) => `${theme.accent(theme.styles.bold(key))} ${theme.muted(action)}`)
    .join(theme.muted("   "));
}

function queueLines(
  state: TuiState,
  width: number,
  height: number,
  theme: TuiTheme,
  borders: TuiBorders,
): string[] {
  const showSidebar = width >= 96;
  if (!showSidebar) {
    return queueMainLines(state, width, height, theme, borders);
  }

  const sidebarWidth = 25;
  const mainWidth = width - sidebarWidth - 1;
  const sidebar = sidebarLines(
    state,
    sidebarWidth,
    height,
    theme,
    borders.vertical === "│",
  );
  const main = queueMainLines(state, mainWidth, height, theme, borders);
  return Array.from({ length: height }, (_, index) =>
    `${fitLine(sidebar[index] ?? "", sidebarWidth)}${theme.line(borders.vertical)}${fitLine(main[index] ?? "", mainWidth)}`,
  );
}

function handleQueueMouse(
  state: TuiState,
  event: TuiMouseEvent,
  safeWidth: number,
  safeHeight: number,
): TuiTransition {
  const innerWidth = safeWidth - 2;
  const bodyHeight = safeHeight - 6;
  const bodyIndex = event.y - 4;
  if (bodyIndex < 0 || bodyIndex >= bodyHeight) {
    return { state, effects: [] };
  }

  const showSidebar = innerWidth >= 96;
  const sidebarWidth = showSidebar ? 25 : 0;
  if (
    showSidebar &&
    event.x >= 2 &&
    event.x < 2 + sidebarWidth
  ) {
    if (bodyIndex === 2) {
      return handleQueueKey(state, "p");
    }
    if (bodyIndex === 3) {
      return handleQueueKey(state, "x");
    }
    if (bodyIndex === 4) {
      return handleQueueKey(state, "c");
    }
    const statusIndex = bodyIndex - 8;
    const statuses = ["all", "actions", "unread", "reading", "done"] as const;
    const status = statuses[statusIndex];
    if (status) {
      return {
        state: applyFilters({
          ...state,
          actionsOnly: status === "actions",
          statusFilter: status === "actions" ? "all" : status,
        }),
        effects: [],
      };
    }
    return { state, effects: [] };
  }

  const mainX = showSidebar ? 2 + sidebarWidth + 1 : 2;
  const mainWidth = showSidebar ? innerWidth - sidebarWidth - 1 : innerWidth;
  const relativeX = event.x - mainX;
  let blockLine = bodyIndex - 2;
  if (relativeX < 0 || relativeX >= mainWidth || blockLine < 0) {
    return { state, effects: [] };
  }

  const metrics = queuePageMetrics(state, mainWidth, bodyHeight);
  let block: QueueLayoutBlock | undefined;
  for (let index = metrics.startBlock; index < metrics.blocks.length; index += 1) {
    const candidate = metrics.blocks[index]!;
    if (blockLine < candidate.height) {
      block = candidate;
      break;
    }
    blockLine -= candidate.height;
  }
  if (!block || block.kind !== "cards" || blockLine >= 4) {
    return { state, effects: [] };
  }
  let column = 0;
  if (metrics.columns === 2) {
    if (relativeX === metrics.firstWidth) {
      return { state, effects: [] };
    }
    column = relativeX > metrics.firstWidth ? 1 : 0;
  }
  const documentIndex = block.documentIndices[column];
  if (documentIndex === undefined) {
    return { state, effects: [] };
  }
  const document = state.visibleDocuments[documentIndex];
  if (!document) {
    return { state, effects: [] };
  }
  return {
    state: { ...state, selectedIndex: documentIndex },
    effects: [{ type: "open", documentId: document.id }],
  };
}

function footerKeyAt(state: TuiState, x: number): string | undefined {
  if (state.searching || x < 2) {
    return undefined;
  }
  const shortcuts: Array<readonly [string, string, string | undefined]> =
    state.mode === "reader"
      ? state.reader?.document.missingAt
        ? [
            ["a", "archive", "a"],
            ["X", "purge", "X"],
            ["b", "queue", "b"],
            ["q", "quit", "q"],
          ]
        : state.contentMode === "archive"
          ? [
              ["j/k", "scroll", undefined],
              ["u", "restore", "u"],
              ["X", "purge", "X"],
              ["b", "queue", "b"],
              ["q", "quit", "q"],
            ]
          : [
              ["j/k", "scroll", undefined],
              ["m", "read", "m"],
              ["u", "unread", "u"],
              ["a", "archive", "a"],
              ["X", "purge", "X"],
              ["b", "queue", "b"],
              ["q", "quit", "q"],
            ]
      : [
          ["j/k", "move", undefined],
          ["enter", "open", "enter"],
          ["a", "archive", "a"],
          ["X", "purge", "X"],
          ["space", "select", " "],
          ["A", "all", "A"],
          ["c", "content", "c"],
          ["v", "archive", "v"],
          ["p", "project", "p"],
          ["x", "space", "x"],
          ["/", "search", "/"],
          ["q", "quit", "q"],
        ];
  let cursor = 2;
  for (const [label, action, key] of shortcuts) {
    const end = cursor + stringWidth(`${label} ${action}`);
    if (x >= cursor && x < end) {
      return key;
    }
    cursor = end + 3;
  }
  return undefined;
}

function sidebarLines(
  state: TuiState,
  width: number,
  height: number,
  theme: TuiTheme,
  unicode: boolean,
): string[] {
  const selectedProjectName = state.workspaceFilter === undefined
    ? "All projects"
    : state.workspaces.find(({ id }) => id === state.workspaceFilter)?.name ??
      state.workspaceFilter;
  const selectedSpaceName = state.selectedSpace === undefined
    ? "All spaces"
    : state.spaces.find(({ id }) => id === state.selectedSpace)?.name ??
      state.selectedSpace;
  const contentName = state.changeReviewsOnly || state.contentMode === "change-reviews"
    ? "Change reviews"
    : "Documents";
  const lines: string[] = [
    theme.accent(theme.styles.bold(" FILTERS")),
    "",
    navigationLine(
      "Project",
      selectedProjectName,
      true,
      width,
      theme,
      unicode,
    ),
    navigationLine(
      "Space",
      selectedSpaceName,
      true,
      width,
      theme,
      unicode,
    ),
    navigationLine(
      "Content",
      contentName,
      true,
      width,
      theme,
      unicode,
    ),
    "",
    theme.accent(theme.styles.bold(" STATUS")),
    "",
  ];
  const contextDocuments = state.documents.filter((document) => {
    const changeReviews = state.changeReviewsOnly || state.contentMode === "change-reviews";
    if (changeReviews !== (document.kind === "change-review")) return false;
    return state.workspaceFilter === undefined ||
      (document.projectId ?? document.workspaceId) === state.workspaceFilter ||
      document.workspaceId === state.workspaceFilter;
  });
  const pendingCount = contextDocuments.filter((document) =>
    pendingReviewForDocument(state.reviewRequests, document.id) !== undefined
  ).length;
  const counts: Record<StatusFilter, number> = {
    all: contextDocuments.length,
    unread: contextDocuments.filter(({ status }) => status === "unread").length,
    reading: contextDocuments.filter(({ status }) => status === "reading").length,
    done: contextDocuments.filter(({ status }) => status === "done").length,
  };
  lines.push(
    navigationLine(
      "All",
      counts.all,
      !state.actionsOnly && state.statusFilter === "all",
      width,
      theme,
      unicode,
    ),
    navigationLine(
      "Waiting for you",
      pendingCount,
      state.actionsOnly,
      width,
      theme,
      unicode,
    ),
  );
  const labels: Record<StatusFilter, string> = {
    all: "All",
    unread: "New",
    reading: "Reading",
    done: "Done",
  };
  for (const status of ["unread", "reading", "done"] as const) {
    lines.push(
      navigationLine(
        labels[status],
        counts[status],
        !state.actionsOnly && state.statusFilter === status,
        width,
        theme,
        unicode,
        status,
      ),
    );
  }
  return lines.slice(0, height);
}

function navigationLine(
  label: string,
  count: number | string,
  selected: boolean,
  width: number,
  theme: TuiTheme,
  unicode: boolean,
  status?: ReadingStatus,
): string {
  const marker = selected ? (unicode ? "●" : "*") : " ";
  const markerStyle = status ? statusStyle(theme, status) : theme.accent;
  const safeLabel = sanitizeTerminalText(label).replace(/\s+/g, " ");
  const text = selected ? theme.styles.bold(safeLabel) : theme.muted(safeLabel);
  return spread(` ${markerStyle(marker)} ${text}`, theme.muted(String(count)), width - 1);
}

interface QueueLayoutBlock {
  kind: "heading" | "cards";
  label?: string;
  documentIndices: number[];
  height: number;
}

interface QueuePageMetrics {
  columns: 1 | 2;
  firstWidth: number;
  blocks: QueueLayoutBlock[];
  startBlock: number;
}

function queuePageMetrics(
  state: TuiState,
  width: number,
  height: number,
): QueuePageMetrics {
  const columns = width >= 84 ? 2 : 1;
  const gap = columns === 2 ? 1 : 0;
  const firstWidth = columns === 2 ? Math.floor((width - gap) / 2) : width;
  const blocks: QueueLayoutBlock[] = [];
  let documentIndex = 0;
  for (const group of state.queueGroups) {
    if (group.label && width >= 84) {
      blocks.push({
        kind: "heading",
        label: group.label,
        documentIndices: [],
        height: 2,
      });
    }
    for (let index = 0; index < group.documents.length; index += columns) {
      const count = Math.min(columns, group.documents.length - index);
      blocks.push({
        kind: "cards",
        documentIndices: Array.from(
          { length: count },
          (_, column) => documentIndex + index + column,
        ),
        height: 5,
      });
    }
    documentIndex += group.documents.length;
  }
  const selectedBlock = Math.max(
    0,
    blocks.findIndex(({ documentIndices }) =>
      documentIndices.includes(state.selectedIndex)
    ),
  );
  const availableHeight = Math.max(1, height - 2);
  let startBlock = selectedBlock;
  let heightBeforeSelection = 0;
  while (
    startBlock > 0 &&
    heightBeforeSelection + (blocks[startBlock - 1]?.height ?? 0) <=
      Math.floor(availableHeight / 2)
  ) {
    startBlock -= 1;
    heightBeforeSelection += blocks[startBlock]?.height ?? 0;
  }
  return { columns, firstWidth, blocks, startBlock };
}

function queueMainLines(
  state: TuiState,
  width: number,
  height: number,
  theme: TuiTheme,
  borders: TuiBorders,
): string[] {
  const count = new Set(state.visibleDocuments.map(({ id }) => id)).size;
  const project = state.workspaceFilter
    ? state.workspaces.find(({ id }) => id === state.workspaceFilter)?.name ?? state.workspaceFilter
    : "All projects";
  const filter = state.actionsOnly
    ? "Waiting for you"
    : state.statusFilter === "all"
      ? "All statuses"
      : statusLabel(state.statusFilter);
  const selectedSpace = state.selectedSpace === undefined
    ? "All spaces"
    : state.spaces.find(({ id }) => id === state.selectedSpace)?.name ??
      state.selectedSpace;
  const space = state.contentMode === "archive"
    ? "Archive · v Documents"
    : state.changeReviewsOnly || state.contentMode === "change-reviews"
    ? "Change reviews"
    : "Documents · c Change reviews";
  const groupLabel = state.grouping === "all"
    ? "ordered"
    : `grouped by ${state.grouping}`;
  const baseView = `${project} · ${selectedSpace} · ${space} · ${filter} · ${groupLabel}`;
  const view = state.search ? `${baseView} · “${state.search}”` : baseView;
  const lines = [
    spread(
      theme.styles.bold(
        state.contentMode === "archive"
          ? `${count} archived ${count === 1 ? "document" : "documents"}`
        : state.changeReviewsOnly || state.contentMode === "change-reviews"
          ? `${count} ${count === 1 ? "change review" : "change reviews"}`
          : `${count} ${count === 1 ? "document" : "documents"}`,
      ),
      theme.muted(view),
      width,
    ),
    state.message ? theme.accent(`! ${sanitizeTerminalText(state.message)}`) : "",
  ];
  if (count === 0) {
    lines.push("", theme.muted("No documents match this view."));
    return lines;
  }

  const metrics = queuePageMetrics(state, width, height);
  const { columns, firstWidth, blocks, startBlock } = metrics;
  const gap = columns === 2 ? 1 : 0;
  const secondWidth = width - firstWidth - gap;
  for (let blockIndex = startBlock; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex]!;
    if (lines.length + block.height > height) break;
    if (block.kind === "heading") {
      const prefix = state.grouping === "project" ? "PROJECT" : "TAG";
      lines.push(
        theme.accent(theme.styles.bold(` ${prefix} · ${sanitizeTerminalText(block.label ?? "")}`)),
        "",
      );
      continue;
    }
    const firstIndex = block.documentIndices[0]!;
    const first = renderDocumentCard(
      state.visibleDocuments[firstIndex]!,
      firstWidth,
      firstIndex === state.selectedIndex,
      pendingReviewForDocument(
        state.reviewRequests,
        state.visibleDocuments[firstIndex]!.id,
      ) !== undefined,
      state.selectedDocumentIds.includes(state.visibleDocuments[firstIndex]!.id),
      theme,
      borders,
    );
    const secondIndex = block.documentIndices[1];
    const secondDocument = secondIndex === undefined
      ? undefined
      : state.visibleDocuments[secondIndex];
    const second = secondDocument
      ? renderDocumentCard(
          secondDocument,
          secondWidth,
          secondIndex === state.selectedIndex,
          pendingReviewForDocument(state.reviewRequests, secondDocument.id) !==
            undefined,
          state.selectedDocumentIds.includes(secondDocument.id),
          theme,
          borders,
        )
      : Array.from({ length: first.length }, () => " ".repeat(secondWidth));
    for (let line = 0; line < first.length; line += 1) {
      lines.push(
        columns === 2
          ? `${first[line] ?? ""}${" ".repeat(gap)}${second[line] ?? ""}`
          : first[line] ?? "",
      );
    }
    lines.push("");
  }
  return lines.slice(0, height);
}

function renderDocumentCard(
  document: PublicDocument,
  width: number,
  selected: boolean,
  actionRequired: boolean,
  batchSelected: boolean,
  theme: TuiTheme,
  borders: TuiBorders,
): string[] {
  const borderStyle = selected ? theme.accent : theme.line;
  const status = statusStyle(theme, document.status);
  const label = document.missingAt
    ? theme.accent("! SOURCE MISSING")
    : status(
        `${statusSymbol(document.status, borders.vertical === "│")} ${statusLabel(document.status).toUpperCase()}`,
      );
  const topPrefix = `${borderStyle(`${borders.topLeft}${borders.horizontal}`)} ${label} `;
  const topFill = Math.max(0, width - stringWidth(topPrefix) - 1);
  const top = `${topPrefix}${borderStyle(`${borders.horizontal.repeat(topFill)}${borders.topRight}`)}`;
  const marker = `${selected ? theme.accent("›") : " "}${batchSelected ? theme.accent("✓") : " "}`;
  const title = selected
    ? theme.styles.bold(sanitizeTerminalText(document.title))
    : theme.ink(sanitizeTerminalText(document.title));
  const meta = [
    document.workspaceId,
    document.kind,
    documentStorageLabel(document.storage),
    document.taskId,
    actionRequired ? "ACTION REQUIRED" : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => sanitizeTerminalText(value))
    .join(" · ");
  const bodyWidth = Math.max(0, width - 2);
  const left = status(borders.vertical);
  const right = borderStyle(borders.vertical);
  const titleLine = `${left}${fitLine(`${marker}${title}`, bodyWidth)}${right}`;
  const metaLine = `${left}${fitLine(`  ${theme.muted(meta)}`, bodyWidth)}${right}`;
  const bottom = borderStyle(
    `${borders.bottomLeft}${borders.horizontal.repeat(Math.max(0, width - 2))}${borders.bottomRight}`,
  );
  return [top, titleLine, metaLine, bottom].map((line) => fitLine(line, width));
}

function readerLines(
  state: TuiState,
  width: number,
  height: number,
  theme: TuiTheme,
  borders: TuiBorders,
): string[] {
  if (!state.reader) {
    return [theme.muted("Document is not loaded.")];
  }
  const { document } = state.reader;
  const title = sanitizeTerminalText(document.title).replace(/\s+/g, " ");
  const pill = document.missingAt
    ? theme.accent("! SOURCE MISSING")
    : statusStyle(theme, document.status)(
        `${statusSymbol(document.status, borders.vertical === "│")} ${statusLabel(document.status).toUpperCase()}`,
      );
  const meta = [
    document.workspaceId,
    document.taskId,
    document.kind,
    documentStorageLabel(document.storage),
    state.reader.backend,
  ].filter((value): value is string => Boolean(value)).join(" · ");
  const heading = spread(
    `${pill}  ${theme.styles.bold(title)}`,
    theme.muted(`revision ${document.revision}`),
    width,
  );
  if (
    state.reader.changeView === "diff" &&
    state.reader.changeReview &&
    state.reader.changeReview.files.length > 0
  ) {
    return changeReviewReaderLines(
      state,
      width,
      height,
      theme,
      borders,
      heading,
      meta,
    );
  }
  const warningLines = state.reader.warnings.map((warning) =>
    theme.accent(`warning: ${sanitizeTerminalText(warning)}`),
  );
  const content = sanitizeTerminalText(state.reader.content, {
    preserveSgr: theme.color,
  }).split("\n");
  const requests = state.reviewRequests.filter(
    (request) => request.documentId === document.id,
  );
  const review =
    pendingReviewForDocument(requests, document.id) ?? requests[0];
  const reviewLines = review
    ? [
        theme.accent(
          theme.styles.bold(
            review.status === "pending" ? "ACTION REQUIRED" : "REVIEW HISTORY",
          ),
        ),
        ...sanitizeTerminalText(review.requestMessage).split("\n"),
        theme.muted(
          review.response
            ? `${review.status.replaceAll("_", " ")} — ${sanitizeTerminalText(review.response.message)}`
            : "waiting for your decision",
        ),
        "",
      ]
    : [];
  const selectedSourceLine = state.reader.sourceMap?.logicalLines[state.reader.sourceLineIndex];
  const showFeedbackDraft = Boolean(
    state.reader.sourceMap ||
      state.reader.feedbackGeneralMessage !== "" ||
      state.reader.markdownFeedbackItems.length > 0 ||
      state.reader.feedbackHistory.length > 0,
  );
  const feedbackLines = showFeedbackDraft ? [
    theme.accent(theme.styles.bold("FEEDBACK DRAFT")),
    theme.muted(selectedSourceLine
      ? `selected source row ${selectedSourceLine.sourceStart.line}: ${sanitizeTerminalText(selectedSourceLine.text.slice(0, 100))}`
      : "no commentable source row"),
    ...(state.reader.feedbackGeneralMessage === ""
      ? []
      : [`general · ${sanitizeTerminalText(state.reader.feedbackGeneralMessage)}`]),
    ...state.reader.markdownFeedbackItems.map((item) =>
      `[ ] ${item.intent} · ${sanitizeTerminalText(item.message)}`
    ),
    ...state.reader.feedbackHistory.flatMap((submission) => [
      `saved · ${submission.id} · revision ${submission.documentRevision}${submission.documentRevision === state.reader!.document.revision ? " · current" : " · historical"} · ${submission.comments.length} comment${submission.comments.length === 1 ? "" : "s"}`,
      ...(submission.generalMessage === undefined
        ? []
        : [`  general · ${sanitizeTerminalText(submission.generalMessage)}`]),
      ...submission.comments.map((comment) =>
        `  ${comment.intent} · ${sanitizeTerminalText(comment.message)} — ${sanitizeTerminalText(tuiStoredFeedbackAnchorLabel(comment))}`
      ),
    ]),
    theme.muted("[/] select source row · f comment · g general feedback · s send"),
    "",
  ] : [];
  const annotationLines = state.annotationComposer
    ? [
        theme.accent(`${state.annotationComposer.kind.toUpperCase()} · ${sanitizeTerminalText(state.annotationComposer.label ?? "selected source row")}`),
        ...sanitizeTerminalText(state.annotationComposer.message || "_").split("\n"),
        theme.muted("ctrl-d save comment · esc cancel"),
        "",
      ]
    : [];
  const feedbackComposerLines = state.feedbackComposer
    ? [
        theme.accent("GENERAL FEEDBACK"),
        ...sanitizeTerminalText(state.feedbackComposer.message || "_").split("\n"),
        theme.muted("ctrl-d save draft · esc cancel"),
        "",
      ]
    : [];
  const composerLines = state.reviewComposer
    ? [
        theme.accent(
          `RESPONSE · ${state.reviewComposer.outcome.replaceAll("_", " ")}`,
        ),
        ...sanitizeTerminalText(state.reviewComposer.message || "_").split("\n"),
        theme.muted("enter newline · ctrl-d submit · esc cancel"),
        "",
      ]
    : [];
  const all = [
    ...(warningLines.length > 0 ? [...warningLines, ""] : []),
    ...content,
    ...(feedbackLines.length === 0 ? [] : ["", ...feedbackLines]),
    ...(reviewLines.length > 0 ? ["", ...reviewLines] : []),
    ...annotationLines,
    ...feedbackComposerLines,
    ...composerLines,
  ];
  const headerLength = state.message ? 4 : 3;
  const available = Math.max(1, height - headerLength);
  const maxScroll = Math.max(0, all.length - available);
  const scroll = clamp(state.scroll, 0, maxScroll);
  const visible = all.slice(scroll, scroll + available);
  const progress = `${scroll + 1}-${Math.min(all.length, scroll + available)} / ${all.length}`;
  const header = [
    heading,
    spread(
      theme.muted(sanitizeTerminalText(meta)),
      theme.muted(progress),
      width,
    ),
  ];
  if (state.message) {
    header.push(theme.accent(`! ${sanitizeTerminalText(state.message)}`));
  }
  header.push("");
  return [
    ...header,
    ...visible.map((line) => fitLine(line, width)),
  ].slice(0, height);
}

function changeReviewReaderLines(
  state: TuiState,
  width: number,
  height: number,
  theme: TuiTheme,
  borders: TuiBorders,
  heading: string,
  meta: string,
): string[] {
  const reader = state.reader;
  const review = reader?.changeReview;
  if (!reader || !review || review.files.length === 0) {
    return [theme.muted("No native diff is available.")];
  }
  const fileIndex = clamp(reader.changeFileIndex, 0, review.files.length - 1);
  const file = review.files[fileIndex]!;
  const hunkIndex = clamp(reader.changeHunkIndex, 0, Math.max(0, file.hunks.length - 1));
  const hunkLabel = `${file.hunks.length} ${file.hunks.length === 1 ? "hunk" : "hunks"}`;
  const header = [
    heading,
    spread(
      theme.muted(sanitizeTerminalText(meta)),
      theme.muted(
        `${reader.changeLayout.toUpperCase()} · file ${fileIndex + 1}/${review.files.length} · ${hunkLabel}`,
      ),
      width,
    ),
    ...(state.message ? [theme.accent(`! ${sanitizeTerminalText(state.message)}`)] : []),
    "",
  ];
  const warnings = [...reader.warnings, ...review.warnings];
  const showFiles = width >= 96;
  const diffWidth = showFiles ? width - 29 : width;
  const inlineFeedback = allReviewFeedbackItems(state);
  const renderedHunks = file.hunks.flatMap((hunk, index) => [
    theme.muted(sanitizeTerminalText(hunk.header)),
    "",
    ...(reader.changeLayout === "side-by-side"
      ? renderSideBySideHunk(
          hunk,
          diffWidth,
          theme,
          borders,
          file.path,
          index === hunkIndex ? reader.changeLineIndex : -1,
          index === hunkIndex ? reader.changeRangeStartIndex : undefined,
          inlineFeedback,
        )
      : renderUnifiedHunk(
          hunk,
          diffWidth,
          theme,
          file.path,
          index === hunkIndex ? reader.changeLineIndex : -1,
          index === hunkIndex ? reader.changeRangeStartIndex : undefined,
          inlineFeedback,
        )),
    ...(index === file.hunks.length - 1 ? [] : [""]),
  ]);
  const body: string[] = [
    ...(warnings.map((warning) => theme.accent(`warning: ${sanitizeTerminalText(warning)}`))),
    ...(warnings.length > 0 ? [""] : []),
    theme.styles.bold(`${changeStatusSymbol(file.status)} ${sanitizeTerminalText(file.path)}`),
    ...(file.previousPath
      ? [theme.muted(`renamed from ${sanitizeTerminalText(file.previousPath)}`)]
      : []),
    ...(renderedHunks.length > 0
      ? renderedHunks
      : [theme.muted("No text hunks."), ""]),
    ...reviewFeedbackLines(state, file, theme),
  ];
  const available = Math.max(1, height - header.length);
  const maxScroll = Math.max(0, body.length - available);
  const scroll = clamp(state.scroll, 0, maxScroll);
  const main = body.slice(scroll, scroll + available);
  if (!showFiles) {
    return [...header, ...main.map((line) => fitLine(line, width))].slice(0, height);
  }
  const sidebarWidth = 28;
  const mainWidth = width - sidebarWidth - 1;
  const sidebar = changeFileLines(review.files, fileIndex, sidebarWidth, theme);
  const rows = Array.from({ length: available }, (_, index) =>
    `${fitLine(sidebar[index] ?? "", sidebarWidth)}${theme.line(borders.vertical)}${fitLine(main[index] ?? "", mainWidth)}`,
  );
  return [...header, ...rows].slice(0, height);
}

function changeFileLines(
  files: ChangeReviewFile[],
  selectedIndex: number,
  width: number,
  theme: TuiTheme,
): string[] {
  const lines = [theme.accent(theme.styles.bold(" FILES")), ""];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    const prefix = index === selectedIndex ? "›" : " ";
    const value = `${prefix} ${changeStatusSymbol(file.status)} ${sanitizeTerminalText(file.path)}`;
    lines.push(index === selectedIndex ? theme.styles.bold(value) : theme.muted(value));
  }
  lines.push("", theme.muted("p / n file · j / k line"));
  return lines.map((line) => fitLine(line, width));
}

function terminalDiffText(
  path: string,
  source: string,
  theme: TuiTheme,
  changedStart = -1,
  changedEnd = -1,
): string {
  let offset = 0;
  let output = "";
  for (const token of highlightDiffLine(path, source)) {
    const boundaries = [0, token.text.length];
    for (const boundary of [changedStart - offset, changedEnd - offset]) {
      if (boundary > 0 && boundary < token.text.length) boundaries.push(boundary);
    }
    boundaries.sort((left, right) => left - right);
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const start = boundaries[index] ?? 0;
      const end = boundaries[index + 1] ?? token.text.length;
      const text = token.text.slice(start, end);
      const styled = theme.syntax[token.kind](text);
      const absoluteStart = offset + start;
      output += changedStart < changedEnd &&
          absoluteStart >= changedStart && absoluteStart < changedEnd
        ? theme.styles.bold.underline(styled)
        : styled;
    }
    offset += token.text.length;
  }
  return output;
}

function renderUnifiedHunk(
  hunk: ChangeReviewHunk,
  width: number,
  theme: TuiTheme,
  path: string,
  selectedIndex: number,
  rangeStartIndex: number | undefined,
  feedbackItems: readonly ReviewFeedbackItem[],
): string[] {
  const lines: string[] = [];
  for (let index = 0; index < hunk.lines.length; index += 1) {
    const line = hunk.lines[index]!;
    const next = hunk.lines[index + 1];
    if (line.kind === "deletion" && next?.kind === "addition") {
      const oldText = sanitizeTerminalText(line.text);
      const newText = sanitizeTerminalText(next.text);
      const changed = changedSegments(oldText, newText);
      lines.push(formatUnifiedLine(
        line,
        terminalDiffText(
          path,
          oldText,
          theme,
          changed.prefix.length,
          changed.prefix.length + changed.oldChanged.length,
        ),
        width,
        theme,
        isSelectedChangeLine(index, selectedIndex, rangeStartIndex),
      ));
      lines.push(...terminalInlineFeedbackLines(
        feedbackItems, path, hunk.id, line, width, theme,
      ));
      lines.push(formatUnifiedLine(
        next,
        terminalDiffText(
          path,
          newText,
          theme,
          changed.prefix.length,
          changed.prefix.length + changed.newChanged.length,
        ),
        width,
        theme,
        isSelectedChangeLine(index + 1, selectedIndex, rangeStartIndex),
      ));
      lines.push(...terminalInlineFeedbackLines(
        feedbackItems, path, hunk.id, next, width, theme,
      ));
      index += 1;
      continue;
    }
    lines.push(formatUnifiedLine(
      line,
      terminalDiffText(path, sanitizeTerminalText(line.text), theme),
      width,
      theme,
      isSelectedChangeLine(index, selectedIndex, rangeStartIndex),
    ));
    lines.push(...terminalInlineFeedbackLines(
      feedbackItems, path, hunk.id, line, width, theme,
    ));
  }
  return lines;
}

function formatUnifiedLine(
  line: ChangeReviewLine,
  text: string,
  width: number,
  theme: TuiTheme,
  selected: boolean,
): string {
  const prefix = `${displayLineNumber(line.oldLine)} ${displayLineNumber(line.newLine)} ${changeLineMarker(line.kind)} `;
  if (line.kind === "addition") {
    const value = theme.additionLine(fitLine(`${prefix}${text}`, width));
    return selected ? theme.styles.underline(value) : value;
  }
  if (line.kind === "deletion") {
    const value = theme.deletionLine(fitLine(`${prefix}${text}`, width));
    return selected ? theme.styles.underline(value) : value;
  }
  const value = theme.muted(`${prefix}${text}`);
  return selected ? theme.styles.underline(value) : value;
}

function renderSideBySideHunk(
  hunk: ChangeReviewHunk,
  width: number,
  theme: TuiTheme,
  borders: TuiBorders,
  path: string,
  selectedIndex: number,
  rangeStartIndex: number | undefined,
  feedbackItems: readonly ReviewFeedbackItem[],
): string[] {
  const leftWidth = Math.max(12, Math.floor((width - 1) / 2));
  const rightWidth = Math.max(12, width - leftWidth - 1);
  const lines = [
    `${fitLine(theme.deletion(theme.styles.bold("OLD")), leftWidth)}${theme.line(borders.vertical)}${fitLine(theme.addition(theme.styles.bold("NEW")), rightWidth)}`,
  ];
  for (let index = 0; index < hunk.lines.length; index += 1) {
    const line = hunk.lines[index]!;
    const next = hunk.lines[index + 1];
    let left: ChangeReviewLine | undefined;
    let right: ChangeReviewLine | undefined;
    let leftText = "";
    let rightText = "";
    if (line.kind === "context") {
      left = line;
      right = line;
      leftText = terminalDiffText(path, sanitizeTerminalText(line.text), theme);
      rightText = leftText;
    } else if (line.kind === "deletion" && next?.kind === "addition") {
      const oldText = sanitizeTerminalText(line.text);
      const newText = sanitizeTerminalText(next.text);
      const changed = changedSegments(oldText, newText);
      left = line;
      right = next;
      leftText = terminalDiffText(
        path,
        oldText,
        theme,
        changed.prefix.length,
        changed.prefix.length + changed.oldChanged.length,
      );
      rightText = terminalDiffText(
        path,
        newText,
        theme,
        changed.prefix.length,
        changed.prefix.length + changed.newChanged.length,
      );
      index += 1;
    } else if (line.kind === "deletion") {
      left = line;
      leftText = terminalDiffText(path, sanitizeTerminalText(line.text), theme);
    } else {
      right = line;
      rightText = terminalDiffText(path, sanitizeTerminalText(line.text), theme);
    }
    const leftValue = formatSideBySideCell(
      left,
      leftText,
      leftWidth,
      theme,
      left !== undefined && isSelectedChangeLine(
        hunk.lines.indexOf(left), selectedIndex, rangeStartIndex,
      ),
    );
    const rightValue = formatSideBySideCell(
      right,
      rightText,
      rightWidth,
      theme,
      right !== undefined && isSelectedChangeLine(
        hunk.lines.indexOf(right), selectedIndex, rangeStartIndex,
      ),
    );
    lines.push(
      `${fitLine(leftValue, leftWidth)}${theme.line(borders.vertical)}${fitLine(rightValue, rightWidth)}`,
    );
    if (left) {
      lines.push(...terminalInlineFeedbackLines(
        feedbackItems, path, hunk.id, left, width, theme,
      ));
    }
    if (right && right !== left) {
      lines.push(...terminalInlineFeedbackLines(
        feedbackItems, path, hunk.id, right, width, theme,
      ));
    }
  }
  return lines;
}

function formatSideBySideCell(
  line: ChangeReviewLine | undefined,
  text: string,
  width: number,
  theme: TuiTheme,
  selected: boolean,
): string {
  if (!line) {
    return fitLine("", width);
  }
  const value = fitLine(
    `${displayLineNumber(line.kind === "addition" ? line.newLine : line.oldLine)} ${text}`,
    width,
  );
  if (line.kind === "addition") {
    const styled = theme.additionLine(value);
    return selected ? theme.styles.underline(styled) : styled;
  }
  if (line.kind === "deletion") {
    const styled = theme.deletionLine(value);
    return selected ? theme.styles.underline(styled) : styled;
  }
  const styled = theme.muted(value);
  return selected ? theme.styles.underline(styled) : styled;
}

function isSelectedChangeLine(
  index: number,
  selectedIndex: number,
  rangeStartIndex: number | undefined,
): boolean {
  return index >= Math.min(rangeStartIndex ?? selectedIndex, selectedIndex) &&
    index <= Math.max(rangeStartIndex ?? selectedIndex, selectedIndex);
}

function changeLineAnchor(
  line: ChangeReviewLine,
): { line: number | null; side: "old" | "new" } {
  return line.kind === "deletion"
    ? { line: line.oldLine, side: "old" }
    : { line: line.newLine, side: "new" };
}

function terminalInlineFeedbackLines(
  items: readonly ReviewFeedbackItem[],
  path: string,
  hunkId: string,
  line: ChangeReviewLine,
  width: number,
  theme: TuiTheme,
): string[] {
  const matches = [
    ...(line.oldLine === null
      ? []
      : feedbackEndingAtLine(items, {
          path, hunkId, line: line.oldLine, side: "old",
        })),
    ...(line.newLine === null
      ? []
      : feedbackEndingAtLine(items, {
          path, hunkId, line: line.newLine, side: "new",
        })),
  ].filter(
    (item, index, candidates) =>
      candidates.findIndex((candidate) => candidate.id === item.id) === index,
  );
  const rendered: string[] = [];
  for (const item of matches) {
    const messageLines = sanitizeTerminalText(item.message).split("\n");
    const first = messageLines.shift() ?? "";
    rendered.push(theme.accent(fitLine(
      `└─ COMMENT ${feedbackAnchorLabel(item)} · ${first}`,
      width,
    )));
    for (const continuation of messageLines) {
      rendered.push(theme.accent(fitLine(`   ${continuation}`, width)));
    }
  }
  return rendered;
}

function allReviewFeedbackItems(state: TuiState): ReviewFeedbackItem[] {
  const reader = state.reader;
  if (!reader) return [];
  const requests = state.reviewRequests.filter(
    (request) => request.documentId === reader.document.id,
  );
  const request = pendingReviewForDocument(requests, reader.document.id) ?? requests[0];
  const persisted = reader.feedbackHistory.length > 0
    ? tuiStoredDiffFeedback(
        reader.feedbackHistory.filter(
          ({ documentRevision }) => documentRevision === reader.document.revision,
        ),
      )
    : request?.response?.items ?? [];
  return [...persisted, ...reader.feedbackItems];
}

function tuiStoredDiffFeedback(
  submissions: readonly PublicFeedbackSubmission[],
): ReviewFeedbackItem[] {
  return submissions.flatMap((submission) => submission.comments.flatMap((comment) => {
    const anchor = comment.anchor;
    if (anchor.kind === "markdown-v1") return [];
    return [{
      id: comment.id.replace(/^comment-/, "feedback-"),
      kind: comment.intent,
      path: anchor.path,
      ...(anchor.kind === "diff-file-v1"
        ? {}
        : {
            hunkId: anchor.hunkId,
            side: anchor.side,
            line: anchor.line,
            ...(anchor.endLine === undefined ? {} : { endLine: anchor.endLine }),
          }),
      message: comment.message,
    }];
  }));
}

function tuiStoredFeedbackAnchorLabel(
  comment: PublicFeedbackSubmission["comments"][number],
): string {
  const anchor = comment.anchor;
  if (anchor.kind === "markdown-v1") {
    return anchor.start.line === anchor.end.line
      ? `document line ${anchor.start.line}`
      : `document lines ${anchor.start.line}-${anchor.end.line}`;
  }
  if (anchor.kind === "diff-file-v1") return anchor.path;
  return anchor.endLine === undefined
    ? `${anchor.path}:${anchor.line} (${anchor.side})`
    : `${anchor.path}:${anchor.line}-${anchor.endLine} (${anchor.side})`;
}

function reviewFeedbackLines(
  state: TuiState,
  file: ChangeReviewFile,
  theme: TuiTheme,
): string[] {
  const reader = state.reader;
  if (!reader) {
    return [];
  }
  const requests = state.reviewRequests.filter(
    (request) => request.documentId === reader.document.id,
  );
  const request = pendingReviewForDocument(requests, reader.document.id) ?? requests[0];
  const persisted = reader.feedbackHistory.length > 0
    ? tuiStoredDiffFeedback(
        reader.feedbackHistory.filter(
          ({ documentRevision }) => documentRevision === reader.document.revision,
        ),
      )
    : request?.response?.items ?? [];
  const lines: string[] = [""];
  if (
    persisted.length > 0 ||
    reader.feedbackItems.length > 0 ||
    reader.markdownFeedbackItems.length > 0 ||
    reader.feedbackGeneralMessage !== ""
  ) {
    lines.push(theme.accent(theme.styles.bold("FEEDBACK")));
    for (const item of persisted) {
      const anchor = feedbackAnchorLabel(item);
      lines.push(`- ${item.kind} · ${sanitizeTerminalText(item.message)} — ${sanitizeTerminalText(anchor)}`);
    }
    for (const item of reader.feedbackItems) {
      const anchor = feedbackAnchorLabel(item);
      lines.push(`[ ] ${item.kind} · ${sanitizeTerminalText(item.message)} — ${sanitizeTerminalText(anchor)}`);
    }
    if (reader.feedbackGeneralMessage !== "") {
      lines.push(`[ ] general · ${sanitizeTerminalText(reader.feedbackGeneralMessage)}`);
    }
    for (const item of reader.markdownFeedbackItems) {
      lines.push(`[ ] ${item.intent} · ${sanitizeTerminalText(item.message)} — document text`);
    }
    lines.push("");
  }
  if (request) {
    lines.push(
      theme.accent(theme.styles.bold(
        request.status === "pending" ? "ACTION REQUIRED" : "REVIEW HISTORY",
      )),
      ...sanitizeTerminalText(request.requestMessage).split("\n"),
      theme.muted(
        request.response
          ? request.status.replaceAll("_", " ")
          : "waiting for your decision",
      ),
      "",
    );
  }
  if (state.annotationComposer) {
    const anchor = state.annotationComposer.label ??
      (state.annotationComposer.path
        ? feedbackAnchorLabel({
            ...state.annotationComposer,
            path: state.annotationComposer.path,
          })
        : "selected document text");
    lines.push(
      theme.accent(`${state.annotationComposer.kind.toUpperCase()} · ${sanitizeTerminalText(anchor)}`),
      ...sanitizeTerminalText(state.annotationComposer.message || "_").split("\n"),
      theme.muted("ctrl-d save note · esc cancel"),
      "",
    );
  }
  if (state.feedbackComposer) {
    lines.push(
      theme.accent("GENERAL FEEDBACK"),
      ...sanitizeTerminalText(state.feedbackComposer.message || "_").split("\n"),
      theme.muted("ctrl-d save draft · esc cancel"),
      "",
    );
  }
  if (state.reviewComposer) {
    lines.push(
      theme.accent(
        state.reviewComposer.outcome === "changes_requested"
          ? "GENERAL NOTE · REQUEST CHANGES"
          : `RESPONSE · ${state.reviewComposer.outcome.replaceAll("_", " ")}`,
      ),
      ...sanitizeTerminalText(state.reviewComposer.message || "_").split("\n"),
      theme.muted("ctrl-d submit · esc cancel"),
      "",
    );
  }
  if (!state.annotationComposer && !state.feedbackComposer && !state.reviewComposer) {
    lines.push(theme.muted(
      `j/k select line · v mark range · f line/range comment · t file comment for ${file.path} · g general feedback · s send · z undo`,
    ));
  }
  return lines;
}

function displayLineNumber(value: number | null): string {
  return value === null ? "    " : String(value).padStart(4, " ");
}

function changeLineMarker(kind: ChangeReviewLine["kind"]): string {
  return kind === "addition" ? "+" : kind === "deletion" ? "-" : " ";
}

function changeStatusSymbol(status: ChangeReviewFile["status"]): string {
  return status === "added" ? "A" : status === "deleted" ? "D" : status === "renamed" ? "R" : "M";
}

function statusStyle(theme: TuiTheme, status: ReadingStatus): ChalkInstance {
  if (status === "reading") {
    return theme.reading;
  }
  if (status === "done") {
    return theme.done;
  }
  return theme.accent;
}

function statusLabel(status: ReadingStatus): string {
  if (status === "unread") {
    return "New";
  }
  if (status === "reading") {
    return "Reading";
  }
  return "Done";
}

function statusSymbol(status: ReadingStatus, unicode: boolean): string {
  if (!unicode) {
    if (status === "reading") {
      return ">";
    }
    if (status === "done") {
      return "x";
    }
    return "*";
  }
  if (status === "reading") {
    return "◐";
  }
  if (status === "done") {
    return "✓";
  }
  return "●";
}

function boxLine(
  value: string,
  width: number,
  borders: TuiBorders,
  theme: TuiTheme,
): string {
  return `${theme.line(borders.vertical)}${fitLine(value, width)}${theme.line(borders.vertical)}`;
}

function fitLine(value: string, width: number): string {
  const fitted = truncate(value, width);
  return `${fitted}${" ".repeat(Math.max(0, width - stringWidth(fitted)))}`;
}

function spread(left: string, right: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const safeRight = truncate(right, Math.max(0, Math.floor(width / 2)));
  const leftWidth = Math.max(0, width - stringWidth(safeRight) - 1);
  const safeLeft = truncate(left, leftWidth);
  const gap = Math.max(1, width - stringWidth(safeLeft) - stringWidth(safeRight));
  return truncate(`${safeLeft}${" ".repeat(gap)}${safeRight}`, width);
}

function truncate(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const safe = sanitizeTerminalText(value, { preserveSgr: true })
    .replace(/[\r\n]/g, " ");
  if (stringWidth(safe) <= width) {
    return safe;
  }
  if (width === 1) {
    return "…";
  }
  return `${sliceAnsi(safe, 0, width - 1)}…`;
}

function readerRenderWidth(width: number): number {
  const safeWidth = clamp(Math.floor(width), 40, 1_000);
  return clamp(safeWidth - 2, 20, 1_000);
}

interface DecodedInput {
  events: TuiInputEvent[];
  remainder: string;
}

type TuiInputEvent =
  | { type: "key"; key: string }
  | { type: "mouse"; event: TuiMouseEvent };

function decodeInput(value: string): DecodedInput {
  const events: TuiInputEvent[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const rest = value.slice(index);
    const mouse = rest.match(/^\u001b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (mouse) {
      const code = Number(mouse[1]);
      const x = Number(mouse[2]);
      const y = Number(mouse[3]);
      const terminator = mouse[4];
      const button = decodeMouseButton(code, terminator);
      if (button) {
        events.push({ type: "mouse", event: { button, x, y } });
      }
      index += mouse[0].length - 1;
      continue;
    }
    if (rest.startsWith("\u001b[<")) {
      return { events, remainder: rest };
    }
    if (rest.startsWith("\u001b[A")) {
      events.push({ type: "key", key: "up" });
      index += 2;
    } else if (rest.startsWith("\u001b[B")) {
      events.push({ type: "key", key: "down" });
      index += 2;
    } else if (rest.startsWith("\u001b[5~")) {
      events.push({ type: "key", key: "pageup" });
      index += 3;
    } else if (rest.startsWith("\u001b[6~")) {
      events.push({ type: "key", key: "pagedown" });
      index += 3;
    } else {
      const character = value[index] ?? "";
      if (character === "\r" || character === "\n") {
        events.push({ type: "key", key: "enter" });
      } else if (character === "\u001b") {
        events.push({ type: "key", key: "escape" });
      } else if (character === "\u0003") {
        events.push({ type: "key", key: "ctrl-c" });
      } else if (character === "\u0004") {
        events.push({ type: "key", key: "ctrl-d" });
      } else if (character === "\u007f" || character === "\b") {
        events.push({ type: "key", key: "backspace" });
      } else {
        events.push({ type: "key", key: character });
      }
    }
  }
  return { events, remainder: "" };
}

function decodeMouseButton(
  code: number,
  terminator: string | undefined,
): TuiMouseEvent["button"] | undefined {
  if (!Number.isSafeInteger(code) || code < 0 || terminator !== "M") {
    return undefined;
  }
  if ((code & 64) !== 0) {
    return (code & 1) === 0 ? "wheel-up" : "wheel-down";
  }
  return (code & 3) === 0 ? "left" : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
