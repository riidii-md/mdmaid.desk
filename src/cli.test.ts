import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DeskApiClient } from "./api-client.js";
import { run } from "./cli.js";
import {
  daemonDescriptorPath,
  readDaemonDescriptor,
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
