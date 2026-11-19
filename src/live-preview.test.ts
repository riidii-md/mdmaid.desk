import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import test from "node:test";
import { Catalog } from "./catalog.js";
import { startDeskServer } from "./server.js";
import { DeskApiClient } from "./api-client.js";
import { runTui } from "./tui.js";
import type { PreviewInfo } from "./preview-sessions.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-live-preview-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const path = join(workspace, "source.md");
  await writeFile(path, "# Saved content\n");
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), { legacyStatePath: false });
  await catalog.addWorkspace({ id: "source", name: "Source", root: workspace, artifactRoots: [workspace] });
  const document = await catalog.registerDocument({
    path, workspaceId: "source", kind: "other", title: "Source", attention: "none",
  });
  const server = await startDeskServer({ catalog, host: "127.0.0.1", port: 0, token: "preview-test-token" });
  const client = new DeskApiClient(server.url, server.token);
  return {
    root, path, catalog, document, server, client,
    async close() { await server.close(); catalog.close(); await rm(root, { recursive: true, force: true }); },
  };
}

async function stream(url: string, documentId: string, content: string) {
  let req!: ClientRequest;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    req = request(`${url}/api/v1/documents/${documentId}/preview`, {
      method: "POST",
      headers: { authorization: "Bearer preview-test-token", "content-type": "application/x-ndjson" },
    }, resolve);
    req.on("error", reject);
    req.write(JSON.stringify({ version: 1, content }) + "\n");
  });
  assert.equal(response.statusCode, 200);
  const lines = createInterface({ input: response })[Symbol.asyncIterator]();
  const receipt = JSON.parse((await lines.next()).value ?? "{}") as { preview: PreviewInfo };
  return {
    req, response, lines, info: receipt.preview,
    async update(version: number, value: string) {
      req.write(JSON.stringify({ version, content: value }) + "\n");
      return JSON.parse((await lines.next()).value ?? "{}") as { preview: PreviewInfo };
    },
    async scroll(version: number, progress: number) {
      req.write(JSON.stringify({ version, scroll: progress }) + "\n");
      return JSON.parse((await lines.next()).value ?? "{}") as { preview: PreviewInfo };
    },
    async close() {
      req.end();
      for await (const _line of lines) { /* drain */ }
    },
  };
}

test("Web and terminal previews show unsaved text without changing disk or catalog identity", async () => {
  const value = await fixture();
  let source: Awaited<ReturnType<typeof stream>> | undefined;
  try {
    source = await stream(value.server.url, value.document.id, "# Unsaved content\n\n<script>unsafe()</script>");
    const web = await value.client.renderDocument(value.document.id, "web", undefined, undefined, {}, source.info.id);
    const terminal = await value.client.renderDocument(value.document.id, "terminal", 90, {}, {}, source.info.id);
    assert.match(web.content, /Unsaved content/);
    assert.doesNotMatch(web.content, /<script>/);
    assert.match(terminal.content, /Unsaved content/);
    assert.equal(web.document.id, value.document.id);
    assert.equal(web.document.revision, value.document.revision);
    assert.equal(await readFile(value.path, "utf8"), "# Saved content\n");
    const saved = await value.client.renderDocument(value.document.id, "web");
    assert.match(saved.content, /Saved content/);
    assert.doesNotMatch(saved.content, /Unsaved content/);
    const updated = await source.update(2, "# Changed without saving\n");
    assert.equal(updated.preview.version, 2);
    const latest = await value.client.renderDocument(value.document.id, "web", undefined, undefined, {}, source.info.id);
    assert.match(latest.content, /Changed without saving/);
    await source.update(3, "# Work in progress\n\n```mermaid\ngraph TD\n A -->");
    const incomplete = await value.client.renderDocument(value.document.id, "terminal", 90, {}, {}, source.info.id);
    assert.match(incomplete.content, /Work in progress/);
  } finally {
    await source?.close();
    await value.close();
  }
});

test("closing an editor stream removes its preview and preserves the saved document", async () => {
  const value = await fixture();
  try {
    const source = await stream(value.server.url, value.document.id, "# Draft");
    await source.close();
    await assert.rejects(value.client.renderDocument(value.document.id, "web", undefined, undefined, {}, source.info.id));
    assert.equal(value.catalog.getDocument(value.document.id)?.revision, 1);
    assert.equal((await value.client.renderDocument(value.document.id, "web")).document.id, value.document.id);
  } finally { await value.close(); }
});

test("TUI starts directly in the requested live document and refreshes without an Enter key", async () => {
  const value = await fixture();
  let source: Awaited<ReturnType<typeof stream>> | undefined;
  const input = new PassThrough();
  const output = new PassThrough();
  Object.assign(output, { columns: 100, rows: 30, isTTY: false });
  let frames = "";
  output.on("data", (chunk: Buffer) => { frames += chunk.toString(); });
  let running: Promise<void> | undefined;
  try {
    source = await stream(value.server.url, value.document.id, "# Initial editor preview");
    running = runTui(value.client, {
      input: input as unknown as ReadStream, output: output as unknown as WriteStream,
      documentId: value.document.id, previewId: source.info.id,
    });
    await waitFor(() => frames.includes("Initial editor preview"));
    input.write("m"); // A draft cannot mark a saved revision read.
    await source.update(2, "# Updated while typing");
    await waitFor(() => frames.includes("Updated while typing"));
    await source.update(3, "# Second typing update");
    await waitFor(() => frames.includes("Second typing update"));
    assert.equal(value.catalog.getDocument(value.document.id)?.completedRevision, null);
    input.write("q");
    await running;
  } finally {
    input.write("q");
    await running;
    await source?.close();
    await value.close();
  }
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for live TUI frame");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}


test("live TUI follows viewport events without changing content or scrolling the source", async () => {
  const value = await fixture();
  let source: Awaited<ReturnType<typeof stream>> | undefined;
  const input = new PassThrough();
  const output = new PassThrough();
  Object.assign(output, { columns: 100, rows: 30, isTTY: false });
  let frames = "";
  output.on("data", (chunk: Buffer) => { frames += chunk.toString(); });
  let running: Promise<void> | undefined;
  try {
    const content = Array.from({ length: 100 }, (_, i) => "Paragraph " + String(i + 1).padStart(3, "0")).join("\n\n");
    source = await stream(value.server.url, value.document.id, content);
    running = runTui(value.client, {
      input: input as unknown as ReadStream, output: output as unknown as WriteStream,
      documentId: value.document.id, previewId: source.info.id,
    });
    await waitFor(() => frames.includes("Paragraph 001"));
    const bottom = await source.scroll(1, 1);
    await waitFor(() => frames.includes("Paragraph 100"));
    assert.equal(bottom.preview.version, 1);
    assert.equal((await value.client.getPreview(value.document.id, source.info.id)).viewport?.progress, 1);
    input.write("k");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await value.client.getPreview(value.document.id, source.info.id)).viewport?.progress, 1,
      "manual right-pane scrolling must not write back to the editor viewport");
    frames = "";
    await source.scroll(1, 0);
    await waitFor(() => frames.includes("Paragraph 001"));
    assert.equal(await readFile(value.path, "utf8"), "# Saved content\n");
    input.write("q");
    await running;
  } finally {
    input.write("q");
    await running;
    await source?.close();
    await value.close();
  }
});
