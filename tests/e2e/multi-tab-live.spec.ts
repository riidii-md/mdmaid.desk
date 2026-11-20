import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { Catalog } from "../../dist/catalog.js";
import { startDeskServer } from "../../dist/server.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-multi-tab-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const path = join(workspace, "document.md");
  await writeFile(path, "# Initial document\n", "utf8");
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  await catalog.addWorkspace({
    id: "multi-tab",
    name: "Multi-tab test",
    root: workspace,
    artifactRoots: [workspace],
  });
  const input = {
    workspaceId: "multi-tab",
    path,
    kind: "brief" as const,
    title: "Multi-tab document",
    attention: "none" as const,
  };
  const document = await catalog.registerDocument(input);
  const server = await startDeskServer({ catalog });
  // Count actual HTTP/1 streams: browser request-finished notifications can be
  // deferred when a page enters the back/forward cache.
  const streams = new Map<ServerResponse, string>();
  let openedStreams = 0;
  const proxy = createServer((request, response) => {
    if (request.url === "/api/v1/events") {
      const tab = request.headers["x-test-tab"];
      streams.set(response, typeof tab === "string" ? tab : "");
      openedStreams += 1;
    }
    const upstream = httpRequest(new URL(request.url ?? "/", server.url), {
      method: request.method,
      headers: request.headers,
    }, (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    response.on("close", () => {
      streams.delete(response);
      upstream.destroy();
    });
    request.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  return {
    document,
    server,
    streams,
    openedStreams: () => openedStreams,
    url: `${base}/d/${document.id}?token=${server.token}`,
    async update(content: string) {
      await writeFile(path, `# ${content}\n`, "utf8");
      await catalog.reconcileReferenceDocument(document.id);
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        proxy.close((error) => error ? reject(error) : resolve());
        proxy.closeAllConnections();
      });
      await server.close();
      catalog.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("eight tabs load and share live updates after the stream owner closes", async ({ context }) => {
  const value = await fixture();
  const { streams } = value;
  try {
    const pages = [];
    const tabIds = new Map<Page, string>();
    for (let index = 0; index < 8; index += 1) {
      const page = await context.newPage();
      pages.push(page);
      const tabId = `tab-${index}`;
      tabIds.set(page, tabId);
      await page.setExtraHTTPHeaders({ "x-test-tab": tabId });
      await page.goto(value.url, { waitUntil: "domcontentloaded", timeout: 5000 });
      await expect(page.locator("#reader-content h1")).toHaveText("Initial document");
      await expect(page.locator("#live-status")).toHaveText(/connected/);
    }
    await expect.poll(() => streams.size).toBe(1);

    await value.update("Updated in every tab");
    for (const page of pages) {
      await expect(page.locator("#reader-content h1")).toHaveText("Updated in every tab");
    }

    const firstOwner = pages.find((page) => tabIds.get(page) === [...streams.values()][0])!;
    await firstOwner.goto("about:blank");
    await expect.poll(() => streams.size).toBe(1);
    await firstOwner.goBack();
    await expect(firstOwner.locator("#reader-content h1")).toHaveText("Updated in every tab");
    await expect.poll(() => streams.size).toBe(1);

    const owner = pages.find((page) => tabIds.get(page) === [...streams.values()][0])!;
    await owner.close();
    await expect.poll(() => streams.size).toBe(1);
    await value.update("Updated after handoff");
    for (const page of pages.filter((candidate) => candidate !== owner)) {
      await expect(page.locator("#reader-content h1")).toHaveText("Updated after handoff");
    }
  } finally {
    await context.close();
    await value.close();
  }
});

for (const mode of ["unavailable", "denied"] as const) {
  test(`live refresh uses no persistent connection when coordination is ${mode}`, async ({ context }) => {
    const value = await fixture();
    await context.addInitScript((selectedMode) => {
      Object.defineProperty(navigator, "locks", {
        value: selectedMode === "unavailable" ? undefined : {
          request: () => Promise.reject(new DOMException("Not allowed", "SecurityError")),
        },
      });
    }, mode);
    try {
      const page = await context.newPage();
      await page.goto(value.url);
      await expect(page.locator("#reader-content h1")).toHaveText("Initial document");
      await expect(page.locator("#live-status")).toHaveText(/connected/);
      expect(value.openedStreams()).toBe(0);
      await value.update("Refreshed without a live stream");
      await expect(page.locator("#reader-content h1")).toHaveText("Refreshed without a live stream");
      expect(value.openedStreams()).toBe(0);
    } finally {
      await context.close();
      await value.close();
    }
  });
}
