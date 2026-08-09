import type { ReadStream, WriteStream } from "node:tty";

import { Chalk, type ChalkInstance } from "chalk";
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";

import type { DeskApiClient } from "./api-client.js";
import type {
  DocumentAction,
  PublicDocument,
  PublicWorkspace,
  ReadingStatus,
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
  const footer = state.mode === "reader"
    ? renderShortcutBar(
        [["j/k", "scroll"], ["m", "read"], ["u", "unread"], ["a", "archive"], ["b", "queue"], ["q", "quit"]],
        theme,
      )
    : state.searching
      ? `${theme.accent("SEARCH")} ${theme.ink(`${sanitizeTerminalText(state.search)}_`)}  ${theme.muted("enter apply  esc clear")}`
      : renderShortcutBar(
          [["j/k", "move"], ["enter", "open"], ["s", "status"], ["p", "project"], ["/", "search"], ["q", "quit"]],
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
  let state = createTuiState(
    await client.listDocuments(),
    await client.listWorkspaces(),
  );
  const wasRaw = input.isRaw;
  const eventController = new AbortController();
  let finished = false;
  let processing = Promise.resolve();
  let refreshing = Promise.resolve();
  let resizeTimer: NodeJS.Timeout | undefined;
  let renderedWidth = readerRenderWidth(output.columns ?? 100);

  const draw = (): void => {
    const width = output.columns ?? 100;
    const height = output.rows ?? 30;
    output.write(
      `\u001b[H\u001b[2J${renderTui(state, width, height, { color, unicode })}`,
    );
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
          state = applyTuiReader(
            state,
            rendered.document,
            rendered.content,
            rendered.backend,
            rendered.warnings,
          );
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

  output.write("\u001b[?1049h\u001b[?25l");
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
    line: styles.rgb(110, 106, 96),
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

  const columns = width >= 84 ? 2 : 1;
  const gap = columns === 2 ? 1 : 0;
  const firstWidth = columns === 2 ? Math.floor((width - gap) / 2) : width;
  const secondWidth = width - firstWidth - gap;
  const rowsPerPage = Math.max(1, Math.floor((height - lines.length + 1) / 5));
  const selectedRow = Math.floor(state.selectedIndex / columns);
  const totalRows = Math.ceil(count / columns);
  const startRow = clamp(
    selectedRow - Math.floor(rowsPerPage / 2),
    0,
    Math.max(0, totalRows - rowsPerPage),
  );

  for (let row = startRow; row < Math.min(totalRows, startRow + rowsPerPage); row += 1) {
    const firstIndex = row * columns;
    const first = renderDocumentCard(
      state.visibleDocuments[firstIndex]!,
      firstWidth,
      firstIndex === state.selectedIndex,
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
  theme: TuiTheme,
  borders: TuiBorders,
): string[] {
  const borderStyle = selected ? theme.accent : theme.line;
  const status = statusStyle(theme, document.status);
  const label = status(
    `${statusSymbol(document.status, borders.vertical === "│")} ${statusLabel(document.status).toUpperCase()}`,
  );
  const topPrefix = `${borderStyle(`${borders.topLeft}${borders.horizontal}`)} ${label} `;
  const topFill = Math.max(0, width - stringWidth(topPrefix) - 1);
  const top = `${topPrefix}${borderStyle(`${borders.horizontal.repeat(topFill)}${borders.topRight}`)}`;
  const marker = selected ? theme.accent("› ") : "  ";
  const title = selected
    ? theme.styles.bold(sanitizeTerminalText(document.title))
    : theme.ink(sanitizeTerminalText(document.title));
  const meta = [document.workspaceId, document.kind, document.taskId]
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
  const pill = statusStyle(theme, document.status)(
    `${statusSymbol(document.status, borders.vertical === "│")} ${statusLabel(document.status).toUpperCase()}`,
  );
  const meta = [
    document.workspaceId,
    document.taskId,
    document.kind,
    state.reader.backend,
  ].filter((value): value is string => Boolean(value)).join(" · ");
  const heading = spread(
    `${pill}  ${theme.styles.bold(title)}`,
    theme.muted(`revision ${document.revision}`),
    width,
  );
  const header = [heading, theme.muted(sanitizeTerminalText(meta))];
  if (state.message) {
    header.push(theme.accent(`! ${sanitizeTerminalText(state.message)}`));
  }
  header.push("");

  const surfaceHeight = Math.max(3, height - header.length);
  const surfaceWidth = Math.max(12, Math.min(width - 2, 108));
  const contentWidth = Math.max(1, surfaceWidth - 4);
  const warningLines = state.reader.warnings.map((warning) =>
    theme.accent(`warning: ${sanitizeTerminalText(warning)}`),
  );
  const content = sanitizeTerminalText(state.reader.content, {
    preserveSgr: theme.color,
  }).split("\n");
  const all = warningLines.length > 0
    ? [...warningLines, "", ...content]
    : content;
  const available = Math.max(1, surfaceHeight - 2);
  const maxScroll = Math.max(0, all.length - available);
  const scroll = clamp(state.scroll, 0, maxScroll);
  const visible = all.slice(scroll, scroll + available);
  const progress = all.length > available
    ? `${scroll + 1}-${Math.min(all.length, scroll + available)} / ${all.length}`
    : `${all.length} lines`;
  const top = labeledBorder(" DOCUMENT ", ` ${progress} `, surfaceWidth, borders, theme);
  const bottom = theme.line(
    `${borders.bottomLeft}${borders.horizontal.repeat(surfaceWidth - 2)}${borders.bottomRight}`,
  );
  const surface = [
    top,
    ...Array.from({ length: available }, (_, index) =>
      `${theme.line(borders.vertical)} ${fitLine(visible[index] ?? "", contentWidth)} ${theme.line(borders.vertical)}`,
    ),
    bottom,
  ];
  const margin = " ".repeat(Math.max(0, Math.floor((width - surfaceWidth) / 2)));
  return [...header, ...surface.map((line) => `${margin}${line}`)].slice(0, height);
}

function labeledBorder(
  leftLabel: string,
  rightLabel: string,
  width: number,
  borders: TuiBorders,
  theme: TuiTheme,
): string {
  const safeLeft = truncate(leftLabel, Math.max(1, Math.floor(width / 2)));
  const safeRight = truncate(rightLabel, Math.max(1, Math.floor(width / 3)));
  const fill = Math.max(0, width - stringWidth(safeLeft) - stringWidth(safeRight) - 2);
  return `${theme.line(borders.topLeft)}${theme.accent(safeLeft)}${theme.line(borders.horizontal.repeat(fill))}${theme.muted(safeRight)}${theme.line(borders.topRight)}`;
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
  const workspaceWidth = safeWidth - 2;
  const surfaceWidth = Math.max(12, Math.min(workspaceWidth - 2, 108));
  return clamp(surfaceWidth - 4, 20, 1_000);
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
