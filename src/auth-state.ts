import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const MAX_AUTH_TOKEN_BYTES = 128;
const AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function authTokenPath(statePath: string): string {
  return join(dirname(resolve(statePath)), "auth-token");
}

export async function readOrCreateAuthToken(
  statePath: string,
): Promise<string> {
  const destination = authTokenPath(statePath);
  const existing = await readAuthToken(destination);
  if (existing !== undefined) {
    return existing;
  }

  const directory = dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const token = randomBytes(32).toString("base64url");
  const temporary = join(
    directory,
    `.${basename(destination)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let temporaryExists = false;
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    temporaryExists = true;
    try {
      await handle.writeFile(`${token}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);

    try {
      await link(temporary, destination);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
      const concurrent = await readAuthToken(destination);
      if (concurrent === undefined) {
        throw new Error("Authentication token disappeared during creation");
      }
      return concurrent;
    }
    await syncDirectory(directory);
    return token;
  } finally {
    if (temporaryExists) {
      await unlinkIfPresent(temporary);
    }
  }
}

async function readAuthToken(path: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Auth token must be a regular, non-symlink file");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error("Auth token must have user-only permissions");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("Auth token must be owned by the current user");
  }
  if (info.size === 0 || info.size > MAX_AUTH_TOKEN_BYTES) {
    throw new Error("Invalid auth token");
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new Error("Auth token changed while opening");
    }
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }

  const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!AUTH_TOKEN_PATTERN.test(token)) {
    throw new Error("Invalid auth token");
  }
  return token;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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
