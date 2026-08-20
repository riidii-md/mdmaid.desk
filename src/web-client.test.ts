import assert from "node:assert/strict";
import test from "node:test";

import {
  documentFragmentId,
  documentOutline,
  filterQueue,
  isSourceMissing,
  pendingReviewForDocument,
  queueCounts,
  requestDocumentPrint,
  reviewResponseError,
  webLoadFailure,
  visibleWorkspaces,
  type WebDocument,
  type WebFilters,
} from "./web-client.js";
import type { PublicReviewRequest, PublicWorkspace } from "./api-types.js";

const documents: WebDocument[] = [
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
    title: "TUI review",
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
  {
    id: "doc-33333333333333333333",
    workspaceId: "alpha",
    kind: "decision",
    storage: "reference",
    title: "Storage decision",
    attention: "approval",
    tags: ["architecture"],
    revision: 1,
    openedRevision: 1,
    completedRevision: 1,
    status: "done",
    archivedAt: null,
    missingAt: null,
    createdAt: "2026-08-08T12:00:00.000Z",
    updatedAt: "2026-08-08T12:00:00.000Z",
    route: "/d/doc-33333333333333333333",
  },
];

const pendingReview: PublicReviewRequest = {
  id: "review-11111111111111111111",
  documentId: documents[0]!.id,
  documentRevision: documents[0]!.revision,
  kind: "plan-decision",
  requestMessage: "Check the rollback path.",
  status: "pending",
  response: null,
  staleAt: null,
  createdAt: "2026-08-19T10:00:00.000Z",
};

test("filters the browser queue by workspace, status, and search", () => {
  const filters: WebFilters = {
    workspaceId: "alpha",
    status: "unread",
    search: "daemon architecture",
  };
  assert.deepEqual(
    filterQueue(documents, filters).map(({ id }) => id),
    ["doc-11111111111111111111"],
  );
  assert.deepEqual(filterQueue(documents, { search: "DESK-1" }), [
    documents[0],
  ]);
  assert.deepEqual(filterQueue(documents, { search: "codex" }), [
    documents[0],
  ]);
});

test("counts reading states for the browser navigation", () => {
  assert.deepEqual(queueCounts(documents), {
    all: 3,
    unread: 1,
    reading: 1,
    done: 1,
  });
});

test("shows actions only for explicit pending review requests", () => {
  assert.equal(
    pendingReviewForDocument([pendingReview], documents[0]!.id)?.requestMessage,
    "Check the rollback path.",
  );
  assert.equal(
    pendingReviewForDocument([pendingReview], documents[2]!.id),
    undefined,
  );
  assert.deepEqual(
    filterQueue(
      documents,
      { status: "all", actionsOnly: true },
      [pendingReview],
    ).map(({ id }) => id),
    [documents[0]!.id],
  );
});

test("requires explanatory text only when changes are requested", () => {
  assert.equal(
    reviewResponseError("changes_requested", "  "),
    "Explain what needs to change.",
  );
  assert.equal(
    reviewResponseError("changes_requested", "Add rollback proof."),
    undefined,
  );
  assert.equal(reviewResponseError("approved", ""), undefined);
  assert.equal(reviewResponseError("rejected", ""), undefined);
});

test("hides projects without visible documents from browser navigation", () => {
  const workspaces: PublicWorkspace[] = [
    { id: "alpha", name: "Alpha", documentCount: 99, route: "/w/alpha" },
    { id: "beta", name: "Beta", documentCount: 0, route: "/w/beta" },
    { id: "empty", name: "Empty", documentCount: 0, route: "/w/empty" },
  ];

  assert.deepEqual(visibleWorkspaces([documents[1]!], workspaces), [
    { id: "beta", name: "Beta", documentCount: 1, route: "/w/beta" },
  ]);
});

test("identifies documents whose registered source disappeared", () => {
  assert.equal(isSourceMissing(documents[0]!), false);
  assert.equal(
    isSourceMissing({
      ...documents[0]!,
      missingAt: "2026-08-13T09:00:00.000Z",
    }),
    true,
  );
});

test("builds document contents from rendered heading anchors", () => {
  assert.deepEqual(
    documentOutline([
      { id: "visible-plan", tagName: "H1", textContent: " Visible plan " },
      { id: "scope", tagName: "H2", textContent: "Scope" },
      { id: "details", tagName: "H4", textContent: "  Details  " },
      { id: "", tagName: "H2", textContent: "No anchor" },
      { id: "empty", tagName: "H3", textContent: "   " },
      { id: "paragraph", tagName: "P", textContent: "Not a heading" },
    ]),
    [
      { id: "visible-plan", level: 1, text: "Visible plan" },
      { id: "scope", level: 2, text: "Scope" },
      { id: "details", level: 4, text: "Details" },
    ],
  );
});

test("decodes document fragments after asynchronous rendering", () => {
  assert.equal(documentFragmentId("#details"), "details");
  assert.equal(documentFragmentId("#space%20heading"), "space heading");
  assert.equal(documentFragmentId(""), undefined);
  assert.equal(documentFragmentId("#"), undefined);
  assert.equal(documentFragmentId("#invalid%2"), undefined);
});

test("requests the browser print dialog for PDF export", () => {
  let calls = 0;
  requestDocumentPrint({
    print(): void {
      calls += 1;
    },
  });
  assert.equal(calls, 1);
});

test("explains how to recover when the browser session expires", () => {
  assert.deepEqual(webLoadFailure("unauthorized"), {
    guidance:
      "Run mdmaid-desk web and open the authenticated URL it prints in this browser.",
    liveStatus: "○ session expired",
    title: "Browser session expired",
  });
  assert.deepEqual(webLoadFailure(), {
    guidance: "Check that the local mdmaid.desk service is running, then reload.",
    liveStatus: "○ unavailable",
    title: "Could not load documents",
  });
});
