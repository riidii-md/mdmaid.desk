import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { Catalog } from "../../dist/catalog.js";
import { startDeskServer } from "../../dist/server.js";

test("switches global Spaces across Docs, Change reviews, and Actions", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-spaces-browser-"));
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
    repository: "github.com/example/product",
    repositoryName: "Product",
  });

  async function add(
    filename: string,
    title: string,
    kind: "plan" | "change-review",
    tag: "work" | "home",
  ) {
    const path = join(workspace, filename);
    await writeFile(path, `# ${title}\n`, "utf8");
    return catalog.registerDocument({
      workspaceId: "example",
      kind,
      title,
      path,
      attention: "approval",
      tags: [tag],
    });
  }
  const workPlan = await add("work.md", "Work plan", "plan", "work");
  await add("home.md", "Home notes", "plan", "home");
  const workReview = await add(
    "work-review.md",
    "Work implementation",
    "change-review",
    "work",
  );
  await catalog.createReviewRequest({
    documentId: workPlan.id,
    kind: "plan-decision",
    requestMessage: "Review the plan.",
  });
  await catalog.createReviewRequest({
    documentId: workReview.id,
    kind: "change-decision",
    requestMessage: "Review the implementation.",
  });
  catalog.createSpace({
    id: "work",
    name: "Work",
    matchers: [{ kind: "tag", value: "work" }],
  });
  catalog.createSpace({
    id: "home",
    name: "Home",
    matchers: [{ kind: "tag", value: "home" }],
  });
  const server = await startDeskServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    token: "spaces-browser-token",
  });

  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: server.url,
    });
    await page.setViewportSize({ width: 760, height: 700 });
    await page.goto(`${server.url}/?token=spaces-browser-token`);
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )).toBe(true);
    await expect(page.locator("a.brand")).toHaveAttribute("href", "/");
    await expect(page.locator("#space-select option")).toHaveText([
      "All",
      "Home",
      "Work",
    ]);
    await expect(page.getByRole("button", { name: "Open Work plan" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Home notes" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Work implementation" })).toHaveCount(0);
    await page.locator("a.brand").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#project-select")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#space-select")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#docs-filter")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#change-reviews-filter")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#theme-toggle")).toBeFocused();

    await expect(page.locator(".status-filters #actions-filter")).toHaveCount(1);

    await page.locator("#space-select").selectOption("work");
    await expect(page).toHaveURL(/space=work/);
    await expect(page.getByRole("button", { name: "Open Work plan" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Home notes" })).toHaveCount(0);

    await page.locator("#actions-filter").click();
    await expect(page.locator("#actions-filter")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Open Work plan" })).toBeVisible();
    await page.locator("#change-reviews-filter").click();
    await expect(page.locator("#actions-filter")).toHaveClass(/active/);
    await expect(page.locator("#change-reviews-filter")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#docs-filter")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "Open Work implementation" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Work plan" })).toHaveCount(0);
    await page.locator("#project-select").click();
    await page.locator('#project-options [role="option"][data-project-id]:not([data-project-id=""])').click();
    await expect(page.locator("#actions-filter")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#change-reviews-filter")).toHaveAttribute("aria-pressed", "true");

    await page.locator("#space-select").selectOption("home");
    await expect(page.locator("#document-queue")).not.toContainText("Work implementation");
    await page.locator("#docs-filter").click();
    await expect(page.getByRole("button", { name: "Open Home notes" })).toHaveCount(0);
    await page.locator('[data-status-filter="all"]').click();
    await expect(page.getByRole("button", { name: "Open Home notes" })).toBeVisible();
    await page.locator("#actions-filter").click();
    await expect(page.getByRole("button", { name: "Open Home notes" })).toHaveCount(0);
    await page.locator('[data-status-filter="unread"]').click();
    await expect(page.getByRole("button", { name: "Open Home notes" })).toBeVisible();
    await expect(page.locator("#actions-filter")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator('[data-status-filter="unread"]')).toHaveAttribute("aria-pressed", "true");

    await page.goBack();
    await page.goBack();
    await expect(page.locator("#space-select")).toHaveValue("work");
    await expect(page.locator("#change-reviews-filter")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#actions-filter")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Open Work implementation" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Work");

    await page.getByRole("button", { name: "Open Work implementation" }).click();
    await page.locator("#copy-link").click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`/d/${workReview.id}`);
    expect(copied).toContain("space=work");
    expect(copied).toContain("view=change-reviews");
    expect(copied).toContain("actions=1");

    catalog.deleteSpace("work");
    await expect(page.locator("#document-queue")).not.toContainText("Work implementation");
    await expect(page.locator('#space-select option[value="work"]')).toHaveAttribute("disabled", "");
    await expect(page.locator('#space-select option[value="work"]')).toContainText("unavailable");
    await expect(page.getByRole("status")).toContainText("space no longer exists");
    await page.locator("#space-select").selectOption("");
    await expect(page).not.toHaveURL(/space=/);
    await expect(page.getByRole("button", { name: "Open Work implementation" })).toBeVisible();
  } finally {
    await server.close();
    catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});
