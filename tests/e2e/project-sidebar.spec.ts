import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { Catalog } from "../../dist/catalog.js";
import { startDeskServer } from "../../dist/server.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-sidebar-browser-"));
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  const workspaces = ["alpha", "beta"];
  for (const id of workspaces) {
    const directory = join(root, id);
    await mkdir(directory);
    await catalog.addWorkspace({
      id,
      name: id,
      root: directory,
      artifactRoots: [directory],
      repository: "github.com/example/browser-test",
      repositoryName: "Browser test",
    });
  }
  async function addDocument(workspaceId: string, taskId: string, title: string) {
    const path = join(root, workspaceId, `${title.replaceAll(" ", "-")}.md`);
    await writeFile(path, `# ${title}\n`, "utf8");
    return catalog.registerDocument({
      workspaceId,
      taskId,
      featureName: taskId === "TEST-1" ? "Project A" : "Project B",
      kind: "brief",
      title,
      path,
      attention: "none",
    });
  }
  const documentA = await addDocument("alpha", "TEST-1", "Doc A");
  const documentB = await addDocument("beta", "TEST-2", "Doc B");
  await addDocument("beta", "TEST-1", "Shared project doc");
  const server = await startDeskServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    token: "browser-test-token",
  });
  return {
    documentA,
    documentB,
    server,
    async close() {
      await server.close();
      catalog.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("project sidebar leaves the reader and survives history and reload", async ({ page }) => {
  const value = await fixture();
  try {
    await page.goto(`${value.server.url}/?token=browser-test-token`);
    await expect(page.getByRole("button", { name: "Open Doc A" })).toBeVisible();

    await page.locator("#project-nav").getByRole("button", { name: /TEST-1/ }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${value.documentA.projectId}$`));
    await page.getByRole("button", { name: "Open Doc A" }).click();
    await expect(page).toHaveURL(new RegExp(`/d/${value.documentA.id}$`));

    await page.locator("#project-nav").getByRole("button", { name: /TEST-2/ }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${value.documentB.projectId}$`));
    await expect(page.getByRole("button", { name: "Open Doc B" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Doc A" })).toHaveCount(0);
    await expect(page.locator("#document-reader")).toBeHidden();

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/d/${value.documentA.id}$`));
    await expect(page.locator("#document-reader")).toBeVisible();
    await page.reload();
    await expect(page.locator("#reader-title")).toHaveText("Doc A");
    await page.locator("#reader-back").click();
    await expect(page).toHaveURL(new RegExp(`/p/${value.documentA.projectId}$`));

    await page.getByRole("button", { name: "Open Doc A" }).click();
    await expect(page.locator("#document-reader")).toBeVisible();
    await page.locator("#actions-filter").click();
    await expect(page.locator("#document-reader")).toBeHidden();
    await page.reload();
    await expect(page.locator("#actions-filter")).toHaveClass(/active/);
    await expect(page).toHaveURL(new RegExp(`/p/${value.documentA.projectId}$`));

    await page.locator("#change-reviews-filter").click();
    await page.reload();
    await expect(page.locator("#change-reviews-filter")).toHaveClass(/active/);
    await expect(page.locator("#queue-title")).toHaveText("Change Reviews");

    await page.goto(`${value.server.url}/w/alpha`);
    await expect(page.getByRole("button", { name: "Open Doc A" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Shared project doc" })).toHaveCount(0);
  } finally {
    await value.close();
  }
});

test("late missing-source refresh cannot reopen the reader after a project click", async ({ page }) => {
  const value = await fixture();
  try {
    await page.goto(`${value.server.url}/?token=browser-test-token`);
    await expect(page.getByRole("button", { name: "Open Doc A" })).toBeVisible();

    await page.route(`**/api/v1/documents/${value.documentA.id}/render?target=web`, (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "source_missing", message: "Source missing" } }),
      }),
    );
    let releaseDocuments!: () => void;
    const documentsReleased = new Promise<void>((resolve) => {
      releaseDocuments = resolve;
    });
    await page.route("**/api/v1/documents", async (route) => {
      await documentsReleased;
      await route.continue();
    });

    const refreshRequested = page.waitForRequest((request) =>
      request.url().endsWith("/api/v1/documents"),
    );
    await page.getByRole("button", { name: "Open Doc A" }).click();
    await refreshRequested;
    await page.locator("#project-nav").getByRole("button", { name: /TEST-2/ }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${value.documentB.projectId}$`));
    const refreshCompleted = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/documents"),
    );
    releaseDocuments();
    await refreshCompleted;
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    ));

    await expect(page.locator("#document-reader")).toBeHidden();
    await expect(page.getByRole("button", { name: "Open Doc B" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/p/${value.documentB.projectId}$`));
    await page.goBack();
    await expect(page).toHaveURL(value.server.url + "/");
    await expect(page.locator("#document-reader")).toBeHidden();
  } finally {
    await value.close();
  }
});
