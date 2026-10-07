import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import { createMarkdownSourceMap } from "mdmaid";

import { Catalog } from "./catalog.js";
import { parseChangeReviewDiffs } from "./change-review.js";
import type { StoredFeedbackSubmission } from "./domain.js";
import {
  SQLITE_SCHEMA_VERSION,
  SqliteCatalogStorage,
} from "./sqlite-storage.js";

async function storageFixture() {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-feedback-storage-"));
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "document.md");
  const statePath = join(root, "catalog.sqlite3");
  await mkdir(workspace);
  await writeFile(documentPath, "# Document\n\nAlpha beta.\n", "utf8");
  const catalog = await Catalog.open(statePath, { legacyStatePath: false });
  await catalog.addWorkspace({
    id: "example",
    name: "Example",
    root: workspace,
    artifactRoots: [workspace],
    repository: "github.com/riidii-md/mdmaid.desk",
    repositoryName: "mdmaid.desk",
  });
  catalog.createSpace({
    id: "included",
    name: "Included",
    matchers: [{ kind: "repository", value: "github.com/riidii-md/mdmaid.desk" }],
  });
  catalog.createSpace({
    id: "excluded",
    name: "Excluded",
    matchers: [{ kind: "tag", value: "not-present" }],
  });
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Document",
    path: documentPath,
    attention: "none",
  });
  catalog.close();
  return { document, statePath };
}

function sampleFeedback(
  document: { id: string; revision: number; contentHash: string },
): StoredFeedbackSubmission {
  return {
    id: "feedback-0123456789abcdef0123",
    documentId: document.id,
    documentRevision: document.revision,
    documentContentHash: document.contentHash,
    generalMessage: "General note",
    comments: [
      {
        id: "comment-0123456789abcdef0123",
        intent: "feedback",
        anchor: {
          kind: "markdown-v1",
          start: { offset: 12, line: 3, column: 1 },
          end: { offset: 17, line: 3, column: 6 },
          exact: "Alpha",
          prefix: "",
          suffix: " beta.",
        },
        message: "Clarify this.",
      },
    ],
    createdAt: "2026-09-29T10:00:00.000Z",
  };
}

test("stores immutable feedback independently from review state and scopes reads", async () => {
  const { document, statePath } = await storageFixture();
  const storage = SqliteCatalogStorage.open(statePath);
  const submission = sampleFeedback(document);

  assert.equal(storage.saveFeedbackSubmission(submission), true);
  assert.equal(storage.saveFeedbackSubmission(submission), false);
  assert.deepEqual(storage.getFeedbackSubmission(submission.id), submission);
  assert.deepEqual(
    storage.getFeedbackSubmission(submission.id, { spaceId: "included" }),
    submission,
  );
  assert.equal(
    storage.getFeedbackSubmission(submission.id, { spaceId: "excluded" }),
    undefined,
  );
  assert.deepEqual(
    storage.listFeedbackSubmissions(
      { documentId: document.id, documentRevision: document.revision },
      { limit: 50 },
    ),
    [submission],
  );
  assert.deepEqual(storage.listReviewRequests(), []);

  const changed: StoredFeedbackSubmission = {
    ...submission,
    generalMessage: "Different",
  };
  assert.equal(storage.saveFeedbackSubmission(changed), false);
  assert.deepEqual(storage.getFeedbackSubmission(submission.id), submission);
  storage.close();
});

test("schema 9 review feedback backfills once into linked schema 10 submissions", async () => {
  const { document, statePath } = await storageFixture();
  const database = new Database(statePath);
  const reviewId = "review-0123456789abcdef0123";
  database.pragma("foreign_keys = ON");
  database.exec(
    `DROP TABLE review_responses;
     DROP TABLE feedback_comments;
     DROP TABLE feedback_submissions;
     CREATE TABLE review_responses (
       review_request_id TEXT PRIMARY KEY REFERENCES review_requests(id) ON DELETE CASCADE,
       outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'changes_requested', 'rejected', 'superseded')),
       message TEXT NOT NULL,
       items_json TEXT,
       created_at TEXT NOT NULL
     ) STRICT;`,
  );
  database.prepare(
    `INSERT INTO review_requests (
       id, document_id, document_revision, document_content_hash,
       kind, request_message, status, stale_at, created_at
     ) VALUES (?, ?, ?, ?, 'change-decision', 'Decide', 'changes_requested', NULL, ?)`,
  ).run(
    reviewId,
    document.id,
    document.revision,
    document.contentHash,
    "2026-09-29T09:00:00.000Z",
  );
  database.prepare(
    `INSERT INTO review_responses (
       review_request_id, outcome, message, items_json, created_at
     ) VALUES (?, 'changes_requested', 'Please revise.', ?, ?)`,
  ).run(
    reviewId,
    JSON.stringify([
      {
        id: "feedback-abcdef0123456789abcd",
        kind: "feedback",
        path: "src/example.ts",
        hunkId: "hunk-1234567890abcdef1234",
        line: 7,
        side: "new",
        message: "Fix this.",
      },
      {
        id: "feedback-fedcba9876543210fedc",
        kind: "todo",
        path: "docs/follow-up.md",
        message: "Follow up.",
      },
    ]),
    "2026-09-29T10:00:00.000Z",
  );
  database.pragma("user_version = 9");
  database.close();

  const storage = SqliteCatalogStorage.open(statePath);
  assert.equal(SQLITE_SCHEMA_VERSION, 10);
  const review = storage.getReviewRequest(reviewId);
  assert.ok(review?.response?.feedbackId);
  assert.equal(review.response.message, "Please revise.");
  assert.deepEqual(review.response.items?.map(({ id, kind }) => ({ id, kind })), [
    { id: "feedback-abcdef0123456789abcd", kind: "feedback" },
    { id: "feedback-fedcba9876543210fedc", kind: "todo" },
  ]);

  const feedbackId = review.response.feedbackId;
  const feedback = storage.getFeedbackSubmission(feedbackId);
  assert.equal(feedback?.reviewRequestId, reviewId);
  assert.equal(feedback?.generalMessage, "Please revise.");
  assert.equal(feedback?.comments[0]?.intent, "feedback");
  assert.deepEqual(feedback?.comments[0]?.anchor, {
    kind: "diff-lines-v1",
    path: "src/example.ts",
    hunkId: "hunk-1234567890abcdef1234",
    side: "new",
    line: 7,
  });
  assert.equal(feedback?.comments[1]?.intent, "todo");
  assert.deepEqual(feedback?.comments[1]?.anchor, {
    kind: "diff-file-v1",
    path: "docs/follow-up.md",
  });
  storage.close();

  const reopened = SqliteCatalogStorage.open(statePath);
  assert.equal(
    reopened.listFeedbackSubmissions({ documentId: document.id }, { limit: 50 })
      .length,
    1,
  );
  reopened.close();
});

test("rolls back schema 10 migration when legacy review feedback is malformed", async () => {
  const { document, statePath } = await storageFixture();
  const database = new Database(statePath);
  const reviewId = "review-99999999999999999999";
  database.pragma("foreign_keys = ON");
  database.exec(
    `DROP TABLE review_responses;
     DROP TABLE feedback_comments;
     DROP TABLE feedback_submissions;
     CREATE TABLE review_responses (
       review_request_id TEXT PRIMARY KEY REFERENCES review_requests(id) ON DELETE CASCADE,
       outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'changes_requested', 'rejected', 'superseded')),
       message TEXT NOT NULL,
       items_json TEXT,
       created_at TEXT NOT NULL
     ) STRICT;`,
  );
  database.prepare(
    `INSERT INTO review_requests (
       id, document_id, document_revision, document_content_hash,
       kind, request_message, status, stale_at, created_at
     ) VALUES (?, ?, ?, ?, 'change-decision', 'Decide', 'changes_requested', NULL, ?)`,
  ).run(
    reviewId,
    document.id,
    document.revision,
    document.contentHash,
    "2026-09-29T09:00:00.000Z",
  );
  database.prepare(
    `INSERT INTO review_responses (
       review_request_id, outcome, message, items_json, created_at
     ) VALUES (?, 'changes_requested', 'Please revise.', ?, ?)`,
  ).run(reviewId, "{not-json", "2026-09-29T10:00:00.000Z");
  database.pragma("user_version = 9");
  database.close();

  assert.throws(
    () => SqliteCatalogStorage.open(statePath),
    /invalid stored review feedback items/,
  );
  const unchanged = new Database(statePath, { readonly: true });
  assert.equal(unchanged.pragma("user_version", { simple: true }), 9);
  const tables = unchanged.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all() as Array<{ name: string }>;
  assert.equal(tables.some(({ name }) => name === "feedback_submissions"), false);
  assert.equal(tables.some(({ name }) => name === "feedback_comments"), false);
  assert.equal(tables.some(({ name }) => name === "review_responses"), true);
  unchanged.close();
});

test("catalog creates retry-safe selected-text feedback without changing waiting state", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-feedback-catalog-"));
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "document.md");
  const content = "# Document\n\nAlpha beta.\n";
  await mkdir(workspace);
  await writeFile(documentPath, content, "utf8");
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  await catalog.addWorkspace({
    id: "example",
    name: "Example",
    root: workspace,
    artifactRoots: [workspace],
  });
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Document",
    path: documentPath,
    attention: "none",
  });
  const map = await createMarkdownSourceMap(content);
  const text = map.segments.find((segment) => segment.text === "Alpha beta.");
  assert.ok(text);
  const input = {
    id: "feedback-11111111111111111111",
    documentId: document.id,
    documentRevision: document.revision,
    sourceWitness: catalog.feedbackSourceWitness(document.id),
    generalMessage: "Overall note.",
    comments: [{
      id: "comment-11111111111111111111",
      intent: "feedback" as const,
      anchor: {
        kind: "markdown-selection-v1" as const,
        start: { ref: text.ref, offset: 0 },
        end: { ref: text.ref, offset: 5 },
      },
      message: "Explain this term.",
    }],
  };

  const created = await catalog.createFeedback(input);
  assert.equal(created.id, input.id);
  assert.equal(created.route, `/f/${input.id}`);
  assert.equal(created.comments[0]?.anchor.kind, "markdown-v1");
  assert.deepEqual(
    created.comments[0]?.anchor.kind === "markdown-v1"
      ? {
          exact: created.comments[0].anchor.exact,
          start: created.comments[0].anchor.start.offset,
          end: created.comments[0].anchor.end.offset,
        }
      : undefined,
    { exact: "Alpha", start: content.indexOf("Alpha"), end: content.indexOf("Alpha") + 5 },
  );
  assert.deepEqual(await catalog.createFeedback(input), created);
  assert.deepEqual(catalog.getFeedback(input.id), created);
  assert.deepEqual(catalog.listFeedback({ documentId: document.id }), {
    items: [created],
  });
  assert.deepEqual(catalog.listReviewRequests(), []);

  const second = await catalog.createFeedback({
    id: "feedback-77777777777777777777",
    documentId: document.id,
    documentRevision: document.revision,
    generalMessage: "Second submission.",
    comments: [],
  });
  const firstPage = catalog.listFeedback({ documentId: document.id, limit: 1 });
  assert.deepEqual(firstPage.items, [second]);
  assert.ok(firstPage.nextCursor);
  assert.deepEqual(catalog.listFeedback({
    documentId: document.id,
    limit: 1,
    cursor: firstPage.nextCursor,
  }), { items: [created] });

  await assert.rejects(
    catalog.createFeedback({ ...input, generalMessage: "Conflicting retry." }),
    /feedback id already has different content/,
  );
  await assert.rejects(
    catalog.createFeedback({ ...input, documentRevision: document.revision + 1 }),
    /document revision changed/,
  );
  await assert.rejects(
    catalog.createFeedback({
      ...input,
      id: "feedback-99999999999999999999",
      sourceWitness: `witness-${"0".repeat(64)}`,
    }),
    /source witness changed/,
  );
  const { sourceWitness: _sourceWitness, ...withoutWitness } = input;
  await assert.rejects(
    catalog.createFeedback({
      ...withoutWitness,
      id: "feedback-88888888888888888888",
    }),
    /requires a source witness/,
  );
  catalog.close();
});

test("completes a review and stores its mixed feedback in one linked submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-review-feedback-"));
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "change.md");
  const content = "# Review\n\nExplain this.\n\n```diff\ndiff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n```\n";
  await mkdir(workspace);
  await writeFile(documentPath, content, "utf8");
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  await catalog.addWorkspace({
    id: "example",
    name: "Example",
    root: workspace,
    artifactRoots: [workspace],
  });
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "change-review",
    title: "Review",
    path: documentPath,
    attention: "approval",
  });
  const request = await catalog.createReviewRequest({
    documentId: document.id,
    kind: "change-decision",
    requestMessage: "Decide.",
  });
  const map = await createMarkdownSourceMap(content, {
    omitFencedCodeLanguages: ["diff"],
  });
  const text = map.segments.find((segment) => segment.text === "Explain this.");
  assert.ok(text);
  const hunk = parseChangeReviewDiffs(content).files[0]?.hunks[0];
  assert.ok(hunk);
  const feedback = {
    id: "feedback-22222222222222222222",
    documentId: document.id,
    documentRevision: document.revision,
    sourceWitness: catalog.feedbackSourceWitness(document.id),
    generalMessage: "Please revise.",
    comments: [
      {
        id: "comment-22222222222222222222",
        intent: "feedback" as const,
        anchor: {
          kind: "markdown-selection-v1" as const,
          start: { ref: text.ref, offset: 0 },
          end: { ref: text.ref, offset: 7 },
        },
        message: "Be specific.",
      },
      {
        id: "comment-33333333333333333333",
        intent: "feedback" as const,
        anchor: {
          kind: "diff-lines-v1" as const,
          path: "src/a.ts",
          hunkId: hunk.id,
          side: "new" as const,
          line: 1,
        },
        message: "Keep the new behavior covered.",
      },
      {
        id: "comment-44444444444444444444",
        intent: "todo" as const,
        anchor: {
          kind: "diff-lines-v1" as const,
          path: "src/a.ts",
          hunkId: hunk.id,
          side: "new" as const,
          line: 1,
        },
        message: "Follow up on this exact line.",
      },
    ],
  };

  const responded = await catalog.respondToReviewRequest(request.id, {
    outcome: "rejected",
    message: "Please revise.",
    feedback,
  });
  assert.equal(responded.response?.feedbackId, feedback.id);
  assert.deepEqual(responded.response?.items?.map(({ id, message }) => ({ id, message })), [{
    id: "feedback-33333333333333333333",
    message: "Keep the new behavior covered.",
  }]);
  assert.deepEqual(
    catalog.getReviewRequest(request.id)?.response?.items,
    responded.response?.items,
  );
  const stored = catalog.getFeedback(feedback.id);
  assert.equal(stored?.reviewRequestId, request.id);
  assert.equal(stored?.comments[0]?.anchor.kind, "markdown-v1");
  assert.equal(stored?.comments[1]?.anchor.kind, "diff-lines-v1");
  assert.equal(stored?.comments[2]?.intent, "todo");
  assert.deepEqual(
    await catalog.respondToReviewRequest(request.id, {
      outcome: "rejected",
      message: "Please revise.",
      feedback,
    }),
    responded,
  );
  await assert.rejects(
    catalog.respondToReviewRequest(request.id, {
      outcome: "rejected",
      message: "Please revise.",
      feedback: {
        ...feedback,
        comments: feedback.comments.map((comment, index) => index === 0
          ? { ...comment, message: "Changed retry payload." }
          : comment),
      },
    }),
    /different response/,
  );
  catalog.close();

  const reopened = await Catalog.open(join(root, "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  assert.deepEqual(
    reopened.getReviewRequest(request.id)?.response?.items,
    responded.response?.items,
  );
  assert.equal(reopened.getFeedback(feedback.id)?.comments[2]?.intent, "todo");
  reopened.close();
});
