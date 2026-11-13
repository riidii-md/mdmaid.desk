import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { Catalog, type DocumentKind } from "../../dist/catalog.js";
import { startDeskServer } from "../../dist/server.js";

test.use({ screenshot: "only-on-failure" });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-responsive-browser-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  await catalog.addWorkspace({
    id: "example",
    name: "Example",
    root: workspace,
    artifactRoots: [workspace],
  });
  const title = "A long implementation review title for documents on folded and unfolded phone screens";
  const source = [
    "# Responsive document",
    "",
    "## Details",
    "",
    `A long link: https://example.invalid/${"long-path".repeat(20)}`,
    "",
    "| First | Second | Third | Fourth |",
    "| --- | --- | --- | --- |",
    `| ${"wideTableCell".repeat(8)} | ${"wideTableCell".repeat(8)} | More | More |`,
    "",
    "```ts",
    `const line = "${"long-code".repeat(35)}";`,
    "```",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[Folded] --> B[Unfolded]",
    "```",
    "",
    "## Conclusion",
    "",
    "The document remains readable.",
  ].join("\n");
  async function add(name: string, content: string, kind: DocumentKind = "brief") {
    const path = join(workspace, `${name}.md`);
    await writeFile(path, content, "utf8");
    return catalog.registerDocument({
      workspaceId: "example",
      kind,
      title: name === "document" ? title : name,
      taskId: "TEST-1234",
      featureName: "Responsive reader",
      path,
      attention: "none",
    });
  }
  const document = await add("document", source);
  const second = await add("second", "# Second document\n\n## More details\n\nContent.");
  const plain = await add("plain", "A document without headings.");
  const reviewPath = `src/${"nested/".repeat(12)}review.ts`;
  const review = await add("review", [
    "# Responsive change review",
    "",
    "```diff",
    `diff --git a/${reviewPath} b/${reviewPath}`,
    `--- a/${reviewPath}`,
    `+++ b/${reviewPath}`,
    "@@ -1 +1 @@",
    `-const text = "${"old-code".repeat(25)}";`,
    `+const text = "${"new-code".repeat(25)}";`,
    "diff --git a/src/second.ts b/src/second.ts",
    "--- a/src/second.ts",
    "+++ b/src/second.ts",
    "@@ -1 +1 @@",
    "-export const second = false;",
    "+export const second = true;",
    "```",
  ].join("\n"), "change-review");
  await catalog.createReviewRequest({
    documentId: review.id,
    documentRevision: review.revision,
    kind: "change-decision",
    requestMessage: "Review the responsive changes.",
  });
  const server = await startDeskServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    token: "browser-test-token",
  });
  return {
    document, second, plain, review, server, catalog,
    documentPath: join(workspace, "document.md"),
    source,
    async close(page: Page) {
      await page.close();
      await server.close();
      catalog.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function expectPageFits(page: Page) {
  const geometry = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const controls = Array.from(document.querySelectorAll<HTMLElement>(
      ".topbar button, .topbar input, .topbar select, .reader-toolbar button, .change-review-toolbar button, .change-view-switcher button, .change-feedback-button, .review-actions button",
    )).filter((element) => element.getClientRects().length > 0);
    return {
      viewport,
      pageWidth: document.documentElement.scrollWidth,
      outside: controls.filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left < -1 || bounds.right > viewport + 1;
      }).map((element) => element.id),
    };
  });
  expect(geometry.pageWidth, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(geometry.outside).toEqual([]);
}

test("desktop contents toggle releases width and survives reader navigation and refresh", async ({ page }) => {
  const value = await fixture();
  try {
    await page.setViewportSize({ width: 2560, height: 1200 });
    await page.goto(`${value.server.url}/d/${value.document.id}?token=browser-test-token`);
    await expect(page.locator("#reader-content h2").first()).toHaveText("Details");
    const withContents = (await page.locator("#reader-content").boundingBox())!.width;
    expect(withContents).toBeGreaterThan(1600);
    const toggle = page.getByRole("button", { name: "hide contents", exact: true });
    await expect(toggle).toHaveAttribute("aria-controls", "sidebar");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#sidebar")).toBeHidden();
    await expect(page.locator("#contents-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#contents-toggle")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#mark-read")).toBeFocused();
    const withoutContents = (await page.locator("#reader-content").boundingBox())!.width;
    expect(withoutContents).toBeGreaterThan(withContents + 200);
    const fillsMain = await page.locator(".main").evaluate((main) => {
      const style = getComputedStyle(main);
      return main.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    });
    expect(withoutContents).toBeCloseTo(fillsMain, 0);
    await page.screenshot({ path: test.info().outputPath("desktop-contents-hidden.png"), fullPage: true });
    await page.locator("#mark-read").click();
    await expect(page.locator("#sidebar")).toBeHidden();
    await page.locator("#reader-back").click();
    await page.getByRole("button", { name: "Open second", exact: true }).click();
    await expect(page.locator("#reader-content")).toContainText("More details");
    await expect(page.locator("#sidebar")).toBeHidden();
    await page.goBack();
    await page.goBack();
    await expect(page.locator("#reader-title")).toHaveText(value.document.title);
    await expect(page.locator("#sidebar")).toBeHidden();
    await writeFile(value.documentPath, `${value.source}\n\n## Live update\n\nUpdated.`, "utf8");
    await value.catalog.reconcileReferenceDocument(value.document.id);
    await expect(page.locator("#reader-content")).toContainText("Live update");
    await expect(page.locator("#sidebar")).toBeHidden();
    await page.getByRole("button", { name: "show contents", exact: true }).click();
    await expect(page.locator("#sidebar")).toBeVisible();
    await page.locator("#reader-toc-list").getByRole("link", { name: "Live update", exact: true }).click();
    await expect(page.locator("#reader-content h2").last()).toBeInViewport();
    await page.getByRole("button", { name: "hide contents", exact: true }).click();
    await page.locator("#reader-back").click();
    await page.locator("#change-reviews-filter").click();
    await page.getByRole("button", { name: "Open review", exact: true }).click();
    await expect(page.locator("#change-position")).toHaveText("file 1/2");
    await expect(page.locator("#contents-toggle")).toBeHidden();
    await page.locator("#change-view-document").click();
    await expect(page.locator("#sidebar")).toBeHidden();
    await expect(page.locator("#contents-toggle")).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "show contents", exact: true }).click();
    await page.locator("#change-view-diff").click();
    await expect(page.locator("#sidebar")).toBeHidden();
    await expect(page.locator("#contents-toggle")).toBeHidden();
    await page.locator("#change-view-document").click();
    await expect(page.locator("#sidebar")).toBeVisible();
    await expect(page.locator("#contents-toggle")).toHaveAttribute("aria-expanded", "true");
    await page.emulateMedia({ media: "print" });
    await expect(page.locator("#sidebar")).toBeHidden();
    await expect(page.locator(".reader-toolbar")).toBeHidden();
    await expect(page.locator("#reader-content")).toBeVisible();
  } finally {
    await value.close(page);
  }
});

test("document and native diff fit folded, unfolded and intermediate viewports", async ({ page }) => {
  const value = await fixture();
  try {
    for (const width of [360, 412, 760, 761, 768, 884, 1024, 1025, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${value.server.url}/d/${value.document.id}?token=browser-test-token`);
      await expect(page.locator("#reader-content h2").first()).toHaveText("Details");
      await expect(page.locator("#reader-content .mermaid svg")).toBeVisible();
      await expectPageFits(page);
      if (width <= 1024) {
        await expect.poll(() => page.locator("#reader-content table").evaluate((element) =>
          element.clientWidth > 0 && element.scrollWidth > element.clientWidth,
        )).toBe(true);
      }
      if ([412, 884, 1920].includes(width)) {
        await page.screenshot({ path: test.info().outputPath(`document-${width}.png`), fullPage: true });
      }
      if (width <= 1024) {
        await expect(page.locator("#sidebar")).toBeHidden();
        await page.getByRole("button", { name: "show contents", exact: true }).click();
        const sidebar = (await page.locator("#sidebar").boundingBox())!;
        const reader = (await page.locator("#document-reader").boundingBox())!;
        expect(sidebar.width).toBeGreaterThan(width - 2);
        expect(sidebar.y + sidebar.height).toBeLessThanOrEqual(reader.y);
        await expectPageFits(page);
      }
      await page.goto(`${value.server.url}/d/${value.review.id}`);
      await expect(page.locator("#change-position")).toHaveText("file 1/2");
      await expect(page.locator("#sidebar")).toBeHidden();
      await expectPageFits(page);
      if ([412, 884, 1920].includes(width)) {
        await page.screenshot({ path: test.info().outputPath(`native-diff-${width}.png`), fullPage: true });
      }
      const diffScroll = await page.locator("#change-diff-stage").evaluate((element) => ({
        viewport: element.clientWidth, content: element.scrollWidth,
      }));
      if (width <= 1024) expect(diffScroll.content).toBeGreaterThan(diffScroll.viewport);
      await page.locator("#change-layout").click();
      await expect(page.locator("#change-layout")).toHaveText("unified");
      await expectPageFits(page);
      if (width === 412) {
        await page.getByRole("button", { name: "feedback on file", exact: true }).click();
        await expect(page.locator("#review-feedback-message")).toBeVisible();
        const composer = (await page.locator("#review-feedback-message").boundingBox())!;
        expect(composer.x + composer.width).toBeLessThanOrEqual(width);
        await page.locator("#review-feedback-message").fill("Review feedback on a phone.");
        await page.locator("#review-feedback-save").click();
        await expect(page.locator("#review-feedback-list")).toContainText("Review feedback on a phone.");
        await expectPageFits(page);
      }
      await page.locator("#change-file-next").click();
      await expect(page.locator("#change-position")).toHaveText("file 2/2");
      await page.locator("#change-view-document").click();
      await expect(page.locator("#reader-content")).toBeVisible();
      await expectPageFits(page);
    }
  } finally {
    await value.close(page);
  }
});

test("resizing updates contents defaults while preserving an explicit choice", async ({ page }) => {
  const value = await fixture();
  try {
    await page.setViewportSize({ width: 412, height: 900 });
    await page.goto(`${value.server.url}/d/${value.document.id}?token=browser-test-token`);
    await expect(page.locator("#reader-content h2").first()).toHaveText("Details");
    await expect(page.locator("#sidebar")).toBeHidden();
    await page.setViewportSize({ width: 884, height: 900 });
    await expectPageFits(page);
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect(page.locator("#sidebar")).toBeVisible();
    await page.getByRole("button", { name: "hide contents", exact: true }).click();
    for (const width of [412, 884, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator("#sidebar")).toBeHidden();
      await expectPageFits(page);
      await expect(page.locator("#reader-title")).toHaveText(value.document.title);
    }
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible();
    await page.setViewportSize({ width: 412, height: 900 });
    await expect(page.locator("#sidebar")).toBeHidden();
    await page.getByRole("button", { name: "show contents", exact: true }).click();
    await page.emulateMedia({ media: "print" });
    await expect(page.locator("#sidebar")).toBeHidden();
    expect(await page.locator(".main").evaluate((element) => getComputedStyle(element).padding)).toBe("0px");
    expect(await page.locator("#reader-content").evaluate((element) => getComputedStyle(element).padding)).toBe("0px");
    await page.emulateMedia({ media: "screen" });
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect(page.locator("#sidebar")).toBeVisible();
    await expectPageFits(page);
  } finally {
    await value.close(page);
  }
});

test("documents without headings reserve no sidebar or contents action", async ({ page }) => {
  const value = await fixture();
  try {
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto(`${value.server.url}/d/${value.plain.id}?token=browser-test-token`);
    await expect(page.locator("#reader-content")).toContainText("A document without headings.");
    await expect(page.locator("#sidebar")).toBeHidden();
    await expect(page.locator("#contents-toggle")).toBeHidden();
    await expectPageFits(page);
  } finally {
    await value.close(page);
  }
});

test("wrapped desktop controls leave headings and queue actions accessible", async ({ page }) => {
  const value = await fixture();
  try {
    await writeFile(value.documentPath, `${value.source}\n\n${"More document content.\n\n".repeat(80)}`, "utf8");
    await value.catalog.reconcileReferenceDocument(value.document.id);
    await value.catalog.registerDocument({
      workspaceId: "example",
      path: value.documentPath,
      kind: "brief",
      title: value.document.title,
      attention: "none",
      tags: ["responsive"],
    });
    value.catalog.createSpace({
      id: "responsive",
      name: "Responsive documents and implementation reviews across desktop and folded phone workspaces",
      matchers: [{ kind: "tag", value: "responsive" }],
    });
    for (const width of [1281, 1366]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${value.server.url}/d/${value.document.id}?token=browser-test-token&space=responsive`);
      await expect(page.locator("#reader-content .mermaid svg")).toBeVisible();
      await page.evaluate(() => {
        window.addEventListener("scrollend", () => {
          document.documentElement.dataset.scrollComplete = "true";
        }, { once: true });
      });
      await page.locator("#reader-toc-list").getByRole("link", { name: "Details", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-scroll-complete", "true");
      await expect.poll(() => page.locator("#reader-content h2").first().evaluate((heading) => {
        const toolbar = document.querySelector(".reader-toolbar")!;
        return heading.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom;
      })).toBeGreaterThanOrEqual(8);
    }
    await page.locator("#reader-back").click();
    await page.locator("#space-select").selectOption("");
    await page.setViewportSize({ width: 1366, height: 300 });
    await page.locator("#select-visible").click();
    await expect(page.locator("#bulk-actions")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => page.locator("#bulk-actions").evaluate((toolbar) =>
      toolbar.getBoundingClientRect().top - document.querySelector(".topbar")!.getBoundingClientRect().bottom,
    )).toBeGreaterThanOrEqual(12);
  } finally {
    await value.close(page);
  }
});
