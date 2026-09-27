import assert from "node:assert/strict";
import { mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Catalog } from "./catalog.js";
import {
  connectToDaemonInfo,
  connectToDaemon,
  daemonDescriptorPath,
  descriptorForServer,
  readDaemonDescriptor,
  removeDaemonDescriptor,
  writeDaemonDescriptor,
  type DaemonDescriptor,
} from "./daemon-state.js";
import { DaemonHealthCompatibilityError } from "./api-client.js";
import { startDeskServer } from "./server.js";

const descriptor: DaemonDescriptor = {
  protocolVersion: 1,
  pid: process.pid,
  host: "127.0.0.1",
  port: 43121,
  token: "daemon-test-token",
  startedAt: "2026-08-08T10:00:00.000Z",
};

test("omits a non-.localhost internal origin from the shared descriptor", () => {
  const server = {
    host: "127.0.0.1",
    port: 43121,
    token: "daemon-test-token",
    url: "http://127.0.0.1:43121",
    webUrl: "http://127.0.0.1:43121/?token=daemon-test-token",
    close: async () => undefined,
  };
  assert.equal(descriptorForServer(server).publicUrl, undefined);
});

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

  await assert.rejects(
    writeDaemonDescriptor(join(root, "unsafe.json"), {
      ...descriptor,
      publicUrl: "http://example.com",
    }),
    /Invalid daemon descriptor/,
  );
});

test("retains a live descriptor when its core-valid protocol version differs", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-daemon-version-"));
  const statePath = join(root, "catalog.sqlite3");
  const path = daemonDescriptorPath(statePath);
  await writeDaemonDescriptor(path, descriptor);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: {
      service: "mdmaid.desk",
      status: "ok",
      version: descriptor.protocolVersion + 1,
      capabilities: ["spaces-v1", "scoped-content-v1"],
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    await assert.rejects(
      connectToDaemonInfo(statePath),
      DaemonHealthCompatibilityError,
    );
    assert.deepEqual(await readDaemonDescriptor(path), descriptor);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("classifies live daemon capability extensions without deleting its descriptor", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const capabilityCase of [
      { name: "absent", value: undefined, compatible: true },
      { name: "malformed", value: ["spaces-v1", 3], compatible: false },
      {
        name: "duplicates and future values",
        value: ["spaces-v1", "spaces-v1", "future-v4"],
        compatible: true,
      },
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `mdmaid-desk-daemon-${capabilityCase.name}-`));
      const statePath = join(root, "catalog.sqlite3");
      const path = daemonDescriptorPath(statePath);
      await writeDaemonDescriptor(path, descriptor);
      globalThis.fetch = async () => new Response(JSON.stringify({
        data: {
          service: "mdmaid.desk",
          status: "ok",
          version: descriptor.protocolVersion,
          ...(capabilityCase.value === undefined
            ? {}
            : { capabilities: capabilityCase.value }),
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

      if (capabilityCase.compatible) {
        const connection = await connectToDaemonInfo(statePath);
        assert.ok(connection);
        if (capabilityCase.value === undefined) {
          await assert.rejects(
            connection.client.requireCapabilities("spaces-v1"),
            DaemonHealthCompatibilityError,
          );
        } else {
          await connection.client.requireCapabilities("spaces-v1");
        }
      } else {
        await assert.rejects(
          connectToDaemonInfo(statePath),
          DaemonHealthCompatibilityError,
        );
      }
      assert.deepEqual(await readDaemonDescriptor(path), descriptor);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
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
