import assert from "node:assert/strict";
import test from "node:test";

import {
  filterQueue,
  queueCounts,
  type WebDocument,
  type WebFilters,
} from "./web-client.js";

const documents: WebDocument[] = [
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
