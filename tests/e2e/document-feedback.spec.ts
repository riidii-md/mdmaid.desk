import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Locator } from "@playwright/test";

import { Catalog } from "../../dist/catalog.js";
import { startDeskServer } from "../../dist/server.js";

async function selectText(locator: Locator, start: number, end: number): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((element, { start, end }) => {
    const point = (offset: number) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (offset <= length) return { node, offset };
        offset -= length;
      }
      throw new Error("selection offset is outside the text");
    };
    const from = point(start);
    const to = point(end);
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, { start, end });
}

for (const width of [1280, 390]) {
  test(`selected-text popups persist and reopen on an ordinary document (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const root = await mkdtemp(join(tmpdir(), "mdmaid-document-feedback-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const documentPath = join(workspace, "brief.md");
    await writeFile(documentPath, [
      "# Ordinary brief",
      "",
      "Alpha beta should be explained.",
      ...Array.from({ length: 24 }, (_, index) => `\nBackground paragraph ${index + 1}.`),
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
    const document = await catalog.registerDocument({
      workspaceId: "example",
      kind: "brief",
      title: "Ordinary brief",
      path: documentPath,
      attention: "none",
    });
    const server = await startDeskServer({
      catalog,
      host: "127.0.0.1",
      port: 0,
      token: "document-feedback-token",
    });

    try {
      await page.goto(`${server.url}/d/${document.id}?token=document-feedback-token`);
      await expect(page.locator("#feedback-panel")).toBeVisible();
      await expect(page.locator("#review-panel")).toBeHidden();

      const mappedText = page.locator("[data-mdmaid-source-ref]", {
        hasText: "Alpha beta should be explained.",
      });
      await mappedText.click();
      const selectedText = await mappedText.evaluate((element) => {
        const text = element.firstChild;
        if (!text) throw new Error("mapped text node is missing");
        const range = element.ownerDocument.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 10);
        const selection = window.getSelection();
        if (!selection) throw new Error("selection is unavailable");
        selection.removeAllRanges();
        selection.addRange(range);
        element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift" }));
        return { range: range.toString(), selection: selection.toString(), node: text.textContent };
      });
      expect(selectedText).toEqual({ range: "Alpha beta", selection: "Alpha beta", node: "Alpha beta should be explained." });
      await expect(page.locator("#document-feedback-add-selection")).toBeVisible();
      const selectionBounds = await mappedText.boundingBox();
      const initialScroll = await page.evaluate(() => window.scrollY);
      const actionBounds = await page.locator("#document-feedback-add-selection").boundingBox();
      expect(actionBounds!.y - selectionBounds!.y).toBeLessThan(60);
      await page.locator("#document-feedback-add-selection").click();
      const composer = page.locator("#review-feedback-composer");
      await expect(composer).toHaveAttribute("role", "dialog");
      const composerBounds = await composer.boundingBox();
      const popupGap = Math.min(
        Math.abs(composerBounds!.y - selectionBounds!.y - selectionBounds!.height),
        Math.abs(selectionBounds!.y - composerBounds!.y - composerBounds!.height),
      );
      expect(popupGap).toBeLessThan(35);
      expect(composerBounds!.x).toBeGreaterThanOrEqual(0);
      expect(composerBounds!.x + composerBounds!.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => window.scrollY)).toBe(initialScroll);
      await expect(page.locator("#review-feedback-message")).toBeFocused();
      await page.locator("#review-feedback-save").click();
      await expect(composer.getByRole("alert")).toHaveText("Feedback text is required.");
      await page.locator("#review-feedback-message").fill("Define this phrase.");
      await page.screenshot({ path: test.info().outputPath("selection-popup.png") });
      await page.locator("#review-feedback-save").click();
      await expect(composer).toBeHidden();
      const marker = page.locator(".document-feedback-marker");
      const popup = page.locator("#document-feedback-popup");
      await expect(marker).toHaveCount(1);
      await marker.hover();
      await expect(popup).toContainText("Define this phrase.");
      await popup.hover();
      await expect(popup).toBeVisible();
      await page.mouse.move(0, 0);
      await expect(popup).toBeHidden();
      await marker.hover();
      await expect(popup).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("comment-popup.png") });
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();
      await expect(page.locator("#review-feedback-list")).toContainText("Define this phrase.");
      await page.reload();
      await expect(page.locator("#review-feedback-list")).toContainText("Define this phrase.");
      await expect(marker).toHaveCount(1);
      await marker.focus();
      await expect(popup).toBeVisible();
      await expect(popup).toContainText("Define this phrase.");
      await page.keyboard.press("Escape");
      await expect(page.locator("#document-reader")).toBeVisible();

      await page.locator("#review-feedback-list").getByRole("button", { name: /Edit feedback/ }).click();
      await expect(composer).toHaveAttribute("role", "dialog");
      await page.locator("#review-feedback-message").fill("Define this phrase, please.");
      await page.locator("#review-feedback-save").click();
      await marker.hover();
      await expect(popup).toContainText("Define this phrase, please.");
      await page.keyboard.press("Escape");

      // A second selection can cross an existing icon without changing its offsets.
      await selectText(mappedText, 0, 10);
      await page.locator("#document-feedback-add-selection").click();
      await page.locator("#review-feedback-message").fill("Another comment on this selection.");
      await page.locator("#review-feedback-save").click();
      await expect(marker).toHaveCount(1);
      await marker.hover();
      await expect(popup).toContainText("Another comment on this selection.");
      await expect(popup).toContainText("Define this phrase, please.");
      await page.keyboard.press("Escape");
      await page.locator(".review-feedback-item").filter({ hasText: "Another comment" })
        .getByRole("button", { name: /Remove feedback/ }).click();
      await expect(marker).toHaveCount(1);
      await marker.hover();
      await expect(popup).not.toContainText("Another comment");
      await page.keyboard.press("Escape");

      await selectText(mappedText, 0, 10);
      await page.locator("#document-feedback-add-selection").click();
      await page.locator("#review-feedback-message").fill("Cancelled comment");
      await page.keyboard.press("Escape");
      await expect(composer).toBeHidden();
      await expect(page.locator("#document-reader")).toBeVisible();
      await expect(page.locator("#review-feedback-list")).not.toContainText("Cancelled comment");
      await page.locator("#feedback-general-message").fill("Overall context.");
      await page.locator("#feedback-send").click();

      const feedbackLink = page.locator("#feedback-error a");
      await expect(feedbackLink).toHaveAttribute("href", /\/f\/feedback-[a-f0-9]{20}/);
      const href = await feedbackLink.getAttribute("href");
      expect(href).not.toBeNull();
      const feedbackId = href!.match(/feedback-[a-f0-9]{20}/)?.[0];
      expect(feedbackId).toBeTruthy();
      const stored = catalog.getFeedback(feedbackId!);
      expect(stored?.generalMessage).toBe("Overall context.");
      expect(stored?.comments[0]?.message).toBe("Define this phrase, please.");
      expect(stored?.comments[0]?.anchor.kind).toBe("markdown-v1");
      expect(catalog.listReviewRequests()).toEqual([]);

      await expect(marker).toHaveCount(1);
      await marker.click();
      await expect(popup).toContainText("Define this phrase, please.");
      await page.keyboard.press("Escape");

      await feedbackLink.click();
      await expect(page).toHaveURL(new RegExp(`/f/${feedbackId}`));
      await expect(page.locator("#reader-title")).toHaveText("Ordinary brief");
      await expect(page.locator("#feedback-history")).toContainText(feedbackId!);
      await expect(page.locator("#feedback-history")).toContainText("Define this phrase, please.");
      await expect(marker).toHaveCount(1);
      await marker.hover();
      await expect(popup).toContainText("Define this phrase, please.");
      await page.keyboard.press("Escape");

      const staleText = page.locator("[data-mdmaid-source-ref]", {
        hasText: "Alpha beta should be explained.",
      });
      await staleText.click();
      await staleText.evaluate((element) => {
        const text = element.firstChild;
        if (!text) throw new Error("mapped text node is missing");
        const range = element.ownerDocument.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 5);
        const selection = window.getSelection();
        if (!selection) throw new Error("selection is unavailable");
        selection.removeAllRanges();
        selection.addRange(range);
        element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift" }));
      });
      await page.locator("#document-feedback-add-selection").click();
      await page.locator("#review-feedback-message").fill("Stale draft must not move.");
      await page.locator("#review-feedback-save").click();
      await expect(page.locator("#review-feedback-list")).toContainText(
        "Stale draft must not move.",
      );

      await writeFile(documentPath, [
        "# Ordinary brief",
        "",
        "A revised explanation replaces the original sentence.",
      ].join("\n"), "utf8");
      const revised = await catalog.registerDocument({
        workspaceId: "example",
        kind: "brief",
        title: "Ordinary brief",
        path: documentPath,
        attention: "none",
      });
      expect(revised.revision).toBe(document.revision + 1);
      await expect(page.locator("#reader-content")).toContainText(
        "A revised explanation replaces the original sentence.",
      );
      await expect(page.locator("#review-feedback-list")).not.toContainText(
        "Stale draft must not move.",
      );
      await expect(marker).toHaveCount(0);
      await expect(popup).toBeHidden();

      await page.goto(new URL(href!, server.url).toString());
      await expect(page.locator("#feedback-history")).toContainText(feedbackId!);
      await expect(page.locator("#feedback-history")).toContainText(
        `revision ${document.revision} · historical`,
      );
      await expect(page.locator("#feedback-history")).toContainText("Define this phrase, please.");
    } finally {
      await page.close();
      await server.close();
      catalog.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
