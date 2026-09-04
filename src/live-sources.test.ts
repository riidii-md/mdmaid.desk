import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { Catalog } from "./catalog.js";
import {
  startLiveSourceCoordinator,
  type DirectoryWatch,
  type DirectoryWatchFactory,
  type LiveSourceEvent,
} from "./live-sources.js";

class FakeDirectoryWatch implements DirectoryWatch {
  closed = false;
  readonly #listener: (filename: string | Buffer | null) => void;
  #errorListener: (() => void) | undefined;

  constructor(listener: (filename: string | Buffer | null) => void) {
    this.#listener = listener;
  }

  close(): void {
    this.closed = true;
  }

  on(event: "error", listener: () => void): this {
    assert.equal(event, "error");
    this.#errorListener = listener;
    return this;
  }

  change(filename: string | Buffer | null): void {
    assert.equal(this.closed, false);
    this.#listener(filename);
  }

  error(): void {
    this.#errorListener?.();
  }
}

async function fixture(): Promise<{
  catalog: Catalog;
  root: string;
  workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-live-sources-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "reports"), { recursive: true });
  const catalog = await Catalog.open(join(root, "state", "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  await catalog.addWorkspace({
    id: "example",
    name: "Example",
    root: workspace,
    artifactRoots: [workspace],
  });
  return { catalog, root, workspace };
}

function fakeWatches(): {
  factory: DirectoryWatchFactory;
  watches: Map<string, FakeDirectoryWatch[]>;
} {
  const watches = new Map<string, FakeDirectoryWatch[]>();
  return {
    watches,
    factory: (directory, listener) => {
      const watch = new FakeDirectoryWatch(listener);
      const existing = watches.get(directory) ?? [];
      existing.push(watch);
      watches.set(directory, existing);
      return watch;
    },
  };
}

test("shares parent watches, filters filenames, and coalesces source changes", async () => {
  const { catalog, root, workspace } = await fixture();
  const reports = join(workspace, "reports");
  const firstPath = join(reports, "first.md");
  const secondPath = join(reports, "second.md");
  const snapshotPath = join(root, "snapshot.md");
  await writeFile(firstPath, "# First\n", "utf8");
  await writeFile(secondPath, "# Second\n", "utf8");
  await writeFile(snapshotPath, "# Snapshot\n", "utf8");
  const first = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "First",
    path: firstPath,
    attention: "none",
  });
  const second = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Second",
    path: secondPath,
    attention: "none",
  });
  await catalog.importDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Snapshot",
    path: snapshotPath,
    attention: "none",
  });
  const fake = fakeWatches();
  const events: LiveSourceEvent[] = [];
  const coordinator = startLiveSourceCoordinator(catalog, {
    debounceMs: 0,
    onEvent: (event) => events.push(event),
    watchDirectory: fake.factory,
  });

  const watchedReports = dirname(first.path);
  assert.deepEqual([...fake.watches.keys()], [watchedReports]);
  assert.equal(fake.watches.get(watchedReports)?.length, 1);
  const watch = fake.watches.get(watchedReports)?.[0];
  assert.ok(watch);

  await writeFile(firstPath, "# First changed\n", "utf8");
  watch.change(basename(firstPath));
  watch.change(Buffer.from(basename(firstPath)));
  watch.change("not-registered.md");
  await eventually(() => events.length === 1);

  assert.deepEqual(events, [
    { action: "source-changed", documentId: first.id, revision: 2 },
  ]);
  assert.equal(catalog.getDocument(first.id)?.revision, 2);
  assert.equal(catalog.getDocument(second.id)?.revision, 1);
  await coordinator.close();
  assert.equal(watch.closed, true);
  catalog.close();
});

test("reconciles every document when a directory event omits its filename", async () => {
  const { catalog, workspace } = await fixture();
  const reports = join(workspace, "reports");
  const firstPath = join(reports, "first.md");
  const secondPath = join(reports, "second.md");
  await writeFile(firstPath, "# First\n", "utf8");
  await writeFile(secondPath, "# Second\n", "utf8");
  const first = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "First",
    path: firstPath,
    attention: "none",
  });
  await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Second",
    path: secondPath,
    attention: "none",
  });
  const fake = fakeWatches();
  const events: LiveSourceEvent[] = [];
  const coordinator = startLiveSourceCoordinator(catalog, {
    debounceMs: 0,
    onEvent: (event) => events.push(event),
    watchDirectory: fake.factory,
  });

  await writeFile(firstPath, "# First changed\n", "utf8");
  fake.watches.get(dirname(first.path))?.[0]?.change(null);
  await eventually(() => events.length === 1);

  assert.equal(events[0]?.documentId, first.id);
  await coordinator.close();
  catalog.close();
});

test("publishes missing and restored transitions across atomic replacement", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "replace.md");
  const replacementPath = join(workspace, "reports", ".replace.tmp");
  await writeFile(documentPath, "# Original\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Replace",
    path: documentPath,
    attention: "none",
  });
  const fake = fakeWatches();
  const events: LiveSourceEvent[] = [];
  const coordinator = startLiveSourceCoordinator(catalog, {
    debounceMs: 0,
    onEvent: (event) => events.push(event),
    watchDirectory: fake.factory,
  });
  const watch = fake.watches.get(dirname(document.path))?.[0];
  assert.ok(watch);

  await rm(documentPath);
  watch.change(basename(documentPath));
  await eventually(() => events.length === 1);
  assert.equal(events[0]?.action, "source-missing");

  await writeFile(replacementPath, "# Replaced\n", "utf8");
  await rename(replacementPath, documentPath);
  watch.change(basename(documentPath));
  await eventually(() => events.length === 2);
  assert.deepEqual(events[1], {
    action: "source-restored",
    documentId: document.id,
    revision: 2,
  });
  await coordinator.close();
  catalog.close();
});

test("refreshes dynamic watch membership and stops cleanly", async () => {
  const { catalog, workspace } = await fixture();
  const firstDirectory = join(workspace, "reports");
  const secondDirectory = join(workspace, "decisions");
  const firstPath = join(firstDirectory, "first.md");
  const secondPath = join(secondDirectory, "second.md");
  await mkdir(secondDirectory);
  await writeFile(firstPath, "# First\n", "utf8");
  await writeFile(secondPath, "# Second\n", "utf8");
  const first = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "First",
    path: firstPath,
    attention: "none",
  });
  const fake = fakeWatches();
  const events: LiveSourceEvent[] = [];
  const coordinator = startLiveSourceCoordinator(catalog, {
    debounceMs: 0,
    onEvent: (event) => events.push(event),
    watchDirectory: fake.factory,
  });
  const firstWatch = fake.watches.get(dirname(first.path))?.[0];
  assert.ok(firstWatch);

  const second = await catalog.registerDocument({
    workspaceId: "example",
    kind: "decision",
    title: "Second",
    path: secondPath,
    attention: "none",
  });
  coordinator.refresh();
  assert.equal(fake.watches.get(dirname(second.path))?.length, 1);

  await catalog.archiveDocument(first.id);
  coordinator.refresh();
  assert.equal(firstWatch.closed, true);

  await coordinator.close();
  await writeFile(secondPath, "# Changed after close\n", "utf8");
  assert.equal(fake.watches.get(dirname(second.path))?.[0]?.closed, true);
  assert.deepEqual(events, []);
  assert.equal(catalog.getDocument(second.id)?.revision, 1);
  catalog.close();
});

test("observes a real local source edit through the native parent watch", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "native.md");
  await writeFile(documentPath, "# Native original\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Native watch",
    path: documentPath,
    attention: "none",
  });
  const events: LiveSourceEvent[] = [];
  const coordinator = startLiveSourceCoordinator(catalog, {
    debounceMs: 10,
    onEvent: (event) => events.push(event),
  });
  try {
    await writeFile(document.path, "# Native changed\n", "utf8");
    await eventuallyWithDelay(() => events.length === 1);
    assert.deepEqual(events[0], {
      action: "source-changed",
      documentId: document.id,
      revision: 2,
    });
  } finally {
    await coordinator.close();
    catalog.close();
  }
});

test("does not follow a replaced source parent symlink when creating watches", async () => {
  const { catalog, root, workspace } = await fixture();
  const reports = join(workspace, "reports");
  const documentPath = join(reports, "symlink-parent.md");
  const outside = join(root, "outside");
  await writeFile(documentPath, "# Authorized\n", "utf8");
  await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Symlink parent",
    path: documentPath,
    attention: "none",
  });
  await mkdir(outside);
  await writeFile(join(outside, basename(documentPath)), "# Outside\n", "utf8");
  await rm(reports, { recursive: true });
  await symlink(outside, reports, "dir");
  const fake = fakeWatches();
  const errors: string[] = [];
  const coordinator = startLiveSourceCoordinator(catalog, {
    debounceMs: 0,
    onError: (error) => errors.push(error.message),
    onEvent: () => undefined,
    watchDirectory: fake.factory,
  });

  assert.equal(fake.watches.size, 0);
  assert.deepEqual(errors, ["Live source watch failed"]);
  assert.doesNotMatch(JSON.stringify(errors), new RegExp(root));
  await coordinator.close();
  catalog.close();
});

test("validates coordinator options and contains watcher failures", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "watch-errors.md");
  await writeFile(documentPath, "# Watch errors\n", "utf8");
  await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Watch errors",
    path: documentPath,
    attention: "none",
  });

  for (const debounceMs of [-1, 1.5]) {
    assert.throws(
      () => startLiveSourceCoordinator(catalog, {
        debounceMs,
        onEvent: () => undefined,
      }),
      /non-negative integer/,
    );
  }

  const constructionErrors: string[] = [];
  const unavailable = startLiveSourceCoordinator(catalog, {
    onError: (error) => constructionErrors.push(error.message),
    onEvent: () => undefined,
    watchDirectory: () => {
      throw new Error("private watch failure");
    },
  });
  assert.deepEqual(constructionErrors, ["Live source watch failed"]);
  await unavailable.close();
  await unavailable.close();
  unavailable.refresh();

  const fake = fakeWatches();
  const runtimeErrors: string[] = [];
  const coordinator = startLiveSourceCoordinator(catalog, {
    onError: (error) => runtimeErrors.push(error.message),
    onEvent: () => undefined,
    watchDirectory: fake.factory,
  });
  const directory = dirname(catalog.listDocuments()[0]!.path);
  const failed = fake.watches.get(directory)?.[0];
  assert.ok(failed);
  failed.error();
  assert.equal(failed.closed, true);
  assert.deepEqual(runtimeErrors, ["Live source watch failed"]);

  coordinator.refresh();
  assert.equal(fake.watches.get(directory)?.length, 2);
  await coordinator.close();
  catalog.close();
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

async function eventuallyWithDelay(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not reached");
}
