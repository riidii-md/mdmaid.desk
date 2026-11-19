import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PREVIEW_BYTES, PreviewSessions } from "./preview-sessions.js";

const document = "doc-11111111111111111111";

test("preview content is transient and bound to the original document", () => {
  let changes = 0;
  const sessions = new PreviewSessions(() => changes++);
  const info = sessions.create(document, { version: 1, content: "# Unsaved" });
  assert.match(info.id, /^preview-[a-f0-9]{32}$/);
  assert.equal(info.route, `/d/${document}?preview=${info.id}`);
  assert.equal(sessions.get(info.id, document).content, "# Unsaved");
  assert.throws(() => sessions.get(info.id, "doc-22222222222222222222"));
  assert.equal(changes, 1);
  sessions.delete(info.id);
  assert.throws(() => sessions.get(info.id, document));
  assert.equal(changes, 2);
});

test("stale updates cannot replace newer buffer contents", () => {
  const sessions = new PreviewSessions();
  const info = sessions.create(document, { version: 1, content: "first" });
  sessions.update(info.id, { version: 3, content: "latest" });
  sessions.update(info.id, { version: 2, content: "stale" });
  assert.equal(sessions.get(info.id, document).content, "latest");
  assert.equal(sessions.get(info.id, document).info.version, 3);
});

test("different editor previews of one source remain independent", () => {
  const sessions = new PreviewSessions();
  const first = sessions.create(document, { version: 1, content: "one editor" });
  const second = sessions.create(document, { version: 1, content: "another editor" });
  sessions.delete(first.id);
  assert.equal(sessions.get(second.id, document).content, "another editor");
});

test("preview updates validate their shape, size, and version", () => {
  const sessions = new PreviewSessions();
  for (const update of [
    null, {}, { version: 0, content: "" }, { version: 1.5, content: "" },
    { version: 1, content: 12 }, { version: 1, content: "", path: "/tmp/wrong" },
    { version: 1, content: "x".repeat(MAX_PREVIEW_BYTES + 1) },
  ]) {
    assert.throws(() => sessions.create(document, update));
  }
  // Incomplete Markdown/Mermaid is expected while a user types.
  const info = sessions.create(document, { version: 1, content: "```mermaid\ngraph" });
  assert.ok(sessions.get(info.id, document));
});

test("scroll updates change viewport metadata without invalidating Markdown", () => {
  let contentChanges = 0;
  let scrollChanges = 0;
  const sessions = new PreviewSessions(() => contentChanges++, () => scrollChanges++);
  const info = sessions.create(document, { version: 1, content: "# Draft" });
  const moved = sessions.update(info.id, { version: 1, scroll: 0.5 });
  assert.equal(moved.version, 1);
  assert.deepEqual(moved.viewport, { progress: 0.5, revision: 1 });
  assert.equal(sessions.get(info.id, document).content, "# Draft");
  assert.equal(contentChanges, 1);
  assert.equal(scrollChanges, 1);
  sessions.update(info.id, { version: 1, scroll: 0.5 });
  assert.equal(scrollChanges, 1, "unchanged viewports should not publish events");
  moved.viewport!.progress = 0;
  assert.equal(sessions.get(info.id, document).info.viewport?.progress, 0.5);
});

test("scroll snapshots are validated and cannot run ahead of the rendered buffer version", () => {
  const sessions = new PreviewSessions();
  const info = sessions.create(document, { version: 2, content: "Current text" });
  for (const scroll of [-0.1, 1.1, NaN, Infinity, "0.5", null]) {
    assert.throws(() => sessions.update(info.id, { version: 2, scroll }));
  }
  assert.throws(() => sessions.update(info.id, { version: 3, scroll: 0.9 }));
  sessions.update(info.id, { version: 2, scroll: 0.6 });
  sessions.update(info.id, { version: 1, scroll: 0 });
  assert.equal(sessions.get(info.id, document).info.viewport?.progress, 0.6);
  sessions.update(info.id, { version: 3, content: "New text", scroll: 1 });
  assert.equal(sessions.get(info.id, document).info.viewport?.progress, 1);
  assert.throws(() => sessions.create(document, { version: 1, scroll: 0.5 }));
});
