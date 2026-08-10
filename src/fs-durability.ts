import { constants } from "node:fs";
import { open } from "node:fs/promises";

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
]);

export async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error, process.platform)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export function isUnsupportedDirectorySyncError(
  error: unknown,
  platform: NodeJS.Platform,
): boolean {
  if (!isNodeError(error) || typeof error.code !== "string") {
    return false;
  }
  if (UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error.code)) {
    return true;
  }
  return (
    platform === "win32" && (error.code === "EPERM" || error.code === "EISDIR")
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
