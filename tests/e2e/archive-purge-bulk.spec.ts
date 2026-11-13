import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { Catalog } from "../../dist/catalog.js";
import { startDeskServer } from "../../dist/server.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-archive-browser-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  await catalog.addWorkspace({
    id: "archive-test",
    name: "Archive test",
    root: workspaceRoot,
    artifactRoots: [workspaceRoot],
  });

  async function addDocument(title: string) {
    const path = join(workspaceRoot, `${title.replaceAll(" ", "-")}.md`);
    await writeFile(path, `# ${title}\n`, "utf8");
    const document = await catalog.registerDocument({
      workspaceId: "archive-test",
      taskId: "ARCHIVE-1",
      featureName: "Archive controls",
      kind: "brief",
      title,
      path,
      attention: "none",
    });
    return { document, path };
  }

  const first = await addDocument("Doc A");
  const second = await addDocument("Doc B");
  const server = await startDeskServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    token: "archive-browser-token",
  });
  return {
    first,
    second,
    server,
    async close() {
      await server.close();
      catalog.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("confirms archive and purge while supporting bulk restore", async ({ page }) => {
  const value = await fixture();
  try {
    await page.goto(`${value.server.url}/?token=archive-browser-token`);
    await expect(page.getByRole("button", { name: "Open Doc A" })).toBeVisible();

    await page.locator("#select-visible").click();
    await expect(page.locator("#selection-count")).toHaveText("2 selected");
    await page.locator("#bulk-archive").click();
    await expect(page.locator("#document-action-dialog")).toBeVisible();
    await page.locator("#document-action-cancel").click();
    await expect(page.getByRole("button", { name: "Open Doc A" })).toBeVisible();

    await page.locator("#bulk-archive").click();
    await page.locator("#document-action-confirm").click();
    await expect(page.getByRole("button", { name: "Open Doc A" })).toHaveCount(0);
    await expect(page.locator("#archive-undo")).toBeVisible();

    await page.locator("#archive-filter").click();
    await expect(page.getByRole("button", { name: "Open Doc A" })).toBeVisible();
    await page.locator("#select-visible").click();
    await page.locator("#bulk-restore").click();
    await expect(page.getByRole("button", { name: "Open Doc A" })).toHaveCount(0);

    await page.locator("#docs-filter").click();
    await expect(page.getByRole("button", { name: "Open Doc A" })).toBeVisible();
    await page.getByLabel("Select Doc A").check();
    await page.locator("#bulk-archive").click();
    await page.locator("#document-action-confirm").click();
    await page.locator("#archive-filter").click();
    await expect(page.getByRole("button", { name: "Open Doc A" })).toBeVisible();

    await page.getByLabel("Select Doc A").check();
    await page.locator("#bulk-purge").click();
    await expect(page.locator("#document-action-dialog")).toContainText(
      "cannot be undone",
    );
    await page.locator("#document-action-cancel").click();
    await expect(page.getByRole("button", { name: "Open Doc A" })).toBeVisible();

    await page.locator("#bulk-purge").click();
    await page.locator("#document-action-confirm").click();
    await expect(page.getByRole("button", { name: "Open Doc A" })).toHaveCount(0);
    await access(value.first.path);
    await access(value.second.path);
  } finally {
    await value.close();
  }
});
