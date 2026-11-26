import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import stringWidth from "string-width";
import { createMarkdownSourceMap } from "mdmaid";
import { renderTerminalDocument } from "./terminal-layout.js";

import type {
  CatalogEvent,
  CatalogSubscriptionOptions,
} from "./api-client.js";
import { DaemonHealthCompatibilityError, DeskApiClient, DeskApiError } from "./api-client.js";
import type {
  PublicDocument,
  PublicFeedbackSubmission,
  PublicReviewRequest,
  PublicWorkspace,
  TerminalBlock,
} from "./api-types.js";
import { documentStorageLabel } from "./api-types.js";
import { parseChangeReviewDiffs } from "./change-review.js";
import {
  applyTuiReader,
  applyTuiMissingReader,
  createTuiState,
  completeTuiReviewResponse,
  groupTuiQueue,
  handleTuiKey,
  handleTuiMouse,
  replaceTuiDocuments,
  refreshTuiReader,
  renderTui,
  runTui,
  shouldRefreshTuiReader,
  scrollTuiReaderToProgress,
} from "./tui.js";

const documents: PublicDocument[] = [
  {
    id: "doc-11111111111111111111",
    workspaceId: "alpha",
    taskId: "DESK-1",
    producer: "codex",
    kind: "plan",
    storage: "reference",
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
    storage: "reference",
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

const reviewRequests: PublicReviewRequest[] = [
  {
    id: "review-11111111111111111111",
    documentId: documents[0]!.id,
    documentRevision: documents[0]!.revision,
    kind: "plan-decision",
    requestMessage: "Verify rollback before approval.",
    status: "pending",
    response: null,
    staleAt: null,
    createdAt: "2026-08-19T10:00:00.000Z",
  },
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

test("groups the TUI queue by project, tag, or one ordered list", () => {
  const tagged: PublicDocument = {
    ...documents[0]!,
    id: "doc-33333333333333333333",
    title: "Tagged decision",
    tags: ["architecture", "release"],
  };
  const queue = [documents[0]!, documents[1]!, tagged];

  assert.deepEqual(
    groupTuiQueue(queue, "project", workspaces).map(({ key, label, documents }) => ({
      key,
      label,
      ids: documents.map(({ id }) => id),
    })),
    [
      {
        key: "project:alpha",
        label: "Alpha",
        ids: [documents[0]!.id, tagged.id],
      },
      {
        key: "project:beta",
        label: "Beta",
        ids: [documents[1]!.id],
      },
    ],
  );
  assert.deepEqual(
    groupTuiQueue(queue, "tag", workspaces).map(({ key, label }) => ({ key, label })),
    [
      { key: "tag:architecture", label: "architecture" },
      { key: "tag:terminal", label: "terminal" },
      { key: "tag:release", label: "release" },
    ],
  );
  assert.deepEqual(groupTuiQueue(queue, "all", workspaces), [
    { key: "all", documents: queue },
  ]);
});

test("groups TUI documents from different workspaces under one logical project", () => {
  const projectName = "EyWizards / SA-2913 (COA Worker Continuity)";
  const shared = documents.map((document) => ({
    ...document,
    projectId: "project-11111111111111111111",
    projectName,
  }));
  assert.deepEqual(
    groupTuiQueue(shared, "project", workspaces).map(
      ({ key, label, documents: grouped }) => ({
        key,
        label,
        ids: grouped.map(({ id }) => id),
      }),
    ),
    [
      {
        key: "project:project-11111111111111111111",
        label: projectName,
        ids: shared.map(({ id }) => id),
      },
    ],
  );
  assert.deepEqual(createTuiState(shared, workspaces).workspaces, [
    {
      id: "project-11111111111111111111",
      name: projectName,
      documentCount: 2,
      route: "/p/project-11111111111111111111",
    },
  ]);
});

test("renders TUI group sections and cycles the grouping mode", () => {
  let state = createTuiState(documents, workspaces);
  assert.equal(state.grouping, "project");
  assert.match(renderTui(state, 128, 30), /PROJECT · Alpha/);
  assert.match(renderTui(state, 128, 30), /PROJECT · Beta/);

  state = handleTuiKey(state, "g").state;
  assert.equal(state.grouping, "tag");
  assert.match(renderTui(state, 128, 30), /TAG · architecture/);

  state = handleTuiKey(state, "g").state;
  assert.equal(state.grouping, "all");
  assert.doesNotMatch(renderTui(state, 128, 30), /PROJECT ·|TAG ·/);
});

test("keeps missing documents visible and directly archivable", () => {
  const missing = {
    ...documents[0]!,
    missingAt: "2026-08-13T09:00:00.000Z",
  };
  const queue = createTuiState([missing], [workspaces[0]!]);
  const frame = renderTui(queue, 100, 24);
  assert.match(frame, /SOURCE MISSING/);
  assert.match(frame, /a archive/);
  const queueConfirmation = handleTuiKey(queue, "a");
  assert.deepEqual(queueConfirmation.effects, []);
  assert.deepEqual(handleTuiKey(queueConfirmation.state, "y").effects, [
    { type: "bulk-action", action: "archive", documentIds: [missing.id] },
  ]);

  const reader = applyTuiMissingReader(queue, missing);
  assert.equal(reader.mode, "reader");
  assert.match(renderTui(reader, 100, 24), /source file is missing/i);
  const readerConfirmation = handleTuiKey(reader, "a");
  assert.deepEqual(readerConfirmation.effects, []);
  assert.deepEqual(handleTuiKey(readerConfirmation.state, "y").effects, [
    { type: "bulk-action", action: "archive", documentIds: [missing.id] },
  ]);
});

test("selects document batches and confirms archive or permanent purge", () => {
  let state = createTuiState(documents, workspaces);
  state = handleTuiKey(state, " ").state;
  assert.deepEqual(state.selectedDocumentIds, [documents[0]!.id]);
  state = handleTuiKey(state, "A").state;
  assert.deepEqual(state.selectedDocumentIds, documents.map(({ id }) => id));

  const archive = handleTuiKey(state, "a");
  assert.deepEqual(archive.effects, []);
  assert.match(renderTui(archive.state, 100, 24), /restore them later/i);
  assert.equal(handleTuiKey(archive.state, "n").state.confirmation, undefined);
  assert.deepEqual(handleTuiKey(archive.state, "y").effects, [
    {
      type: "bulk-action",
      action: "archive",
      documentIds: documents.map(({ id }) => id),
    },
  ]);

  const purge = handleTuiKey(state, "X");
  assert.match(renderTui(purge.state, 100, 24), /cannot be undone/i);
  assert.deepEqual(handleTuiKey(purge.state, "y").effects, [
    {
      type: "bulk-action",
      action: "purge",
      documentIds: documents.map(({ id }) => id),
    },
  ]);
});

test("opens the archive and restores selected documents", () => {
  const archived = documents.map((document) => ({
    ...document,
    archivedAt: "2026-09-27T10:00:00.000Z",
  }));
  const archivedChangeReview: PublicDocument = {
    ...archived[0]!,
    id: "doc-33333333333333333333",
    kind: "change-review",
    title: "Archived change review",
  };
  let state = createTuiState(documents, workspaces);
  const openArchive = handleTuiKey(state, "v");
  assert.equal(openArchive.state.contentMode, "archive");
  assert.deepEqual(openArchive.effects, [{ type: "reload" }]);

  state = replaceTuiDocuments(
    openArchive.state,
    [...archived, archivedChangeReview],
    workspaces,
  );
  assert.deepEqual(
    state.visibleDocuments.map(({ id }) => id).sort(),
    [...archived.map(({ id }) => id), archivedChangeReview.id].sort(),
  );
  assert.equal(handleTuiKey(state, "c").state.contentMode, "archive");
  state = handleTuiKey(state, " ").state;
  assert.deepEqual(handleTuiKey(state, "u").effects, [
    {
      type: "bulk-action",
      action: "restore",
      documentIds: [archived[0]!.id],
    },
  ]);
});

test("filters by status, project, and terminal search input", () => {
  let state = createTuiState(documents, workspaces);
  state = handleTuiKey(state, "s").state;
  assert.equal(state.actionsOnly, true);
  assert.equal(state.statusFilter, "all");
  state = handleTuiKey(state, "s").state;
  assert.equal(state.actionsOnly, false);
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
  assert.match(queueFrame, /FILTERS/);
  assert.match(queueFrame, /Project.*Space.*Content.*STATUS/s);
  assert.match(queueFrame, /STATUS/);
  assert.match(queueFrame, /Daemon plan/);
  assert.match(queueFrame, /Terminal review/);
  assert.match(queueFrame, /live source/);
  assert.match(queueFrame, /j\/k/);
  assert.match(queueFrame, /\u001b\[38;2;143;181;175m/);

  const compactFrame = renderTui(queue, 68, 22);
  assert.equal(compactFrame.split("\n").length, 22);
  assert.match(compactFrame, /2 documents/);
  assert.doesNotMatch(compactFrame, /FILTERS/);

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
  assert.match(readerFrame, /live source/);
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

test("comments on a source row and submits feedback without a pending decision", async () => {
  const markdown = "# Heading\n\nAlpha beta.\n";
  const sourceMap = await createMarkdownSourceMap(markdown);
  let state = applyTuiReader(
    createTuiState(documents, workspaces),
    documents[1]!,
    "Heading\n\nAlpha beta.",
    "built-in",
    [],
    undefined,
    sourceMap,
  );
  state = handleTuiKey(state, "]").state;
  state = handleTuiKey(state, "f").state;
  for (const character of "Clarify this") {
    state = handleTuiKey(state, character).state;
  }
  state = handleTuiKey(state, "ctrl-d").state;
  assert.equal(state.reader?.markdownFeedbackItems.length, 1);
  const submitted = handleTuiKey(state, "s");
  assert.equal(submitted.effects[0]?.type, "feedback-submit");
  const effect = submitted.effects[0];
  assert.ok(effect?.type === "feedback-submit");
  assert.equal(effect.input.documentId, documents[1]!.id);
  assert.equal(effect.input.comments[0]?.anchor.kind, "markdown-selection-v1");
  assert.equal(effect.input.comments[0]?.message, "Clarify this");
});

test("fits phone terminals and keeps reading controls visible", () => {
  const queue = createTuiState(documents, workspaces);
  const reader = applyTuiReader(queue, documents[0]!, "Phone reader", "source", []);
  for (const width of [20, 24, 32, 40, 60, 100]) {
    for (const color of [false, true]) {
      for (const state of [queue, reader]) {
        const frame = renderTui(state, width, 24, { color });
        assert.equal(frame.split("\n").length, 24);
        for (const line of frame.split("\n")) {
          assert.equal(stringWidth(line), width, `frame must fit ${width} columns`);
        }
      }
    }
  }
  assert.match(renderTui(reader, 32, 24), /w wide/);
  assert.match(renderTui(reader, 32, 24), /b queue/);
  assert.match(renderTui(queue, 32, 24), /enter open/);
});

test("pans wide content without changing its geometry or scrolling the shell", () => {
  let reader = applyTuiReader(
    createTuiState(documents, workspaces), documents[0]!,
    `\u001b[31m${"左".repeat(8)}${"-".repeat(48)}RIGHT EDGE\u001b[39m\nshort`,
    "beautiful-mermaid", [],
  );
  reader = handleTuiKey(reader, "w").state;
  for (let index = 0; index < 30; index += 1) {
    reader = handleTuiKey(reader, "right").state;
  }
  const frame = renderTui(reader, 32, 24, { color: true });
  assert.match(frame, /RIGHT EDGE/);
  assert.match(frame, /h\/l/);
  assert.match(frame, /Daemon plan/);
  assert.match(frame, /\u001b\[31m/);
  for (const line of frame.split("\n")) assert.equal(stringWidth(line), 32);

  reader = handleTuiKey(reader, "0").state;
  assert.match(renderTui(reader, 32, 24), /左左左左左左左左/);
  reader = handleTuiKey(reader, "l").state;
  assert.doesNotMatch(renderTui(reader, 32, 24), /左左左左左左左左/);
  reader = handleTuiKey(reader, "h").state;
  assert.match(renderTui(reader, 32, 24), /左左左左左左左左/);
  reader = handleTuiKey(reader, "left").state;
  assert.match(renderTui(reader, 32, 24), /左左左左左左左左/);

  const fresh = applyTuiReader(reader, documents[1]!, "fresh", "source", []);
  assert.match(renderTui(fresh, 32, 24), /fresh/);
  assert.match(renderTui(fresh, 32, 24), /w wide/);
});

test("phone mouse targets match the visible compact controls", () => {
  const queue = createTuiState(documents, workspaces);
  assert.equal(handleTuiMouse(queue, {
    button: "left", x: footerColumn(queue, 32, "/ search"), y: 27,
  }, 32, 28).state.searching, true);
  const reader = applyTuiReader(queue, documents[0]!, "content", "source", []);
  const wide = handleTuiMouse(reader, {
    button: "left", x: footerColumn(reader, 32, "w wide"), y: 27,
  }, 32, 28);
  assert.equal(wide.state.reader?.wide, true);
  assert.deepEqual(wide.effects, [{ type: "rerender", documentId: documents[0]!.id }]);
  assert.equal(handleTuiMouse(wide.state, {
    button: "left", x: footerColumn(wide.state, 32, "b queue"), y: 27,
  }, 32, 28).state.mode, "queue");
});

test("horizontal clipping preserves grapheme boundaries and terminal cell alignment", () => {
  const reader = applyTuiReader(createTuiState(documents, workspaces), documents[0]!,
    `\u001b[31m${"界".repeat(25)}\u001b[39m\n${"👩‍💻é".repeat(20)}`, "source", []);
  const frame = renderTui({ ...reader, horizontalScroll: 1 }, 32, 24, { color: true });
  const plain = stripVTControlCharacters(frame).split("\n");
  assert.ok(plain[6]?.startsWith("│‹ 界"), "a clipped half of a wide character occupies a blank cell");
  assert.ok(plain[7]?.startsWith("│‹ é👩‍💻"), "emoji and combining characters stay whole");
  for (const line of frame.split("\n")) assert.equal(stringWidth(line), 32);
});

test("pans wide blocks by default while keeping surrounding prose fixed", async () => {
  const result = await renderTerminalDocument([
    "Prose stays at the left.", "", "```mermaid", "flowchart LR",
    "A[First service] --> B[Last service]", "```", "", "After the diagram.",
  ].join("\n"), { width: 30 });
  let reader = applyTuiReader(createTuiState(documents, workspaces), documents[0]!,
    result.output, result.backend, result.warnings, undefined, undefined, undefined, result.blocks);
  const before = renderTui(reader, 32, 30);
  assert.match(before, /h\/l pan/);
  reader = handleTuiKey(reader, "right").state;
  const after = renderTui(reader, 32, 30);
  assert.match(after, /│Prose stays at the left\./);
  assert.match(after, /│After the diagram\./);
  assert.notEqual(after, before);
  assert.equal(reader.reader?.wide, false, "no manual wide-view toggle is needed");
});

test("scrolling a large document does not parse or measure its content again", () => {
  const content = Array.from({ length: 3000 }, (_, index) => `line ${index}: ${"text ".repeat(15)}`).join("\n");
  let reader = applyTuiReader(createTuiState(documents, workspaces), documents[0]!, content, "source", []);
  Object.defineProperty(reader.reader, "content", {
    get: () => { throw new Error("document content was read again during scrolling"); },
  });
  for (let index = 0; index < 50; index++) {
    reader = handleTuiKey(reader, "j").state;
    assert.equal(renderTui(reader, 80, 30).split("\n").length, 30);
  }
});

test("targets only new live-source revisions at the open TUI reader", () => {
  const documentId = documents[0]!.id;
  assert.equal(
    shouldRefreshTuiReader(
      { action: "source-changed", documentId, revision: 2 },
      documentId,
      1,
    ),
    true,
  );
  assert.equal(
    shouldRefreshTuiReader(
      { action: "source-changed", documentId, revision: 1 },
      documentId,
      1,
    ),
    false,
  );
  assert.equal(
    shouldRefreshTuiReader(
      { action: "source-restored", documentId, revision: 1 },
      documentId,
      1,
    ),
    true,
  );
  assert.equal(
    shouldRefreshTuiReader(
      { action: "tags", documentId },
      documentId,
      1,
    ),
    false,
  );
  assert.equal(
    shouldRefreshTuiReader(
      { action: "source-missing", documentId, revision: 1 },
      documents[1]!.id,
      1,
    ),
    false,
  );
  assert.equal(documentStorageLabel("reference"), "live source");
  assert.equal(documentStorageLabel("managed"), "snapshot");
});

test("drops anchored TUI drafts when the rendered document revision changes", async () => {
  const firstMarkdown = "# Heading\n\nAlpha beta.\n";
  const secondMarkdown = "# Heading\n\nDifferent text.\n";
  let state = applyTuiReader(
    createTuiState(documents, workspaces),
    documents[1]!,
    "Heading\n\nAlpha beta.",
    "built-in",
    [],
    undefined,
    await createMarkdownSourceMap(firstMarkdown),
    `witness-${"a".repeat(64)}`,
  );
  state = handleTuiKey(state, "]").state;
  state = handleTuiKey(state, "f").state;
  for (const character of "Old anchor") {
    state = handleTuiKey(state, character).state;
  }
  state = handleTuiKey(state, "ctrl-d").state;
  assert.equal(state.reader?.markdownFeedbackItems.length, 1);

  const revised = { ...documents[1]!, revision: documents[1]!.revision + 1 };
  const refreshed = refreshTuiReader(
    state,
    revised,
    "Heading\n\nDifferent text.",
    "built-in",
    [],
    undefined,
    await createMarkdownSourceMap(secondMarkdown),
    `witness-${"b".repeat(64)}`,
  );
  assert.deepEqual(refreshed.reader?.markdownFeedbackItems, []);
  assert.equal(refreshed.reader?.feedbackGeneralMessage, "");
  assert.equal(refreshed.reader?.sourceWitness, `witness-${"b".repeat(64)}`);
});

test("filters explicit actions and composes a review response", () => {
  const queue = createTuiState(documents, workspaces, reviewRequests);
  const queueFrame = renderTui(queue, 128, 30);
  assert.doesNotMatch(queueFrame, /ACTIONS/);
  assert.match(
    queueFrame,
    /FILTERS[\s\S]*Project[\s\S]*Space[\s\S]*Content[\s\S]*STATUS[\s\S]*Waiting for you/,
  );
  assert.ok(
    queueFrame.indexOf("All projects") < queueFrame.indexOf("All spaces") &&
      queueFrame.indexOf("All spaces") < queueFrame.indexOf("Documents"),
  );
  assert.match(queueFrame, /Waiting for you/);

  const actions = handleTuiKey(queue, "r").state;
  assert.equal(actions.actionsOnly, true);
  assert.deepEqual(
    actions.visibleDocuments.map(({ id }) => id),
    [documents[0]!.id],
  );

  const reader = applyTuiReader(
    actions,
    documents[0]!,
    "Rendered plan.",
    "beautiful-mermaid",
    [],
  );
  const readerFrame = renderTui(reader, 100, 28);
  assert.match(readerFrame, /Verify rollback before approval/);
  assert.match(readerFrame, /y approve/);
  assert.match(readerFrame, /c changes/);
  assert.match(readerFrame, /x reject/);
  assert.match(readerFrame, /o supersede/);
  assert.ok(
    readerFrame.indexOf("Rendered plan.") <
      readerFrame.indexOf("ACTION REQUIRED"),
    "the decision section should follow the document content",
  );

  let composing = handleTuiKey(reader, "y").state;
  assert.equal(composing.reviewComposer?.outcome, "approved");
  for (const key of "Proceed after backup.") {
    composing = handleTuiKey(composing, key).state;
  }
  const submitted = handleTuiKey(composing, "ctrl-d");
  assert.deepEqual(submitted.effects, [
    {
      type: "review-response",
      requestId: reviewRequests[0]!.id,
      outcome: "approved",
      message: "Proceed after backup.",
    },
  ]);

  const changes = handleTuiKey(reader, "c").state;
  const invalid = handleTuiKey(changes, "ctrl-d");
  assert.deepEqual(invalid.effects, []);
  assert.match(invalid.state.message ?? "", /Explain what needs to change/);

  const superseding = handleTuiKey(reader, "o").state;
  assert.equal(superseding.reviewComposer?.outcome, "superseded");
});

test("provides a dedicated Change Reviews space", () => {
  const changeReview: PublicDocument = {
    ...documents[0]!,
    id: "doc-33333333333333333333",
    kind: "change-review",
    title: "Checkout refactor",
    attention: "approval",
  };
  const changeDecision: PublicReviewRequest = {
    ...reviewRequests[0]!,
    id: "review-33333333333333333333",
    documentId: changeReview.id,
    kind: "change-decision",
    requestMessage: "Review the exact implementation before publication.",
  };
  let state = createTuiState(
    [...documents, changeReview],
    workspaces,
    [...reviewRequests, changeDecision],
  );

  const inbox = renderTui(state, 128, 30);
  assert.match(inbox, /c content/);
  assert.doesNotMatch(inbox, /Checkout refactor/);

  state = handleTuiKey(state, "c").state;
  assert.equal(state.changeReviewsOnly, true);
  assert.deepEqual(
    state.visibleDocuments.map(({ id }) => id),
    [changeReview.id],
  );
  const changes = renderTui(state, 128, 30);
  assert.match(changes, /mdmaid\.desk.*CHANGE REVIEWS/);
  assert.match(changes, /1 change review/);
  assert.doesNotMatch(changes, /Daemon plan/);

  const reader = applyTuiReader(
    state,
    changeReview,
    "Changed files and relationship diagram.",
    "beautiful-mermaid",
    [],
  );
  const readerFrame = renderTui(reader, 100, 28);
  assert.match(readerFrame, /CHANGE REVIEW/);
  assert.match(readerFrame, /Review the exact implementation/);
  assert.match(readerFrame, /y approve/);

  const blocked = handleTuiKey(reader, "y").state;
  assert.equal(blocked.reviewComposer, undefined);
  assert.match(blocked.message ?? "", /complete native diff/i);
});

test("renders a continuous native file diff and returns multiple anchored feedback items", () => {
  const changeReview: PublicDocument = {
    ...documents[0]!,
    id: "doc-44444444444444444444",
    kind: "change-review",
    title: "Authentication refactor",
    attention: "approval",
  };
  const changeDecision: PublicReviewRequest = {
    ...reviewRequests[0]!,
    id: "review-44444444444444444444",
    documentId: changeReview.id,
    kind: "change-decision",
    requestMessage: "Review this exact implementation.",
  };
  const parsed = parseChangeReviewDiffs([
    "```diff",
    "diff --git a/src/auth.ts b/src/auth.ts",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1 +1 @@",
    "-return token == expected;",
    "+return token === expected;",
    "@@ -10 +10 @@",
    "-return fallback;",
    "+return secureFallback;",
    "diff --git a/test/auth.test.ts b/test/auth.test.ts",
    "--- a/test/auth.test.ts",
    "+++ b/test/auth.test.ts",
    "@@ -4 +4,2 @@",
    " expect(valid).toBe(true);",
    "+expect(expired).toBe(false);",
    "```",
  ].join("\n"));
  let state = applyTuiReader(
    createTuiState([changeReview], [workspaces[0]!], [changeDecision]),
    changeReview,
    "Rendered narrative",
    "beautiful-mermaid",
    [],
    parsed,
  );

  assert.equal(state.reader?.changeView, "diff");
  let frame = renderTui(state, 130, 32, { color: true });
  const plainFrame = stripVTControlCharacters(frame);
  assert.match(plainFrame, /FILES/);
  assert.match(plainFrame, /src\/auth\.ts/);
  assert.match(plainFrame, /UNIFIED/);
  assert.match(plainFrame, /token === expected/);
  assert.match(plainFrame, /secureFallback/);
  assert.match(plainFrame, /2 hunks/);
  assert.doesNotMatch(plainFrame, /hunk 1\/2/);
  assert.match(plainFrame, /f line feedback/);
  assert.match(frame, /\u001b\[[0-9;]*4m/);
  assert.match(frame, /\u001b\[48;2;/);
  assert.match(
    frame,
    /\u001b\[38;2;227;166;239m(?:\u001b\[[0-9;]*m)*return/,
  );

  const incomplete = structuredClone(state);
  incomplete.reader!.changeReview!.warnings.push("A diff hunk was omitted.");
  const blocked = handleTuiKey(incomplete, "y").state;
  assert.equal(blocked.reviewComposer, undefined);
  assert.match(blocked.message ?? "", /incomplete/i);

  const hostile = structuredClone(parsed);
  hostile.files[0]!.hunks[0]!.lines[0]!.text += "\u001b]52;c;ZXhmaWx0cmF0ZQ==\u0007";
  const hostileState = applyTuiReader(
    createTuiState([changeReview], [workspaces[0]!], [changeDecision]),
    changeReview,
    "Rendered narrative",
    "beautiful-mermaid",
    [],
    hostile,
  );
  assert.doesNotMatch(renderTui(hostileState, 130, 32, { color: true }), /\u001b\]52/);

  state = handleTuiKey(state, "n").state;
  assert.equal(state.reader?.changeFileIndex, 1);
  assert.match(renderTui(state, 130, 32), /test\/auth\.test\.ts/);
  state = handleTuiKey(state, "v").state;
  assert.equal(state.reader?.changeRangeStartIndex, 0);
  state = handleTuiKey(state, "j").state;
  state = handleTuiKey(state, "f").state;
  assert.equal(state.annotationComposer?.line, 4);
  assert.equal(state.annotationComposer?.endLine, 5);
  assert.equal(state.annotationComposer?.side, "new");
  for (const key of "Keep this assertion block together.") {
    state = handleTuiKey(state, key).state;
  }
  state = handleTuiKey(state, "ctrl-d").state;
  assert.equal(state.reader?.feedbackItems[0]?.endLine, 5);
  assert.match(
    renderTui(state, 130, 40),
    /expect\(expired\).*Keep this assertion block together\..*FEEDBACK/s,
  );
  state = handleTuiKey(state, "z").state;
  state = handleTuiKey(state, "p").state;
  assert.equal(state.reader?.changeFileIndex, 0);
  state = handleTuiKey(state, "j").state;
  assert.equal(state.reader?.changeLineIndex, 1);
  state = handleTuiKey(state, "j").state;
  assert.equal(state.reader?.changeHunkIndex, 1);
  assert.equal(state.reader?.changeLineIndex, 0);
  state = handleTuiKey(state, "k").state;
  assert.equal(state.reader?.changeHunkIndex, 0);
  assert.equal(state.reader?.changeLineIndex, 1);
  state = handleTuiKey(state, "k").state;
  assert.equal(state.reader?.changeLineIndex, 0);
  assert.match(renderTui(state, 130, 32), /j\/k line/);
  assert.match(renderTui(state, 130, 32), /p \/ n file/);
  state = handleTuiKey(state, "m").state;
  assert.equal(state.reader?.changeLayout, "side-by-side");
  frame = renderTui(state, 130, 32);
  assert.match(frame, /OLD.*NEW/);
  assert.match(stripVTControlCharacters(frame), /token === expected/);
  assert.match(stripVTControlCharacters(frame), /secureFallback/);

  state = handleTuiKey(state, "f").state;
  assert.equal(state.annotationComposer?.kind, "feedback");
  for (const key of "Use constant-time comparison.") {
    state = handleTuiKey(state, key).state;
  }
  state = handleTuiKey(state, "ctrl-d").state;
  assert.equal(state.reader?.feedbackItems.length, 1);
  assert.equal(state.reader?.feedbackItems[0]?.path, "src/auth.ts");
  assert.match(state.reader?.feedbackItems[0]?.hunkId ?? "", /^hunk-/);
  assert.equal(state.reader?.feedbackItems[0]?.line, 1);
  assert.equal(state.reader?.feedbackItems[0]?.side, "old");

  state = handleTuiKey(state, "t").state;
  for (const key of "Add an expired-token test.") {
    state = handleTuiKey(state, key).state;
  }
  state = handleTuiKey(state, "ctrl-d").state;
  assert.equal(state.reader?.feedbackItems.length, 2);
  assert.equal(state.reader?.feedbackItems[1]?.kind, "feedback");
  assert.equal(state.reader?.feedbackItems[1]?.hunkId, undefined);

  state = handleTuiKey(state, "y").state;
  assert.equal(state.reviewComposer?.outcome, "approved");
  assert.equal(state.reviewComposer?.items.length, 2);

  state = handleTuiKey(state, "escape").state;

  state = handleTuiKey(state, "z").state;
  assert.equal(state.reader?.feedbackItems.length, 1);
  state = handleTuiKey(state, "t").state;
  for (const key of "Add an expired-token test.") {
    state = handleTuiKey(state, key).state;
  }
  state = handleTuiKey(state, "ctrl-d").state;
  assert.equal(state.reader?.feedbackItems.length, 2);

  state = handleTuiKey(state, "c").state;
  assert.equal(state.reviewComposer?.outcome, "changes_requested");
  assert.equal(state.reviewComposer?.items.length, 2);
  assert.equal(state.reviewComposer?.message, "");
  for (const key of "Also simplify the retry branch.") {
    state = handleTuiKey(state, key).state;
  }
  const submitted = handleTuiKey(state, "ctrl-d");
  assert.equal(submitted.effects[0]?.type, "review-response");
  assert.deepEqual(
    submitted.effects[0]?.type === "review-response"
      ? submitted.effects[0].items
      : undefined,
    state.reader?.feedbackItems,
  );
  assert.equal(
    submitted.effects[0]?.type === "review-response"
      ? submitted.effects[0].message
      : undefined,
    "Also simplify the retry branch.",
  );
});

test("clears submitted TUI feedback and renders approved items as history", () => {
  const changeReview: PublicDocument = {
    ...documents[0]!,
    id: "doc-33333333333333333333",
    kind: "change-review",
    title: "Authentication refactor",
    attention: "approval",
  };
  const item = {
    id: "feedback-11111111111111111111",
    kind: "feedback" as const,
    path: "src/auth.ts",
    hunkId: "hunk-22222222222222222222",
    line: 1,
    side: "new" as const,
    message: "Use the constant-time helper.",
  };
  const request: PublicReviewRequest = {
    ...reviewRequests[0]!,
    documentId: changeReview.id,
    documentRevision: changeReview.revision,
    status: "approved",
    response: {
      outcome: "approved",
      message: "Approved with context.",
      items: [item],
      createdAt: "2026-08-19T10:05:00.000Z",
    },
  };
  const diff = parseChangeReviewDiffs([
    "```diff",
    "diff --git a/src/auth.ts b/src/auth.ts",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1 +1 @@",
    "-return token == expected;",
    "+return token === expected;",
    "```",
  ].join("\n"));
  let state = applyTuiReader(
    createTuiState([changeReview], [workspaces[0]!], [request]),
    changeReview,
    "Rendered narrative",
    "beautiful-mermaid",
    [],
    diff,
  );
  state = {
    ...state,
    reader: state.reader
      ? { ...state.reader, feedbackItems: [item] }
      : undefined,
    reviewComposer: {
      requestId: request.id,
      outcome: "approved",
      message: "Approved with context.",
      items: [item],
    },
  };

  state = completeTuiReviewResponse(state);

  assert.deepEqual(state.reader?.feedbackItems, []);
  assert.equal(state.reviewComposer, undefined);
  const frame = renderTui(state, 130, 32);
  assert.equal(frame.match(/Use the constant-time helper\./g)?.length, 1);
  assert.doesNotMatch(frame, /\[ \] feedback · Use the constant-time helper\./);
  assert.match(frame, /- feedback · Use the constant-time helper\./);
});

test("renders historical TUI feedback messages without placing old anchors inline", () => {
  const current = { ...documents[0]!, revision: 2 };
  let state = applyTuiReader(
    createTuiState(documents, workspaces),
    current,
    "Rendered narrative",
    "built-in",
    [],
  );
  const historical = {
    id: "feedback-99999999999999999999",
    documentId: current.id,
    documentRevision: 1,
    generalMessage: "Earlier overall note.",
    comments: [{
      id: "comment-99999999999999999999",
      intent: "feedback" as const,
      anchor: {
        kind: "markdown-v1" as const,
        start: { offset: 0, line: 1, column: 1 },
        end: { offset: 4, line: 1, column: 5 },
        exact: "Old",
        prefix: "",
        suffix: " text",
      },
      message: "Earlier anchored note.",
    }],
    createdAt: "2026-08-19T10:05:00.000Z",
    route: "/f/feedback-99999999999999999999",
  } satisfies PublicFeedbackSubmission;
  state = {
    ...state,
    reader: state.reader
      ? { ...state.reader, feedbackHistory: [historical] }
      : undefined,
  };

  const frame = renderTui(state, 130, 32);
  assert.match(frame, /revision 1 · historical/);
  assert.match(frame, /Earlier overall note\./);
  assert.match(frame, /Earlier anchored note\./);
  assert.match(frame, /document line 1/);
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
    { button: "left", x: 10, y: 6 },
    128,
    28,
  );
  assert.equal(project.state.workspaceFilter, "alpha");
  assert.equal(
    handleTuiMouse(project.state, { button: "left", x: 10, y: 6 }, 128, 28)
      .state.workspaceFilter,
    "beta",
  );

  const status = handleTuiMouse(
    queue,
    { button: "left", x: 10, y: 15 },
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
    handleTuiMouse(queue, { button: "left", x: 30, y: 15 }, 128, 28)
      .effects,
    [{ type: "open", documentId: documents[1]!.id }],
  );

  const opened = handleTuiMouse(
    queue,
    { button: "left", x: 30, y: 8 },
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
    { button: "left", x: footerColumn(reader, 100, "m read"), y: 23 },
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
  const archiveConfirmation = handleTuiMouse(
    queue,
    { button: "left", x: footerColumn(queue, 128, "a archive"), y: 27 },
    128,
    28,
  );
  assert.deepEqual(archiveConfirmation.effects, []);
  assert.deepEqual(handleTuiKey(archiveConfirmation.state, "y").effects, [
    {
      type: "bulk-action",
      action: "archive",
      documentIds: [documents[0]!.id],
    },
  ]);
  assert.equal(
    handleTuiMouse(queue, { button: "left", x: footerColumn(queue, 128, "/ search"), y: 27 }, 128, 28)
      .state.searching,
    true,
  );
});

test("switches Spaces fail-closed before requesting scoped reload", () => {
  const state = createTuiState(documents, workspaces, reviewRequests, [{
    id: "work",
    name: "Work",
    matchers: [{ kind: "tag", value: "work" }],
  }]);
  const switched = handleTuiKey(state, "x");
  assert.equal(switched.state.selectedSpace, "work");
  assert.deepEqual(switched.state.documents, []);
  assert.deepEqual(switched.state.reviewRequests, []);
  assert.deepEqual(switched.effects, [{ type: "reload" }]);
  assert.match(renderTui(switched.state, 128, 28), /Work/);
});

test("drags the reader in both directions without activating controls", () => {
  const original = applyTuiReader(createTuiState(documents, workspaces), documents[0]!,
    Array.from({ length: 50 }, (_, index) => `line ${index}: ${"wide text ".repeat(24)}`).join("\n"), "source", []);
  let reader = handleTuiMouse(original, { button: "left", x: 24, y: 15 }, 160, 24).state;
  let dragged = handleTuiMouse(reader, { button: "left-drag", x: 19, y: 12 }, 160, 24);
  assert.equal(dragged.state.scroll, 3);
  assert.equal(dragged.state.horizontalScroll, 5);
  assert.deepEqual(dragged.effects, []);
  reader = handleTuiMouse(dragged.state, { button: "left-drag", x: 17, y: 10 }, 160, 24).state;
  assert.equal(reader.scroll, 5);
  assert.equal(reader.horizontalScroll, 7);
  const released = handleTuiMouse(reader, { button: "left-up", x: footerColumn(reader, 160, "m read"), y: 23 }, 160, 24);
  assert.deepEqual(released.effects, [], "releasing over the footer must not mark a document read");
  dragged = handleTuiMouse(released.state, { button: "left-drag", x: 10, y: 8 }, 160, 24);
  assert.equal(dragged.state.scroll, 5, "a released gesture cannot keep scrolling");
  assert.equal(dragged.state.horizontalScroll, 7);
  reader = handleTuiMouse(original, { button: "left", x: 24, y: 15 }, 160, 24).state;
  const footer = handleTuiMouse(reader, { button: "left-drag", x: footerColumn(reader, 160, "m read"), y: 23 }, 160, 24);
  assert.deepEqual(footer.effects, []);
});

test("horizontal wheel events pan wide blocks without moving the queue", () => {
  const queue = createTuiState(documents, workspaces);
  assert.equal(handleTuiMouse(queue, { button: "wheel-right", x: 10, y: 10 }, 80, 24).state, queue);
  const reader = applyTuiReader(queue, documents[0]!, "long line ".repeat(30), "source", []);
  const right = handleTuiMouse(reader, { button: "wheel-right", x: 10, y: 10 }, 80, 24).state;
  assert.equal(right.horizontalScroll, 8);
  assert.equal(right.scroll, 0);
  const left = handleTuiMouse(right, { button: "wheel-left", x: 10, y: 10 }, 80, 24).state;
  assert.equal(left.horizontalScroll, 0);
});

test("dragging prose does not pan a different wide block", () => {
  const blocks: TerminalBlock[] = [{ kind: "flow", content: "Ordinary text." },
    { kind: "wide", content: "wide block ".repeat(12) }];
  const reader = applyTuiReader(createTuiState(documents, workspaces), documents[0]!,
    blocks.map((block) => block.content).join("\n\n"), "source", [], undefined, undefined, undefined, blocks);
  const prose = handleTuiMouse(reader, { button: "left", x: 20, y: 7 }, 32, 24).state;
  const draggedProse = handleTuiMouse(prose, { button: "left-drag", x: 10, y: 7 }, 32, 24).state;
  assert.equal(draggedProse.horizontalScroll, 0);
  const wide = handleTuiMouse(reader, { button: "left", x: 20, y: 9 }, 32, 24).state;
  assert.equal(handleTuiMouse(wide, { button: "left-drag", x: 10, y: 9 }, 32, 24).state.horizontalScroll, 10);
});

function footerColumn(state: ReturnType<typeof createTuiState>, width: number, label: string): number {
  const footer = stripVTControlCharacters(renderTui(state, width, 28)).split("\n").at(-2)!;
  const index = footer.indexOf(label);
  assert.ok(index >= 0, `footer must show ${label}`);
  return index + 1;
}

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
    {
      ...refreshed,
      reviewRequests: [
        {
          ...reviewRequests[0]!,
          requestMessage: "unsafe\u001b]52;c;review-stolen\u0007\nmessage",
        },
      ],
    },
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

test("drops TUI draft feedback when the pending review changes externally", () => {
  const item = {
    id: "feedback-11111111111111111111",
    kind: "feedback" as const,
    path: "src/auth.ts",
    message: "Draft feedback",
  };
  const base = applyTuiReader(
    createTuiState(documents, workspaces, reviewRequests),
    documents[0]!,
    "Rendered plan.",
    "beautiful-mermaid",
    [],
  );
  const editing = {
    ...base,
    reader: base.reader
      ? { ...base.reader, feedbackItems: [item] }
      : undefined,
    annotationComposer: {
      kind: "feedback" as const,
      path: item.path,
      message: item.message,
    },
    reviewComposer: {
      requestId: reviewRequests[0]!.id,
      outcome: "approved" as const,
      message: "",
      items: [item],
    },
  };
  const terminal: PublicReviewRequest = {
    ...reviewRequests[0]!,
    status: "approved",
    response: {
      outcome: "approved",
      message: "",
      items: [item],
      createdAt: "2026-08-19T10:05:00.000Z",
    },
  };
  const replacement: PublicReviewRequest = {
    ...reviewRequests[0]!,
    id: "review-22222222222222222222",
  };

  const unchanged = replaceTuiDocuments(
    editing,
    documents,
    workspaces,
    reviewRequests,
  );
  assert.deepEqual(unchanged.reader?.feedbackItems, [item]);
  assert.deepEqual(unchanged.annotationComposer, editing.annotationComposer);
  assert.deepEqual(unchanged.reviewComposer, editing.reviewComposer);

  for (const requests of [[terminal], [replacement]]) {
    const refreshed = replaceTuiDocuments(
      editing,
      documents,
      workspaces,
      requests,
    );
    assert.deepEqual(refreshed.reader?.feedbackItems, []);
    assert.equal(refreshed.annotationComposer, undefined);
    assert.equal(refreshed.reviewComposer, undefined);
  }
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

test("requires scrollable-block support before opening a terminal session", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ data: {
      service: "mdmaid.desk", status: "ok", version: 1,
      capabilities: ["spaces-v1", "scoped-content-v1"],
    } }), { headers: { "content-type": "application/json" } });
  });
  const client = new DeskApiClient("http://127.0.0.1:12345", "test-token");
  await assert.rejects(runTui(client), (error: unknown) =>
    error instanceof DaemonHealthCompatibilityError && /terminal-scroll-blocks-v1.*restart/.test(error.message));
  assert.equal(requests.length, 1, "an older daemon must be rejected before reading the queue");
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
  let onReady: (() => void) | undefined;
  const client = {
    listDocuments: async () => {
      lists += 1;
      return structuredClone(current);
    },
    listWorkspaces: async () => structuredClone(workspaces),
    listReviewRequests: async () => [],
    listSpaces: async () => [],
    renderDocument: async (
      id: string,
      _target: string,
      _width: number,
      preferences: { color?: boolean; unicode?: boolean },
    ) => {
      renders += 1;
      renderPreferences = preferences;
      const renderedDocument = current.find((document) => document.id === id)!;
      return {
        document: renderedDocument,
        target: "terminal" as const,
        content: `# Live reader\n\nRendered revision ${renderedDocument.revision} by mdmaid.`,
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
      onReady = options.onReady;
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
  onCatalog?.({});
  await eventually(() => lists > listsBeforeEvent);
  assert.equal(renders, 2);
  const listsBeforeReady = lists;
  onReady?.();
  await eventually(() => lists > listsBeforeReady);
  assert.equal(renders, 3);

  const openedId = actions
    .find((value) => value.startsWith("opened:"))
    ?.slice("opened:".length);
  assert.ok(openedId);
  current = current.map((document) =>
    document.id === openedId
      ? {
          ...document,
          revision: document.revision + 1,
          status: "unread" as const,
        }
      : document,
  );
  onCatalog?.({});
  await eventually(() => renders === 4);
  assert.equal(
    actions.filter((value) => value === `opened:${openedId}`).length,
    1,
  );
  input.write("m");
  await eventually(() => actions.some((value) => value.startsWith("read:")));
  input.write("bq");
  await running;

  assert.match(terminal, /Rendered revision 2 by mdmaid/);
  assert.match(terminal, /\u001b\[\?1049h/);
  assert.match(terminal, /\u001b\[\?1049l/);
  assert.match(terminal, /\u001b\[\?1000h\u001b\[\?1002h\u001b\[\?1006h\u001b\[\?1007h/);
  assert.match(terminal, /\u001b\[\?1007l\u001b\[\?1006l\u001b\[\?1002l\u001b\[\?1000l/);
  assert.equal(terminal.match(/\u001b\[2J/g)?.length, 1);
  assert.deepEqual(renderPreferences, { color: true, unicode: true, overflow: "scroll" });
});

test("discards a delayed TUI reload after switching to another Space", async () => {
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
  const allDocument = { ...documents[0]!, title: "All current" };
  const workDocument = { ...documents[1]!, title: "Work stale" };
  let resolveWork: ((value: PublicDocument[]) => void) | undefined;
  const workDocuments = new Promise<PublicDocument[]>((resolve) => {
    resolveWork = resolve;
  });
  const scopes: Array<string | undefined> = [];
  const client = {
    listDocuments: async (scope: { spaceId?: string } = {}) => {
      scopes.push(scope.spaceId);
      return scope.spaceId === "work" ? workDocuments : [allDocument];
    },
    listWorkspaces: async () => [workspaces[0]!],
    listReviewRequests: async () => [],
    listSpaces: async () => [{
      id: "work",
      name: "Work",
      matchers: [{ kind: "tag" as const, value: "work" }],
    }],
    subscribeCatalog: async (
      _listener: (event: CatalogEvent) => void,
      options: CatalogSubscriptionOptions = {},
    ) => {
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
  await eventually(() => terminal.includes("All current"));
  input.write("x");
  await eventually(() => scopes.includes("work"));
  input.write("x");
  resolveWork?.([workDocument]);
  await eventually(() => scopes.filter((scope) => scope === undefined).length >= 2);
  input.write("q");
  await running;

  assert.match(terminal, /All current/);
  assert.doesNotMatch(terminal, /Work stale/);
});

test("renders real tables and diagrams with horizontal scrolling enabled by default", async (t) => {
  const markdown = [
    "| Name | State | Details | Owner | Kind | Risk | Tests | Next |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    "| service | ready | Inspect the entire table | team | plan | low | pass | ship |", "",
    "```mermaid", "flowchart LR", "A[First service] --> B[RIGHT EDGE]", "```",
  ].join("\n");
  const renders: Array<{ width: number; content: string }> = [];
  const harness = await startPhoneTui(async (width) => {
    const result = await renderTerminalDocument(markdown, { width, color: false });
    renders.push({ width, content: result.output });
    return { content: result.output, blocks: result.blocks };
  });
  t.after(harness.close);
  harness.input.write("\r");
  await eventually(() => harness.actions.length === 1);
  assert.equal(renders[0]?.width, 30);
  await eventually(() => harness.terminal().includes("h/l pan"));
  assert.match(renders[0]!.content, /Inspect the entire table/);
  assert.ok(renders[0]?.content.split("\n").some((line) => line.includes("First service") && line.includes("RIGHT EDGE")), "wide diagrams retain aligned nodes on the same row");
  const beforePan = harness.terminal().length;
  harness.input.write("\u001b");
  harness.input.write("[C");
  harness.input.write("l".repeat(3));
  await eventually(() => harness.terminal().slice(beforePan).includes("RIGHT EDGE"));
  assert.equal(renders.length, 1, "panning uses the existing rendering without a mode toggle");
  harness.input.write("w");
  await eventually(() => renders.length === 2);
  assert.equal(renders[1]?.width, 1000);
  harness.input.write("w");
  await eventually(() => renders.length === 3);
  assert.equal(renders[2]?.width, 30);
  assert.equal(harness.actions.length, 1, "layout changes never mark a revision opened again");
  const beforeEscape = harness.terminal().length;
  harness.input.write("\u001b");
  await eventually(() => harness.terminal().slice(beforeEscape).includes("INBOX"));
});

test("rerenders at the latest phone width and ignores a resize response after returning to the queue", async (t) => {
  const widths: number[] = [];
  const pending: { release?: (content: string) => void } = {};
  const releaseRender = (content: string): void => { pending.release?.(content); };
  const harness = await startPhoneTui(async (width) => {
    widths.push(width);
    if (width === 22) return new Promise<string>((resolve) => { pending.release = resolve; });
    return `rendered at ${width}`;
  });
  t.after(async () => { releaseRender("cancelled"); await harness.close(); });
  harness.input.write("\r");
  await eventually(() => harness.actions.length === 1);
  harness.output.columns = 24;
  harness.output.emit("resize");
  await eventually(() => pending.release !== undefined);
  harness.output.columns = 40;
  harness.output.emit("resize");
  releaseRender("obsolete narrow rendering");
  await eventually(() => widths.includes(38));
  assert.doesNotMatch(harness.terminal(), /obsolete narrow rendering/);
  assert.match(harness.terminal(), /rendered at 38/);

  delete pending.release;
  harness.output.columns = 24;
  harness.output.emit("resize");
  await eventually(() => pending.release !== undefined);
  harness.input.write("b");
  releaseRender("late reader must stay closed");
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.doesNotMatch(harness.terminal(), /late reader must stay closed/);
});

test("accepts mobile drag events, application arrows, and horizontal wheels over SSH", async (t) => {
  const harness = await startPhoneTui(async () => Array.from({ length: 50 }, (_, index) =>
    `line ${index}: ${"wide text ".repeat(12)}`).join("\n"));
  t.after(harness.close);
  harness.input.write("\r");
  await eventually(() => harness.actions.length === 1);
  let position = harness.terminal().length;
  harness.input.write("\u001bO");
  harness.input.write("B");
  await eventually(() => harness.terminal().slice(position).includes("2-16 / 50"));
  position = harness.terminal().length;
  harness.input.write("\u001b[1;2B");
  await eventually(() => harness.terminal().slice(position).includes("3-17 / 50"));
  position = harness.terminal().length;
  harness.input.write("\u001bOA");
  await eventually(() => harness.terminal().slice(position).includes("2-16 / 50"));
  position = harness.terminal().length;
  harness.input.write("\u001b[<0;20;15M\u001b[<32;18;");
  harness.input.write("11M\u001b[<0;18;11m");
  await eventually(() => harness.terminal().slice(position).includes("6-20 / 50"));
  position = harness.terminal().length;
  harness.input.write("\u001b[<67;18;11M");
  await eventually(() => harness.terminal().slice(position).includes("h/l pan  11-"));
  assert.equal(harness.actions.length, 1);
});

test("accepts legacy mouse scrolling from clients that do not send SGR events", async (t) => {
  const harness = await startPhoneTui(async () => Array.from({ length: 50 }, (_, index) =>
    `line ${index}: ${"wide text ".repeat(12)}`).join("\n"));
  t.after(harness.close);
  harness.input.write("\r");
  await eventually(() => harness.actions.length === 1);
  const mouse = (code: number, x: number, y: number): string =>
    `\u001b[M${String.fromCharCode(code + 32, x + 32, y + 32)}`;
  let position = harness.terminal().length;
  const press = mouse(0, 20, 15);
  harness.input.write(press.slice(0, 4));
  harness.input.write(press.slice(4) + mouse(32, 18, 12) + mouse(3, 18, 12));
  await eventually(() => harness.terminal().slice(position).includes("4-18 / 50"));
  position = harness.terminal().length;
  harness.input.write(mouse(65, 18, 12));
  await eventually(() => harness.terminal().slice(position).includes("7-21 / 50"));
  assert.equal(harness.actions.length, 1);
});

async function startPhoneTui(render: (width: number) => Promise<string | { content: string; blocks: TerminalBlock[] }>) {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 32, rows: 24, isTTY: true });
  let terminal = "";
  const actions: string[] = [];
  output.on("data", (chunk: Buffer) => { terminal += chunk.toString(); });
  let subscribed = false;
  const client = {
    listDocuments: async () => documents,
    listWorkspaces: async () => workspaces,
    listReviewRequests: async () => [],
    renderDocument: async (_id: string, _target: string, width: number) => {
      const result = await render(width);
      return { document: documents[0]!, ...(typeof result === "string" ? { content: result } : result),
        backend: "beautiful-mermaid", warnings: [] };
    },
    act: async (_id: string, action: string) => { actions.push(action); return documents[0]!; },
    subscribeCatalog: async (_listener: unknown, options: CatalogSubscriptionOptions) => {
      subscribed = true;
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
    },
  } as unknown as DeskApiClient;
  const running = runTui(client, { input: input as unknown as ReadStream, output: output as unknown as WriteStream, color: false });
  await eventually(() => subscribed);
  return { input, output, actions, terminal: () => terminal, close: async () => { input.write("q"); await running; } };
}

test("opens a safe missing-source reader when a source disappears during render", async () => {
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

  const present = structuredClone(documents[0]!);
  const missing = {
    ...present,
    missingAt: "2026-08-13T09:00:00.000Z",
  };
  let sourceMissing = false;
  const actions: string[] = [];
  const client = {
    listDocuments: async () => [sourceMissing ? missing : present],
    listWorkspaces: async () => [workspaces[0]!],
    listReviewRequests: async () => [],
    listSpaces: async () => [],
    renderDocument: async () => {
      sourceMissing = true;
      throw new DeskApiError(
        410,
        "source_missing",
        "Document source is missing",
      );
    },
    act: async (id: string, action: string) => {
      actions.push(`${action}:${id}`);
      return missing;
    },
    bulkAct: async (action: string, ids: string[]) => {
      actions.push(...ids.map((id) => `${action}:${id}`));
      return action === "purge"
        ? { action, purgedIds: ids }
        : { action, documents: [] };
    },
    subscribeCatalog: async (
      _listener: (event: CatalogEvent) => void,
      options: CatalogSubscriptionOptions = {},
    ) => {
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
  input.write("\r");
  await eventually(() => /source file is missing/i.test(terminal));
  input.write("a");
  input.write("y");
  await eventually(() => actions.includes(`archive:${present.id}`));
  input.write("q");
  await running;

  assert.doesNotMatch(terminal, /ENOENT|\/Users\//);
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not reached");
}


test("source scroll progress reaches the top and bottom of the rendered document", () => {
  const reader = applyTuiReader(createTuiState(documents, workspaces), documents[0]!,
    Array.from({ length: 100 }, (_, i) => "Document row " + String(i + 1).padStart(3, "0")).join("\n"),
    "markdown", []);
  const middle = scrollTuiReaderToProgress(reader, 0.5, 30);
  assert.ok(middle.scroll > 0);
  const bottom = scrollTuiReaderToProgress(reader, 1, 30);
  assert.match(renderTui(bottom, 100, 30), /Document row 100/);
  assert.doesNotMatch(renderTui(bottom, 100, 30), /Document row 001/);
  const top = scrollTuiReaderToProgress(bottom, 0, 30);
  assert.match(renderTui(top, 100, 30), /Document row 001/);
  assert.equal(scrollTuiReaderToProgress(reader, 1, 500).scroll, 0);
});
