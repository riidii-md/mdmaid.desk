import { lstatSync, realpathSync, watch } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import type { Catalog } from "./catalog.js";

export interface DirectoryWatch {
  close(): void;
  on(event: "error", listener: (error?: unknown) => void): this;
}

export type DirectoryWatchFactory = (
  directory: string,
  listener: (filename: string | Buffer | null) => void,
) => DirectoryWatch;

export interface LiveSourceEvent {
  action: "source-changed" | "source-missing" | "source-restored";
  documentId: string;
  revision: number;
}

export interface LiveSourceError {
  documentId?: string;
  message: "Live source reconciliation failed" | "Live source watch failed";
}

export interface LiveSourceCoordinatorOptions {
  debounceMs?: number;
  onError?: (error: LiveSourceError) => void;
  onEvent: (event: LiveSourceEvent) => void;
  watchDirectory?: DirectoryWatchFactory;
}

interface WatchedDirectory {
  documents: Map<string, Set<string>>;
  watcher: DirectoryWatch;
}

export interface LiveSourceCoordinator {
  close(): Promise<void>;
  refresh(): void;
}

export function startLiveSourceCoordinator(
  catalog: Catalog,
  options: LiveSourceCoordinatorOptions,
): LiveSourceCoordinator {
  const coordinator = new DefaultLiveSourceCoordinator(catalog, options);
  coordinator.refresh();
  return coordinator;
}

class DefaultLiveSourceCoordinator implements LiveSourceCoordinator {
  readonly #catalog: Catalog;
  readonly #debounceMs: number;
  readonly #onError: (error: LiveSourceError) => void;
  readonly #onEvent: (event: LiveSourceEvent) => void;
  readonly #watchDirectory: DirectoryWatchFactory;
  readonly #directories = new Map<string, WatchedDirectory>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #operations = new Map<string, Promise<void>>();
  #closed = false;

  constructor(catalog: Catalog, options: LiveSourceCoordinatorOptions) {
    if (
      options.debounceMs !== undefined &&
      (!Number.isSafeInteger(options.debounceMs) || options.debounceMs < 0)
    ) {
      throw new Error("live source debounce must be a non-negative integer");
    }
    this.#catalog = catalog;
    this.#debounceMs = options.debounceMs ?? 80;
    this.#onError = options.onError ?? (() => undefined);
    this.#onEvent = options.onEvent;
    this.#watchDirectory = options.watchDirectory ?? nativeDirectoryWatch;
  }

  refresh(): void {
    if (this.#closed) {
      return;
    }
    const desired = new Map<string, Map<string, Set<string>>>();
    const workspaces = new Map(
      this.#catalog.listWorkspaces().map((workspace) => [workspace.id, workspace]),
    );
    for (const document of this.#catalog.listDocuments()) {
      if (document.storage !== "reference" || document.archivedAt !== null) {
        continue;
      }
      const workspace = workspaces.get(document.workspaceId);
      const directory = workspace
        ? authorizedSourceParent(document.path, workspace.artifactRoots)
        : undefined;
      if (!directory) {
        this.#onError({ message: "Live source watch failed" });
        continue;
      }
      const filename = basename(document.path);
      const files = desired.get(directory) ?? new Map<string, Set<string>>();
      const documentIds = files.get(filename) ?? new Set<string>();
      documentIds.add(document.id);
      files.set(filename, documentIds);
      desired.set(directory, files);
    }

    for (const [directory, watched] of this.#directories) {
      const documents = desired.get(directory);
      if (documents) {
        watched.documents = documents;
      } else {
        watched.watcher.close();
        this.#directories.delete(directory);
      }
    }

    for (const [directory, documents] of desired) {
      if (this.#directories.has(directory)) {
        continue;
      }
      let watcher: DirectoryWatch;
      try {
        watcher = this.#watchDirectory(directory, (filename) => {
          this.#handleDirectoryEvent(directory, filename);
        });
      } catch {
        this.#onError({ message: "Live source watch failed" });
        continue;
      }
      watcher.on("error", () => {
        if (this.#directories.get(directory)?.watcher === watcher) {
          watcher.close();
          this.#directories.delete(directory);
        }
        this.#onError({ message: "Live source watch failed" });
      });
      this.#directories.set(directory, { documents, watcher });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    for (const { watcher } of this.#directories.values()) {
      watcher.close();
    }
    this.#directories.clear();
    await Promise.allSettled([...this.#operations.values()]);
  }

  #handleDirectoryEvent(
    directory: string,
    filename: string | Buffer | null,
  ): void {
    if (this.#closed) {
      return;
    }
    const watched = this.#directories.get(directory);
    if (!watched) {
      return;
    }
    if (filename === null) {
      for (const documentIds of watched.documents.values()) {
        for (const documentId of documentIds) {
          this.#schedule(documentId);
        }
      }
      return;
    }
    const name = Buffer.isBuffer(filename) ? filename.toString("utf8") : filename;
    for (const documentId of watched.documents.get(name) ?? []) {
      this.#schedule(documentId);
    }
  }

  #schedule(documentId: string): void {
    const pending = this.#timers.get(documentId);
    if (pending) {
      clearTimeout(pending);
    }
    this.#timers.set(
      documentId,
      setTimeout(() => {
        this.#timers.delete(documentId);
        this.#enqueue(documentId);
      }, this.#debounceMs),
    );
  }

  #enqueue(documentId: string): void {
    const previous = this.#operations.get(documentId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.#closed) {
          return;
        }
        try {
          const result = await this.#catalog.reconcileReferenceDocument(documentId);
          if (this.#closed || result.action === "unchanged") {
            return;
          }
          this.#onEvent({
            action: result.action,
            documentId: result.document.id,
            revision: result.document.revision,
          });
        } catch {
          this.#onError({
            documentId,
            message: "Live source reconciliation failed",
          });
        }
      });
    this.#operations.set(documentId, operation);
    void operation.finally(() => {
      if (this.#operations.get(documentId) === operation) {
        this.#operations.delete(documentId);
      }
    });
  }
}

function nativeDirectoryWatch(
  directory: string,
  listener: (filename: string | Buffer | null) => void,
): DirectoryWatch {
  const watcher = watch(
    directory,
    { encoding: "buffer", persistent: false },
    (_event, filename) => listener(filename),
  );
  const result: DirectoryWatch = {
    close: () => watcher.close(),
    on: (_event, errorListener) => {
      watcher.on("error", errorListener);
      return result;
    },
  };
  return result;
}

function authorizedSourceParent(
  documentPath: string,
  artifactRoots: string[],
): string | undefined {
  const requested = resolve(dirname(documentPath));
  try {
    const info = lstatSync(requested);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return undefined;
    }
    const canonical = realpathSync(requested);
    if (
      canonical !== requested ||
      !artifactRoots.some((root) => isWithin(root, canonical))
    ) {
      return undefined;
    }
    return canonical;
  } catch {
    return undefined;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}
