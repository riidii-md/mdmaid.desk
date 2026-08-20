import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { Catalog, DocumentSourceMissingError } from "./catalog.js";

async function fixture(): Promise<{
  catalog: Catalog;
  statePath: string;
  workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "reports"), { recursive: true });
  const statePath = join(root, "state", "catalog.sqlite3");
  const catalog = await Catalog.open(statePath);
  await catalog.addWorkspace({
    id: "example",
    name: "Example",
    root: workspace,
    artifactRoots: [workspace],
  });
  return { catalog, statePath, workspace };
}

test("registers documents idempotently and persists the catalog", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "plan.md");
  await writeFile(documentPath, "# Plan\n", "utf8");

  const first = await catalog.registerDocument({
    workspaceId: "example",
    taskId: "PROJECT-123",
    kind: "plan",
    title: "Implementation plan",
    path: documentPath,
    attention: "approval",
  });
  const second = await catalog.registerDocument({
    workspaceId: "example",
    taskId: "PROJECT-123",
    kind: "plan",
    title: "Updated implementation plan",
    path: documentPath,
    attention: "approval",
  });

  assert.equal(second.id, first.id);
  assert.equal(second.revision, 1);
  assert.equal(second.status, "unread");
  assert.equal(catalog.listDocuments().length, 1);
  assert.equal(catalog.listDocuments()[0]?.title, "Updated implementation plan");

  const restored = await Catalog.open(statePath);
  assert.deepEqual(restored.listDocuments(), catalog.listDocuments());

  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
});

test("registers workspace-local source links and persists their safe mappings", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const sourceDirectory = join(workspace, "Backend", "Features");
  const sourcePath = join(sourceDirectory, "AgentTurnV2.cs");
  const documentPath = join(workspace, "reports", "evidence.md");
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(
    sourcePath,
    "public sealed class AgentTurnV2\n{\n    // evidence\n}\n",
    "utf8",
  );
  await writeFile(
    documentPath,
    [
      "# Evidence",
      "",
      "[local source][agent-turn]",
      "[external](https://example.com/reference)",
      "[mail](mailto:reader@example.com)",
      "[section](#evidence)",
      "",
      "[agent-turn]: ../Backend/Features/AgentTurnV2.cs#L2",
      "[unused]: ../../outside-secret.cs",
      "",
    ].join("\n"),
    "utf8",
  );

  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Evidence",
    path: documentPath,
    attention: "review",
  });

  assert.equal(document.sourceLinks.length, 1);
  const sourceLink = document.sourceLinks[0]!;
  assert.match(sourceLink.id, /^source-[a-f0-9]{20}$/);
  assert.deepEqual(sourceLink, {
    id: sourceLink.id,
    href: "../Backend/Features/AgentTurnV2.cs#L2",
    workspacePath: join("Backend", "Features", "AgentTurnV2.cs"),
  });
  assert.equal(sourceLink.workspacePath, relative(workspace, sourcePath));

  const source = await catalog.readDocumentSource(document.id, sourceLink.id);
  assert.equal(source.name, "AgentTurnV2.cs");
  assert.equal(
    source.content,
    "public sealed class AgentTurnV2\n{\n    // evidence\n}\n",
  );

  await catalog.markDocumentOpened(document.id);
  assert.deepEqual(catalog.getDocument(document.id)?.sourceLinks, [sourceLink]);
  catalog.close();

  const restored = await Catalog.open(statePath, { legacyStatePath: false });
  assert.deepEqual(restored.getDocument(document.id)?.sourceLinks, [sourceLink]);
  assert.equal(
    (await restored.readDocumentSource(document.id, sourceLink.id)).content,
    source.content,
  );
  restored.close();
});

test("resolves registered Markdown source links to catalog documents", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "index.md");
  const targetPath = join(workspace, "reports", "guide.md");
  const draftPath = join(workspace, "reports", "draft.md");
  const snapshotPath = join(workspace, "reports", "snapshot.md");
  await writeFile(targetPath, "# Guide\n\n## Details\n", "utf8");
  await writeFile(draftPath, "# Draft\n", "utf8");
  await writeFile(snapshotPath, "# Snapshot\n", "utf8");
  await writeFile(
    documentPath,
    [
      "[guide](guide.md#details)",
      "[draft](draft.md)",
      "[snapshot](snapshot.md)",
      "",
    ].join("\n"),
    "utf8",
  );

  const target = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Guide",
    path: targetPath,
    attention: "none",
  });
  await catalog.importDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Snapshot",
    path: snapshotPath,
    attention: "none",
  });
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Index",
    path: documentPath,
    attention: "none",
  });

  const guideLink = document.sourceLinks.find(
    ({ href }) => href === "guide.md#details",
  );
  const draftLink = document.sourceLinks.find(({ href }) => href === "draft.md");
  const snapshotLink = document.sourceLinks.find(
    ({ href }) => href === "snapshot.md",
  );
  assert.ok(guideLink);
  assert.ok(draftLink);
  assert.ok(snapshotLink);

  const targets = catalog.resolveDocumentSourceTargets(document.id);
  assert.equal(targets.get(guideLink.id), target.id);
  assert.equal(targets.has(draftLink.id), false);
  assert.equal(targets.has(snapshotLink.id), false);
  catalog.close();
});

test("replaces source-link mappings when a document is registered again", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "changing-links.md");
  const firstSource = join(workspace, "first.ts");
  const secondSource = join(workspace, "second.ts");
  await writeFile(firstSource, "export const first = true;\n", "utf8");
  await writeFile(secondSource, "export const second = true;\n", "utf8");
  await writeFile(documentPath, "[first](../first.ts)\n", "utf8");

  const first = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Changing links",
    path: documentPath,
    attention: "none",
  });
  await writeFile(documentPath, "[second](../second.ts)\n", "utf8");
  const second = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Changing links",
    path: documentPath,
    attention: "none",
  });

  assert.equal(first.sourceLinks.length, 1);
  assert.deepEqual(
    second.sourceLinks.map(({ href }) => href),
    ["../second.ts"],
  );
  await assert.rejects(
    catalog.readDocumentSource(first.id, first.sourceLinks[0]!.id),
    /unknown document source link/,
  );
  catalog.close();
});

test("rejects local source links that escape the workspace or use symlinks", async () => {
  const { catalog, workspace } = await fixture();
  const outside = join(workspace, "..", "outside-secret.cs");
  const traversalDocument = join(workspace, "reports", "traversal.md");
  await writeFile(outside, "secret\n", "utf8");
  await writeFile(traversalDocument, "[secret](../../outside-secret.cs)\n", "utf8");

  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "example",
      kind: "brief",
      title: "Traversal",
      path: traversalDocument,
      attention: "none",
    }),
    /local source link is outside workspace root/,
  );

  const linkedSource = join(workspace, "linked-source.cs");
  const symlinkDocument = join(workspace, "reports", "symlink.md");
  await symlink(outside, linkedSource);
  await writeFile(symlinkDocument, "[secret](../linked-source.cs)\n", "utf8");
  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "example",
      kind: "brief",
      title: "Symlink",
      path: symlinkDocument,
      attention: "none",
    }),
    /local source link must not be a symlink/,
  );
  catalog.close();
});

test("re-authorizes linked sources when they are read", async () => {
  const { catalog, workspace } = await fixture();
  const sourcePath = join(workspace, "source.ts");
  const outside = join(workspace, "..", "replacement-secret.ts");
  const documentPath = join(workspace, "reports", "source-link.md");
  await writeFile(sourcePath, "export const safe = true;\n", "utf8");
  await writeFile(outside, "export const secret = true;\n", "utf8");
  await writeFile(documentPath, "[source](../source.ts)\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Source link",
    path: documentPath,
    attention: "none",
  });
  const sourceLink = document.sourceLinks[0]!;

  await rm(sourcePath);
  await symlink(outside, sourcePath);
  await assert.rejects(
    catalog.readDocumentSource(document.id, sourceLink.id),
    /linked source must not be a symlink/,
  );

  await rm(sourcePath);
  await assert.rejects(
    catalog.readDocumentSource(document.id, sourceLink.id),
    /linked source is missing/,
  );
  catalog.close();
});

test("bounds source-link expansion and rejects binary linked sources", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "bounded-links.md");
  const sourcePath = join(workspace, "binary.dat");
  await writeFile(sourcePath, Buffer.from([0]));
  await writeFile(documentPath, "[binary](../binary.dat)\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Bounded links",
    path: documentPath,
    attention: "none",
  });
  await assert.rejects(
    catalog.readDocumentSource(document.id, document.sourceLinks[0]!.id),
    /linked source must contain UTF-8 text/,
  );

  await writeFile(
    documentPath,
    Array.from(
      { length: 513 },
      (_, index) => `[source ${index}](../binary.dat#L${index + 1})`,
    ).join("\n"),
    "utf8",
  );
  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "example",
      kind: "brief",
      title: "Too many links",
      path: documentPath,
      attention: "none",
    }),
    /more than 512 links/,
  );
  catalog.close();
});

test("marks disappeared sources missing and clears the state when they return", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "temporary.md");
  await writeFile(documentPath, "# Temporary\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Temporary",
    path: documentPath,
    attention: "none",
  });

  await rm(documentPath);
  await assert.rejects(
    catalog.readDocument(document.id),
    (error: unknown) => {
      assert.ok(error instanceof DocumentSourceMissingError);
      assert.equal(error.document.id, document.id);
      assert.equal(error.message, "Document source is missing");
      return true;
    },
  );
  assert.notEqual(catalog.getDocument(document.id)?.missingAt, null);

  await writeFile(documentPath, "# Restored\n", "utf8");
  const restored = await catalog.readDocument(document.id);
  assert.equal(restored.content, "# Restored\n");
  assert.equal(restored.document.missingAt, null);
  catalog.close();
});

test("rejects documents outside registered artifact roots", async () => {
  const { catalog, workspace } = await fixture();
  const outsidePath = join(workspace, "..", "outside.md");
  await writeFile(outsidePath, "# Outside\n", "utf8");

  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "example",
      kind: "other",
      title: "Outside",
      path: outsidePath,
      attention: "none",
    }),
    /outside registered artifact roots/,
  );
});

test("imports an outside Markdown source into durable private storage", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const outsidePath = join(workspace, "..", "agent-output.md");
  await writeFile(outsidePath, "# Durable agent output\n", "utf8");

  const imported = await catalog.importDocument({
    workspaceId: "example",
    producer: "claude-code",
    kind: "brief",
    title: "Durable agent output",
    path: outsidePath,
    attention: "review",
    tags: ["agent"],
  });

  assert.equal(imported.storage, "managed");
  assert.notEqual(imported.path, outsidePath);
  assert.match(imported.path, /[/\\]managed[/\\]example[/\\]doc-[a-f0-9]{20}-[a-f0-9]{64}\.md$/);
  assert.equal((await stat(imported.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(statePath, "..", "managed"))).mode & 0o777, 0o700);

  const repeated = await catalog.importDocument({
    workspaceId: "example",
    producer: "claude-code",
    kind: "brief",
    title: "Durable agent output",
    path: outsidePath,
    attention: "review",
    tags: ["agent"],
  });
  assert.equal(repeated.id, imported.id);
  assert.equal(repeated.revision, 1);

  await writeFile(outsidePath, "# Durable agent output v2\n", "utf8");
  const changed = await catalog.importDocument({
    workspaceId: "example",
    producer: "claude-code",
    kind: "brief",
    title: "Durable agent output",
    path: outsidePath,
    attention: "review",
    tags: ["agent"],
  });
  assert.equal(changed.id, imported.id);
  assert.equal(changed.revision, 2);
  assert.notEqual(changed.path, imported.path);

  await rm(outsidePath);
  assert.equal(
    (await catalog.readDocument(imported.id)).content,
    "# Durable agent output v2\n",
  );

  const restored = await Catalog.open(statePath, { legacyStatePath: false });
  assert.equal(restored.getDocument(imported.id)?.storage, "managed");
  assert.equal(
    (await restored.readDocument(imported.id)).content,
    "# Durable agent output v2\n",
  );
  restored.close();
  catalog.close();
});

test("keeps registration root policy separate from managed imports", async () => {
  const { catalog, workspace } = await fixture();
  const outsidePath = join(workspace, "..", "outside-managed.md");
  const symlinkPath = join(workspace, "..", "outside-link.md");
  await writeFile(outsidePath, "# Managed\n", "utf8");
  await symlink(outsidePath, symlinkPath);

  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "example",
      kind: "other",
      title: "Reference",
      path: outsidePath,
      attention: "none",
    }),
    /outside registered artifact roots/,
  );
  await assert.rejects(
    catalog.importDocument({
      workspaceId: "example",
      kind: "other",
      title: "Symlink",
      path: symlinkPath,
      attention: "none",
    }),
    /must not be a symlink/,
  );

  const imported = await catalog.importDocument({
    workspaceId: "example",
    kind: "other",
    title: "Managed",
    path: outsidePath,
    attention: "none",
  });
  await assert.doesNotReject(
    catalog.addWorkspace({
      id: "example",
      name: "Example renamed",
      root: workspace,
      artifactRoots: [workspace],
    }),
  );
  assert.equal(catalog.getDocument(imported.id)?.storage, "managed");
  catalog.close();
});

test("rejects symlink escapes from registered artifact roots", async () => {
  const { catalog, workspace } = await fixture();
  const outsideDir = await mkdtemp(join(tmpdir(), "mdmaid-desk-outside-"));
  const outsidePath = join(outsideDir, "secret.md");
  await writeFile(outsidePath, "# Secret\n", "utf8");
  await symlink(outsideDir, join(workspace, "linked"));

  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "example",
      kind: "other",
      title: "Escaped",
      path: join(workspace, "linked", "secret.md"),
      attention: "none",
    }),
    /outside registered artifact roots/,
  );
});

test("rejects non-Markdown and oversized files", async () => {
  const { catalog, workspace } = await fixture();
  const textPath = join(workspace, "notes.txt");
  const largePath = join(workspace, "large.md");
  await writeFile(textPath, "notes", "utf8");
  await writeFile(largePath, "x".repeat(257), "utf8");

  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "example",
      kind: "other",
      title: "Notes",
      path: textPath,
      attention: "none",
    }),
    /Markdown files/,
  );
  await assert.rejects(
    catalog.importDocument({
      workspaceId: "example",
      kind: "other",
      title: "Notes",
      path: textPath,
      attention: "none",
    }),
    /Markdown files/,
  );

  const smallCatalog = await Catalog.open(join(workspace, ".state", "catalog.sqlite3"), {
    maxDocumentBytes: 256,
  });
  await smallCatalog.addWorkspace({
    id: "example",
    name: "Example",
    root: workspace,
    artifactRoots: [workspace],
  });
  await assert.rejects(
    smallCatalog.registerDocument({
      workspaceId: "example",
      kind: "other",
      title: "Large",
      path: largePath,
      attention: "none",
    }),
    /exceeds 256 bytes/,
  );
  await assert.rejects(
    smallCatalog.importDocument({
      workspaceId: "example",
      kind: "other",
      title: "Large import",
      path: largePath,
      attention: "none",
    }),
    /exceeds 256 bytes/,
  );
});

test("rejects symlinked managed storage without writing through it", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-managed-symlink-"));
  const workspace = join(root, "workspace");
  const statePath = join(root, "state", "catalog.sqlite3");
  const redirected = join(root, "redirected");
  const sourcePath = join(root, "outside.md");
  await mkdir(workspace);
  await mkdir(redirected);
  await writeFile(sourcePath, "# Outside\n", "utf8");
  const catalog = await Catalog.open(statePath, { legacyStatePath: false });
  await catalog.addWorkspace({
    id: "example",
    name: "Example",
    root: workspace,
    artifactRoots: [workspace],
  });
  await symlink(redirected, join(root, "state", "managed"));

  await assert.rejects(
    catalog.importDocument({
      workspaceId: "example",
      kind: "brief",
      title: "Outside",
      path: sourcePath,
      attention: "none",
    }),
    /non-symlink directory/,
  );
  assert.deepEqual(await readFile(sourcePath, "utf8"), "# Outside\n");
  assert.deepEqual(await readdir(redirected), []);
  catalog.close();
});

test("rejects malformed legacy catalog entries without consuming the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-invalid-state-"));
  const statePath = join(root, "catalog.sqlite3");
  const legacyStatePath = join(root, "catalog.json");
  await writeFile(
    legacyStatePath,
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [
        {
          id: "example",
          name: "Example",
          root: root,
          artifactRoots: "not-an-array",
        },
      ],
      documents: [],
    }),
    "utf8",
  );

  await assert.rejects(
    Catalog.open(statePath, { legacyStatePath }),
    /invalid workspace entry/,
  );
  await assert.doesNotReject(access(legacyStatePath));
});

test("rejects workspace updates that would orphan registered documents", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "review.md");
  const otherRoot = join(workspace, "other");
  await mkdir(otherRoot);
  await writeFile(documentPath, "# Review\n", "utf8");
  await catalog.registerDocument({
    workspaceId: "example",
    kind: "review",
    title: "Review",
    path: documentPath,
    attention: "review",
  });

  await assert.rejects(
    catalog.addWorkspace({
      id: "example",
      name: "Example",
      root: workspace,
      artifactRoots: [otherRoot],
    }),
    /exclude registered document/,
  );
});

test("tracks reading progress by content revision", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "status.md");
  await writeFile(documentPath, "# First revision\n", "utf8");

  const registered = await catalog.registerDocument({
    workspaceId: "example",
    producer: "codex",
    kind: "plan",
    title: "Status plan",
    path: documentPath,
    attention: "review",
    tags: ["Architecture", "architecture", "urgent"],
  });
  assert.equal(registered.revision, 1);
  assert.equal(registered.status, "unread");
  assert.deepEqual(registered.tags, ["architecture", "urgent"]);

  const opened = await catalog.markDocumentOpened(registered.id);
  assert.equal(opened.status, "reading");
  assert.equal(opened.openedRevision, 1);

  const completed = await catalog.markDocumentRead(registered.id);
  assert.equal(completed.status, "done");
  assert.equal(completed.completedRevision, 1);

  const metadataOnly = await catalog.registerDocument({
    workspaceId: "example",
    producer: "codex",
    kind: "plan",
    title: "Renamed status plan",
    path: documentPath,
    attention: "none",
    tags: ["architecture", "urgent"],
  });
  assert.equal(metadataOnly.revision, 1);
  assert.equal(metadataOnly.status, "done");

  await writeFile(documentPath, "# Second revision\n", "utf8");
  const changed = await catalog.registerDocument({
    workspaceId: "example",
    producer: "codex",
    kind: "plan",
    title: "Renamed status plan",
    path: documentPath,
    attention: "none",
    tags: ["architecture", "urgent"],
  });
  assert.equal(changed.revision, 2);
  assert.equal(changed.status, "unread");
  assert.equal(changed.openedRevision, 1);
  assert.equal(changed.completedRevision, 1);

  catalog.close();
  const restored = await Catalog.open(statePath);
  assert.deepEqual(restored.listDocuments(), [changed]);
  restored.close();
});

test("persists explicit review requests separately from reading progress", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "approval.md");
  await writeFile(documentPath, "# Approval\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    producer: "codex",
    kind: "plan",
    title: "Approval plan",
    path: documentPath,
    attention: "approval",
  });

  assert.deepEqual(catalog.listReviewRequests(), []);
  const request = await catalog.createReviewRequest({
    documentId: document.id,
    documentRevision: document.revision,
    kind: "plan-decision",
    requestMessage: "Please verify rollback coverage.\r\nKeep the rationale.",
  });
  assert.match(request.id, /^review-[a-f0-9]{20}$/);
  assert.equal(request.status, "pending");
  assert.equal(
    request.requestMessage,
    "Please verify rollback coverage.\nKeep the rationale.",
  );
  assert.equal(request.response, null);

  await catalog.markDocumentOpened(document.id);
  await catalog.markDocumentRead(document.id);
  assert.equal(catalog.getReviewRequest(request.id)?.status, "pending");

  catalog.close();
  const restored = await Catalog.open(statePath);
  assert.deepEqual(restored.getReviewRequest(request.id), request);
  restored.close();
});

test("records one durable human response and requires reasons for changes", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "decision.md");
  await writeFile(documentPath, "# Decision\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Decision plan",
    path: documentPath,
    attention: "none",
  });
  const request = await catalog.createReviewRequest({
    documentId: document.id,
    kind: "plan-decision",
    requestMessage: "Check the deployment order.",
  });

  await assert.rejects(
    catalog.respondToReviewRequest(request.id, {
      outcome: "changes_requested",
      message: "   ",
    }),
    /response message is required/,
  );
  const responded = await catalog.respondToReviewRequest(request.id, {
    outcome: "changes_requested",
    message: "Move the database migration before the daemon restart.",
  });
  assert.equal(responded.status, "changes_requested");
  assert.equal(
    responded.response?.message,
    "Move the database migration before the daemon restart.",
  );

  await catalog.archiveDocument(document.id);

  assert.deepEqual(
    await catalog.respondToReviewRequest(request.id, {
      outcome: "changes_requested",
      message: "Move the database migration before the daemon restart.",
    }),
    responded,
  );
  await assert.rejects(
    catalog.respondToReviewRequest(request.id, {
      outcome: "approved",
      message: "",
    }),
    /already has a different response/,
  );
  catalog.close();
});

test("stales a pending review when document content changes", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "revision-gate.md");
  await writeFile(documentPath, "# Version one\n", "utf8");
  const first = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Revision gate",
    path: documentPath,
    attention: "none",
  });
  const request = await catalog.createReviewRequest({
    documentId: first.id,
    documentRevision: first.revision,
    kind: "plan-decision",
    requestMessage: "Review this exact revision.",
  });

  await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Metadata only",
    path: documentPath,
    attention: "review",
  });
  assert.equal(catalog.getReviewRequest(request.id)?.status, "pending");

  await writeFile(documentPath, "# Version two\n", "utf8");
  await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Revision gate",
    path: documentPath,
    attention: "none",
  });
  assert.equal(catalog.getReviewRequest(request.id)?.status, "stale");
  await assert.rejects(
    catalog.respondToReviewRequest(request.id, {
      outcome: "approved",
      message: "",
    }),
    /review request is stale/,
  );
  catalog.close();
});

test("refuses a response when the source changed without re-registration", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "unobserved-revision.md");
  await writeFile(documentPath, "# Reviewed version\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Unobserved revision",
    path: documentPath,
    attention: "none",
  });
  const request = await catalog.createReviewRequest({
    documentId: document.id,
    kind: "plan-decision",
    requestMessage: "Review this exact file content.",
  });

  await writeFile(documentPath, "# Changed behind the catalog\n", "utf8");

  await assert.rejects(
    catalog.respondToReviewRequest(request.id, {
      outcome: "approved",
      message: "Looks good.",
    }),
    /review request is stale/,
  );
  assert.equal(catalog.getReviewRequest(request.id)?.status, "stale");
  catalog.close();
});

test("refuses to create a review for unregistered source changes", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "unregistered-create.md");
  await writeFile(documentPath, "# Registered version\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Registered version",
    path: documentPath,
    attention: "none",
  });

  await writeFile(documentPath, "# Changed before review creation\n", "utf8");

  await assert.rejects(
    catalog.createReviewRequest({
      documentId: document.id,
      kind: "plan-decision",
      requestMessage: "Review the current content.",
    }),
    /document content changed/,
  );
  assert.deepEqual(catalog.listReviewRequests(), []);
  catalog.close();
});

test("fails review creation and response closed when sources disappear", async () => {
  const { catalog, workspace } = await fixture();
  const responsePath = join(workspace, "reports", "missing-response.md");
  await writeFile(responsePath, "# Response source\n", "utf8");
  const responseDocument = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Response source",
    path: responsePath,
    attention: "none",
  });
  const request = await catalog.createReviewRequest({
    documentId: responseDocument.id,
    kind: "plan-decision",
    requestMessage: "Review before it disappears.",
  });
  await rm(responsePath);
  await assert.rejects(
    catalog.respondToReviewRequest(request.id, {
      outcome: "approved",
      message: "Approved.",
    }),
    /review request is stale/,
  );
  assert.equal(catalog.getReviewRequest(request.id)?.status, "stale");

  const createPath = join(workspace, "reports", "missing-create.md");
  await writeFile(createPath, "# Creation source\n", "utf8");
  const createDocument = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Creation source",
    path: createPath,
    attention: "none",
  });
  await rm(createPath);
  await assert.rejects(
    catalog.createReviewRequest({
      documentId: createDocument.id,
      kind: "plan-decision",
      requestMessage: "This cannot be reviewed.",
    }),
    /document source is unavailable/,
  );
  catalog.close();
});

test("creates pending review requests idempotently and rejects conflicts", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "idempotent-review.md");
  await writeFile(documentPath, "# Plan\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Plan",
    path: documentPath,
    attention: "none",
  });
  const input = {
    documentId: document.id,
    documentRevision: document.revision,
    kind: "plan-decision" as const,
    requestMessage: "Review it.",
  };
  const first = await catalog.createReviewRequest(input);
  await assert.rejects(
    catalog.archiveDocument(document.id),
    /document has a pending review request/,
  );
  assert.deepEqual(await catalog.createReviewRequest(input), first);
  await assert.rejects(
    catalog.createReviewRequest({
      ...input,
      requestMessage: "Review a different concern.",
    }),
    /already has a pending review request/,
  );
  await assert.rejects(
    catalog.createReviewRequest({
      ...input,
      documentRevision: 99,
    }),
    /document revision changed/,
  );
  await catalog.respondToReviewRequest(first.id, {
    outcome: "approved",
    message: "Approved.",
  });
  await catalog.archiveDocument(document.id);
  await assert.rejects(
    catalog.createReviewRequest(input),
    /document is archived/,
  );
  catalog.close();
});

test("persists tags and filters status, archive, and missing state", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const planPath = join(workspace, "reports", "plan.md");
  const reviewPath = join(workspace, "reports", "review.md");
  await writeFile(planPath, "# Plan\n", "utf8");
  await writeFile(reviewPath, "# Review\n", "utf8");

  const plan = await catalog.registerDocument({
    workspaceId: "example",
    taskId: "DESK-1",
    kind: "plan",
    title: "Plan's title",
    path: planPath,
    attention: "approval",
    tags: ["architecture", "task-1"],
  });
  const review = await catalog.registerDocument({
    workspaceId: "example",
    taskId: "DESK-2",
    kind: "review",
    title: "Review",
    path: reviewPath,
    attention: "review",
    tags: ["task-1"],
  });

  await catalog.markDocumentRead(plan.id);
  await catalog.markDocumentMissing(review.id);
  await catalog.archiveDocument(review.id);

  assert.deepEqual(
    catalog.listDocuments({ tag: "architecture" }).map(({ id }) => id),
    [plan.id],
  );
  assert.deepEqual(
    catalog.listDocuments({ status: "done" }).map(({ id }) => id),
    [plan.id],
  );
  assert.deepEqual(
    catalog.listDocuments({ archived: true, missing: true }).map(({ id }) => id),
    [review.id],
  );
  assert.equal(catalog.listDocuments().some(({ id }) => id === review.id), false);

  catalog.close();
  const restored = await Catalog.open(statePath);
  assert.deepEqual(restored.listDocuments({ archived: true })[0]?.tags, ["task-1"]);
  restored.close();
});

test("imports a legacy JSON catalog once and preserves it as a backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-legacy-state-"));
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "plan.md");
  const databasePath = join(root, "catalog.sqlite3");
  const legacyStatePath = join(root, "catalog.json");
  await mkdir(workspace);
  await writeFile(documentPath, "# Imported plan\n", "utf8");
  await writeFile(
    legacyStatePath,
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [
        {
          id: "example",
          name: "Example",
          root: workspace,
          artifactRoots: [workspace],
        },
      ],
      documents: [
        {
          id: "doc-0123456789abcdefabcd",
          workspaceId: "example",
          kind: "plan",
          title: "Imported plan",
          path: documentPath,
          attention: "none",
          createdAt: "2026-08-01T10:00:00.000Z",
          updatedAt: "2026-08-01T10:00:00.000Z",
        },
      ],
    }),
    "utf8",
  );

  const catalog = await Catalog.open(databasePath, { legacyStatePath });
  assert.equal(catalog.listWorkspaces().length, 1);
  assert.equal(catalog.listDocuments()[0]?.revision, 1);
  assert.equal(catalog.listDocuments()[0]?.status, "unread");
  catalog.close();

  await assert.rejects(access(legacyStatePath), { code: "ENOENT" });
  assert.equal(
    JSON.parse(await readFile(`${legacyStatePath}.migrated`, "utf8")).schemaVersion,
    1,
  );

  const restored = await Catalog.open(databasePath, { legacyStatePath });
  assert.equal(restored.listDocuments().length, 1);
  restored.close();
});

test("applies the SQLite schema migration and rejects a future schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-schema-"));
  const databasePath = join(root, "catalog.sqlite3");
  const catalog = await Catalog.open(databasePath, { legacyStatePath: false });
  catalog.close();

  const versionOne = new Database(databasePath);
  versionOne.exec("ALTER TABLE documents DROP COLUMN source_path");
  versionOne.exec("ALTER TABLE documents DROP COLUMN storage_kind");
  versionOne.pragma("user_version = 1");
  versionOne.close();
  const migrated = await Catalog.open(databasePath, { legacyStatePath: false });
  migrated.close();

  const versionTwo = new Database(databasePath);
  versionTwo.exec("DROP TABLE document_source_links");
  versionTwo.pragma("user_version = 2");
  versionTwo.close();
  const migratedAgain = await Catalog.open(databasePath, {
    legacyStatePath: false,
  });
  migratedAgain.close();

  const versionThree = new Database(databasePath);
  versionThree.exec("DROP TABLE review_responses");
  versionThree.exec("DROP TABLE review_requests");
  versionThree.pragma("user_version = 3");
  versionThree.close();
  const migratedReviews = await Catalog.open(databasePath, {
    legacyStatePath: false,
  });
  migratedReviews.close();

  const database = new Database(databasePath, { readonly: true });
  assert.equal(database.pragma("user_version", { simple: true }), 4);
  assert.deepEqual(
    database
      .prepare<[], { name: string }>("PRAGMA table_info(documents)")
      .all()
      .map(({ name }) => name)
      .filter((name) => name === "storage_kind" || name === "source_path"),
    ["storage_kind", "source_path"],
  );
  assert.deepEqual(
    database
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ name }) => name),
    [
      "document_source_links",
      "document_tags",
      "documents",
      "review_requests",
      "review_responses",
      "tags",
      "workspace_artifact_roots",
      "workspaces",
    ],
  );
  database.close();

  const futurePath = join(root, "future.sqlite3");
  const future = new Database(futurePath);
  future.pragma("user_version = 99");
  future.close();
  await assert.rejects(
    Catalog.open(futurePath, { legacyStatePath: false }),
    /unsupported SQLite catalog schema 99/,
  );
});

test("rolls back the entire legacy import when one document conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-legacy-rollback-"));
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "plan.md");
  const databasePath = join(root, "catalog.sqlite3");
  const legacyStatePath = join(root, "catalog.json");
  await mkdir(workspace);
  await writeFile(documentPath, "# Plan\n", "utf8");

  const workspaceEntry = {
    id: "example",
    name: "Example",
    root: workspace,
    artifactRoots: [workspace],
  };
  const documentEntry = {
    id: "doc-11111111111111111111",
    workspaceId: "example",
    kind: "plan",
    title: "Plan",
    path: documentPath,
    attention: "none",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
  };
  await writeFile(
    legacyStatePath,
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [workspaceEntry],
      documents: [
        documentEntry,
        { ...documentEntry, id: "doc-22222222222222222222" },
      ],
    }),
    "utf8",
  );

  await assert.rejects(
    Catalog.open(databasePath, { legacyStatePath }),
    /UNIQUE constraint failed/,
  );
  await writeFile(
    legacyStatePath,
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [workspaceEntry],
      documents: [documentEntry],
    }),
    "utf8",
  );

  const catalog = await Catalog.open(databasePath, { legacyStatePath });
  assert.deepEqual(
    catalog.listDocuments().map(({ id }) => id),
    [documentEntry.id],
  );
  catalog.close();
  await assert.rejects(access(legacyStatePath), { code: "ENOENT" });
  await assert.doesNotReject(access(`${legacyStatePath}.migrated`));
});

test("rejects a symlink used as the SQLite catalog path", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-db-symlink-"));
  const targetPath = join(root, "target.sqlite3");
  const linkedPath = join(root, "catalog.sqlite3");
  const database = new Database(targetPath);
  database.close();
  await symlink(targetPath, linkedPath);

  await assert.rejects(
    Catalog.open(linkedPath, { legacyStatePath: false }),
    /regular, non-symlink file/,
  );
});

test("supports lifecycle updates and all persisted document filters", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "lifecycle.md");
  await writeFile(documentPath, "# Lifecycle\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    taskId: "DESK-3",
    producer: "claude",
    kind: "review",
    title: "Lifecycle",
    path: documentPath,
    attention: "changes_requested",
    tags: ["Initial"],
  });

  assert.equal(catalog.listDocuments({ workspaceId: "example" }).length, 1);
  assert.equal(catalog.listDocuments({ taskId: "DESK-3" }).length, 1);
  assert.equal(catalog.listDocuments({ kind: "review" }).length, 1);
  assert.equal(
    catalog.listDocuments({ attention: "changes_requested" }).length,
    1,
  );
  assert.equal(catalog.listDocuments({ status: "unread" }).length, 1);
  assert.equal(catalog.listDocuments({ missing: false }).length, 1);

  await catalog.markDocumentOpened(document.id);
  assert.equal(catalog.listDocuments({ status: "reading" }).length, 1);
  await catalog.markDocumentRead(document.id);
  assert.equal(catalog.listDocuments({ status: "done" }).length, 1);
  assert.equal((await catalog.markDocumentUnread(document.id)).status, "unread");

  const tagged = await catalog.setDocumentTags(document.id, ["Updated", "final"]);
  assert.deepEqual(tagged.tags, ["final", "updated"]);
  await assert.rejects(
    catalog.setDocumentTags(document.id, ["not a valid tag"]),
    /tags must use/,
  );

  await catalog.markDocumentMissing(document.id);
  assert.equal((await catalog.markDocumentPresent(document.id)).missingAt, null);
  const archived = await catalog.archiveDocument(document.id);
  assert.equal((await catalog.archiveDocument(document.id)).archivedAt, archived.archivedAt);
  assert.equal((await catalog.restoreDocument(document.id)).archivedAt, null);

  await assert.rejects(
    catalog.markDocumentRead("invalid"),
    /invalid document id/,
  );
  await assert.rejects(
    catalog.markDocumentRead("doc-00000000000000000000"),
    /unknown document/,
  );
  catalog.close();
});

test("validates structured catalog input at runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-validation-"));
  const databasePath = join(root, "catalog.sqlite3");
  await assert.rejects(Catalog.open("", { legacyStatePath: false }), /database path/);
  await assert.rejects(
    Catalog.open(databasePath, { maxDocumentBytes: 0 }),
    /positive integer/,
  );
  await assert.rejects(
    Catalog.open(databasePath, { legacyStatePath: "" }),
    /legacyStatePath/,
  );

  const catalog = await Catalog.open(databasePath, { legacyStatePath: false });
  await assert.rejects(
    catalog.addWorkspace({
      id: "Invalid ID",
      name: "Invalid",
      root,
      artifactRoots: [root],
    }),
    /invalid workspace input/,
  );
  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "unknown",
      kind: "other",
      title: "Unknown",
      path: join(root, "unknown.md"),
      attention: "none",
    }),
    /unknown workspace/,
  );
  assert.throws(
    () => catalog.listDocuments({ status: "invalid" as never }),
    /invalid status filter/,
  );
  assert.throws(
    () => catalog.listDocuments({ tag: "not a valid tag" }),
    /invalid tag filter/,
  );
  catalog.close();
});

test("rejects malformed rows read from the SQLite catalog", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "tampered.md");
  await writeFile(documentPath, "# Tampered\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "other",
    title: "Tampered",
    path: documentPath,
    attention: "none",
  });
  catalog.close();

  const database = new Database(statePath);
  database
    .prepare("UPDATE documents SET kind = ? WHERE id = ?")
    .run("not-a-kind", document.id);
  database.close();

  const reopened = await Catalog.open(statePath, { legacyStatePath: false });
  assert.throws(() => reopened.listDocuments(), /invalid document row/);
  reopened.close();
});

test("rejects malformed private source-link mappings read from SQLite", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "linked.md");
  const sourcePath = join(workspace, "source.ts");
  await writeFile(sourcePath, "export const value = true;\n", "utf8");
  await writeFile(documentPath, "[source](../source.ts)\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "other",
    title: "Linked",
    path: documentPath,
    attention: "none",
  });
  catalog.close();

  const database = new Database(statePath);
  database
    .prepare(
      "UPDATE document_source_links SET workspace_path = ? WHERE document_id = ?",
    )
    .run("../outside.ts", document.id);
  database.close();

  const reopened = await Catalog.open(statePath, { legacyStatePath: false });
  assert.throws(() => reopened.getDocument(document.id), /invalid document row/);
  reopened.close();
});
