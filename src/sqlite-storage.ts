import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

import Database from "better-sqlite3";

import {
  isAttention,
  isDocumentKind,
  type Attention,
  type DocumentFilters,
  type DocumentKind,
  type StoredDocument,
  type Workspace,
} from "./domain.js";
import type { CatalogStorage } from "./storage.js";

export const SQLITE_SCHEMA_VERSION = 1;

interface WorkspaceRow {
  id: string;
  name: string;
  root: string;
}

interface ArtifactRootRow {
  path: string;
}

interface DocumentRow {
  id: string;
  workspace_id: string;
  task_id: string | null;
  producer: string | null;
  kind: string;
  title: string;
  path: string;
  attention: string;
  content_hash: string;
  revision: number;
  opened_revision: number | null;
  completed_revision: number | null;
  archived_at: string | null;
  missing_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TagRow {
  name: string;
}

const INITIAL_SCHEMA = `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root TEXT NOT NULL
  ) STRICT;

  CREATE TABLE workspace_artifact_roots (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    PRIMARY KEY (workspace_id, path)
  ) STRICT;

  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    task_id TEXT,
    producer TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    path TEXT NOT NULL,
    attention TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    opened_revision INTEGER CHECK (opened_revision IS NULL OR opened_revision > 0),
    completed_revision INTEGER CHECK (completed_revision IS NULL OR completed_revision > 0),
    archived_at TEXT,
    missing_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace_id, path)
  ) STRICT;

  CREATE TABLE tags (
    name TEXT PRIMARY KEY
  ) STRICT;

  CREATE TABLE document_tags (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag_name TEXT NOT NULL REFERENCES tags(name) ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_name)
  ) STRICT;

  CREATE INDEX documents_workspace_idx ON documents(workspace_id);
  CREATE INDEX documents_task_idx ON documents(task_id);
  CREATE INDEX documents_kind_idx ON documents(kind);
  CREATE INDEX documents_attention_idx ON documents(attention);
  CREATE INDEX documents_updated_idx ON documents(updated_at DESC);
  CREATE INDEX document_tags_tag_idx ON document_tags(tag_name);
`;

export class SqliteCatalogStorage implements CatalogStorage {
  readonly #database: Database.Database;

  private constructor(database: Database.Database) {
    this.#database = database;
  }

  static open(databasePath: string): SqliteCatalogStorage {
    const canonicalPath = resolve(databasePath);
    mkdirSync(dirname(canonicalPath), { recursive: true, mode: 0o700 });
    try {
      const info = lstatSync(canonicalPath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error("SQLite catalog must be a regular, non-symlink file");
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    const database = new Database(canonicalPath);
    try {
      chmodSync(canonicalPath, 0o600);
      database.pragma("foreign_keys = ON");
      database.pragma("journal_mode = DELETE");
      database.pragma("busy_timeout = 5000");
      migrate(database);
      return new SqliteCatalogStorage(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    if (this.#database.open) {
      this.#database.close();
    }
  }

  isEmpty(): boolean {
    const row = this.#database
      .prepare<[], { count: number }>(
        "SELECT (SELECT count(*) FROM workspaces) + (SELECT count(*) FROM documents) AS count",
      )
      .get();
    return row?.count === 0;
  }

  transaction<T>(operation: () => T): T {
    return this.#database.transaction(operation)();
  }

  listWorkspaces(): Workspace[] {
    const rows = this.#database
      .prepare<[], WorkspaceRow>("SELECT id, name, root FROM workspaces ORDER BY id")
      .all();
    const roots = this.#database.prepare<
      [string],
      ArtifactRootRow
    >(
      "SELECT path FROM workspace_artifact_roots WHERE workspace_id = ? ORDER BY path",
    );
    return rows.map((row) =>
      validateWorkspaceRow(
        row,
        roots.all(row.id).map(({ path }) => path),
      ),
    );
  }

  getWorkspace(id: string): Workspace | undefined {
    const row = this.#database
      .prepare<[string], WorkspaceRow>(
        "SELECT id, name, root FROM workspaces WHERE id = ?",
      )
      .get(id);
    if (!row) {
      return undefined;
    }
    const artifactRoots = this.#database
      .prepare<[string], ArtifactRootRow>(
        "SELECT path FROM workspace_artifact_roots WHERE workspace_id = ? ORDER BY path",
      )
      .all(id)
      .map(({ path }) => path);
    return validateWorkspaceRow(row, artifactRoots);
  }

  saveWorkspace(workspace: Workspace): void {
    this.transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO workspaces (id, name, root)
           VALUES (@id, @name, @root)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, root = excluded.root`,
        )
        .run(workspace);
      this.#database
        .prepare("DELETE FROM workspace_artifact_roots WHERE workspace_id = ?")
        .run(workspace.id);
      const insertRoot = this.#database.prepare(
        "INSERT INTO workspace_artifact_roots (workspace_id, path) VALUES (?, ?)",
      );
      for (const artifactRoot of workspace.artifactRoots) {
        insertRoot.run(workspace.id, artifactRoot);
      }
    });
  }

  listDocuments(filters: DocumentFilters = {}): StoredDocument[] {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];

    if (filters.workspaceId !== undefined) {
      clauses.push("d.workspace_id = ?");
      parameters.push(filters.workspaceId);
    }
    if (filters.taskId !== undefined) {
      clauses.push("d.task_id = ?");
      parameters.push(filters.taskId);
    }
    if (filters.kind !== undefined) {
      clauses.push("d.kind = ?");
      parameters.push(filters.kind);
    }
    if (filters.attention !== undefined) {
      clauses.push("d.attention = ?");
      parameters.push(filters.attention);
    }
    if (filters.tag !== undefined) {
      clauses.push(
        "EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id AND dt.tag_name = ?)",
      );
      parameters.push(filters.tag);
    }
    if (filters.status === "done") {
      clauses.push("d.completed_revision = d.revision");
    } else if (filters.status === "reading") {
      clauses.push(
        "d.completed_revision IS NOT d.revision AND d.opened_revision = d.revision",
      );
    } else if (filters.status === "unread") {
      clauses.push(
        "d.completed_revision IS NOT d.revision AND d.opened_revision IS NOT d.revision",
      );
    }

    clauses.push(filters.archived === true ? "d.archived_at IS NOT NULL" : "d.archived_at IS NULL");
    if (filters.missing !== undefined) {
      clauses.push(filters.missing ? "d.missing_at IS NOT NULL" : "d.missing_at IS NULL");
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#database
      .prepare<Array<string | number>, DocumentRow>(
        `SELECT d.* FROM documents d${where} ORDER BY d.updated_at DESC, d.id`,
      )
      .all(...parameters);
    return rows.map((row) => this.#mapDocument(row));
  }

  getDocument(id: string): StoredDocument | undefined {
    const row = this.#database
      .prepare<[string], DocumentRow>("SELECT * FROM documents WHERE id = ?")
      .get(id);
    return row ? this.#mapDocument(row) : undefined;
  }

  saveDocument(document: StoredDocument): void {
    this.transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO documents (
             id, workspace_id, task_id, producer, kind, title, path, attention,
             content_hash, revision, opened_revision, completed_revision,
             archived_at, missing_at, created_at, updated_at
           ) VALUES (
             @id, @workspaceId, @taskId, @producer, @kind, @title, @path, @attention,
             @contentHash, @revision, @openedRevision, @completedRevision,
             @archivedAt, @missingAt, @createdAt, @updatedAt
           )
           ON CONFLICT(id) DO UPDATE SET
             workspace_id = excluded.workspace_id,
             task_id = excluded.task_id,
             producer = excluded.producer,
             kind = excluded.kind,
             title = excluded.title,
             path = excluded.path,
             attention = excluded.attention,
             content_hash = excluded.content_hash,
             revision = excluded.revision,
             opened_revision = excluded.opened_revision,
             completed_revision = excluded.completed_revision,
             archived_at = excluded.archived_at,
             missing_at = excluded.missing_at,
             updated_at = excluded.updated_at`,
        )
        .run({
          id: document.id,
          workspaceId: document.workspaceId,
          taskId: document.taskId ?? null,
          producer: document.producer ?? null,
          kind: document.kind,
          title: document.title,
          path: document.path,
          attention: document.attention,
          contentHash: document.contentHash,
          revision: document.revision,
          openedRevision: document.openedRevision,
          completedRevision: document.completedRevision,
          archivedAt: document.archivedAt,
          missingAt: document.missingAt,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt,
        });

      this.#database
        .prepare("DELETE FROM document_tags WHERE document_id = ?")
        .run(document.id);
      const saveTag = this.#database.prepare(
        "INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING",
      );
      const assignTag = this.#database.prepare(
        "INSERT INTO document_tags (document_id, tag_name) VALUES (?, ?)",
      );
      for (const tag of document.tags) {
        saveTag.run(tag);
        assignTag.run(document.id, tag);
      }
      this.#database.exec(
        "DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM document_tags WHERE document_tags.tag_name = tags.name)",
      );
    });
  }

  #mapDocument(row: DocumentRow): StoredDocument {
    const tags = this.#database
      .prepare<[string], TagRow>(
        `SELECT t.name
         FROM tags t
         JOIN document_tags dt ON dt.tag_name = t.name
         WHERE dt.document_id = ?
         ORDER BY t.name`,
      )
      .all(row.id)
      .map(({ name }) => name);
    validateDocumentRow(row, tags);
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      ...(row.task_id === null ? {} : { taskId: row.task_id }),
      ...(row.producer === null ? {} : { producer: row.producer }),
      kind: row.kind as DocumentKind,
      title: row.title,
      path: row.path,
      attention: row.attention as Attention,
      tags,
      contentHash: row.content_hash,
      revision: row.revision,
      openedRevision: row.opened_revision,
      completedRevision: row.completed_revision,
      archivedAt: row.archived_at,
      missingAt: row.missing_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function migrate(database: Database.Database): void {
  const rawVersion = database.pragma("user_version", { simple: true });
  if (typeof rawVersion !== "number" || !Number.isSafeInteger(rawVersion)) {
    throw new Error("could not determine SQLite catalog schema version");
  }
  if (rawVersion > SQLITE_SCHEMA_VERSION) {
    throw new Error(`unsupported SQLite catalog schema ${rawVersion}`);
  }
  if (rawVersion < 1) {
    database.transaction(() => {
      database.exec(INITIAL_SCHEMA);
      database.pragma("user_version = 1");
    })();
  }
}

function validateWorkspaceRow(
  row: WorkspaceRow,
  artifactRoots: string[],
): Workspace {
  if (
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.id) ||
    row.name.trim() === "" ||
    !isAbsolute(row.root) ||
    artifactRoots.length === 0 ||
    artifactRoots.some(
      (artifactRoot) =>
        !isAbsolute(artifactRoot) || !isWithin(row.root, artifactRoot),
    )
  ) {
    throw new Error(`invalid workspace row ${row.id}`);
  }
  return { ...row, artifactRoots };
}

function validateDocumentRow(row: DocumentRow, tags: string[]): void {
  if (
    !/^doc-[a-f0-9]{20}$/.test(row.id) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.workspace_id) ||
    (row.task_id !== null && row.task_id.trim() === "") ||
    (row.producer !== null && row.producer.trim() === "") ||
    !isDocumentKind(row.kind) ||
    row.title.trim() === "" ||
    !isAbsolute(row.path) ||
    extname(row.path).toLowerCase() !== ".md" ||
    !isAttention(row.attention) ||
    !/^[a-f0-9]{64}$/.test(row.content_hash) ||
    !isPositiveInteger(row.revision) ||
    !isProgressRevision(row.opened_revision, row.revision) ||
    !isProgressRevision(row.completed_revision, row.revision) ||
    !isNullableDate(row.archived_at) ||
    !isNullableDate(row.missing_at) ||
    !isDate(row.created_at) ||
    !isDate(row.updated_at) ||
    tags.some((tag) => !/^[a-z0-9][a-z0-9._/-]{0,63}$/.test(tag))
  ) {
    throw new Error(`invalid document row ${row.id}`);
  }
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isProgressRevision(value: number | null, revision: number): boolean {
  return value === null || (isPositiveInteger(value) && value <= revision);
}

function isNullableDate(value: string | null): boolean {
  return value === null || isDate(value);
}

function isDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
