import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DeskApiClient } from "./api-client.js";
import { Catalog } from "./catalog.js";
import { isEntrypoint, run } from "./cli.js";
import {
  daemonDescriptorPath,
  readDaemonDescriptor,
  type DaemonConnection,
} from "./daemon-state.js";
import type {
  DeskServerOptions,
  RunningDeskServer,
} from "./server.js";

function output(): {
  write: (value: string) => void;
  text: () => string;
} {
  const chunks: string[] = [];
  return {
    write: (value) => {
      chunks.push(value);
    },
    text: () => chunks.join(""),
  };
}

test("adds a workspace, registers a document, and lists it", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-"));
  const workspace = join(root, "workspace");
  const statePath = join(root, "state", "catalog.sqlite3");
  const documentPath = join(workspace, "plan.md");
  await mkdir(workspace);
  await writeFile(documentPath, "# Plan\n", "utf8");
  const stdout = output();
  const stderr = output();

  assert.equal(
    await run(
      [
        "workspace",
        "add",
        workspace,
        "--id",
        "example",
        "--name",
        "Example",
      ],
      stdout,
      stderr,
      { statePath },
    ),
    0,
  );
  assert.equal(
    await run(
      [
        "register",
        documentPath,
        "--workspace",
        "example",
        "--kind",
        "plan",
        "--task",
        "PROJECT-123",
        "--attention",
        "approval",
      ],
      stdout,
      stderr,
      { statePath },
    ),
    0,
  );
  assert.equal(
    await run(
      ["list", "--workspace", "example", "--task", "PROJECT-123"],
      stdout,
      stderr,
      { statePath },
    ),
    0,
  );
  assert.equal(
    await run(["workspace", "list"], stdout, stderr, { statePath }),
    0,
  );

  assert.match(stdout.text(), /workspace example added/);
  assert.match(stdout.text(), /registered doc-/);
  assert.match(stdout.text(), /PROJECT-123/);
  assert.equal(stderr.text(), "");
});

test("publishes an explicit review gate and returns its response as JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-review-"));
  const workspace = join(root, "workspace");
  const statePath = join(root, "state", "catalog.sqlite3");
  const documentPath = join(workspace, "plan.md");
  await mkdir(workspace);
  await writeFile(documentPath, "# Plan\n", "utf8");
  const stderr = output();
  assert.equal(
    await run(
      ["workspace", "add", workspace, "--id", "example"],
      output(),
      stderr,
      { statePath },
    ),
    0,
  );

  const publishedOutput = output();
  assert.equal(
    await run(
      [
        "register",
        documentPath,
        "--workspace",
        "example",
        "--kind",
        "plan",
        "--expect",
        "plan-decision",
        "--request-message",
        "Verify rollback before approval.",
        "--json",
      ],
      publishedOutput,
      stderr,
      { statePath },
    ),
    0,
  );
  const published = JSON.parse(publishedOutput.text()) as {
    document: { id: string; revision: number };
    reviewRequest: { id: string; requestMessage: string; status: string };
    schemaVersion: number;
  };
  assert.equal(published.schemaVersion, 1);
  assert.equal(published.reviewRequest.status, "pending");
  assert.equal(
    published.reviewRequest.requestMessage,
    "Verify rollback before approval.",
  );

  const responseOutput = output();
  assert.equal(
    await run(
      [
        "review",
        "respond",
        published.reviewRequest.id,
        "--outcome",
        "changes_requested",
        "--message",
        "Add a restore verification step.",
        "--json",
      ],
      responseOutput,
      stderr,
      { statePath },
    ),
    0,
  );
  assert.equal(
    JSON.parse(responseOutput.text()).reviewRequest.response.message,
    "Add a restore verification step.",
  );

  const waitOutput = output();
  assert.equal(
    await run(
      ["review", "wait", published.reviewRequest.id, "--json"],
      waitOutput,
      stderr,
      { statePath },
    ),
    0,
  );
  const waited = JSON.parse(waitOutput.text());
  assert.equal(waited.reviewRequest.status, "changes_requested");
  assert.equal(
    waited.reviewRequest.requestMessage,
    "Verify rollback before approval.",
  );

  const createdOutput = output();
  assert.equal(
    await run(
      [
        "review",
        "create",
        published.document.id,
        "--kind",
        "plan-decision",
        "--message",
        "Verify the follow-up plan.",
        "--json",
      ],
      createdOutput,
      stderr,
      { statePath },
    ),
    0,
  );
  const created = JSON.parse(createdOutput.text());
  assert.equal(created.reviewRequest.status, "pending");
  assert.equal(
    created.reviewRequest.requestMessage,
    "Verify the follow-up plan.",
  );

  const shownOutput = output();
  assert.equal(
    await run(
      ["review", "show", created.reviewRequest.id, "--json"],
      shownOutput,
      stderr,
      { statePath },
    ),
    0,
  );
  assert.deepEqual(
    JSON.parse(shownOutput.text()).reviewRequest,
    created.reviewRequest,
  );
  assert.equal(stderr.text(), "");
});

test("waits on daemon events and returns the durable review decision", async () => {
  const pending = {
    id: "review-0123456789abcdefabcd",
    documentId: "doc-0123456789abcdefabcd",
    documentRevision: 1,
    kind: "plan-decision" as const,
    requestMessage: "Check the rollout.",
    status: "pending" as const,
    response: null,
    staleAt: null,
    createdAt: "2026-08-19T09:00:00.000Z",
  };
  const approved = {
    ...pending,
    status: "approved" as const,
    response: {
      outcome: "approved" as const,
      message: "Proceed after the canary check.",
      createdAt: "2026-08-19T09:05:00.000Z",
    },
  };
  let current = pending as typeof pending | typeof approved;
  const client = {
    getReviewRequest: async () => current,
    subscribeCatalog: async (
      onEvent: (event: { action: string; reviewRequestId: string }) => void,
      options: { signal?: AbortSignal; onReady?: () => void },
    ) => {
      options.onReady?.();
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => {
          current = approved;
          onEvent({
            action: "review-responded",
            reviewRequestId: pending.id,
          });
        }, 1);
        options.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolvePromise();
          },
          { once: true },
        );
      });
    },
  } as unknown as DeskApiClient;
  const stdout = output();
  const stderr = output();

  assert.equal(
    await run(
      ["review", "wait", pending.id, "--json"],
      stdout,
      stderr,
      {
        statePath: "/unused/catalog.sqlite3",
        connectDaemon: async () => client,
      },
    ),
    0,
  );
  const result = JSON.parse(stdout.text());
  assert.equal(result.reviewRequest.status, "approved");
  assert.equal(
    result.reviewRequest.response.message,
    "Proceed after the canary check.",
  );
  assert.equal(stderr.text(), "");
});

test("keeps attention-only documents passive and validates review flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-passive-"));
  const workspace = join(root, "workspace");
  const statePath = join(root, "state", "catalog.sqlite3");
  const documentPath = join(workspace, "plan.md");
  await mkdir(workspace);
  await writeFile(documentPath, "# Plan\n", "utf8");
  await run(
    ["workspace", "add", workspace, "--id", "example"],
    output(),
    output(),
    { statePath },
  );
  assert.equal(
    await run(
      [
        "register",
        documentPath,
        "--workspace",
        "example",
        "--attention",
        "approval",
      ],
      output(),
      output(),
      { statePath },
    ),
    0,
  );
  const catalog = await Catalog.open(statePath);
  assert.deepEqual(catalog.listReviewRequests(), []);
  catalog.close();

  const stderr = output();
  assert.equal(
    await run(
      [
        "register",
        documentPath,
        "--workspace",
        "example",
        "--wait",
      ],
      output(),
      stderr,
      { statePath },
    ),
    2,
  );
  assert.match(stderr.text(), /--wait requires --expect/);
});

test("routes producer writes through a live daemon without opening local storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-producer-"));
  const statePath = join(root, "missing", "catalog.sqlite3");
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "review.md");
  await mkdir(workspace);
  await writeFile(documentPath, "# Review\n", "utf8");
  const calls: unknown[] = [];
  const client = {
    addWorkspace: async (input: unknown) => {
      calls.push(["workspace", input]);
      return { id: "example", name: "Example", documentCount: 0, route: "/w/example" };
    },
    registerDocument: async (input: unknown) => {
      calls.push(["document", input]);
      return {
        id: "doc-0123456789abcdefabcd",
        workspaceId: "example",
        producer: "codex",
        kind: "review",
        title: "Review",
        attention: "review",
        tags: ["agent"],
        revision: 1,
        openedRevision: null,
        completedRevision: null,
        status: "unread",
        archivedAt: null,
        missingAt: null,
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
        route: "/d/doc-0123456789abcdefabcd",
      };
    },
    importDocument: async (input: unknown) => {
      calls.push(["import", input]);
      return {
        id: "doc-fedcba9876543210abcd",
        workspaceId: "example",
        storage: "managed",
        kind: "brief",
        title: "Review",
        attention: "review",
        tags: [],
        revision: 1,
        openedRevision: null,
        completedRevision: null,
        status: "unread",
        archivedAt: null,
        missingAt: null,
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
        route: "/d/doc-fedcba9876543210abcd",
      };
    },
  } as unknown as DeskApiClient;
  const stdout = output();
  const stderr = output();
  const options = { statePath, connectDaemon: async () => client };

  assert.equal(
    await run(
      ["workspace", "add", workspace, "--id", "example", "--name", "Example"],
      stdout,
      stderr,
      options,
    ),
    0,
  );
  assert.equal(
    await run(
      [
        "import",
        documentPath,
        "--workspace",
        "example",
        "--kind",
        "brief",
        "--attention",
        "review",
      ],
      stdout,
      stderr,
      options,
    ),
    0,
  );
  assert.equal(
    await run(
      [
        "register",
        documentPath,
        "--workspace",
        "example",
        "--kind",
        "review",
        "--attention",
        "review",
        "--producer",
        "codex",
        "--tag",
        "agent",
      ],
      stdout,
      stderr,
      options,
    ),
    0,
  );

  assert.deepEqual(calls, [
    ["workspace", { id: "example", name: "Example", root: workspace, artifactRoots: [workspace] }],
    ["import", {
      workspaceId: "example",
      kind: "brief",
      title: "review",
      path: documentPath,
      attention: "review",
    }],
    ["document", {
      workspaceId: "example",
      producer: "codex",
      kind: "review",
      title: "review",
      path: documentPath,
      attention: "review",
      tags: ["agent"],
    }],
  ]);
  await assert.rejects(readFile(statePath), /ENOENT/);
  assert.equal(stderr.text(), "");
  assert.match(stdout.text(), /imported doc-fedcba9876543210abcd/);
});

test("returns a usage error for incomplete commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-error-"));
  const stdout = output();
  const stderr = output();

  assert.equal(
    await run(["workspace", "add"], stdout, stderr, {
      statePath: join(root, "catalog.sqlite3"),
    }),
    2,
  );
  assert.match(stderr.text(), /workspace root is required/);
});

test("uses the mdmaid-desk executable name in help output", async () => {
  const stdout = output();
  const stderr = output();

  assert.equal(await run(["--help"], stdout, stderr), 0);
  assert.match(stdout.text(), /mdmaid-desk/);
  assert.doesNotMatch(stdout.text(), /mdmaid-show/);
  assert.equal(stderr.text(), "");
});

test("prints the published package version without opening the catalog", async () => {
  const stdout = output();
  const stderr = output();
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as { version?: unknown };

  assert.equal(await run(["--version"], stdout, stderr), 0);
  assert.equal(stdout.text(), `${packageJson.version}\n`);
  assert.equal(stderr.text(), "");
});

test("recognizes an installed entrypoint reached through a filesystem alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-entrypoint-"));
  const realDirectory = join(root, "real");
  const aliasDirectory = join(root, "alias");
  const realEntrypoint = join(realDirectory, "cli.js");
  await mkdir(realDirectory);
  await writeFile(realEntrypoint, "// entrypoint\n", "utf8");
  await symlink(
    realDirectory,
    aliasDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );

  assert.equal(
    isEntrypoint(pathToFileURL(realEntrypoint).href, join(aliasDirectory, "cli.js")),
    true,
  );
});

test("runs the web service until shutdown and prints its browser URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-web-"));
  const stdout = output();
  const stderr = output();
  let started: DeskServerOptions | undefined;
  let closed = false;

  const exit = await run(["web", "--port", "43121"], stdout, stderr, {
    statePath: join(root, "catalog.sqlite3"),
    startServer: async (options) => {
      started = options;
      return fakeServer(
        () => {
          closed = true;
        },
        {
          webUrl: `${options.publicUrl}/?token=test-token`,
        },
      );
    },
    waitForShutdown: async () => {
      const descriptor = await readDaemonDescriptor(
        daemonDescriptorPath(join(root, "catalog.sqlite3")),
      );
      assert.equal(descriptor?.port, 43121);
      assert.equal(descriptor?.token, "test-token");
    },
  });

  assert.equal(exit, 0);
  assert.equal(started?.host, "127.0.0.1");
  assert.equal(started?.port, 43121);
  assert.equal(started?.publicUrl, "http://mdmaid.desk.localhost:43121");
  assert.match(started?.token ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.match(
    stdout.text(),
    /mdmaid\.desk web: http:\/\/mdmaid\.desk\.localhost:43121\/\?token=/,
  );
  assert.equal(stderr.text(), "");
  assert.equal(closed, true);
  assert.equal(
    await readDaemonDescriptor(
      daemonDescriptorPath(join(root, "catalog.sqlite3")),
    ),
    undefined,
  );
});

test("reuses a running daemon when opening the web workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-web-live-"));
  const stdout = output();
  const stderr = output();
  const connection = fakeConnection();

  const exit = await run(["web"], stdout, stderr, {
    statePath: join(root, "catalog.sqlite3"),
    connectDaemonInfo: async () => connection,
    startServer: async () => {
      throw new Error("must not start another daemon");
    },
  });

  assert.equal(exit, 0);
  assert.equal(
    stdout.text(),
    "mdmaid.desk web: http://mdmaid.desk.localhost:43121/?token=test-token\n",
  );
  assert.equal(stderr.text(), "");
});

test("exposes explicit daemon lifecycle and user-service commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-daemon-"));
  const statePath = join(root, "catalog.sqlite3");
  const stdout = output();
  const stderr = output();
  const connection = fakeConnection();
  const calls: string[] = [];
  const options = {
    statePath,
    connectDaemonInfo: async () => connection,
    startDaemon: async (_statePath: string, port?: number) => {
      calls.push(`start:${port ?? "auto"}`);
      return connection;
    },
    stopDaemon: async () => {
      calls.push("stop");
      return true;
    },
    installUserService: async (_statePath: string, port?: number) => {
      calls.push(`install:${port ?? "auto"}`);
    },
    uninstallUserService: async () => {
      calls.push("uninstall");
    },
  };

  assert.equal(
    await run(["daemon", "start", "--port", "43210"], stdout, stderr, options),
    0,
  );
  assert.equal(await run(["daemon", "status"], stdout, stderr, options), 0);
  assert.equal(await run(["daemon", "stop"], stdout, stderr, options), 0);
  assert.equal(
    await run(["daemon", "install", "--port", "43211"], stdout, stderr, options),
    0,
  );
  assert.equal(await run(["daemon", "uninstall"], stdout, stderr, options), 0);

  assert.deepEqual(calls, [
    "start:43210",
    "stop",
    "install:43211",
    "uninstall",
  ]);
  assert.match(stdout.text(), /daemon started/);
  assert.match(stdout.text(), /daemon running/);
  assert.match(stdout.text(), /daemon stopped/);
  assert.match(stdout.text(), /user service installed/);
  assert.match(stdout.text(), /user service uninstalled/);
  assert.equal(stderr.text(), "");
});

test("uses the canonical direct localhost HTTP origin by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-http-"));
  const stdout = output();
  const stderr = output();
  let started: DeskServerOptions | undefined;

  const exit = await run(["web"], stdout, stderr, {
    statePath: join(root, "catalog.sqlite3"),
    startServer: async (options) => {
      started = options;
      return fakeServer(() => undefined, {
        port: options.port ?? 0,
        webUrl: `${options.publicUrl}/?token=${options.token ?? ""}`,
      });
    },
    waitForShutdown: async () => undefined,
  });

  assert.equal(exit, 0);
  assert.equal(started?.host, "127.0.0.1");
  assert.equal(started?.port, 43127);
  assert.equal(
    started?.publicUrl,
    "http://mdmaid.desk.localhost:43127",
  );
  assert.match(
    stdout.text(),
    /mdmaid\.desk web: http:\/\/mdmaid\.desk\.localhost:43127\/\?token=/,
  );
  assert.doesNotMatch(stdout.text(), /proxy target/);
  assert.equal(stderr.text(), "");
});

test("lets the daemon choose an available port when the default is occupied", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-open-port-"));
  const statePath = join(root, "catalog.sqlite3");
  const stdout = output();
  const stderr = output();
  const attempted: number[] = [];

  const exit = await run(
    ["__daemon-serve", "--state-path", statePath],
    stdout,
    stderr,
    {
      startServer: async (options) => {
        attempted.push(options.port ?? -1);
        if (attempted.length === 1) {
          const error = new Error("address in use") as NodeJS.ErrnoException;
          error.code = "EADDRINUSE";
          throw error;
        }
        return fakeServer(() => undefined, {
          port: 49876,
          url: "http://127.0.0.1:49876",
          webUrl: "http://127.0.0.1:49876/?token=test-token",
        });
      },
      waitForShutdown: async () => {
        const descriptor = await readDaemonDescriptor(
          daemonDescriptorPath(statePath),
        );
        assert.equal(descriptor?.port, 49876);
      },
    },
  );

  assert.equal(exit, 0);
  assert.deepEqual(attempted, [43127, 0]);
  assert.equal(stdout.text(), "");
  assert.equal(stderr.text(), "");
});

test("runs the terminal workspace through the same daemon API", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-tui-"));
  const stdout = output();
  const stderr = output();
  let clientSeen: DeskApiClient | undefined;
  let closed = false;

  const exit = await run(["tui"], stdout, stderr, {
    statePath: join(root, "catalog.sqlite3"),
    startServer: async () => fakeServer(() => {
      closed = true;
    }),
    runTui: async (client) => {
      clientSeen = client;
    },
  });

  assert.equal(exit, 0);
  assert.ok(clientSeen);
  assert.equal(stderr.text(), "");
  assert.equal(closed, true);
});

test("reuses the running daemon for the terminal workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-tui-live-"));
  const stdout = output();
  const stderr = output();
  const sharedClient = new (await import("./api-client.js")).DeskApiClient(
    "http://127.0.0.1:43121",
    "shared-token",
  );
  let clientSeen: DeskApiClient | undefined;

  const exit = await run(["tui"], stdout, stderr, {
    statePath: join(root, "catalog.sqlite3"),
    connectDaemon: async () => sharedClient,
    startServer: async () => {
      throw new Error("must not start another daemon");
    },
    runTui: async (client) => {
      clientSeen = client;
    },
  });

  assert.equal(exit, 0);
  assert.equal(clientSeen, sharedClient);
  assert.equal(stderr.text(), "");
});

test("validates web command arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-web-error-"));
  const stdout = output();
  const stderr = output();
  const statePath = join(root, "catalog.sqlite3");

  assert.equal(await run(["web", "extra"], stdout, stderr, { statePath }), 2);
  assert.equal(
    await run(["web", "--port", "70000"], stdout, stderr, { statePath }),
    2,
  );
  assert.equal(
    await run(
      ["web", "--public-url", "http://example.com"],
      stdout,
      stderr,
      { statePath },
    ),
    2,
  );
  assert.equal(
    await run(
      [
        "web",
        "--port",
        "43127",
        "--public-url",
        "http://mdmaid.desk.localhost:43128",
      ],
      stdout,
      stderr,
      { statePath },
    ),
    2,
  );
  assert.match(stderr.text(), /web accepts options only/);
  assert.match(stderr.text(), /port must be an integer between 0 and 65535/);
  assert.match(
    stderr.text(),
    /public URL must be an HTTP or HTTPS \.localhost origin/,
  );
  assert.match(stderr.text(), /HTTP public URL port must match server port/);
});

test("reports usage errors for invalid commands and options", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-usage-"));
  const statePath = join(root, "catalog.sqlite3");
  const cases: Array<{ args: string[]; message: RegExp }> = [
    { args: ["unknown"], message: /unknown command/ },
    { args: ["workspace", "remove"], message: /action must be add or list/ },
    {
      args: ["workspace", "add", root, root, "--id", "example"],
      message: /accepts one root/,
    },
    { args: ["workspace", "add", root], message: /--id is required/ },
    {
      args: ["workspace", "add", root, "--id"],
      message: /option --id requires a value/,
    },
    {
      args: ["workspace", "add", root, "--id", "example", "--unknown", "x"],
      message: /unknown option/,
    },
    {
      args: [
        "workspace",
        "add",
        root,
        "--id",
        "example",
        "--id",
        "again",
      ],
      message: /may be used only once/,
    },
    { args: ["register"], message: /document path is required/ },
    {
      args: ["register", "one.md", "two.md", "--workspace", "example"],
      message: /accepts one document path/,
    },
    {
      args: ["register", "one.md", "--workspace", "example", "--kind", "unknown"],
      message: /unknown document kind/,
    },
    {
      args: [
        "register",
        "one.md",
        "--workspace",
        "example",
        "--attention",
        "unknown",
      ],
      message: /unknown attention state/,
    },
    { args: ["list", "extra"], message: /list accepts options only/ },
  ];

  for (const entry of cases) {
    const stdout = output();
    const stderr = output();
    assert.equal(
      await run(entry.args, stdout, stderr, { statePath }),
      2,
      entry.args.join(" "),
    );
    assert.match(stderr.text(), entry.message);
  }
});

function fakeServer(
  onClose: () => void,
  overrides: Partial<RunningDeskServer> = {},
): RunningDeskServer {
  return {
    host: "127.0.0.1",
    port: 43121,
    token: "test-token",
    url: "http://127.0.0.1:43121",
    webUrl: "http://127.0.0.1:43121/?token=test-token",
    close: async () => {
      onClose();
    },
    ...overrides,
  };
}

function fakeConnection(): DaemonConnection {
  return {
    client: new DeskApiClient("http://127.0.0.1:43121", "test-token"),
    descriptor: {
      protocolVersion: 1,
      pid: process.pid,
      host: "127.0.0.1",
      port: 43121,
      token: "test-token",
      startedAt: "2026-08-12T00:00:00.000Z",
    },
    url: "http://127.0.0.1:43121",
  };
}
