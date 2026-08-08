import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { run } from "./cli.js";

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
