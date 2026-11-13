import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test as base, expect } from "@playwright/test";

import { Catalog } from "../../dist/catalog.js";
import { startDeskServer } from "../../dist/server.js";

const title = "Sharing / report: Проба";
const test = base.extend({
  desk: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), "mdmaid-export-e2e-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const picture = join(workspace, "picture.png");
    await writeFile(picture, png);
    await writeFile(join(workspace, "picture.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80" fill="orange"/><text x="10" y="40">Local SVG</text></svg>');
    await writeFile(join(workspace, "source.ts"), "export const value = 1;");
    const path = join(workspace, "document.md");
    await writeFile(path, [
      "# Shared document", "", "## Details", "", "Offline document text.", "",
      "[jump](#details)", "[source](source.ts)", "[external](https://example.com/reference)", "",
      "![Local picture](picture.png)", "![Vector picture](picture.svg)",
      `![Inline picture](data:image/png;base64,${png.toString("base64")})`, "",
      "| Name | Value |", "| --- | --- |", "| Sharing | Offline |", "",
      "```mermaid", "graph LR", "  Draft --> Shared", "```", "",
      ...["first.ts", "second.ts"].flatMap((name) => [
        "```diff", `diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`,
        "@@ -1 +1 @@", "-const oldValue = 1;", "+const newValue = 2;", "```", "",
      ]),
    ].join("\n"));
    const catalog = await Catalog.open(join(root, "catalog.sqlite3"), { legacyStatePath: false });
    await catalog.addWorkspace({ id: "test", name: "Test", root: workspace, artifactRoots: [workspace] });
    const document = await catalog.registerDocument({ workspaceId: "test", path, kind: "change-review", title, attention: "review" });
    const server = await startDeskServer({ catalog });
    try {
      await use({ server, document, picture, path });
    } finally {
      await server.close();
      catalog.close();
      await rm(root, { recursive: true, force: true });
    }
  },
});

async function openDocument(page, desk) {
  await page.goto(`${desk.server.url}/d/${desk.document.id}?token=${desk.server.token}`);
  await expect(page.getByRole("button", { name: "download HTML" })).toBeEnabled();
}

test("downloads one title-named file with pictures, diagrams and every patch, readable offline", async ({ page, browser, desk }, testInfo) => {
  await openDocument(page, desk);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "download HTML" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("Sharing report Проба.html");
  const path = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  const html = await readFile(path, "utf8");
  expect(html).toContain("data:font/woff2;base64,");
  expect(html).not.toMatch(/src="(?:\/|https?:)|href="\/(?:assets|d)\//);
  expect(html).not.toContain(desk.server.token);
  expect(html).not.toContain("<script");
  expect(html).toContain("script-src 'none'");

  const offline = await browser.newContext({ offline: true, javaScriptEnabled: false });
  try {
    const reader = await offline.newPage();
    const requests = [];
    reader.on("request", (request) => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
    await reader.goto(pathToFileURL(path).href);
    await expect(reader).toHaveTitle(title);
    await expect(reader.getByText("Offline document text.")).toBeVisible();
    await expect(reader.locator("pre").filter({ hasText: "second.ts" })).toBeVisible();
    await expect(reader.locator(".mermaid svg")).toBeVisible();
    await expect(reader.locator("img")).toHaveCount(3);
    expect(await reader.locator("img").evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0))).toBe(true);
    await reader.getByRole("link", { name: "jump", exact: true }).click();
    expect(new URL(reader.url()).hash).toBe("#details");
    expect(requests).toEqual([]);
    await reader.screenshot({ path: testInfo.outputPath("offline.png"), fullPage: true });
  } finally {
    await offline.close();
  }
});

test("print and Save as PDF prepare the full document and restore the reader after closing", async ({ page, desk }, testInfo) => {
  await openDocument(page, desk);
  const previousTitle = await page.title();
  let printed = 0;
  await page.exposeFunction("capturePrint", async () => {
    await page.emulateMedia({ media: "print" });
    expect(await page.title()).toBe("Sharing report Проба");
    expect(await page.locator(".workspace").evaluate((element) => getComputedStyle(element).display)).toBe("none");
    expect(await page.locator(".document-export").innerText()).toContain("second.ts");
    expect(await page.locator(".document-export img").evaluateAll((images) => images.every((image) => image.naturalWidth > 0))).toBe(true);
    const pdf = await page.pdf({ path: testInfo.outputPath(`document-${printed}.pdf`), format: "A4" });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    printed += 1;
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  });
  await page.evaluate(() => {
    window.print = () => { void window.capturePrint(); };
  });
  for (const name of ["save PDF", "print"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator("#export-status")).toHaveText("Print dialog closed.");
    await expect(page.locator(".document-export")).toHaveCount(0);
    await expect(page).toHaveTitle(previousTitle);
    await expect(page.getByRole("button", { name: "download HTML" })).toBeEnabled();
  }
  expect(printed).toBe(2);
});

test("reports a missing picture without downloading or printing an incomplete document", async ({ page, desk }) => {
  await openDocument(page, desk);
  await rm(desk.picture);
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.getByRole("button", { name: "download HTML" }).click();
  await expect(page.locator("#export-status")).toContainText("unavailable");
  await expect(page.locator(".document-export")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "download HTML" })).toBeEnabled();
  expect(downloads).toBe(0);
});

test("disables exports when the document source is missing", async ({ page, desk }) => {
  await openDocument(page, desk);
  await rm(desk.path);
  await page.reload();
  await expect(page.getByText("Source file is missing", { exact: true })).toBeVisible();
  for (const name of ["print", "save PDF", "download HTML"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  }
});

test("restores the reader when the browser refuses to print", async ({ page, desk }) => {
  await openDocument(page, desk);
  const previousTitle = await page.title();
  await page.evaluate(() => {
    window.print = () => { throw new Error("Printing is unavailable in this browser."); };
  });
  await page.getByRole("button", { name: "print", exact: true }).click();
  await expect(page.locator("#export-status")).toContainText("Printing is unavailable");
  await expect(page).toHaveTitle(previousTitle);
  await expect(page.locator(".document-export")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "download HTML" })).toBeEnabled();
  expect(await page.locator("body").getAttribute("class")).not.toContain("printing-export");
});

test("does not download an export after the reader navigates away during preparation", async ({ page, desk }) => {
  await openDocument(page, desk);
  let allowMedia;
  const mediaGate = new Promise((resolve) => { allowMedia = resolve; });
  let mediaRequested;
  const requested = new Promise((resolve) => { mediaRequested = resolve; });
  await page.route("**/media/**", async (route) => {
    mediaRequested();
    await mediaGate;
    await route.continue();
  });
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.getByRole("button", { name: "download HTML" }).click();
  await requested;
  await expect(page.locator(".document-export")).toHaveCount(1);
  await page.getByRole("button", { name: "← queue", exact: true }).click();
  allowMedia();
  await expect(page.locator(".document-export")).toHaveCount(0);
  await expect(page.locator("#queue-panel")).toBeVisible();
  expect(downloads).toBe(0);
});

test("embeds SVG image elements and rejects remote pictures without leaving a partial export", async ({ page, desk }) => {
  await openDocument(page, desk);
  const media = desk.document.sourceLinks.find(({ href }) => href === "picture.png");
  const result = await page.evaluate(async ({ id, mediaId }) => {
    const { prepareDocumentExport } = await import("/assets/document-export.js");
    const document = { id, title: "SVG image" };
    const prepared = await prepareDocumentExport({
      document,
      content: `<svg xmlns="http://www.w3.org/2000/svg"><image href="/d/${id}/media/${mediaId}" width="20" height="20"/></svg>`,
    }, "light");
    const embedded = prepared.html.includes('href="data:image/png;base64,');
    prepared.dispose();
    try {
      await prepareDocumentExport({ document, content: '<img src="https://example.com/remote.png">' }, "light");
      return { embedded, error: "" };
    } catch (error) {
      return { embedded, error: error.message };
    }
  }, { id: desk.document.id, mediaId: media.id });
  expect(result.embedded).toBe(true);
  expect(result.error).toContain("Cannot export this picture");
  await expect(page.locator(".document-export")).toHaveCount(0);
});
