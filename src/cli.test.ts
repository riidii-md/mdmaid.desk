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
  const root = await mkdtemp(join(tmpdir(), "mdmaid-show-cli-"));
  const workspace = join(root, "workspace");
  const statePath = join(root, "state", "catalog.json");
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

  assert.match(stdout.text(), /workspace example added/);
  assert.match(stdout.text(), /registered doc-/);
  assert.match(stdout.text(), /PROJECT-123/);
  assert.equal(stderr.text(), "");
});

test("returns a usage error for incomplete commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-show-cli-error-"));
  const stdout = output();
  const stderr = output();

  assert.equal(
    await run(["workspace", "add"], stdout, stderr, {
      statePath: join(root, "catalog.json"),
    }),
    2,
  );
  assert.match(stderr.text(), /workspace root is required/);
});
