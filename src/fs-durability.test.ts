import assert from "node:assert/strict";
import test from "node:test";

import { isUnsupportedDirectorySyncError } from "./fs-durability.js";

function filesystemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

test("accepts unsupported directory sync operations without hiding I/O errors", () => {
  assert.equal(
    isUnsupportedDirectorySyncError(filesystemError("EPERM"), "win32"),
    true,
  );
  assert.equal(
    isUnsupportedDirectorySyncError(filesystemError("EISDIR"), "win32"),
    true,
  );
  assert.equal(
    isUnsupportedDirectorySyncError(filesystemError("EINVAL"), "linux"),
    true,
  );
  assert.equal(
    isUnsupportedDirectorySyncError(filesystemError("EPERM"), "linux"),
    false,
  );
  assert.equal(
    isUnsupportedDirectorySyncError(filesystemError("EIO"), "win32"),
    false,
  );
});
