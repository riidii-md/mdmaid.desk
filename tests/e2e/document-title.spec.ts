import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { Catalog } from "../../dist/catalog.js";
import { startDeskServer } from "../../dist/server.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-title-browser-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  await catalog.addWorkspace({
    id: "title-test",
    name: "Title test",
    root: workspace,
    artifactRoots: [workspace],
  });
  async function addDocument(name: string, title: string) {
    const path = join(workspace, `${name}.md`);
    await writeFile(path, "# Document body\n", "utf8");
    const input = {
      workspaceId: "title-test",
      path,
      kind: "brief" as const,
      title,
      attention: "none" as const,
    };
    return { document: await catalog.registerDocument(input), input };
  }
  const first = await addDocument("first", "Daemon plan");
  const second = await addDocument("second", "Review <storage> & rollout — Проба");
  const server = await startDeskServer({ catalog });
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

test("names tabs after the open document across navigation and archive", async ({ page }) => {
  const value = await fixture();
  try {
    await page.goto(value.server.webUrl);
    await expect(page).toHaveTitle("mdmaid.desk");
    await page.getByRole("button", { name: "Open Daemon plan", exact: true }).click();
    await expect(page).toHaveTitle(value.first.document.title);
    await expect(page).toHaveURL(new RegExp(`/d/${value.first.document.id}`));

    await page.goBack();
    await expect(page).toHaveTitle("mdmaid.desk");
    await page.goForward();
    await expect(page).toHaveTitle(value.first.document.title);
    await page.locator("#reader-back").click();
    await expect(page).toHaveTitle("mdmaid.desk");

    await page.getByRole("button", {
      name: `Open ${value.second.document.title}`,
      exact: true,
    }).click();
    await expect(page).toHaveTitle(value.second.document.title);
    await expect(page).toHaveURL(new RegExp(`/d/${value.second.document.id}`));
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/assets/favicon.svg");

    await page.locator("#archive").click();
    await page.locator("#document-action-confirm").click();
    await expect(page.locator("#queue-panel")).toBeVisible();
    await expect(page).toHaveTitle("mdmaid.desk");
  } finally {
    await page.close();
    await value.close();
  }
});

test("keeps direct-link tab titles current after catalog updates", async ({ page }) => {
  const value = await fixture();
  try {
    await page.goto(`${value.server.url}/d/${value.second.document.id}?token=${value.server.token}`);
    await expect(page).toHaveTitle(value.second.document.title);
    await expect(page.locator("#reader-content h1")).toHaveText("Document body");
    await expect(page.locator("#live-status")).toHaveText(/connected/);

    const title = "Revised storage review";
    const updated = await page.request.post(`${value.server.url}/api/v1/documents`, {
      headers: { authorization: `Bearer ${value.server.token}` },
      data: { ...value.second.input, title },
    });
    expect(updated.ok()).toBe(true);
    await expect(page).toHaveTitle(title);
    await expect(page.locator("#reader-title")).toHaveText(title);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/assets/favicon.svg");
  } finally {
    await page.close();
    await value.close();
  }
});
