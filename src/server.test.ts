import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Catalog, type Document } from "./catalog.js";
import {
  startDeskServer,
  type DeskServerOptions,
  type RunningDeskServer,
} from "./server.js";

interface ServerFixture {
  catalog: Catalog;
  document: Document;
  root: string;
  server: RunningDeskServer;
  workspace: string;
}

async function fixture(
  serverOptions: Omit<DeskServerOptions, "catalog"> = {},
): Promise<ServerFixture> {
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
      "\u001b]52;c;terminal-injection\u0007",
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
    ...serverOptions,
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

test("hides empty projects after their last visible document is archived", async () => {
  const value = await fixture();
  const emptyRoot = join(value.root, "empty-workspace");
  await mkdir(emptyRoot);
  await value.catalog.addWorkspace({
    id: "empty",
    name: "Empty",
    root: emptyRoot,
    artifactRoots: [emptyRoot],
  });
  try {
    const before = await authorized(value, "/api/v1/workspaces");
    assert.deepEqual(await before.json(), {
      data: [
        {
          id: "example",
          name: "Example",
          documentCount: 1,
          route: "/w/example",
        },
      ],
    });

    const archived = await authorized(
      value,
      `/api/v1/documents/${value.document.id}/archive`,
      { method: "POST" },
    );
    assert.equal(archived.status, 200);
    const after = await authorized(value, "/api/v1/workspaces");
    assert.deepEqual(await after.json(), { data: [] });
    assert.deepEqual(
      value.catalog.listWorkspaces().map(({ id }) => id),
      ["empty", "example"],
    );
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
      `/api/v1/documents/${value.document.id}/render?target=terminal&width=80&color=true&unicode=true`,
    );
    assert.equal(terminal.status, 200);
    const terminalBody = (await terminal.json()) as {
      data: { backend: string; content: string; target: string; warnings: string[] };
    };
    assert.equal(terminalBody.data.target, "terminal");
    assert.match(terminalBody.data.content, /Visible plan/);
    assert.equal(terminalBody.data.backend, "beautiful-mermaid");
    assert.ok(Array.isArray(terminalBody.data.warnings));
    assert.match(terminalBody.data.content, /\u001b\[[0-9;]*m/);
    assert.match(terminalBody.data.content, /═/);
    assert.doesNotMatch(terminalBody.data.content, /\u001b\]|\u0007|terminal-injection/);
    assert.doesNotMatch(terminalBody.data.content, /\u001b\[[0-9;]*[A-HJKSTf]/);

    const invalidPreference = await authorized(
      value,
      `/api/v1/documents/${value.document.id}/render?target=terminal&color=rainbow`,
    );
    assert.equal(invalidPreference.status, 400);
  } finally {
    await closeFixture(value);
  }
});

test("reports missing sources safely while keeping their records archivable", async () => {
  const value = await fixture();
  await rm(join(value.workspace, "plan.md"));
  try {
    const render = await authorized(
      value,
      `/api/v1/documents/${value.document.id}/render?target=web`,
    );
    assert.equal(render.status, 410);
    assert.deepEqual(await render.json(), {
      error: {
        code: "source_missing",
        message: "Document source is missing",
      },
    });

    const missing = value.catalog.getDocument(value.document.id);
    assert.equal(typeof missing?.missingAt, "string");

    const archived = await authorized(
      value,
      `/api/v1/documents/${value.document.id}/archive`,
      { method: "POST" },
    );
    assert.equal(archived.status, 200);
    const archivedBody = (await archived.json()) as {
      data: { archivedAt: string | null; missingAt: string | null };
    };
    assert.equal(typeof archivedBody.data.archivedAt, "string");
    assert.equal(typeof archivedBody.data.missingAt, "string");
    assert.doesNotMatch(JSON.stringify(archivedBody), new RegExp(value.root));
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

test("adds workspaces through validated producer-neutral input", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-server-workspace-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  const server = await startDeskServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    token: "workspace-token",
  });
  const value = { catalog, root, server, workspace } as ServerFixture;
  try {
    const response = await authorized(value, "/api/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "created",
        name: "Created",
        root: workspace,
        artifactRoots: [workspace],
      }),
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("location"), "/api/v1/workspaces/created");
    assert.deepEqual(await response.json(), {
      data: {
        id: "created",
        name: "Created",
        documentCount: 0,
        route: "/w/created",
      },
    });

    const invalid = await authorized(value, "/api/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "created", root: workspace }),
    });
    assert.equal(invalid.status, 422);
    assert.deepEqual(await invalid.json(), {
      error: {
        code: "validation_error",
        message: "Invalid workspace registration",
      },
    });
  } finally {
    await server.close();
    catalog.close();
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
    assert.doesNotMatch(cookie, /Secure/);

    const anotherBrowser = await fetch(
      new URL("/?token=test-token", value.server.url),
      { redirect: "manual" },
    );
    assert.equal(anotherBrowser.status, 303);

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

test("uses the configured localhost HTTPS origin for browser security", async () => {
  const value = await fixture({
    publicUrl: "https://mdmaid.desk.localhost",
  });
  try {
    assert.equal(
      value.server.webUrl,
      "https://mdmaid.desk.localhost/?token=test-token",
    );

    const bootstrap = await fetch(
      new URL("/?token=test-token", value.server.url),
      { redirect: "manual" },
    );
    const cookie = bootstrap.headers.get("set-cookie") ?? "";
    assert.equal(bootstrap.status, 303);
    assert.match(cookie, /Secure/);
    assert.equal(
      bootstrap.headers.get("strict-transport-security"),
      "max-age=31536000",
    );

    const accepted = await fetch(
      new URL(`/api/v1/documents/${value.document.id}/read`, value.server.url),
      {
        method: "POST",
        headers: {
          cookie: cookie.split(";")[0] ?? "",
          origin: "https://mdmaid.desk.localhost",
        },
      },
    );
    assert.equal(accepted.status, 200);

    const rejected = await fetch(
      new URL(`/api/v1/documents/${value.document.id}/unread`, value.server.url),
      {
        method: "POST",
        headers: {
          cookie: cookie.split(";")[0] ?? "",
          origin: value.server.url,
        },
      },
    );
    assert.equal(rejected.status, 403);
  } finally {
    await closeFixture(value);
  }
});

test("uses a direct localhost HTTP origin without certificate-only headers", async () => {
  const value = await fixture({
    publicUrl: "http://mdmaid.desk.localhost:43127",
  });
  try {
    assert.equal(
      value.server.webUrl,
      "http://mdmaid.desk.localhost:43127/?token=test-token",
    );

    const bootstrap = await fetch(
      new URL("/?token=test-token", value.server.url),
      { redirect: "manual" },
    );
    const cookie = bootstrap.headers.get("set-cookie") ?? "";
    assert.equal(bootstrap.status, 303);
    assert.doesNotMatch(cookie, /Secure/);
    assert.equal(bootstrap.headers.get("strict-transport-security"), null);

    const accepted = await fetch(
      new URL(`/api/v1/documents/${value.document.id}/read`, value.server.url),
      {
        method: "POST",
        headers: {
          cookie: cookie.split(";")[0] ?? "",
          origin: "http://mdmaid.desk.localhost:43127",
        },
      },
    );
    assert.equal(accepted.status, 200);
  } finally {
    await closeFixture(value);
  }
});

test("rejects unsafe public web origins", async () => {
  const value = await fixture();
  try {
    for (const publicUrl of [
      "ftp://mdmaid.desk.localhost",
      "https://example.com",
      "https://mdmaid.desk.localhost/path",
      "https://user:password@mdmaid.desk.localhost",
    ]) {
      await assert.rejects(
        startDeskServer({
          catalog: value.catalog,
          publicUrl,
          token: "another-test-token",
        }),
        /public URL must be an HTTP or HTTPS \.localhost origin/,
      );
    }
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

test("serves the browser workspace and local visual assets", async () => {
  const value = await fixture();
  try {
    const bootstrap = await fetch(
      new URL("/?token=test-token", value.server.url),
      { redirect: "manual" },
    );
    const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const headers = { cookie };

    const page = await fetch(new URL("/", value.server.url), { headers });
    const html = await page.text();
    assert.match(html, /data-testid="project-nav"/);
    assert.match(html, /data-testid="document-queue"/);
    assert.match(html, /data-testid="document-reader"/);
    assert.match(html, /\/assets\/app\.css/);
    assert.match(html, /\/assets\/app\.js/);
    assert.match(html, /\/assets\/mermaid\.min\.js/);

    const workspacePage = await fetch(new URL("/w/example", value.server.url), {
      headers,
    });
    assert.equal(workspacePage.status, 200);
    assert.match(await workspacePage.text(), /data-workspace-id="example"/);

    const css = await fetch(new URL("/assets/app.css", value.server.url), {
      headers,
    });
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    assert.match(await css.text(), /Departure Mono/);

    const app = await fetch(new URL("/assets/app.js", value.server.url), {
      headers,
    });
    assert.equal(app.status, 200);
    assert.match(app.headers.get("content-type") ?? "", /javascript/);
    assert.match(await app.text(), /mdmaid\.desk web client/);

    const mermaid = await fetch(
      new URL("/assets/mermaid.min.js", value.server.url),
      { headers },
    );
    assert.equal(mermaid.status, 200);
    assert.match(mermaid.headers.get("content-type") ?? "", /javascript/);

    const font = await fetch(
      new URL("/assets/departure-mono.woff2", value.server.url),
      { headers },
    );
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("content-type"), "font/woff2");
    assert.ok((await font.arrayBuffer()).byteLength > 1_000);
  } finally {
    await closeFixture(value);
  }
});
