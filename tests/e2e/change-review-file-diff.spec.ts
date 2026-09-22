import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { Catalog } from "../../dist/catalog.js";
import { startDeskServer } from "../../dist/server.js";

test("shows the complete selected-file diff without hunk navigation", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-change-review-browser-"));
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
  const path = join(workspace, "review.md");
  await writeFile(path, [
    "# Authentication refactor",
    "",
    "```diff",
    "diff --git a/src/auth.ts b/src/auth.ts",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1 +1 @@",
    "-return token == expected;",
    "+return token === expected;",
    "@@ -10 +10 @@",
    "-return fallback;",
    "+return secureFallback;",
    "```",
  ].join("\n"), "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "change-review",
    title: "Authentication refactor",
    path,
    attention: "none",
  });
  const server = await startDeskServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    token: "browser-test-token",
  });

  try {
    await page.goto(
      `${server.url}/d/${document.id}?token=browser-test-token`,
    );
    await expect(page.locator("#change-review-viewer")).toBeVisible();
    await expect(page.locator("#change-position")).toHaveText("file 1/1");
    await expect(page.locator("#change-diff-stage")).toContainText(
      "return token === expected;",
    );
    await expect(page.locator("#change-diff-stage")).toContainText(
      "return secureFallback;",
    );
    await expect(page.locator("#change-hunk-previous")).toHaveCount(0);
    await expect(page.locator("#change-hunk-next")).toHaveCount(0);

    await page.locator("#change-layout").click();
    await expect(page.locator("#change-layout")).toHaveText("unified");
    await expect(page.locator("#change-diff-stage")).toContainText(
      "return secureFallback;",
    );
  } finally {
    await server.close();
    catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});
