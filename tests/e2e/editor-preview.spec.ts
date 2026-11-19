import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Catalog } from "../../dist/catalog.js";
import { startDeskServer } from "../../dist/server.js";
import { pipePreview } from "../../dist/preview-client.js";
import type { PreviewInfo } from "../../dist/preview-sessions.js";

test("whole-document Web preview updates before save and returns to saved source when editor disconnects", async ({ page, context }) => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-editor-web-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const path = join(workspace, "source.md");
  await writeFile(path, "# Saved document\n");
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), { legacyStatePath: false });
  await catalog.addWorkspace({ id: "editor", name: "Editor", root: workspace, artifactRoots: [workspace] });
  const document = await catalog.registerDocument({ workspaceId: "editor", path, title: "Source", kind: "other", attention: "none" });
  const server = await startDeskServer({ catalog, host: "127.0.0.1", port: 0, token: "editor-preview-token" });
  const input = new PassThrough();
  let ready!: (info: PreviewInfo) => void;
  const receipt = new Promise<PreviewInfo>((resolve) => { ready = resolve; });
  const streaming = pipePreview(server.url, server.token, document.id, input, ready);
  try {
    input.write(JSON.stringify({ version: 1, content: "# Unsaved document\n\nFirst paragraph." }) + "\n");
    const preview = await receipt;
    await page.goto(server.url + preview.route + "&token=" + server.token);
    await expect(page.locator("#reader-content")).toContainText("Unsaved document");
    await expect(page.locator("#live-preview-notice")).toHaveText("Unsaved editor preview");
    await expect(page.locator("#feedback-panel")).toBeHidden();
    await expect(page.locator("#review-panel")).toBeHidden();
    expect(new URL(page.url()).hash).toBe("");

    const saved = await context.newPage();
    await saved.goto(server.url + "/d/" + document.id + "?token=" + server.token);
    await expect(saved.locator("#reader-content")).toContainText("Saved document");

    input.write(JSON.stringify({ version: 2, content: "# Unsaved document\n\nTyped without saving." }) + "\n");
    await expect(page.locator("#reader-content")).toContainText("Typed without saving");
    await expect(saved.locator("#reader-content")).not.toContainText("Typed without saving");
    expect(await readFile(path, "utf8")).toBe("# Saved document\n");
    expect(catalog.getDocument(document.id)?.revision).toBe(1);

    input.end();
    await streaming;
    await expect(page.locator("#reader-content")).toContainText("Saved document");
    await expect(page.locator("#live-preview-notice")).toContainText("preview ended");
  } finally {
    input.end();
    await streaming;
    await server.close();
    catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});
