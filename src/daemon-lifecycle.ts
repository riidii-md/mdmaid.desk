import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  connectToDaemonInfo,
  daemonDescriptorPath,
  type DaemonConnection,
} from "./daemon-state.js";

const START_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 50;

export async function startDaemon(
  statePath: string,
  port?: number,
): Promise<DaemonConnection> {
  const existing = await connectToDaemonInfo(statePath);
  if (existing) {
    assertRequestedPort(existing, port);
    return existing;
  }

  const directory = dirname(resolve(statePath));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lockPath = join(directory, "daemon.start.lock");
  let lock;
  try {
    lock = await open(
      lockPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
    if (await removeDeadProcessLock(lockPath)) {
      return startDaemon(statePath, port);
    }
    const concurrent = await waitForDaemon(statePath, START_TIMEOUT_MS);
    if (concurrent) {
      assertRequestedPort(concurrent, port);
      return concurrent;
    }
    if (await removeDeadProcessLock(lockPath)) {
      return startDaemon(statePath, port);
    }
    throw new Error("another daemon start is still in progress");
  }

  try {
    await lock.writeFile(`${process.pid}\n`, "utf8");
    await lock.sync();
    const concurrent = await connectToDaemonInfo(statePath);
    if (concurrent) {
      return concurrent;
    }

    const logPath = join(directory, "daemon.log");
    const log = await open(
      logPath,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY,
      0o600,
    );
    try {
      await chmod(logPath, 0o600);
      const entrypoint = fileURLToPath(new URL("./cli.js", import.meta.url));
      const child = spawn(
        process.execPath,
        [
          entrypoint,
          "__daemon-serve",
          "--state-path",
          resolve(statePath),
          ...(port === undefined ? [] : ["--port", String(port)]),
        ],
        {
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
        },
      );
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child.once("spawn", resolveSpawn);
        child.once("error", rejectSpawn);
      });
      child.unref();
    } finally {
      await log.close();
    }

    const connection = await waitForDaemon(statePath, START_TIMEOUT_MS);
    if (!connection) {
      throw new Error(`daemon did not start; inspect ${logPath}`);
    }
    if (port !== undefined && port !== 0 && connection.descriptor.port !== port) {
      throw new Error(`daemon did not bind requested port ${port}`);
    }
    return connection;
  } finally {
    await lock.close();
    await unlinkIfPresent(lockPath);
  }
}

function assertRequestedPort(
  connection: DaemonConnection,
  port: number | undefined,
): void {
  if (
    port !== undefined &&
    port !== 0 &&
    connection.descriptor.port !== port
  ) {
    throw new Error(
      `daemon is already running on port ${connection.descriptor.port}`,
    );
  }
}

async function removeDeadProcessLock(path: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("daemon start lock must be a regular, non-symlink file");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error("daemon start lock must have user-only permissions");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("daemon start lock must be owned by the current user");
  }
  if (info.size === 0) {
    return false;
  }
  if (info.size > 32) {
    throw new Error("invalid daemon start lock");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
  let raw: string;
  try {
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new Error("daemon start lock changed while opening");
    }
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  if (!/^[1-9]\d*\n?$/.test(raw)) {
    throw new Error("invalid daemon start lock");
  }
  const pid = Number(raw.trim());
  if (!Number.isSafeInteger(pid)) {
    throw new Error("invalid daemon start lock");
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ESRCH") {
      return false;
    }
  }
  let current;
  try {
    current = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
  if (current.dev !== info.dev || current.ino !== info.ino) {
    return false;
  }
  await unlink(path);
  return true;
}

export async function stopDaemon(statePath: string): Promise<boolean> {
  const connection = await connectToDaemonInfo(statePath);
  if (!connection) {
    return false;
  }
  try {
    process.kill(connection.descriptor.pid, "SIGTERM");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ESRCH") {
      throw error;
    }
  }
  const descriptorPath = daemonDescriptorPath(statePath);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await connectToDaemonInfo(statePath);
    if (!current) {
      return true;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `daemon did not stop; descriptor remains at ${descriptorPath}`,
  );
}

async function waitForDaemon(
  statePath: string,
  timeoutMs: number,
): Promise<DaemonConnection | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connection = await connectToDaemonInfo(statePath);
    if (connection) {
      return connection;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
