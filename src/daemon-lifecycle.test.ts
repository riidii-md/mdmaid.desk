import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Catalog } from "./catalog.js";
import {
  connectToDaemonInfo,
  descriptorForServer,
  daemonDescriptorPath,
  writeDaemonDescriptor,
} from "./daemon-state.js";
import { startDaemon, stopDaemon } from "./daemon-lifecycle.js";
import { startDeskServer } from "./server.js";

test("reuses an authenticated daemon and rejects a conflicting selected port", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-lifecycle-"));
  const statePath = join(root, "catalog.sqlite3");
  const catalog = await Catalog.open(statePath, { legacyStatePath: false });
  const server = await startDeskServer({ catalog, port: 0 });
  await writeDaemonDescriptor(
    daemonDescriptorPath(statePath),
    descriptorForServer(server),
  );
  try {
    const connection = await startDaemon(statePath);
    assert.equal(connection.descriptor.port, server.port);
    await assert.rejects(
      startDaemon(statePath, server.port + 1),
      /already running on port/,
    );
  } finally {
    await server.close();
    catalog.close();
  }
  assert.equal(await stopDaemon(statePath), false);
});

test("starts on an available port, reports it, and stops cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-lifecycle-spawn-"));
  const statePath = join(root, "catalog.sqlite3");
  const connection = await startDaemon(statePath);
  try {
    assert.ok(connection.descriptor.port > 0);
    assert.equal(
      connection.descriptor.port,
      Number(new URL(connection.url).port),
    );
    const discovered = await connectToDaemonInfo(statePath);
    assert.equal(discovered?.descriptor.port, connection.descriptor.port);
  } finally {
    assert.equal(await stopDaemon(statePath), true);
  }
  assert.equal(await connectToDaemonInfo(statePath), undefined);
});

test("reclaims a user-owned start lock left by a dead process", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-lifecycle-stale-"));
  const statePath = join(root, "state", "catalog.sqlite3");
  await mkdir(join(root, "state"));
  await writeFile(
    join(root, "state", "daemon.start.lock"),
    "2147483647\n",
    { mode: 0o600 },
  );

  const connection = await startDaemon(statePath);
  try {
    assert.ok(connection.descriptor.port > 0);
  } finally {
    await stopDaemon(statePath);
  }
});
