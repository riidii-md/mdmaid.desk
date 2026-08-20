import type { ReadStream, WriteStream } from "node:tty";

import { Chalk, type ChalkInstance } from "chalk";
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";

import { DeskApiError, type DeskApiClient } from "./api-client.js";
import type {
  DocumentAction,
  PublicDocument,
  PublicReviewRequest,
  PublicWorkspace,
  ReadingStatus,
  ReviewOutcome,
} from "./api-types.js";
import { sanitizeTerminalText } from "./terminal-text.js";

type TuiMode = "queue" | "reader";
type StatusFilter = "all" | ReadingStatus;

interface TuiReader {
  backend: string;
  content: string;
  document: PublicDocument;
  warnings: string[];
}

interface TuiReviewComposer {
  requestId: string;
  outcome: ReviewOutcome;
  message: string;
}

export interface TuiState {
  documents: PublicDocument[];
  reviewRequests: PublicReviewRequest[];
  reviewComposer?: TuiReviewComposer | undefined;
  actionsOnly: boolean;
  mode: TuiMode;
  reader?: TuiReader | undefined;
  search: string;
  searching: boolean;
  selectedIndex: number;
  statusFilter: StatusFilter;
  visibleDocuments: PublicDocument[];
  workspaceFilter?: string | undefined;
  workspaces: PublicWorkspace[];
  scroll: number;
  message?: string | undefined;
}

export type TuiEffect =
  | { type: "open"; documentId: string }
  | { type: "action"; documentId: string; action: DocumentAction }
  | {
      type: "review-response";
      requestId: string;
      outcome: ReviewOutcome;
      message: string;
    }
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
): TuiState {
  const visibleWorkspaces = workspacesForDocuments(documents, workspaces);
  const state: TuiState = {
    documents,
    reviewRequests,
    actionsOnly: false,
    mode: "queue",
    search: "",
    searching: false,
    selectedIndex: 0,
    statusFilter: "all",
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
): TuiState {
  return {
    ...state,
    mode: "reader",
    reader: { backend, content, document, warnings },
    reviewComposer: undefined,
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
    selectedIndex:
      selectedIndex >= 0
        ? selectedIndex
        : clamp(next.selectedIndex, 0, Math.max(0, next.visibleDocuments.length - 1)),
  };
  if (next.reader) {
    const readerDocumentId = next.reader.document.id;
    const updated = documents.find(({ id }) => id === readerDocumentId);
    if (updated) {
      next = { ...next, reader: { ...next.reader, document: updated } };
    }
    if (
      pendingReviewForDocument(reviewRequests, readerDocumentId) ===
      undefined
    ) {
      next = { ...next, reviewComposer: undefined };
    }
  }
  return next;
}

export function handleTuiKey(state: TuiState, key: string): TuiTransition {
  if (key === "ctrl-c") {
    return { state, effects: [{ type: "quit" }] };
  }
  if (state.searching) {
    return handleSearchKey(state, key);
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
  const footer = state.reviewComposer
    ? renderShortcutBar(
        [["enter", "newline"], ["ctrl-d", "submit"], ["esc", "cancel"]],
        theme,
      )
    : state.mode === "reader"
      ? renderShortcutBar(
          state.reader?.document.missingAt
            ? [["a", "archive"], ["b", "queue"], ["q", "quit"]]
            : pendingReviewForDocument(
                  state.reviewRequests,
                  state.reader?.document.id ?? "",
                )
              ? [["y", "approve"], ["c", "changes"], ["x", "reject"], ["j/k", "scroll"], ["b", "queue"]]
              : [["j/k", "scroll"], ["m", "read"], ["u", "unread"], ["a", "archive"], ["b", "queue"], ["q", "quit"]],
          theme,
        )
    : state.searching
      ? `${theme.accent("SEARCH")} ${theme.ink(`${sanitizeTerminalText(state.search)}_`)}  ${theme.muted("enter apply  esc clear")}`
      : renderShortcutBar(
          [["j/k", "move"], ["enter", "open"], ["r", "actions"], ["a", "archive"], ["s", "status"], ["p", "project"], ["/", "search"], ["q", "quit"]],
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
  const [initialDocuments, initialWorkspaces, initialReviewRequests] =
    await Promise.all([
      client.listDocuments(),
      client.listWorkspaces(),
      client.listReviewRequests(),
    ]);
  let state = createTuiState(
    initialDocuments,
    initialWorkspaces,
    initialReviewRequests,
  );
  const wasRaw = input.isRaw;
  const eventController = new AbortController();
  let finished = false;
  let processing = Promise.resolve();
  let refreshing = Promise.resolve();
  let resizeTimer: NodeJS.Timeout | undefined;
  let renderedWidth = readerRenderWidth(output.columns ?? 100);
  let inputBuffer = "";
  let previousFrame: string[] | undefined;

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

  const execute = async (effect: TuiEffect): Promise<void> => {
    if (effect.type === "quit") {
      cleanup();
      return;
    }
    try {
      if (effect.type === "open") {
        const rendered = await client.renderDocument(
          effect.documentId,
          "terminal",
          readerRenderWidth(output.columns ?? 100),
          { color, unicode },
        );
        renderedWidth = readerRenderWidth(output.columns ?? 100);
        state = applyTuiReader(
          state,
          rendered.document,
          rendered.content,
          rendered.backend,
          rendered.warnings,
        );
        draw();
        await client.act(effect.documentId, "opened");
      } else if (effect.type === "action") {
        await client.act(effect.documentId, effect.action);
        if (effect.action === "archive") {
          state = { ...state, mode: "queue", reader: undefined, scroll: 0 };
        }
      } else {
        await client.respondToReviewRequest(effect.requestId, {
          outcome: effect.outcome,
          message: effect.message,
        });
        state = { ...state, reviewComposer: undefined };
      }
      const [documents, workspaces, reviewRequests] = await Promise.all([
        client.listDocuments(),
        client.listWorkspaces(),
        client.listReviewRequests(),
      ]);
      state = replaceTuiDocuments(
        state,
        documents,
        workspaces,
        reviewRequests,
      );
      draw();
    } catch (error) {
      if (
        effect.type === "open" &&
        error instanceof DeskApiError &&
        error.code === "source_missing"
      ) {
        try {
          const [documents, reviewRequests] = await Promise.all([
            client.listDocuments(),
            client.listReviewRequests(),
          ]);
          state = replaceTuiDocuments(
            state,
            documents,
            state.workspaces,
            reviewRequests,
          );
          const missing = documents.find(({ id }) => id === effect.documentId);
          if (missing) {
            state = applyTuiMissingReader(state, missing);
            draw();
            return;
          }
        } catch {
          // Fall through to a safe message; queue archive remains available.
        }
      }
      state = {
        ...state,
        message: error instanceof Error ? error.message : "TUI request failed",
      };
      draw();
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
      for (const effect of transition.effects) {
        processing = processing.then(() => execute(effect));
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
      processing = processing.then(async () => {
        try {
          const rendered = await client.renderDocument(
            documentId,
            "terminal",
            nextWidth,
            { color, unicode },
          );
          renderedWidth = nextWidth;
          const scroll = state.scroll;
          state = applyTuiReader(
            state,
            rendered.document,
            rendered.content,
            rendered.backend,
            rendered.warnings,
          );
          state = { ...state, scroll };
          draw();
        } catch (error) {
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
  void client
    .subscribeCatalog(() => {
      refreshing = refreshing
        .then(async () => {
          const [documents, workspaces, reviewRequests] = await Promise.all([
            client.listDocuments(),
            client.listWorkspaces(),
            client.listReviewRequests(),
          ]);
          state = replaceTuiDocuments(
            state,
            documents,
            workspaces,
            reviewRequests,
          );
          draw();
        })
        .catch((error: unknown) => {
          if (!finished) {
            state = {
              ...state,
              message: error instanceof Error ? error.message : "Live refresh failed",
            };
            draw();
          }
        });
    }, { signal: eventController.signal })
    .catch((error: unknown) => {
      if (!finished) {
        state = {
          ...state,
          message: error instanceof Error ? error.message : "Live events failed",
        };
        draw();
      }
    });

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
  if (key === "a") {
    const document = state.visibleDocuments[state.selectedIndex];
    return {
      state,
      effects: document
        ? [{ type: "action", action: "archive", documentId: document.id }]
        : [],
    };
  }
  if (key === "r") {
    return {
      state: applyFilters({
        ...state,
        actionsOnly: !state.actionsOnly,
        selectedIndex: 0,
      }),
      effects: [],
    };
  }
  if (key === "s") {
    const filters: StatusFilter[] = ["all", "unread", "reading", "done"];
    const index = filters.indexOf(state.statusFilter);
    return {
      state: applyFilters({
        ...state,
        statusFilter: filters[(index + 1) % filters.length] ?? "all",
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
  };
  const reviewOutcome = reviewOutcomes[key];
  if (pending && reviewOutcome) {
    return {
      state: {
        ...state,
        reviewComposer: {
          requestId: pending.id,
          outcome: reviewOutcome,
          message: "",
        },
        message: undefined,
      },
      effects: [],
    };
  }
  const actions: Partial<Record<string, DocumentAction>> = {
    m: "read",
    u: "unread",
    a: "archive",
  };
  const action = actions[key];
  if (
    action &&
    state.reader &&
    (action === "archive" || state.reader.document.missingAt === null)
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
    if (
      composer.outcome === "changes_requested" &&
      composer.message.trim() === ""
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
          message: composer.message,
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

function applyFilters(state: TuiState): TuiState {
  const terms = state.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visibleDocuments = state.documents.filter((document) => {
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
      document.workspaceId !== state.workspaceFilter
    ) {
      return false;
    }
    const searchable = [
      document.title,
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
  return {
    ...state,
    selectedIndex: clamp(
      state.selectedIndex,
      0,
      Math.max(0, visibleDocuments.length - 1),
    ),
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
  for (const document of documents) {
    counts.set(
      document.workspaceId,
      (counts.get(document.workspaceId) ?? 0) + 1,
    );
  }
  return workspaces.flatMap((workspace) => {
    const documentCount = counts.get(workspace.id) ?? 0;
    return documentCount === 0 ? [] : [{ ...workspace, documentCount }];
  });
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
  brand: ChalkInstance;
  color: boolean;
  done: ChalkInstance;
  ink: ChalkInstance;
  line: ChalkInstance;
  muted: ChalkInstance;
  reading: ChalkInstance;
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
    brand: styles.rgb(255, 119, 88).bold,
    color,
    done: styles.rgb(105, 198, 154),
    ink: styles,
    line: styles.rgb(143, 181, 175),
    muted: styles.rgb(170, 166, 154),
    reading: styles.rgb(124, 160, 255),
    styles,
  };
}

function renderWorkspaceTitle(
  state: TuiState,
  width: number,
  theme: TuiTheme,
  unicode: boolean,
): string {
  const section = state.mode === "reader" ? "DOCUMENT READER" : "DOCUMENT INBOX";
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
      return {
        state: applyFilters({ ...state, workspaceFilter: undefined }),
        effects: [],
      };
    }
    const workspaceIndex = bodyIndex - 3;
    const workspace = state.workspaces[workspaceIndex];
    if (workspace) {
      return {
        state: applyFilters({ ...state, workspaceFilter: workspace.id }),
        effects: [],
      };
    }
    const statusIndex = bodyIndex - (6 + state.workspaces.length);
    const statuses: StatusFilter[] = ["all", "unread", "reading", "done"];
    const status = statuses[statusIndex];
    if (status) {
      return {
        state: applyFilters({ ...state, statusFilter: status }),
        effects: [],
      };
    }
    return { state, effects: [] };
  }

  const mainX = showSidebar ? 2 + sidebarWidth + 1 : 2;
  const mainWidth = showSidebar ? innerWidth - sidebarWidth - 1 : innerWidth;
  const relativeX = event.x - mainX;
  const cardLine = bodyIndex - 2;
  if (relativeX < 0 || relativeX >= mainWidth || cardLine < 0) {
    return { state, effects: [] };
  }
  const lineInCard = cardLine % 5;
  if (lineInCard >= 4) {
    return { state, effects: [] };
  }

  const metrics = queuePageMetrics(state, mainWidth, bodyHeight);
  let column = 0;
  if (metrics.columns === 2) {
    if (relativeX === metrics.firstWidth) {
      return { state, effects: [] };
    }
    column = relativeX > metrics.firstWidth ? 1 : 0;
  }
  const row = Math.floor(cardLine / 5);
  const documentIndex =
    (metrics.startRow + row) * metrics.columns + column;
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
            ["b", "queue", "b"],
            ["q", "quit", "q"],
          ]
        : [
            ["j/k", "scroll", undefined],
            ["m", "read", "m"],
            ["u", "unread", "u"],
            ["a", "archive", "a"],
            ["b", "queue", "b"],
            ["q", "quit", "q"],
          ]
      : [
          ["j/k", "move", undefined],
          ["enter", "open", "enter"],
          ["a", "archive", "a"],
          ["s", "status", "s"],
          ["p", "project", "p"],
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
  const lines: string[] = [theme.accent(theme.styles.bold(" PROJECTS")), ""];
  lines.push(
    navigationLine(
      "All documents",
      state.documents.length,
      state.workspaceFilter === undefined,
      width,
      theme,
      unicode,
    ),
  );
  for (const workspace of state.workspaces) {
    lines.push(
      navigationLine(
        workspace.name,
        workspace.documentCount,
        state.workspaceFilter === workspace.id,
        width,
        theme,
        unicode,
      ),
    );
  }
  lines.push("", theme.accent(theme.styles.bold(" ACTIONS")), "");
  lines.push(
    navigationLine(
      "Waiting for you",
      state.reviewRequests.filter(({ status }) => status === "pending").length,
      state.actionsOnly,
      width,
      theme,
      unicode,
    ),
  );
  lines.push("", theme.accent(theme.styles.bold(" STATUS")), "");
  const counts: Record<StatusFilter, number> = {
    all: state.documents.length,
    unread: state.documents.filter(({ status }) => status === "unread").length,
    reading: state.documents.filter(({ status }) => status === "reading").length,
    done: state.documents.filter(({ status }) => status === "done").length,
  };
  const labels: Record<StatusFilter, string> = {
    all: "All",
    unread: "New",
    reading: "Reading",
    done: "Done",
  };
  for (const status of ["all", "unread", "reading", "done"] as const) {
    lines.push(
      navigationLine(
        labels[status],
        counts[status],
        state.statusFilter === status,
        width,
        theme,
        unicode,
        status === "all" ? undefined : status,
      ),
    );
  }
  return lines.slice(0, height);
}

function navigationLine(
  label: string,
  count: number,
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

interface QueuePageMetrics {
  columns: 1 | 2;
  firstWidth: number;
  rowsPerPage: number;
  startRow: number;
  totalRows: number;
}

function queuePageMetrics(
  state: TuiState,
  width: number,
  height: number,
): QueuePageMetrics {
  const columns = width >= 84 ? 2 : 1;
  const gap = columns === 2 ? 1 : 0;
  const firstWidth = columns === 2 ? Math.floor((width - gap) / 2) : width;
  const rowsPerPage = Math.max(1, Math.floor((height - 2 + 1) / 5));
  const selectedRow = Math.floor(state.selectedIndex / columns);
  const totalRows = Math.ceil(state.visibleDocuments.length / columns);
  const startRow = clamp(
    selectedRow - Math.floor(rowsPerPage / 2),
    0,
    Math.max(0, totalRows - rowsPerPage),
  );
  return { columns, firstWidth, rowsPerPage, startRow, totalRows };
}

function queueMainLines(
  state: TuiState,
  width: number,
  height: number,
  theme: TuiTheme,
  borders: TuiBorders,
): string[] {
  const count = state.visibleDocuments.length;
  const project = state.workspaceFilter
    ? state.workspaces.find(({ id }) => id === state.workspaceFilter)?.name ?? state.workspaceFilter
    : "All projects";
  const filter = state.statusFilter === "all" ? "All statuses" : statusLabel(state.statusFilter);
  const view = state.search ? `${project} · ${filter} · “${state.search}”` : `${project} · ${filter}`;
  const lines = [
    spread(
      theme.styles.bold(`${count} ${count === 1 ? "document" : "documents"}`),
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
  const { columns, firstWidth, rowsPerPage, startRow, totalRows } = metrics;
  const gap = columns === 2 ? 1 : 0;
  const secondWidth = width - firstWidth - gap;

  for (let row = startRow; row < Math.min(totalRows, startRow + rowsPerPage); row += 1) {
    const firstIndex = row * columns;
    const first = renderDocumentCard(
      state.visibleDocuments[firstIndex]!,
      firstWidth,
      firstIndex === state.selectedIndex,
      pendingReviewForDocument(
        state.reviewRequests,
        state.visibleDocuments[firstIndex]!.id,
      ) !== undefined,
      theme,
      borders,
    );
    const secondDocument = columns === 2
      ? state.visibleDocuments[firstIndex + 1]
      : undefined;
    const second = secondDocument
      ? renderDocumentCard(
          secondDocument,
          secondWidth,
          firstIndex + 1 === state.selectedIndex,
          pendingReviewForDocument(state.reviewRequests, secondDocument.id) !==
            undefined,
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
    if (row < Math.min(totalRows, startRow + rowsPerPage) - 1) {
      lines.push("");
    }
  }
  return lines.slice(0, height);
}

function renderDocumentCard(
  document: PublicDocument,
  width: number,
  selected: boolean,
  actionRequired: boolean,
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
  const marker = selected ? theme.accent("› ") : "  ";
  const title = selected
    ? theme.styles.bold(sanitizeTerminalText(document.title))
    : theme.ink(sanitizeTerminalText(document.title));
  const meta = [
    document.workspaceId,
    document.kind,
    document.storage,
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
    document.storage,
    state.reader.backend,
  ].filter((value): value is string => Boolean(value)).join(" · ");
  const heading = spread(
    `${pill}  ${theme.styles.bold(title)}`,
    theme.muted(`revision ${document.revision}`),
    width,
  );
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
    ...(reviewLines.length > 0 ? ["", ...reviewLines] : []),
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
