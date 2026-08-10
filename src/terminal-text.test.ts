import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeTerminalText } from "./terminal-text.js";

test("preserves only safe renderer-owned SGR styling", () => {
  const value = [
    "\u001b[1mBold\u001b[22m",
    "\u001b[38;2;255;119;88mAccent\u001b[39m",
    "\u001b[2Jcleared",
    "\u001b]52;c;clipboard\u0007safe",
    "\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\",
    "\u202eoverride",
  ].join("\n");

  const safe = sanitizeTerminalText(value, { preserveSgr: true });
  assert.match(safe, /\u001b\[1mBold\u001b\[22m/);
  assert.match(safe, /\u001b\[38;2;255;119;88mAccent\u001b\[39m/);
  assert.match(safe, /cleared/);
  assert.match(safe, /safe/);
  assert.match(safe, /link/);
  assert.doesNotMatch(safe, /\u001b\[2J|clipboard|example\.com|\u0007|\u202e/);
});

test("removes all control styling from untrusted metadata", () => {
  assert.equal(
    sanitizeTerminalText("title\u001b[31m red\u001b[39m\tend"),
    "title red    end",
  );
});
