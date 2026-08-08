import assert from "node:assert/strict";
import { chmod, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { authTokenPath, readOrCreateAuthToken } from "./auth-state.js";

test("creates and reuses a user-only persistent authentication token", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-auth-state-"));
  const statePath = join(root, "catalog.sqlite3");

  const [first, concurrent] = await Promise.all([
    readOrCreateAuthToken(statePath),
    readOrCreateAuthToken(statePath),
  ]);
  const second = await readOrCreateAuthToken(statePath);

  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(concurrent, first);
  assert.equal(second, first);
  assert.equal((await stat(authTokenPath(statePath))).mode & 0o077, 0);
});

test("rejects exposed, malformed, and symlinked authentication tokens", async () => {
  const exposedRoot = await mkdtemp(join(tmpdir(), "mdmaid-desk-auth-exposed-"));
  const exposedState = join(exposedRoot, "catalog.sqlite3");
  await writeFile(authTokenPath(exposedState), "a".repeat(43), { mode: 0o600 });
  await chmod(authTokenPath(exposedState), 0o644);
  await assert.rejects(
    readOrCreateAuthToken(exposedState),
    /user-only permissions/,
  );

  const malformedRoot = await mkdtemp(join(tmpdir(), "mdmaid-desk-auth-bad-"));
  const malformedState = join(malformedRoot, "catalog.sqlite3");
  await writeFile(authTokenPath(malformedState), "not-a-valid-token\n", {
    mode: 0o600,
  });
  await assert.rejects(readOrCreateAuthToken(malformedState), /Invalid auth token/);

  const linkedRoot = await mkdtemp(join(tmpdir(), "mdmaid-desk-auth-link-"));
  const linkedState = join(linkedRoot, "catalog.sqlite3");
  const target = join(linkedRoot, "target");
  await writeFile(target, `${"b".repeat(43)}\n`, { mode: 0o600 });
  await symlink(target, authTokenPath(linkedState));
  await assert.rejects(
    readOrCreateAuthToken(linkedState),
    /regular, non-symlink file/,
  );
});
