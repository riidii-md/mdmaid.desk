import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

import Database from "better-sqlite3";

import {
  isAttention,
  isDocumentKind,
  isReviewKind,
  isReviewOutcome,
  isReviewStatus,
  type Attention,
  type DocumentFilters,
  type DocumentKind,
  type DocumentSourceLink,
  type DocumentStorage,
  type ReviewRequestFilters,
  type ReviewResponse,
  type StoredDocument,
  type StoredReviewRequest,
  type Workspace,
} from "./domain.js";
import type { CatalogStorage } from "./storage.js";

export const SQLITE_SCHEMA_VERSION = 4;

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
  storage_kind: string;
  path: string;
  source_path: string | null;
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

interface SourceLinkRow {
  id: string;
  href: string;
  workspace_path: string;
}

interface DocumentIdRow {
  id: string;
}

interface ReviewRequestRow {
  id: string;
  document_id: string;
  document_revision: number;
  document_content_hash: string;
  kind: string;
  request_message: string;
  status: string;
  stale_at: string | null;
  created_at: string;
}

interface ReviewResponseRow {
  outcome: string;
  message: string;
  created_at: string;
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
    storage_kind TEXT NOT NULL CHECK (storage_kind IN ('reference', 'managed')),
    path TEXT NOT NULL,
    source_path TEXT,
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

  CREATE TABLE document_source_links (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    href TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    PRIMARY KEY (document_id, id),
    UNIQUE (document_id, href)
  ) STRICT;

  CREATE TABLE review_requests (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
    document_revision INTEGER NOT NULL CHECK (document_revision > 0),
    document_content_hash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('plan-decision')),
    request_message TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'changes_requested', 'rejected', 'stale')),
    stale_at TEXT,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE review_responses (
    review_request_id TEXT PRIMARY KEY REFERENCES review_requests(id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'changes_requested', 'rejected')),
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
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
  CREATE UNIQUE INDEX review_requests_pending_document_idx
    ON review_requests(document_id) WHERE status = 'pending';
  CREATE INDEX review_requests_document_idx
    ON review_requests(document_id, created_at DESC);
  CREATE INDEX review_requests_status_idx
    ON review_requests(status, created_at DESC);
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

  getReferenceDocumentIdByPath(
    workspaceId: string,
    path: string,
  ): string | undefined {
    return this.#database
      .prepare<[string, string], DocumentIdRow>(
        `SELECT id
         FROM documents
         WHERE workspace_id = ? AND path = ? AND storage_kind = 'reference'`,
      )
      .get(workspaceId, path)?.id;
  }

  saveDocument(document: StoredDocument): void {
    this.transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO documents (
             id, workspace_id, task_id, producer, kind, title, storage_kind,
             path, source_path, attention,
             content_hash, revision, opened_revision, completed_revision,
             archived_at, missing_at, created_at, updated_at
           ) VALUES (
             @id, @workspaceId, @taskId, @producer, @kind, @title, @storage,
             @path, @sourcePath, @attention,
             @contentHash, @revision, @openedRevision, @completedRevision,
             @archivedAt, @missingAt, @createdAt, @updatedAt
           )
           ON CONFLICT(id) DO UPDATE SET
             workspace_id = excluded.workspace_id,
             task_id = excluded.task_id,
             producer = excluded.producer,
             kind = excluded.kind,
             title = excluded.title,
             storage_kind = excluded.storage_kind,
             path = excluded.path,
             source_path = excluded.source_path,
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
          storage: document.storage,
          path: document.path,
          sourcePath: document.sourcePath ?? null,
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
      this.#database
        .prepare("DELETE FROM document_source_links WHERE document_id = ?")
        .run(document.id);
      const assignSourceLink = this.#database.prepare(
        `INSERT INTO document_source_links (
           document_id, id, href, workspace_path
         ) VALUES (?, ?, ?, ?)`,
      );
      for (const sourceLink of document.sourceLinks) {
        assignSourceLink.run(
          document.id,
          sourceLink.id,
          sourceLink.href,
          sourceLink.workspacePath,
        );
      }
      this.#database.exec(
        "DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM document_tags WHERE document_tags.tag_name = tags.name)",
      );
      this.#database
        .prepare(
          `UPDATE review_requests
           SET status = 'stale', stale_at = @staleAt
           WHERE document_id = @documentId
             AND status = 'pending'
             AND (
               document_revision <> @documentRevision
               OR document_content_hash <> @documentContentHash
               OR @missingAt IS NOT NULL
             )`,
        )
        .run({
          documentId: document.id,
          documentRevision: document.revision,
          documentContentHash: document.contentHash,
          missingAt: document.missingAt,
          staleAt: document.updatedAt,
        });
    });
  }

  listReviewRequests(
    filters: ReviewRequestFilters = {},
  ): StoredReviewRequest[] {
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (filters.documentId !== undefined) {
      clauses.push("document_id = ?");
      parameters.push(filters.documentId);
    }
    if (filters.status !== undefined) {
      clauses.push("status = ?");
      parameters.push(filters.status);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    return this.#database
      .prepare<string[], ReviewRequestRow>(
        `SELECT * FROM review_requests${where} ORDER BY created_at DESC, id`,
      )
      .all(...parameters)
      .map((row) => this.#mapReviewRequest(row));
  }

  getReviewRequest(id: string): StoredReviewRequest | undefined {
    const row = this.#database
      .prepare<[string], ReviewRequestRow>(
        "SELECT * FROM review_requests WHERE id = ?",
      )
      .get(id);
    return row ? this.#mapReviewRequest(row) : undefined;
  }

  saveReviewRequest(request: StoredReviewRequest): void {
    if (
      request.status !== "pending" ||
      request.response !== null ||
      request.staleAt !== null
    ) {
      throw new Error("new review request must be pending");
    }
    this.#database
      .prepare(
        `INSERT INTO review_requests (
           id, document_id, document_revision, document_content_hash,
           kind, request_message, status, stale_at, created_at
         ) VALUES (
           @id, @documentId, @documentRevision, @documentContentHash,
           @kind, @requestMessage, @status, @staleAt, @createdAt
         )`,
      )
      .run(request);
  }

  completeReviewRequest(request: StoredReviewRequest): boolean {
    if (request.response === null) {
      throw new Error("completed review request requires a response");
    }
    const response = request.response;
    return this.transaction(() => {
      const result = this.#database
        .prepare(
          `UPDATE review_requests
           SET status = @status
           WHERE id = @id
             AND status = 'pending'
             AND document_revision = @documentRevision
             AND document_content_hash = @documentContentHash`,
        )
        .run(request);
      if (result.changes !== 1) {
        return false;
      }
      this.#database
        .prepare(
          `INSERT INTO review_responses (
             review_request_id, outcome, message, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          request.id,
          response.outcome,
          response.message,
          response.createdAt,
        );
      return true;
    });
  }

  staleReviewRequest(id: string, staleAt: string): boolean {
    const result = this.#database
      .prepare(
        `UPDATE review_requests
         SET status = 'stale', stale_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(staleAt, id);
    return result.changes === 1;
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
    const sourceLinks = this.#database
      .prepare<[string], SourceLinkRow>(
        `SELECT id, href, workspace_path
         FROM document_source_links
         WHERE document_id = ?
         ORDER BY href`,
      )
      .all(row.id)
      .map(({ id, href, workspace_path: workspacePath }) => ({
        id,
        href,
        workspacePath,
      }));
    validateDocumentRow(row, tags, sourceLinks);
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      ...(row.task_id === null ? {} : { taskId: row.task_id }),
      ...(row.producer === null ? {} : { producer: row.producer }),
      kind: row.kind as DocumentKind,
      title: row.title,
      storage: row.storage_kind as DocumentStorage,
      path: row.path,
      ...(row.source_path === null ? {} : { sourcePath: row.source_path }),
      attention: row.attention as Attention,
      tags,
      sourceLinks,
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

  #mapReviewRequest(row: ReviewRequestRow): StoredReviewRequest {
    const responseRow = this.#database
      .prepare<[string], ReviewResponseRow>(
        `SELECT outcome, message, created_at
         FROM review_responses WHERE review_request_id = ?`,
      )
      .get(row.id);
    const response: ReviewResponse | null = responseRow
      ? {
          outcome: responseRow.outcome as ReviewResponse["outcome"],
          message: responseRow.message,
          createdAt: responseRow.created_at,
        }
      : null;
    validateReviewRequestRow(row, response);
    return {
      id: row.id,
      documentId: row.document_id,
      documentRevision: row.document_revision,
      documentContentHash: row.document_content_hash,
      kind: row.kind as StoredReviewRequest["kind"],
      requestMessage: row.request_message,
      status: row.status as StoredReviewRequest["status"],
      response,
      staleAt: row.stale_at,
      createdAt: row.created_at,
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
      database.pragma(`user_version = ${SQLITE_SCHEMA_VERSION}`);
    })();
    return;
  }
  if (rawVersion < 2) {
    database.transaction(() => {
      database.exec(
        "ALTER TABLE documents ADD COLUMN storage_kind TEXT NOT NULL DEFAULT 'reference' CHECK (storage_kind IN ('reference', 'managed'))",
      );
      database.exec("ALTER TABLE documents ADD COLUMN source_path TEXT");
      database.pragma("user_version = 2");
    })();
  }
  if (rawVersion < 3) {
    database.transaction(() => {
      database.exec(
        `CREATE TABLE IF NOT EXISTS document_source_links (
           document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
           id TEXT NOT NULL,
           href TEXT NOT NULL,
           workspace_path TEXT NOT NULL,
           PRIMARY KEY (document_id, id),
           UNIQUE (document_id, href)
         ) STRICT`,
      );
      database.pragma("user_version = 3");
    })();
  }
  if (rawVersion < 4) {
    database.transaction(() => {
      database.exec(
        `CREATE TABLE IF NOT EXISTS review_requests (
           id TEXT PRIMARY KEY,
           document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
           document_revision INTEGER NOT NULL CHECK (document_revision > 0),
           document_content_hash TEXT NOT NULL,
           kind TEXT NOT NULL CHECK (kind IN ('plan-decision')),
           request_message TEXT NOT NULL,
           status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'changes_requested', 'rejected', 'stale')),
           stale_at TEXT,
           created_at TEXT NOT NULL
         ) STRICT;
         CREATE TABLE IF NOT EXISTS review_responses (
           review_request_id TEXT PRIMARY KEY REFERENCES review_requests(id) ON DELETE CASCADE,
           outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'changes_requested', 'rejected')),
           message TEXT NOT NULL,
           created_at TEXT NOT NULL
         ) STRICT;
         CREATE UNIQUE INDEX IF NOT EXISTS review_requests_pending_document_idx
           ON review_requests(document_id) WHERE status = 'pending';
         CREATE INDEX IF NOT EXISTS review_requests_document_idx
           ON review_requests(document_id, created_at DESC);
         CREATE INDEX IF NOT EXISTS review_requests_status_idx
           ON review_requests(status, created_at DESC);`,
      );
      database.pragma("user_version = 4");
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

function validateDocumentRow(
  row: DocumentRow,
  tags: string[],
  sourceLinks: DocumentSourceLink[],
): void {
  if (
    !/^doc-[a-f0-9]{20}$/.test(row.id) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.workspace_id) ||
    (row.task_id !== null && row.task_id.trim() === "") ||
    (row.producer !== null && row.producer.trim() === "") ||
    !isDocumentKind(row.kind) ||
    row.title.trim() === "" ||
    (row.storage_kind !== "reference" && row.storage_kind !== "managed") ||
    !isAbsolute(row.path) ||
    extname(row.path).toLowerCase() !== ".md" ||
    !isAttention(row.attention) ||
    (row.storage_kind === "reference" && row.source_path !== null) ||
    (row.storage_kind === "managed" &&
      (row.source_path === null ||
        !isAbsolute(row.source_path) ||
        extname(row.source_path).toLowerCase() !== ".md")) ||
    !/^[a-f0-9]{64}$/.test(row.content_hash) ||
    !isPositiveInteger(row.revision) ||
    !isProgressRevision(row.opened_revision, row.revision) ||
    !isProgressRevision(row.completed_revision, row.revision) ||
    !isNullableDate(row.archived_at) ||
    !isNullableDate(row.missing_at) ||
    !isDate(row.created_at) ||
    !isDate(row.updated_at) ||
    tags.some((tag) => !/^[a-z0-9][a-z0-9._/-]{0,63}$/.test(tag)) ||
    sourceLinks.some(
      ({ id, href, workspacePath }) =>
        !/^source-[a-f0-9]{20}$/.test(id) ||
        href === "" ||
        href.length > 4096 ||
        !isSafeRelativePath(workspacePath),
    )
  ) {
    throw new Error(`invalid document row ${row.id}`);
  }
}

function validateReviewRequestRow(
  row: ReviewRequestRow,
  response: ReviewResponse | null,
): void {
  const terminal = row.status !== "pending" && row.status !== "stale";
  if (
    !/^review-[a-f0-9]{20}$/.test(row.id) ||
    !/^doc-[a-f0-9]{20}$/.test(row.document_id) ||
    !isPositiveInteger(row.document_revision) ||
    !/^[a-f0-9]{64}$/.test(row.document_content_hash) ||
    !isReviewKind(row.kind) ||
    !isValidReviewMessage(row.request_message) ||
    !isReviewStatus(row.status) ||
    !isNullableDate(row.stale_at) ||
    !isDate(row.created_at) ||
    (row.status === "stale") !== (row.stale_at !== null) ||
    terminal !== (response !== null) ||
    (response !== null &&
      (!isReviewOutcome(response.outcome) ||
        !isValidReviewMessage(response.message) ||
        !isDate(response.createdAt) ||
        response.outcome !== row.status))
  ) {
    throw new Error(`invalid review request row ${row.id}`);
  }
}

function isValidReviewMessage(value: string): boolean {
  return (
    value.length <= 16 * 1024 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

function isSafeRelativePath(path: string): boolean {
  const normalized = relative(".", path);
  return (
    path !== "" &&
    !isAbsolute(path) &&
    normalized !== ".." &&
    !normalized.startsWith(`..${sep}`) &&
    !isAbsolute(normalized)
  );
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
