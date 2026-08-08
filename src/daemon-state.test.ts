import assert from "node:assert/strict";
import { mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Catalog } from "./catalog.js";
import {
  connectToDaemon,
  daemonDescriptorPath,
  readDaemonDescriptor,
  removeDaemonDescriptor,
  writeDaemonDescriptor,
  type DaemonDescriptor,
} from "./daemon-state.js";
import { startDeskServer } from "./server.js";

const descriptor: DaemonDescriptor = {
  protocolVersion: 1,
  pid: process.pid,
  host: "127.0.0.1",
  port: 43121,
  token: "daemon-test-token",
  startedAt: "2026-08-08T10:00:00.000Z",
};

test("atomically stores a user-only daemon descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-daemon-state-"));
  const path = join(root, "daemon.json");
  await writeDaemonDescriptor(path, descriptor);

  assert.deepEqual(await readDaemonDescriptor(path), descriptor);
  assert.equal((await stat(path)).mode & 0o077, 0);
  assert.equal(
    await removeDaemonDescriptor(path, { ...descriptor, token: "another-token" }),
    false,
  );
  assert.deepEqual(await readDaemonDescriptor(path), descriptor);
  assert.equal(await removeDaemonDescriptor(path, descriptor), true);
  assert.equal(await readDaemonDescriptor(path), undefined);
});

test("rejects malformed and symlinked daemon descriptors", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-daemon-invalid-"));
  const malformed = join(root, "malformed.json");
  await writeFile(malformed, "{}", { mode: 0o600 });
  await assert.rejects(readDaemonDescriptor(malformed), /Invalid daemon descriptor/);

  const target = join(root, "target.json");
  const link = join(root, "daemon.json");
  await writeFile(target, JSON.stringify(descriptor), { mode: 0o600 });
  await symlink(target, link);
  await assert.rejects(readDaemonDescriptor(link), /non-symlink file/);
});

test("connects to a live descriptor and removes stale connection state", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-daemon-connect-"));
  const statePath = join(root, "catalog.sqlite3");
  const catalog = await Catalog.open(statePath, { legacyStatePath: false });
  const server = await startDeskServer({ catalog, token: "daemon-live-token" });
  const live: DaemonDescriptor = {
    protocolVersion: 1,
    pid: process.pid,
    host: server.host,
    port: server.port,
    token: server.token,
    startedAt: new Date().toISOString(),
  };
  const path = daemonDescriptorPath(statePath);
  await writeDaemonDescriptor(path, live);

  try {
    assert.ok(await connectToDaemon(statePath));
  } finally {
    await server.close();
    catalog.close();
  }
  assert.equal(await connectToDaemon(statePath), undefined);
  assert.equal(await readDaemonDescriptor(path), undefined);
});
