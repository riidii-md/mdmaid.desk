import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { DeskApiClient } from "./api-client.js";
import { syncDirectory } from "./fs-durability.js";
import type { RunningDeskServer } from "./server.js";

export const DESK_PROTOCOL_VERSION = 1;
const MAX_DESCRIPTOR_BYTES = 8 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface DaemonDescriptor {
  protocolVersion: number;
  pid: number;
  host: string;
  port: number;
  token: string;
  startedAt: string;
}

export interface DaemonConnection {
  client: DeskApiClient;
  descriptor: DaemonDescriptor;
  url: string;
}

export function daemonDescriptorPath(statePath: string): string {
  return join(dirname(resolve(statePath)), "daemon.json");
}

export function descriptorForServer(server: RunningDeskServer): DaemonDescriptor {
  return {
    protocolVersion: DESK_PROTOCOL_VERSION,
    pid: process.pid,
    host: server.host,
    port: server.port,
    token: server.token,
    startedAt: new Date().toISOString(),
  };
}

export async function writeDaemonDescriptor(
  path: string,
  descriptor: DaemonDescriptor,
): Promise<void> {
  validateDaemonDescriptor(descriptor);
  const destination = resolve(path);
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await assertReplaceable(destination);
  const temporary = join(
    directory,
    `.${basename(destination)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let created = false;
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await handle.writeFile(`${JSON.stringify(descriptor)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    created = false;
    await syncDirectory(directory);
  } finally {
    if (created) {
      await unlinkIfPresent(temporary);
    }
  }
}

export async function readDaemonDescriptor(
  path: string,
): Promise<DaemonDescriptor | undefined> {
  const destination = resolve(path);
  let info;
  try {
    info = await lstat(destination);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Daemon descriptor must be a regular, non-symlink file");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error("Daemon descriptor must have user-only permissions");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("Daemon descriptor must be owned by the current user");
  }
  if (info.size > MAX_DESCRIPTOR_BYTES) {
    throw new Error("Invalid daemon descriptor");
  }
  const handle = await open(
    destination,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let raw: string;
  try {
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new Error("Daemon descriptor changed while opening");
    }
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid daemon descriptor");
  }
  if (!isDaemonDescriptor(value)) {
    throw new Error("Invalid daemon descriptor");
  }
  return value;
}

export async function removeDaemonDescriptor(
  path: string,
  expected: DaemonDescriptor,
): Promise<boolean> {
  const current = await readDaemonDescriptor(path);
  if (!current || !sameDescriptor(current, expected)) {
    return false;
  }
  try {
    await unlink(resolve(path));
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function connectToDaemon(
  statePath: string,
): Promise<DeskApiClient | undefined> {
  return (await connectToDaemonInfo(statePath))?.client;
}

export async function connectToDaemonInfo(
  statePath: string,
): Promise<DaemonConnection | undefined> {
  const path = daemonDescriptorPath(statePath);
  const descriptor = await readDaemonDescriptor(path);
  if (!descriptor) {
    return undefined;
  }
  const host = descriptor.host.includes(":")
    ? `[${descriptor.host}]`
    : descriptor.host;
  const client = new DeskApiClient(
    `http://${host}:${descriptor.port}`,
    descriptor.token,
  );
  try {
    const health = await client.health(AbortSignal.timeout(1_000));
    if (health.version !== descriptor.protocolVersion) {
      throw new Error("Daemon protocol version does not match its descriptor");
    }
    return {
      client,
      descriptor,
      url: `http://${host}:${descriptor.port}`,
    };
  } catch {
    await removeDaemonDescriptor(path, descriptor);
    return undefined;
  }
}

function validateDaemonDescriptor(value: DaemonDescriptor): void {
  if (!isDaemonDescriptor(value)) {
    throw new Error("Invalid daemon descriptor");
  }
}

function isDaemonDescriptor(value: unknown): value is DaemonDescriptor {
  if (!isRecord(value) || Object.keys(value).length !== 6) {
    return false;
  }
  return (
    value.protocolVersion === DESK_PROTOCOL_VERSION &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.host === "string" &&
    LOOPBACK_HOSTS.has(value.host) &&
    typeof value.port === "number" &&
    Number.isSafeInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65_535 &&
    typeof value.token === "string" &&
    value.token.length >= 8 &&
    typeof value.startedAt === "string" &&
    !Number.isNaN(Date.parse(value.startedAt))
  );
}

async function assertReplaceable(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Daemon descriptor must be a regular, non-symlink file");
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function sameDescriptor(left: DaemonDescriptor, right: DaemonDescriptor): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.pid === right.pid &&
    left.host === right.host &&
    left.port === right.port &&
    left.token === right.token &&
    left.startedAt === right.startedAt
  );
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
