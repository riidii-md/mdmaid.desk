import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Catalog, type Document } from "./catalog.js";
import { startDeskServer, type RunningDeskServer } from "./server.js";

interface ServerFixture {
  catalog: Catalog;
  document: Document;
  root: string;
  server: RunningDeskServer;
  workspace: string;
}

async function fixture(): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-server-"));
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "plan.md");
  await mkdir(workspace);
  await writeFile(
    documentPath,
    [
      "# Visible plan",
      "",
      "<script>globalThis.pwned = true</script>",
      "",
      "[unsafe](javascript:alert(1))",
      "",
      "```mermaid",
      "graph LR",
      "  Queue --> Reader",
      "```",
      "",
    ].join("\n"),
    "utf8",
  );

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
    taskId: "DESK-4",
    producer: "codex",
    kind: "plan",
    title: "Visible plan",
    path: documentPath,
    attention: "review",
    tags: ["architecture"],
  });
  const server = await startDeskServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    token: "test-token",
  });
  return { catalog, document, root, server, workspace };
}

async function closeFixture(value: ServerFixture): Promise<void> {
  await value.server.close();
  value.catalog.close();
}

function authorized(
  fixture: ServerFixture,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(new URL(path, fixture.server.url), {
    ...init,
    headers: {
      authorization: `Bearer ${fixture.server.token}`,
      ...init.headers,
    },
  });
}

test("serves health publicly and protects catalog APIs", async () => {
  const value = await fixture();
  try {
    const health = await fetch(new URL("/api/v1/health", value.server.url));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      data: { service: "mdmaid.desk", status: "ok", version: 1 },
    });

    const unauthorized = await fetch(
      new URL("/api/v1/documents", value.server.url),
    );
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), {
      error: { code: "unauthorized", message: "Authentication required" },
    });
  } finally {
    await closeFixture(value);
  }
});

test("lists public document metadata without leaking filesystem paths", async () => {
  const value = await fixture();
  try {
    const response = await authorized(
      value,
      "/api/v1/documents?workspace=example&status=unread&tag=architecture",
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      data: Array<Record<string, unknown>>;
    };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]?.id, value.document.id);
    assert.equal(body.data[0]?.status, "unread");
    assert.equal(body.data[0]?.route, `/d/${value.document.id}`);
    assert.equal("path" in (body.data[0] ?? {}), false);
    assert.equal("contentHash" in (body.data[0] ?? {}), false);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(value.root));

    const workspaces = await authorized(value, "/api/v1/workspaces");
    assert.equal(workspaces.status, 200);
    assert.doesNotMatch(await workspaces.text(), new RegExp(value.root));
  } finally {
    await closeFixture(value);
  }
});

test("renders authorized Markdown for web and terminal targets", async () => {
  const value = await fixture();
  try {
    const web = await authorized(
      value,
      `/api/v1/documents/${value.document.id}/render?target=web`,
    );
    assert.equal(web.status, 200);
    const webBody = (await web.json()) as {
      data: { content: string; target: string };
    };
    assert.equal(webBody.data.target, "web");
    assert.match(webBody.data.content, /Visible plan/);
    assert.match(webBody.data.content, /class="mermaid"/);
    assert.doesNotMatch(webBody.data.content, /<script/i);
    assert.doesNotMatch(webBody.data.content, /javascript:/i);

    const terminal = await authorized(
      value,
      `/api/v1/documents/${value.document.id}/render?target=terminal&width=80`,
    );
    assert.equal(terminal.status, 200);
    const terminalBody = (await terminal.json()) as {
      data: { backend: string; content: string; target: string; warnings: string[] };
    };
    assert.equal(terminalBody.data.target, "terminal");
    assert.match(terminalBody.data.content, /Visible plan/);
    assert.ok(["veol", "beautiful-mermaid", "source"].includes(terminalBody.data.backend));
    assert.ok(Array.isArray(terminalBody.data.warnings));
  } finally {
    await closeFixture(value);
  }
});

test("shares reading lifecycle mutations through the API", async () => {
  const value = await fixture();
  try {
    const opened = await authorized(
      value,
      `/api/v1/documents/${value.document.id}/opened`,
      { method: "POST" },
    );
    assert.equal(opened.status, 200);
    assert.equal(((await opened.json()) as { data: Document }).data.status, "reading");

    const read = await authorized(
      value,
      `/api/v1/documents/${value.document.id}/read`,
      { method: "POST" },
    );
    assert.equal(read.status, 200);
    assert.equal(((await read.json()) as { data: Document }).data.status, "done");

    const unread = await authorized(
      value,
      `/api/v1/documents/${value.document.id}/unread`,
      { method: "POST" },
    );
    assert.equal(unread.status, 200);
    assert.equal(((await unread.json()) as { data: Document }).data.status, "unread");

    const tags = await authorized(
      value,
      `/api/v1/documents/${value.document.id}/tags`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags: ["updated", "review"] }),
      },
    );
    assert.equal(tags.status, 200);
    assert.deepEqual(
      ((await tags.json()) as { data: Document }).data.tags,
      ["review", "updated"],
    );
  } finally {
    await closeFixture(value);
  }
});

test("registers documents through validated producer-neutral input", async () => {
  const value = await fixture();
  try {
    const documentPath = join(value.workspace, "review.md");
    await writeFile(documentPath, "# Review\n", "utf8");
    const response = await authorized(value, "/api/v1/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "example",
        producer: "hermes",
        kind: "review",
        title: "Review",
        path: documentPath,
        attention: "none",
        tags: ["agent"],
      }),
    });
    assert.equal(response.status, 201);
    assert.match(response.headers.get("location") ?? "", /^\/api\/v1\/documents\/doc-/);
    const body = (await response.json()) as { data: Record<string, unknown> };
    assert.equal(body.data.producer, "hermes");
    assert.equal("path" in body.data, false);

    const invalid = await authorized(value, "/api/v1/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "example" }),
    });
    assert.equal(invalid.status, 422);
    assert.deepEqual(await invalid.json(), {
      error: {
        code: "validation_error",
        message: "Invalid document registration",
      },
    });
  } finally {
    await closeFixture(value);
  }
});

test("bootstraps a browser cookie and serves secure workspace routes", async () => {
  const value = await fixture();
  try {
    const bootstrap = await fetch(
      new URL("/?token=test-token", value.server.url),
      { redirect: "manual" },
    );
    assert.equal(bootstrap.status, 303);
    assert.equal(bootstrap.headers.get("location"), "/");
    const cookie = bootstrap.headers.get("set-cookie") ?? "";
    assert.match(cookie, /mdmaid_desk_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);

    const page = await fetch(new URL("/", value.server.url), {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.match(await page.text(), /mdmaid\.desk/);

    const route = await fetch(
      new URL(`/d/${value.document.id}`, value.server.url),
      { headers: { cookie: cookie.split(";")[0] ?? "" } },
    );
    assert.equal(route.status, 200);
    assert.match(await route.text(), new RegExp(value.document.id));
  } finally {
    await closeFixture(value);
  }
});

test("rejects cross-origin cookie mutations and oversized JSON", async () => {
  const value = await fixture();
  try {
    const crossOrigin = await fetch(
      new URL(`/api/v1/documents/${value.document.id}/read`, value.server.url),
      {
        method: "POST",
        headers: {
          cookie: "mdmaid_desk_session=test-token",
          origin: "https://example.com",
        },
      },
    );
    assert.equal(crossOrigin.status, 403);

    const oversized = await authorized(value, "/api/v1/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(70_000) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await closeFixture(value);
  }
});
