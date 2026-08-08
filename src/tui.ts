import type { ReadStream, WriteStream } from "node:tty";

import type { DeskApiClient } from "./api-client.js";
import type {
  DocumentAction,
  PublicDocument,
  PublicWorkspace,
  ReadingStatus,
} from "./api-types.js";

type TuiMode = "queue" | "reader";
type StatusFilter = "all" | ReadingStatus;

interface TuiReader {
  backend: string;
  content: string;
  document: PublicDocument;
  warnings: string[];
}

export interface TuiState {
  documents: PublicDocument[];
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
  | { type: "quit" };

export interface TuiTransition {
  state: TuiState;
  effects: TuiEffect[];
}

export interface TuiIo {
  input?: ReadStream;
  output?: WriteStream;
}

export function createTuiState(
  documents: PublicDocument[],
  workspaces: PublicWorkspace[],
): TuiState {
  const state: TuiState = {
    documents,
    mode: "queue",
    search: "",
    searching: false,
    selectedIndex: 0,
    statusFilter: "all",
    visibleDocuments: [],
    workspaces,
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
    scroll: 0,
    searching: false,
    message: undefined,
  };
}

export function replaceTuiDocuments(
  state: TuiState,
  documents: PublicDocument[],
): TuiState {
  const selectedId = state.visibleDocuments[state.selectedIndex]?.id;
  let next = applyFilters({ ...state, documents });
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
    const updated = documents.find(({ id }) => id === next.reader?.document.id);
    if (updated) {
      next = { ...next, reader: { ...next.reader, document: updated } };
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
  if (key === "q") {
    return { state, effects: [{ type: "quit" }] };
  }
  if (state.mode === "reader") {
    return handleReaderKey(state, key);
  }
  return handleQueueKey(state, key);
}

export function renderTui(state: TuiState, width: number, height: number): string {
  const safeWidth = clamp(Math.floor(width), 40, 1_000);
  const safeHeight = clamp(Math.floor(height), 8, 500);
  const innerWidth = safeWidth - 2;
  const top = `+${"-".repeat(innerWidth)}+`;
  const title = state.mode === "reader" ? renderReaderTitle(state) : "mdmaid.desk / document queue";
  const footer = state.mode === "reader"
    ? "j/k scroll  m read  u unread  a archive  b queue  q quit"
    : state.searching
      ? `search: ${state.search}_  enter apply  esc clear`
      : "j/k select  enter open  s status  p project  / search  q quit";
  const bodyHeight = safeHeight - 5;
  const body = state.mode === "reader"
    ? readerLines(state, innerWidth, bodyHeight)
    : queueLines(state, innerWidth, bodyHeight);
  const lines = [top, boxLine(title, innerWidth), boxLine("", innerWidth)];
  for (let index = 0; index < bodyHeight; index += 1) {
    lines.push(boxLine(body[index] ?? "", innerWidth));
  }
  lines.push(boxLine(footer, innerWidth), top);
  return lines.join("\n");
}

export async function runTui(
  client: DeskApiClient,
  io: TuiIo = {},
): Promise<void> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  let state = createTuiState(
    await client.listDocuments(),
    await client.listWorkspaces(),
  );
  const wasRaw = input.isRaw;
  const eventController = new AbortController();
  let finished = false;
  let processing = Promise.resolve();
  let refreshing = Promise.resolve();

  const draw = (): void => {
    const width = output.columns ?? 100;
    const height = output.rows ?? 30;
    output.write(`\u001b[H\u001b[2J${renderTui(state, width, height)}`);
  };
  const cleanup = (): void => {
    if (finished) {
      return;
    }
    finished = true;
    input.off("data", onData);
    process.off("SIGWINCH", draw);
    eventController.abort();
    if (input.isTTY) {
      input.setRawMode(Boolean(wasRaw));
    }
    input.pause();
    output.write("\u001b[?25h\u001b[?1049l");
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
          clamp((output.columns ?? 100) - 4, 20, 1_000),
        );
        state = applyTuiReader(
          state,
          rendered.document,
          rendered.content,
          rendered.backend,
          rendered.warnings,
        );
        draw();
        await client.act(effect.documentId, "opened");
      } else {
        await client.act(effect.documentId, effect.action);
        if (effect.action === "archive") {
          state = { ...state, mode: "queue", reader: undefined, scroll: 0 };
        }
      }
      state = replaceTuiDocuments(state, await client.listDocuments());
      draw();
    } catch (error) {
      state = {
        ...state,
        message: error instanceof Error ? error.message : "TUI request failed",
      };
      draw();
    }
  };

  const onData = (chunk: Buffer | string): void => {
    for (const key of decodeKeys(chunk.toString())) {
      if (finished) {
        return;
      }
      const transition = handleTuiKey(state, key);
      state = transition.state;
      draw();
      for (const effect of transition.effects) {
        processing = processing.then(() => execute(effect));
      }
    }
  };

  output.write("\u001b[?1049h\u001b[?25l");
  if (input.isTTY) {
    input.setRawMode(true);
  }
  input.resume();
  input.on("data", onData);
  process.on("SIGWINCH", draw);
  draw();
  void client
    .subscribeCatalog(() => {
      refreshing = refreshing
        .then(async () => {
          const [documents, workspaces] = await Promise.all([
            client.listDocuments(),
            client.listWorkspaces(),
          ]);
          state = {
            ...replaceTuiDocuments(state, documents),
            workspaces,
          };
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
    return {
      state: {
        ...state,
        selectedIndex: clamp(
          state.selectedIndex + 1,
          0,
          Math.max(0, state.visibleDocuments.length - 1),
        ),
      },
      effects: [],
    };
  }
  if (key === "k" || key === "up") {
    return {
      state: { ...state, selectedIndex: Math.max(0, state.selectedIndex - 1) },
      effects: [],
    };
  }
  if (key === "enter") {
    const document = state.visibleDocuments[state.selectedIndex];
    return {
      state,
      effects: document ? [{ type: "open", documentId: document.id }] : [],
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
  const actions: Partial<Record<string, DocumentAction>> = {
    m: "read",
    u: "unread",
    a: "archive",
  };
  const action = actions[key];
  if (action && state.reader) {
    return {
      state,
      effects: [
        { type: "action", action, documentId: state.reader.document.id },
      ],
    };
  }
  return { state, effects: [] };
}

function applyFilters(state: TuiState): TuiState {
  const terms = state.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visibleDocuments = state.documents.filter((document) => {
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

function queueLines(state: TuiState, width: number, height: number): string[] {
  const workspace = state.workspaceFilter ?? "all projects";
  const summary = `${workspace} / ${state.statusFilter} / ${state.visibleDocuments.length} documents`;
  if (state.visibleDocuments.length === 0) {
    return [summary, "", "No documents match this view."];
  }
  const rows = state.visibleDocuments.map((document, index) => {
    const marker = index === state.selectedIndex ? ">" : " ";
    const status = document.status === "unread" ? "NEW" : document.status === "reading" ? "READING" : "DONE";
    return `${marker} [${status}] ${document.title}  ${document.workspaceId}/${document.kind}`;
  });
  const available = Math.max(1, height - 2);
  const start = clamp(
    state.selectedIndex - Math.floor(available / 2),
    0,
    Math.max(0, rows.length - available),
  );
  return [truncate(summary, width), "", ...rows.slice(start, start + available)];
}

function readerLines(state: TuiState, width: number, height: number): string[] {
  if (!state.reader) {
    return ["Document is not loaded."];
  }
  const meta = [
    state.reader.document.workspaceId,
    state.reader.document.taskId,
    state.reader.document.kind,
    state.reader.backend,
  ].filter(Boolean).join(" / ");
  const warningLines = state.reader.warnings.map((warning) => `warning: ${warning}`);
  const content = state.reader.content.split(/\r?\n/);
  const all = [meta, ...warningLines, "", ...content];
  const maxScroll = Math.max(0, all.length - height);
  const scroll = clamp(state.scroll, 0, maxScroll);
  return all.slice(scroll, scroll + height).map((line) => truncate(line, width));
}

function renderReaderTitle(state: TuiState): string {
  if (!state.reader) {
    return "mdmaid.desk / reader";
  }
  return `mdmaid.desk / ${state.reader.document.title} [${state.reader.document.status}]`;
}

function boxLine(value: string, width: number): string {
  return `|${truncate(value, width).padEnd(width)}|`;
}

function truncate(value: string, width: number): string {
  const safe = stripTerminalControls(value).replace(/[\r\n\t]/g, " ");
  if (safe.length <= width) {
    return safe;
  }
  return width <= 1 ? safe.slice(0, width) : `${safe.slice(0, width - 1)}…`;
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[PX^_][\s\S]*?\u001b\\/g, "")
    .replace(/\u001b./g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function decodeKeys(value: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const rest = value.slice(index);
    if (rest.startsWith("\u001b[A")) {
      keys.push("up");
      index += 2;
    } else if (rest.startsWith("\u001b[B")) {
      keys.push("down");
      index += 2;
    } else {
      const character = value[index] ?? "";
      if (character === "\r" || character === "\n") {
        keys.push("enter");
      } else if (character === "\u001b") {
        keys.push("escape");
      } else if (character === "\u0003") {
        keys.push("ctrl-c");
      } else if (character === "\u007f" || character === "\b") {
        keys.push("backspace");
      } else {
        keys.push(character);
      }
    }
  }
  return keys;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
