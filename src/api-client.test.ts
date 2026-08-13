import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DeskApiClient,
  DeskApiError,
  type CatalogEvent,
} from "./api-client.js";
import { Catalog } from "./catalog.js";
import { startDeskServer } from "./server.js";

test("uses the versioned daemon API for terminal client operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-api-client-"));
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "plan.md");
  await mkdir(workspace);
  await writeFile(documentPath, "# Terminal plan\n", "utf8");
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
    kind: "plan",
    title: "Terminal plan",
    path: documentPath,
    attention: "none",
    tags: ["terminal"],
  });
  const server = await startDeskServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
  });

  try {
    const client = new DeskApiClient(server.url, server.token);
    assert.equal((await client.health()).status, "ok");
    assert.deepEqual(
      (await client.listDocuments()).map(({ id }) => id),
      [document.id],
    );
    assert.deepEqual(
      (await client.listWorkspaces()).map(({ id }) => id),
      ["example"],
    );
    const rendered = await client.renderDocument(document.id, "terminal", 78, {
      color: true,
      unicode: false,
    });
    assert.match(rendered.content, /Terminal plan/);
    assert.match(rendered.content, /\u001b\[[0-9;]*m/);
    assert.equal(rendered.backend, "beautiful-mermaid");
    assert.equal((await client.act(document.id, "opened")).status, "reading");
    assert.equal((await client.act(document.id, "read")).status, "done");

    const controller = new AbortController();
    let ready!: () => void;
    let received!: (value: CatalogEvent) => void;
    const readyEvent = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const catalogEvent = new Promise<CatalogEvent>(
      (resolve) => {
        received = resolve;
      },
    );
    const subscription = client.subscribeCatalog(received, {
      signal: controller.signal,
      onReady: ready,
    });
    await readyEvent;
    await client.act(document.id, "unread");
    assert.deepEqual(await catalogEvent, {
      action: "unread",
      documentId: document.id,
    });
    controller.abort();
    await subscription;
  } finally {
    await server.close();
    catalog.close();
  }
});

test("preserves typed source-missing errors for client recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-api-missing-"));
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "temporary.md");
  await mkdir(workspace);
  await writeFile(documentPath, "# Temporary\n", "utf8");
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
    title: "Temporary",
    path: documentPath,
    attention: "none",
  });
  const server = await startDeskServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    token: "missing-token",
  });
  await rm(documentPath);

  try {
    const client = new DeskApiClient(server.url, server.token);
    await assert.rejects(
      client.renderDocument(document.id, "terminal"),
      (error: unknown) => {
        assert.ok(error instanceof DeskApiError);
        assert.equal(error.status, 410);
        assert.equal(error.code, "source_missing");
        assert.equal(error.message, "Document source is missing");
        return true;
      },
    );
  } finally {
    await server.close();
    catalog.close();
  }
});

test("rejects malformed or unauthorized daemon responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-api-client-auth-"));
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  const server = await startDeskServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    token: "correct-token",
  });
  try {
    const client = new DeskApiClient(server.url, "wrong-token");
    await assert.rejects(client.listDocuments(), /Authentication required/);
  } finally {
    await server.close();
    catalog.close();
  }
});

test("routes producer workspace and document mutations through the daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-api-producer-"));
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "review.md");
  await mkdir(workspace);
  await writeFile(documentPath, "# Review\n", "utf8");
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  const server = await startDeskServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    token: "producer-token",
  });
  try {
    const client = new DeskApiClient(server.url, server.token);
    const controller = new AbortController();
    let ready!: () => void;
    let received!: (value: {
      action: string;
      documentId?: string;
      workspaceId?: string;
    }) => void;
    const readyEvent = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const workspaceEvent = new Promise<{
      action: string;
      documentId?: string;
      workspaceId?: string;
    }>((resolve) => {
      received = resolve;
    });
    const subscription = client.subscribeCatalog(received, {
      signal: controller.signal,
      onReady: ready,
    });
    await readyEvent;
    const added = await client.addWorkspace({
      id: "example",
      name: "Example",
      root: workspace,
      artifactRoots: [workspace],
    });
    assert.equal(added.id, "example");
    assert.deepEqual(await workspaceEvent, {
      action: "workspace-added",
      workspaceId: "example",
    });

    const document = await client.registerDocument({
      workspaceId: "example",
      producer: "codex",
      kind: "review",
      title: "Review",
      path: documentPath,
      attention: "review",
      tags: ["agent"],
    });
    assert.equal(document.workspaceId, "example");
    assert.equal(document.producer, "codex");
    assert.deepEqual(document.tags, ["agent"]);
    const outsidePath = join(root, "outside.md");
    await writeFile(outsidePath, "# Managed\n", "utf8");
    const imported = await client.importDocument({
      workspaceId: "example",
      kind: "brief",
      title: "Managed",
      path: outsidePath,
      attention: "none",
    });
    assert.equal(imported.storage, "managed");
    controller.abort();
    await subscription;
  } finally {
    await server.close();
    catalog.close();
  }
});
