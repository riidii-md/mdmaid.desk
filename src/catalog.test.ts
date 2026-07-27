import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Catalog } from "./catalog.js";

async function fixture(): Promise<{
  catalog: Catalog;
  statePath: string;
  workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-show-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "reports"), { recursive: true });
  const statePath = join(root, "state", "catalog.json");
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
  assert.equal(catalog.listDocuments().length, 1);
  assert.equal(catalog.listDocuments()[0]?.title, "Updated implementation plan");

  const restored = await Catalog.open(statePath);
  assert.deepEqual(restored.listDocuments(), catalog.listDocuments());

  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
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

test("rejects symlink escapes from registered artifact roots", async () => {
  const { catalog, workspace } = await fixture();
  const outsideDir = await mkdtemp(join(tmpdir(), "mdmaid-show-outside-"));
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

  const smallCatalog = await Catalog.open(join(workspace, ".state", "catalog.json"), {
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
});

test("rejects malformed persisted catalog entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-show-invalid-state-"));
  const statePath = join(root, "catalog.json");
  await writeFile(
    statePath,
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

  await assert.rejects(Catalog.open(statePath), /invalid workspace entry/);
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
