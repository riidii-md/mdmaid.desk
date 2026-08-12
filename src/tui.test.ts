import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import stringWidth from "string-width";

import type {
  CatalogEvent,
  CatalogSubscriptionOptions,
  DeskApiClient,
} from "./api-client.js";
import type { PublicDocument, PublicWorkspace } from "./api-types.js";
import {
  applyTuiReader,
  createTuiState,
  handleTuiKey,
  handleTuiMouse,
  replaceTuiDocuments,
  renderTui,
  runTui,
} from "./tui.js";

const documents: PublicDocument[] = [
  {
    id: "doc-11111111111111111111",
    workspaceId: "alpha",
    taskId: "DESK-1",
    producer: "codex",
    kind: "plan",
    title: "Daemon plan",
    attention: "review",
    tags: ["architecture"],
    revision: 1,
    openedRevision: null,
    completedRevision: null,
    status: "unread",
    archivedAt: null,
    missingAt: null,
    createdAt: "2026-08-08T10:00:00.000Z",
    updatedAt: "2026-08-08T10:00:00.000Z",
    route: "/d/doc-11111111111111111111",
  },
  {
    id: "doc-22222222222222222222",
    workspaceId: "beta",
    kind: "review",
    title: "Terminal review",
    attention: "none",
    tags: ["terminal"],
    revision: 2,
    openedRevision: 2,
    completedRevision: null,
    status: "reading",
    archivedAt: null,
    missingAt: null,
    createdAt: "2026-08-08T11:00:00.000Z",
    updatedAt: "2026-08-08T11:00:00.000Z",
    route: "/d/doc-22222222222222222222",
  },
];

const workspaces: PublicWorkspace[] = [
  { id: "alpha", name: "Alpha", documentCount: 1, route: "/w/alpha" },
  { id: "beta", name: "Beta", documentCount: 1, route: "/w/beta" },
];

test("navigates and opens the selected queue document", () => {
  const initial = createTuiState(documents, workspaces);
  const moved = handleTuiKey(initial, "j");
  assert.equal(moved.state.selectedIndex, 1);
  assert.deepEqual(moved.effects, []);

  const opened = handleTuiKey(moved.state, "enter");
  assert.deepEqual(opened.effects, [
    { type: "open", documentId: documents[1]?.id },
  ]);
});

test("filters by status, project, and terminal search input", () => {
  let state = createTuiState(documents, workspaces);
  state = handleTuiKey(state, "s").state;
  assert.equal(state.statusFilter, "unread");
  assert.deepEqual(state.visibleDocuments.map(({ id }) => id), [documents[0]?.id]);

  state = handleTuiKey(state, "p").state;
  assert.equal(state.workspaceFilter, "alpha");
  state = handleTuiKey(state, "/").state;
  state = handleTuiKey(state, "d").state;
  state = handleTuiKey(state, "a").state;
  assert.equal(state.search, "da");
  state = handleTuiKey(state, "enter").state;
  assert.equal(state.searching, false);
  assert.deepEqual(state.visibleDocuments.map(({ id }) => id), [documents[0]?.id]);

  const searching = handleTuiKey(createTuiState(documents, workspaces), "/").state;
  const typedQ = handleTuiKey(searching, "q");
  assert.equal(typedQ.state.search, "q");
  assert.deepEqual(typedQ.effects, []);
});

test("renders the web-inspired responsive queue and reader workspace", () => {
  const queue = createTuiState(documents, workspaces);
  const queueFrame = renderTui(queue, 128, 28, { color: true });
  assert.equal(queueFrame.split("\n").length, 28);
  assert.match(queueFrame, /mdmaid\.desk/);
  assert.match(queueFrame, /DOCUMENT INBOX/);
  assert.match(queueFrame, /PROJECTS/);
  assert.match(queueFrame, /STATUS/);
  assert.match(queueFrame, /Daemon plan/);
  assert.match(queueFrame, /Terminal review/);
  assert.match(queueFrame, /j\/k/);
  assert.match(queueFrame, /\u001b\[38;2;143;181;175m/);

  const compactFrame = renderTui(queue, 68, 22);
  assert.equal(compactFrame.split("\n").length, 22);
  assert.match(compactFrame, /2 documents/);
  assert.doesNotMatch(compactFrame, /PROJECTS/);

  const reader = applyTuiReader(
    queue,
    documents[0]!,
    "\u001b[1mDaemon plan\u001b[22m\n\nRendered terminal document.",
    "beautiful-mermaid",
    [],
  );
  const readerFrame = renderTui(reader, 100, 24, { color: true });
  assert.match(readerFrame, /Daemon plan/);
  assert.match(readerFrame, /Rendered terminal document/);
  assert.match(readerFrame, /DOCUMENT READER/);
  assert.match(readerFrame, /\u001b\[[0-9;]*m/);
  assert.match(readerFrame, /m.*read/);
  assert.doesNotMatch(readerFrame, / DOCUMENT /);
  const plainReaderLines = readerFrame
    .split("\n")
    .map((line) => stripVTControlCharacters(line));
  assert.match(plainReaderLines[4] ?? "", /1-3 \/ 3/);
  assert.equal(
    plainReaderLines.find((line) => line.includes("Rendered terminal document."))?.indexOf("Rendered"),
    1,
  );
  for (const line of readerFrame.split("\n")) {
    assert.equal(stringWidth(line), 100);
  }

  assert.deepEqual(handleTuiKey(reader, "m").effects, [
    { type: "action", action: "read", documentId: documents[0]?.id },
  ]);
  assert.equal(handleTuiKey(reader, "b").state.mode, "queue");
  assert.deepEqual(handleTuiKey(reader, "q").effects, [{ type: "quit" }]);
});

test("supports mouse navigation, direct actions, wheel, and page scrolling", () => {
  const queue = createTuiState(documents, workspaces);

  assert.equal(
    handleTuiMouse(queue, { button: "left", x: 0, y: 0 }, 128, 28).state,
    queue,
  );
  assert.equal(
    handleTuiMouse(queue, { button: "wheel-down", x: 50, y: 12 }, 128, 28)
      .state.selectedIndex,
    1,
  );
  assert.equal(
    handleTuiMouse(queue, { button: "wheel-up", x: 50, y: 12 }, 128, 28)
      .state.selectedIndex,
    0,
  );

  const project = handleTuiMouse(
    queue,
    { button: "left", x: 10, y: 8 },
    128,
    28,
  );
  assert.equal(project.state.workspaceFilter, "beta");
  assert.equal(
    handleTuiMouse(project.state, { button: "left", x: 10, y: 6 }, 128, 28)
      .state.workspaceFilter,
    undefined,
  );

  const status = handleTuiMouse(
    queue,
    { button: "left", x: 10, y: 14 },
    128,
    28,
  );
  assert.equal(status.state.statusFilter, "reading");
  assert.deepEqual(
    handleTuiMouse(queue, { button: "left", x: 77, y: 7 }, 128, 28)
      .effects,
    [],
  );
  assert.deepEqual(
    handleTuiMouse(queue, { button: "left", x: 80, y: 7 }, 128, 28)
      .effects,
    [{ type: "open", documentId: documents[1]!.id }],
  );

  const opened = handleTuiMouse(
    queue,
    { button: "left", x: 30, y: 7 },
    128,
    28,
  );
  assert.deepEqual(opened.effects, [
    { type: "open", documentId: documents[0]!.id },
  ]);

  const reader = applyTuiReader(
    queue,
    documents[0]!,
    Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"),
    "beautiful-mermaid",
    [],
  );
  const wheel = handleTuiMouse(
    reader,
    { button: "wheel-down", x: 50, y: 12 },
    100,
    24,
  );
  assert.equal(wheel.state.scroll, 3);
  assert.equal(
    handleTuiMouse(wheel.state, { button: "wheel-up", x: 50, y: 12 }, 100, 24)
      .state.scroll,
    0,
  );
  assert.equal(
    handleTuiMouse(
      { ...reader, scroll: 999 },
      { button: "wheel-down", x: 50, y: 12 },
      100,
      24,
    ).state.scroll,
    25,
  );
  assert.equal(handleTuiKey(reader, "pagedown").state.scroll, 10);
  assert.equal(handleTuiKey(wheel.state, "pageup").state.scroll, 0);

  const markedRead = handleTuiMouse(
    reader,
    { button: "left", x: 17, y: 23 },
    100,
    24,
  );
  assert.deepEqual(markedRead.effects, [
    { type: "action", action: "read", documentId: documents[0]!.id },
  ]);

  assert.deepEqual(
    handleTuiMouse(queue, { button: "left", x: 15, y: 27 }, 128, 28)
      .effects,
    [{ type: "open", documentId: documents[0]!.id }],
  );
  assert.equal(
    handleTuiMouse(queue, { button: "left", x: 50, y: 27 }, 128, 28)
      .state.searching,
    true,
  );
});

test("preserves selection and allows only safe document styling", () => {
  let state = createTuiState(documents, workspaces);
  state = handleTuiKey(state, "j").state;
  const refreshed = replaceTuiDocuments(state, [
    { ...documents[0]!, title: "unsafe\u001b]52;c;payload\u0007\nline" },
    { ...documents[1]!, status: "done", completedRevision: 2 },
  ]);

  assert.equal(refreshed.visibleDocuments[refreshed.selectedIndex]?.id, documents[1]?.id);
  const frame = renderTui(refreshed, 80, 20);
  assert.doesNotMatch(frame, /[\u001b\u0007]/);
  assert.doesNotMatch(frame, /payload\u0007/);

  const styledReader = applyTuiReader(
    refreshed,
    documents[0]!,
    "\u001b[36mTrusted heading\u001b[39m\n\u001b]52;c;stolen\u0007Unsafe",
    "beautiful-mermaid",
    [],
  );
  const styledFrame = renderTui(styledReader, 80, 20, { color: true });
  assert.match(styledFrame, /\u001b\[36mTrusted heading\u001b\[39m/);
  assert.doesNotMatch(styledFrame, /\u001b\]52|stolen|\u0007/);

  const plainAsciiFrame = renderTui(styledReader, 80, 20, {
    color: false,
    unicode: false,
  });
  assert.doesNotMatch(plainAsciiFrame, /\u001b|[┌┐└┘─│●◐✓]/);
});

test("removes empty projects and clears their active TUI filter", () => {
  const filtered = {
    ...createTuiState(documents, workspaces),
    workspaceFilter: "alpha",
  };
  const refreshed = replaceTuiDocuments(filtered, [documents[1]!]);

  assert.deepEqual(refreshed.workspaces, [
    { id: "beta", name: "Beta", documentCount: 1, route: "/w/beta" },
  ]);
  assert.equal(refreshed.workspaceFilter, undefined);
  assert.deepEqual(refreshed.visibleDocuments, [documents[1]]);
});

test("runs the interactive TUI through render, events, actions, and clean exit", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  Object.defineProperties(output, {
    columns: { value: 80 },
    rows: { value: 20 },
    isTTY: { value: true },
  });
  let terminal = "";
  output.on("data", (chunk: Buffer) => {
    terminal += chunk.toString();
  });

  let current = structuredClone(documents);
  const actions: string[] = [];
  let renders = 0;
  let renderPreferences: { color?: boolean; unicode?: boolean } | undefined;
  let lists = 0;
  let onCatalog: ((event: CatalogEvent) => void) | undefined;
  const client = {
    listDocuments: async () => {
      lists += 1;
      return structuredClone(current);
    },
    listWorkspaces: async () => structuredClone(workspaces),
    renderDocument: async (
      id: string,
      _target: string,
      _width: number,
      preferences: { color?: boolean; unicode?: boolean },
    ) => {
      renders += 1;
      renderPreferences = preferences;
      return {
        document: current.find((document) => document.id === id)!,
        target: "terminal" as const,
        content: "# Live reader\n\nRendered by mdmaid.",
        backend: "source",
        warnings: [],
      };
    },
    act: async (id: string, action: string) => {
      actions.push(`${action}:${id}`);
      current = current.map((document) =>
        document.id === id
          ? {
              ...document,
              status: action === "read" ? "done" as const : "reading" as const,
              openedRevision: document.revision,
              completedRevision: action === "read" ? document.revision : null,
            }
          : document,
      );
      return current.find((document) => document.id === id)!;
    },
    subscribeCatalog: async (
      listener: (event: CatalogEvent) => void,
      options: CatalogSubscriptionOptions = {},
    ) => {
      onCatalog = listener;
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  } as unknown as DeskApiClient;

  const running = runTui(client, {
    env: { TERM: "xterm-256color" },
    input: input as unknown as ReadStream,
    output: output as unknown as WriteStream,
  });
  await eventually(() => onCatalog !== undefined);
  input.write("\u001b[<0;10");
  input.write(";7M");
  await eventually(() => renders === 1 && actions.some((value) => value.startsWith("opened:")));
  input.write("\u001b[<65;10;7M\u001b[<64;10;7M\u001b[6~\u001b[5~");
  input.write("\u001b[<0;10;7m");
  const listsBeforeEvent = lists;
  onCatalog?.({ action: "tags", documentId: documents[1]!.id });
  await eventually(() => lists > listsBeforeEvent);
  input.write("m");
  await eventually(() => actions.some((value) => value.startsWith("read:")));
  input.write("bq");
  await running;

  assert.match(terminal, /Rendered by mdmaid/);
  assert.match(terminal, /\u001b\[\?1049h/);
  assert.match(terminal, /\u001b\[\?1049l/);
  assert.match(terminal, /\u001b\[\?1000h\u001b\[\?1006h/);
  assert.match(terminal, /\u001b\[\?1006l\u001b\[\?1000l/);
  assert.equal(terminal.match(/\u001b\[2J/g)?.length, 1);
  assert.deepEqual(renderPreferences, { color: true, unicode: true });
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}
