import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
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
  const queueFrame = renderTui(queue, 128, 28);
  assert.equal(queueFrame.split("\n").length, 28);
  assert.match(queueFrame, /mdmaid\.desk/);
  assert.match(queueFrame, /DOCUMENT INBOX/);
  assert.match(queueFrame, /PROJECTS/);
  assert.match(queueFrame, /STATUS/);
  assert.match(queueFrame, /Daemon plan/);
  assert.match(queueFrame, /Terminal review/);
  assert.match(queueFrame, /j\/k/);

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
  for (const line of readerFrame.split("\n")) {
    assert.equal(stringWidth(line), 100);
  }

  assert.deepEqual(handleTuiKey(reader, "m").effects, [
    { type: "action", action: "read", documentId: documents[0]?.id },
  ]);
  assert.equal(handleTuiKey(reader, "b").state.mode, "queue");
  assert.deepEqual(handleTuiKey(reader, "q").effects, [{ type: "quit" }]);
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
  input.write("j\r");
  await eventually(() => renders === 1 && actions.some((value) => value.startsWith("opened:")));
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
