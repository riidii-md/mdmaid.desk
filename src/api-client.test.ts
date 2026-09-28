import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  DeskApiClient,
  DeskApiError,
  type CatalogEvent,
} from "./api-client.js";
import { Catalog } from "./catalog.js";
import { SqliteCatalogStorage } from "./sqlite-storage.js";
import { startLiveSourceCoordinator } from "./live-sources.js";
import { startDeskServer } from "./server.js";

test("rejects unsafe daemon client configuration", async () => {
  assert.throws(
    () => new DeskApiClient("file:///tmp/mdmaid.sock", "long-enough-token"),
    /HTTP or HTTPS/,
  );
  assert.throws(
    () => new DeskApiClient("http://user:secret@127.0.0.1", "long-enough-token"),
    /must not contain credentials/,
  );
  assert.throws(
    () => new DeskApiClient("http://127.0.0.1", "short"),
    /at least 8 characters/,
  );
  const client = new DeskApiClient("http://127.0.0.1:1", "long-enough-token");
  await assert.rejects(
    client.renderDocument(
      "doc-11111111111111111111",
      "terminal",
      10,
    ),
    /render width must be an integer between 20 and 1000/,
  );
});

test("reconciles workspace identity through the authenticated daemon API", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-api-reconcile-"));
  const workspace = join(root, "workspace");
  const statePath = join(root, "catalog.sqlite3");
  await mkdir(workspace);
  const canonicalWorkspace = await realpath(workspace);
  const storage = SqliteCatalogStorage.open(statePath);
  for (const id of ["task-derived", "stable-repository"]) {
    storage.saveWorkspace(
      {
        id,
        name: id,
        root: canonicalWorkspace,
        artifactRoots: [canonicalWorkspace],
      },
      { key: "github.com/acme/repository", name: "Repository" },
    );
  }
  storage.close();
  const catalog = await Catalog.open(statePath, { legacyStatePath: false });
  const server = await startDeskServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    token: "reconcile-token",
  });

  try {
    const client = new DeskApiClient(server.url, server.token);
    assert.ok(
      (await client.health()).capabilities?.includes("workspace-reconciliation-v1"),
    );
    assert.deepEqual(
      await client.reconcileWorkspace("task-derived", {
        targetWorkspaceId: "stable-repository",
        apply: true,
      }),
      {
        sourceWorkspaceId: "task-derived",
        targetWorkspaceId: "stable-repository",
        applied: true,
        movedDocumentIds: [],
        discardedDocumentIds: [],
        blockingConflicts: [],
        reviewRequestCount: 0,
      },
    );
    assert.deepEqual(
      catalog.listWorkspaces().map(({ id }) => id),
      ["stable-repository"],
    );
  } finally {
    await server.close();
    catalog.close();
  }
});

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
    assert.deepEqual(await client.health(), {
      service: "mdmaid.desk",
      status: "ok",
      version: 1,
      capabilities: [
        "spaces-v1",
        "scoped-content-v1",
        "workspace-reconciliation-v1",
      ],
    });
    assert.deepEqual(await client.listSpaces(), []);
    const repositories = await client.listRepositories();
    assert.equal(repositories.length, 1);
    assert.match(repositories[0]?.key ?? "", /^local:[a-f0-9]{64}$/);
    assert.deepEqual(repositories[0]?.workspaceIds, ["example"]);
    assert.equal(repositories[0]?.kind, "local");
    assert.deepEqual(await client.createSpace({
      id: "terminal",
      name: "Terminal",
      matchers: [{ kind: "tag", value: "terminal" }],
    }), {
      id: "terminal",
      name: "Terminal",
      matchers: [{ kind: "tag", value: "terminal" }],
    });
    assert.deepEqual(
      (await client.listDocuments({ spaceId: "terminal" })).map(({ id }) => id),
      [document.id],
    );
    assert.deepEqual(
      (await client.listWorkspaces({ spaceId: "terminal" })).map(({ id }) => id),
      ["example"],
    );
    assert.equal((await client.getDocument(document.id, { spaceId: "terminal" })).id, document.id);
    assert.match(
      (await client.renderDocument(
        document.id,
        "terminal",
        78,
        {},
        { spaceId: "terminal" },
      )).content,
      /Terminal plan/,
    );
    assert.equal((await client.getSpace("terminal")).name, "Terminal");
    assert.equal((await client.renameSpace("terminal", "Work")).name, "Work");
    assert.deepEqual(
      (await client.replaceSpaceMatchers("terminal", [
        { kind: "repository-namespace", value: "github.com/example" },
      ])).matchers,
      [{ kind: "repository-namespace", value: "github.com/example" }],
    );
    assert.deepEqual(await client.listDocuments({ spaceId: "terminal" }), []);
    await assert.rejects(
      client.getDocument(document.id, { spaceId: "terminal" }),
      (error: unknown) => error instanceof DeskApiError && error.status === 404,
    );
    assert.deepEqual(await client.deleteSpace("terminal"), { id: "terminal" });
    assert.deepEqual(
      (await client.listDocuments()).map(({ id }) => id),
      [document.id],
    );
    assert.deepEqual(
      (await client.listWorkspaces()).map(({ id }) => id),
      ["example"],
    );
    assert.deepEqual(await client.listProjects(), [
      {
        id: document.projectId,
        name: document.projectName,
        documentCount: 1,
        route: `/p/${document.projectId}`,
      },
    ]);
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
    assert.deepEqual(await catalogEvent, {});
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

test("preserves complete Mermaid validation reports from the daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-api-mermaid-"));
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "broken.md");
  await mkdir(workspace);
  await writeFile(documentPath, [
    "```mermaid",
    "stateDiagram-v2",
    "  [*] -->",
    "```",
    "",
    "```mermaid",
    "stateDiagram-v2",
    "  Ready -->",
    "```",
  ].join("\n"), "utf8");
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  await catalog.addWorkspace({
    id: "example",
    name: "Example",
    root: workspace,
    artifactRoots: [workspace],
  });
  const server = await startDeskServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    token: "mermaid-token",
  });

  try {
    const client = new DeskApiClient(server.url, server.token);
    await assert.rejects(
      client.registerDocument({
        workspaceId: "example",
        kind: "review",
        title: "Broken",
        path: documentPath,
        attention: "review",
      }),
      (error: unknown) => {
        assert.ok(error instanceof DeskApiError);
        assert.equal(error.status, 422);
        assert.equal(error.code, "invalid_mermaid");
        assert.equal(error.validation?.diagramCount, 2);
        assert.deepEqual(
          error.validation?.issues.map(({ block, line }) => ({ block, line })),
          [
            { block: 1, line: 1 },
            { block: 2, line: 6 },
          ],
        );
        return true;
      },
    );
  } finally {
    await server.close();
    catalog.close();
  }
});

test("receives validated path-free live source events with revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-api-live-source-"));
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "live.md");
  await mkdir(workspace);
  await writeFile(documentPath, "# Original\n", "utf8");
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  await catalog.addWorkspace({
    id: "example",
    name: "Example",
    root: workspace,
    artifactRoots: [workspace],
  });
  let emitChange: ((filename: string | Buffer | null) => void) | undefined;
  let watchClosed = false;
  const server = await startDeskServer(
    {
      catalog,
      host: "127.0.0.1",
      port: 0,
      token: "live-source-token",
    },
    {
      startLiveSources: (sourceCatalog, options) =>
        startLiveSourceCoordinator(sourceCatalog, {
          ...options,
          debounceMs: 0,
          watchDirectory: (_directory, listener) => {
            emitChange = listener;
            const watcher = {
              close: () => {
                watchClosed = true;
              },
              on: (_event: "error", _listener: (error?: unknown) => void) => watcher,
            };
            return watcher;
          },
        }),
    },
  );

  try {
    const client = new DeskApiClient(server.url, server.token);
    const document = await client.registerDocument({
      workspaceId: "example",
      kind: "brief",
      title: "Live source",
      path: documentPath,
      attention: "none",
    });
    assert.ok(emitChange);
    const controller = new AbortController();
    let ready!: () => void;
    let received!: (value: CatalogEvent) => void;
    const readyEvent = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const sourceEvent = new Promise<CatalogEvent>((resolve) => {
      received = resolve;
    });
    const subscription = client.subscribeCatalog(received, {
      signal: controller.signal,
      onReady: ready,
    });
    await readyEvent;

    await writeFile(documentPath, "# Changed\n", "utf8");
    assert.ok(emitChange);
    emitChange(basename(documentPath));
    assert.deepEqual(await sourceEvent, {});
    assert.equal(catalog.getDocument(document.id)?.revision, 2);
    controller.abort();
    await subscription;
    await client.act(document.id, "archive");
    assert.equal(watchClosed, true);
  } finally {
    await server.close();
    catalog.close();
  }
  assert.equal(watchClosed, true);
});

test("validates review requests and receives their live events", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-api-reviews-"));
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "plan.md");
  await mkdir(workspace);
  await writeFile(documentPath, "# Review plan\n", "utf8");
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
    title: "Review plan",
    path: documentPath,
    attention: "none",
  });
  const server = await startDeskServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    token: "review-token",
  });
  try {
    const client = new DeskApiClient(server.url, server.token);
    const controller = new AbortController();
    let ready!: () => void;
    let received!: (value: CatalogEvent) => void;
    const readyEvent = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const reviewEvent = new Promise<CatalogEvent>((resolve) => {
      received = resolve;
    });
    const subscription = client.subscribeCatalog(received, {
      signal: controller.signal,
      onReady: ready,
    });
    await readyEvent;

    const request = await client.createReviewRequest({
      documentId: document.id,
      documentRevision: document.revision,
      kind: "plan-decision",
      requestMessage: "Please decide and explain.",
    });
    assert.equal(request.status, "pending");
    assert.equal(request.requestMessage, "Please decide and explain.");
    assert.deepEqual(await reviewEvent, {});
    assert.deepEqual(await client.getReviewRequest(request.id), request);
    assert.deepEqual(
      (await client.listReviewRequests({ status: "pending" })).map(({ id }) => id),
      [request.id],
    );

    const responded = await client.respondToReviewRequest(request.id, {
      outcome: "superseded",
      message: "A newer review replaces this one.",
    });
    assert.equal(responded.status, "superseded");
    assert.equal(
      responded.response?.message,
      "A newer review replaces this one.",
    );
    controller.abort();
    await subscription;
  } finally {
    await server.close();
    catalog.close();
  }
});

test("reads file-level feedback from the daemon after a human decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-api-file-feedback-"));
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "change-review.md");
  await mkdir(workspace);
  await writeFile(documentPath, "# Change review\n", "utf8");
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
    title: "Change review",
    path: documentPath,
    attention: "approval",
  });
  const server = await startDeskServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    token: "file-feedback-token",
  });
  try {
    const client = new DeskApiClient(server.url, server.token);
    const request = await client.createReviewRequest({
      documentId: document.id,
      kind: "change-decision",
      requestMessage: "Review this implementation.",
    });
    const item = {
      id: "feedback-11111111111111111111",
      kind: "feedback" as const,
      path: "docs/ai/agentic/harness-migration-plan.md",
      message: "Leave this file unchanged.",
    };
    const decided = await client.respondToReviewRequest(request.id, {
      outcome: "changes_requested",
      message: "Everything else is good.",
      items: [item],
    });
    assert.deepEqual(decided.response?.items, [item]);
    assert.deepEqual((await client.getReviewRequest(request.id)).response?.items, [item]);
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
    let received!: (value: CatalogEvent) => void;
    const readyEvent = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const workspaceEvent = new Promise<CatalogEvent>((resolve) => {
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
    assert.deepEqual(await workspaceEvent, {});

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
