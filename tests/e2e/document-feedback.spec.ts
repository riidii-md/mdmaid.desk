import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { Catalog } from "../../dist/catalog.js";
import { startDeskServer } from "../../dist/server.js";

test("submits selected-text feedback on an ordinary document and reopens its stable route", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-document-feedback-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const documentPath = join(workspace, "brief.md");
  await writeFile(documentPath, [
    "# Ordinary brief",
    "",
    "Alpha beta should be explained.",
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
    await page.locator("#document-feedback-add-selection").click();
    await page.locator("#review-feedback-message").fill("Define this phrase.");
    await page.locator("#review-feedback-save").click();
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
    expect(stored?.comments[0]?.message).toBe("Define this phrase.");
    expect(stored?.comments[0]?.anchor.kind).toBe("markdown-v1");
    expect(catalog.listReviewRequests()).toEqual([]);

    await feedbackLink.click();
    await expect(page).toHaveURL(new RegExp(`/f/${feedbackId}`));
    await expect(page.locator("#reader-title")).toHaveText("Ordinary brief");
    await expect(page.locator("#feedback-history")).toContainText(feedbackId!);
    await expect(page.locator("#feedback-history")).toContainText("Define this phrase.");

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

    await page.goto(new URL(href!, server.url).toString());
    await expect(page.locator("#feedback-history")).toContainText(feedbackId!);
    await expect(page.locator("#feedback-history")).toContainText(
      `revision ${document.revision} · historical`,
    );
    await expect(page.locator("#feedback-history")).toContainText("Define this phrase.");
  } finally {
    await page.close();
    await server.close();
    catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});
