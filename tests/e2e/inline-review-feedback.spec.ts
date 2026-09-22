import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { Catalog } from "../../dist/catalog.js";
import { startDeskServer } from "../../dist/server.js";

test("selects, persists, and renders a review comment inline", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-inline-feedback-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const documentPath = join(workspace, "change-review.md");
  await writeFile(documentPath, [
    "# Validation change",
    "",
    "```diff",
    "diff --git a/src/validation.ts b/src/validation.ts",
    "--- a/src/validation.ts",
    "+++ b/src/validation.ts",
    "@@ -4 +4,2 @@",
    " validate(input);",
    "+normalize(input);",
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
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "change-review",
    title: "Validation change",
    path: documentPath,
    attention: "approval",
  });
  await catalog.createReviewRequest({
    documentId: document.id,
    kind: "change-decision",
    requestMessage: "Review this validation change.",
  });
  const server = await startDeskServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    token: "inline-feedback-token",
  });

  try {
    await page.goto(`${server.url}/?token=inline-feedback-token`);
    await page.locator("#change-reviews-filter").click();
    await page.getByRole("button", { name: "Open Validation change" }).click();

    const lineFour = page.getByRole("button", {
      name: /Add feedback on new line 4/,
    });
    const lineFive = page.getByRole("button", {
      name: /Add feedback on new line 5/,
    });
    await lineFour.click();
    await expect(page.locator(".native-diff #review-feedback-composer")).toBeVisible();
    await lineFive.click({ modifiers: ["Shift"] });
    await expect(page.locator("#review-feedback-anchor")).toHaveText(
      "Feedback on src/validation.ts:4-5 (new)",
    );
    await expect(page.locator("button.diff-line-number.selected-range")).toHaveCount(2);

    await page.locator("#review-feedback-message").fill(
      "Keep this validation block together.",
    );
    await page.locator("#review-feedback-save").click();
    await expect(page.locator(".diff-inline-feedback")).toContainText(
      "Keep this validation block together.",
    );
    await expect(page.locator("#review-feedback-list")).toContainText(
      "src/validation.ts:4-5 (new)",
    );

    await page.reload();
    await expect(page.locator(".diff-inline-feedback")).toContainText(
      "Keep this validation block together.",
    );
  } finally {
    await server.close();
    catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});
