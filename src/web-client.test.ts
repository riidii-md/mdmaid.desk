import assert from "node:assert/strict";
import test from "node:test";

import {
  changeReviewApprovalError,
  documentFragmentId,
  documentOutline,
  filterQueue,
  groupQueue,
  highlightDiffLine,
  isSourceMissing,
  nearestHeadingPosition,
  parseLiveSourceCatalogEvent,
  pendingReviewForDocument,
  queueGroupingPreference,
  queueCounts,
  requestDocumentPrint,
  reviewResponseError,
  renderMermaidNodes,
  shouldRefreshWebReader,
  sourceModeLabel,
  WEB_LINE_FEEDBACK_HINT,
  webDiffLineControlModel,
  webDiffRows,
  webLoadFailure,
  visibleWorkspaces,
  type WebDocument,
  type WebFilters,
} from "./web-client.js";
import { parseChangeReviewDiffs } from "./change-review.js";
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
  {
    id: "doc-44444444444444444444",
    workspaceId: "alpha",
    kind: "change-review",
    storage: "reference",
    title: "Authentication refactor",
    attention: "approval",
    tags: ["review"],
    revision: 1,
    openedRevision: null,
    completedRevision: null,
    status: "unread",
    archivedAt: null,
    missingAt: null,
    createdAt: "2026-08-08T13:00:00.000Z",
    updatedAt: "2026-08-08T13:00:00.000Z",
    route: "/d/doc-44444444444444444444",
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

test("provides a dedicated browser Change Reviews space", () => {
  assert.deepEqual(
    filterQueue(documents, { status: "all", changeReviewsOnly: true }).map(
      ({ id }) => id,
    ),
    ["doc-44444444444444444444"],
  );
});

test("builds native unified and side-by-side rows with intra-line changes", () => {
  const parsed = parseChangeReviewDiffs([
    "```diff",
    "diff --git a/src/auth.ts b/src/auth.ts",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1 +1 @@",
    "-return token == expected;",
    "+return token === expected;",
    "```",
  ].join("\n"));
  const rows = webDiffRows(parsed.files[0]!.hunks[0]!);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.old?.line, 1);
  assert.equal(rows[0]?.new?.line, 1);
  assert.equal(rows[0]?.old?.changed, "");
  assert.equal(rows[0]?.new?.changed, "=");
  assert.equal(rows[0]?.old?.suffix, " expected;");
});

test("syntax-highlights code diff lines without changing their text", () => {
  const source =
    'const request = await catalog.createReviewRequest({ kind: "change-decision", revision: 3 }); // durable';
  const tokens = highlightDiffLine("src/catalog.test.ts", source);

  assert.equal(tokens.map(({ text }) => text).join(""), source);
  assert.deepEqual(
    tokens
      .filter(({ kind }) => kind !== "plain")
      .map(({ kind, text }) => [kind, text]),
    [
      ["keyword", "const"],
      ["operator", "="],
      ["keyword", "await"],
      ["function", "createReviewRequest"],
      ["operator", "({"],
      ["property", "kind"],
      ["operator", ":"],
      ["string", '"change-decision"'],
      ["operator", ","],
      ["property", "revision"],
      ["operator", ":"],
      ["number", "3"],
      ["operator", "});"],
      ["comment", "// durable"],
    ],
  );
});

test("keeps unsupported and hostile diff text as inert plain text", () => {
  const source = '<script>alert("diff")</script>';
  assert.deepEqual(highlightDiffLine("fixture.unknown", source), [
    { kind: "plain", text: source },
  ]);
});

test("fails change-review approval closed when the native diff is incomplete", () => {
  assert.match(changeReviewApprovalError(undefined) ?? "", /native diff/i);
  assert.match(
    changeReviewApprovalError({
      schemaVersion: 1,
      files: [],
      warnings: ["A diff hunk was omitted."],
    }) ?? "",
    /incomplete/i,
  );
  assert.equal(
    changeReviewApprovalError({
      schemaVersion: 1,
      files: [{ path: "README.md", status: "modified", hunks: [] }],
      warnings: [],
    }),
    undefined,
  );
});

test("counts reading states for the browser navigation", () => {
  assert.deepEqual(queueCounts(documents), {
    all: 4,
    unread: 2,
    reading: 1,
    done: 1,
  });
});

test("groups the queue by project without changing document order", () => {
  const workspaces: PublicWorkspace[] = [
    {
      id: "alpha",
      name: "Alpha project",
      documentCount: 2,
      route: "/w/alpha",
    },
    { id: "beta", name: "Beta project", documentCount: 1, route: "/w/beta" },
  ];

  assert.deepEqual(groupQueue(documents, "project", workspaces), [
    {
      key: "project:alpha",
      label: "Alpha project",
      documents: [documents[0], documents[2], documents[3]],
    },
    {
      key: "project:beta",
      label: "Beta project",
      documents: [documents[1]],
    },
  ]);
});

test("groups different workspaces by their shared logical project", () => {
  const shared = [
    {
      ...documents[0]!,
      projectId: "project-11111111111111111111",
      projectName: "EyWizards / SA-2913 (COA Worker Continuity)",
    },
    {
      ...documents[1]!,
      projectId: "project-11111111111111111111",
      projectName: "EyWizards / SA-2913 (COA Worker Continuity)",
    },
  ];

  assert.deepEqual(groupQueue(shared, "project", []), [
    {
      key: "project:project-11111111111111111111",
      label: "EyWizards / SA-2913 (COA Worker Continuity)",
      documents: shared,
    },
  ]);
  assert.deepEqual(visibleWorkspaces(shared, []), [
    {
      id: "project-11111111111111111111",
      name: "EyWizards / SA-2913 (COA Worker Continuity)",
      documentCount: 2,
      route: "/p/project-11111111111111111111",
    },
  ]);
});

test("groups multi-tag documents under every tag and puts untagged last", () => {
  const untagged = {
    ...documents[1]!,
    id: "doc-44444444444444444444",
    tags: [],
  };
  const multiTagged = {
    ...documents[0]!,
    tags: ["architecture", "planning"],
  };

  assert.deepEqual(
    groupQueue([multiTagged, documents[1]!, untagged], "tag", []),
    [
      {
        key: "tag:architecture",
        label: "#architecture",
        documents: [multiTagged],
      },
      {
        key: "tag:planning",
        label: "#planning",
        documents: [multiTagged],
      },
      {
        key: "tag:terminal",
        label: "#terminal",
        documents: [documents[1]],
      },
      {
        key: "tag:untagged",
        label: "untagged",
        documents: [untagged],
      },
    ],
  );
});

test("keeps one flat ordered group for the all view", () => {
  assert.deepEqual(groupQueue(documents, "all", []), [
    { key: "all", documents },
  ]);
});

test("defaults invalid or missing grouping preferences to projects", () => {
  assert.equal(queueGroupingPreference(null), "project");
  assert.equal(queueGroupingPreference("unexpected"), "project");
  assert.equal(queueGroupingPreference("tag"), "tag");
  assert.equal(queueGroupingPreference("all"), "all");
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
    reviewResponseError("changes_requested", "Add rollback proof.", []),
    undefined,
  );
  assert.equal(
    reviewResponseError("changes_requested", "", [{
      id: "feedback-11111111111111111111",
      kind: "feedback",
      path: "src/auth.ts",
      line: 14,
      side: "new",
      message: "Handle the expired token here.",
    }]),
    undefined,
  );
  assert.equal(reviewResponseError("approved", ""), undefined);
  assert.equal(reviewResponseError("rejected", ""), undefined);
  assert.equal(reviewResponseError("superseded", ""), undefined);
});

test("makes pending line feedback an explicit visible action", () => {
  assert.deepEqual(webDiffLineControlModel(14, "new", true), {
    lineText: "14",
    feedbackMarker: "+",
    feedbackLabel: "Add feedback on new line 14",
  });
  assert.deepEqual(webDiffLineControlModel(14, "old", false), {
    lineText: "14",
  });
  assert.deepEqual(webDiffLineControlModel(null, "new", true), {
    lineText: "",
  });
  assert.equal(
    WEB_LINE_FEEDBACK_HINT,
    "Line feedback: click + beside a line number.",
  );
});

test("isolates Mermaid failures so one diagram cannot hide the document", async () => {
  const first = {} as Element;
  const second = {} as Element;
  const rendered: Element[] = [];
  const failed: Array<{ node: Element; error: unknown }> = [];

  await renderMermaidNodes(
    {
      async run({ nodes }) {
        const node = nodes[0]!;
        rendered.push(node);
        if (node === first) {
          throw new Error("invalid state diagram");
        }
      },
    },
    [first, second],
    (node, error) => failed.push({ node, error }),
  );

  assert.deepEqual(rendered, [first, second]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.node, first);
  assert.match(String(failed[0]?.error), /invalid state diagram/);
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

test("validates targeted live-source refresh events", () => {
  const selectedId = documents[0]!.id;
  const changed = parseLiveSourceCatalogEvent(JSON.stringify({
    action: "source-changed",
    documentId: selectedId,
    revision: 2,
  }));
  assert.deepEqual(changed, {
    action: "source-changed",
    documentId: selectedId,
    revision: 2,
  });
  assert.equal(shouldRefreshWebReader(changed, selectedId, 1), true);
  assert.equal(shouldRefreshWebReader(changed, selectedId, 2), false);
  assert.equal(
    shouldRefreshWebReader(changed, documents[1]!.id, 1),
    false,
  );
  assert.equal(
    shouldRefreshWebReader(
      { ...changed, action: "source-missing", revision: 1 },
      selectedId,
      1,
    ),
    true,
  );
  assert.equal(parseLiveSourceCatalogEvent("not json"), undefined);
  assert.equal(
    parseLiveSourceCatalogEvent(JSON.stringify({
      action: "source-changed",
      documentId: selectedId,
      revision: 0,
    })),
    undefined,
  );
  assert.equal(
    parseLiveSourceCatalogEvent(JSON.stringify({
      action: "source-changed",
      documentId: selectedId,
      revision: 2,
      path: "/private/source.md",
    })),
    undefined,
  );
  assert.equal(
    parseLiveSourceCatalogEvent(JSON.stringify({
      action: "tags",
      documentId: selectedId,
    })),
    undefined,
  );
});

test("selects the nearest heading for live reader position restoration", () => {
  assert.deepEqual(
    nearestHeadingPosition([
      { id: "overview", top: -240 },
      { id: "current", top: -12 },
      { id: "next", top: 180 },
    ]),
    { id: "current", top: -12 },
  );
  assert.equal(
    nearestHeadingPosition([{ id: "", top: -1 }]),
    undefined,
  );
});

test("labels reference and managed storage for readers", () => {
  assert.equal(sourceModeLabel("reference"), "live source");
  assert.equal(sourceModeLabel("managed"), "snapshot");
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
