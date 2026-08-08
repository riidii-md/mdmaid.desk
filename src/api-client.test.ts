import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeskApiClient } from "./api-client.js";
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
    const rendered = await client.renderDocument(document.id, "terminal", 78);
    assert.match(rendered.content, /Terminal plan/);
    assert.ok(["veol", "beautiful-mermaid", "source"].includes(rendered.backend));
    assert.equal((await client.act(document.id, "opened")).status, "reading");
    assert.equal((await client.act(document.id, "read")).status, "done");

    const controller = new AbortController();
    let ready!: () => void;
    let received!: (value: { action: string; documentId: string }) => void;
    const readyEvent = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const catalogEvent = new Promise<{ action: string; documentId: string }>(
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
