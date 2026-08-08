import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  stat,
} from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  isAttention,
  isDocumentKind,
  presentDocument,
  type Attention,
  type Document,
  type DocumentFilters,
  type DocumentKind,
  type StoredDocument,
  type Workspace,
} from "./domain.js";
import { SqliteCatalogStorage } from "./sqlite-storage.js";
import type { CatalogStorage } from "./storage.js";

export type {
  Attention,
  Document,
  DocumentFilters,
  DocumentKind,
  ReadingStatus,
  Workspace,
} from "./domain.js";

export const CATALOG_SCHEMA_VERSION = 1;
const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_LEGACY_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_TITLE_LENGTH = 512;
const MAX_CONTEXT_LENGTH = 256;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface LegacyCatalogState {
  schemaVersion: 1;
  workspaces: Workspace[];
  documents: LegacyDocument[];
}

interface LegacyDocument {
  id: string;
  workspaceId: string;
  taskId?: string;
  kind: DocumentKind;
  title: string;
  path: string;
  attention: Attention;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogOptions {
  maxDocumentBytes?: number;
  legacyStatePath?: string | false;
}

export interface AddWorkspaceInput {
  id: string;
  name: string;
  root: string;
  artifactRoots: string[];
}

export interface RegisterDocumentInput {
  workspaceId: string;
  taskId?: string;
  producer?: string;
  kind: DocumentKind;
  title: string;
  path: string;
  attention: Attention;
  tags?: string[];
}

interface InspectedDocument {
  path: string;
  contentHash: string;
}

export class Catalog {
  readonly #storage: CatalogStorage;
  readonly #maxDocumentBytes: number;

  private constructor(storage: CatalogStorage, options: CatalogOptions) {
    this.#storage = storage;
    this.#maxDocumentBytes =
      options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  }

  static async open(
    databasePath: string,
    options: CatalogOptions = {},
  ): Promise<Catalog> {
    validateCatalogOptions(options);
    if (typeof databasePath !== "string" || databasePath.trim() === "") {
      throw new Error("database path is required");
    }

    const storage = SqliteCatalogStorage.open(resolve(databasePath));
    const catalog = new Catalog(storage, options);
    try {
      const legacyStatePath =
        options.legacyStatePath === false
          ? undefined
          : resolve(
              options.legacyStatePath ??
                defaultLegacyStatePath(resolve(databasePath)),
            );
      if (legacyStatePath && storage.isEmpty()) {
        await catalog.#migrateLegacyState(legacyStatePath);
      }
      return catalog;
    } catch (error) {
      storage.close();
      throw error;
    }
  }

  close(): void {
    this.#storage.close();
  }

  listWorkspaces(): Workspace[] {
    return structuredClone(this.#storage.listWorkspaces());
  }

  listDocuments(filters: DocumentFilters = {}): Document[] {
    const validated = validateFilters(filters);
    return this.#storage
      .listDocuments(validated)
      .map((document) => presentDocument(document));
  }

  async addWorkspace(input: AddWorkspaceInput): Promise<Workspace> {
    validateAddWorkspaceInput(input);
    const root = await canonicalDirectory(input.root, "workspace root");
    const artifactRoots: string[] = [];
    for (const candidate of input.artifactRoots) {
      const artifactRoot = await canonicalDirectory(candidate, "artifact root");
      if (!isWithin(root, artifactRoot)) {
        throw new Error("artifact root is outside workspace root");
      }
      if (!artifactRoots.includes(artifactRoot)) {
        artifactRoots.push(artifactRoot);
      }
    }

    const workspace: Workspace = {
      id: input.id,
      name: input.name.trim(),
      root,
      artifactRoots,
    };
    const existing = this.#storage.getWorkspace(workspace.id);
    if (existing && existing.root !== workspace.root) {
      throw new Error(`workspace ${workspace.id} already uses another root`);
    }

    const documents = [
      ...this.#storage.listDocuments(),
      ...this.#storage.listDocuments({ archived: true }),
    ];
    const excludedDocument = documents.find(
      (document) =>
        document.workspaceId === workspace.id &&
        !workspace.artifactRoots.some((artifactRoot) =>
          isWithin(artifactRoot, document.path),
        ),
    );
    if (excludedDocument) {
      throw new Error(
        `workspace update would exclude registered document ${excludedDocument.id}`,
      );
    }

    this.#storage.saveWorkspace(workspace);
    return structuredClone(workspace);
  }

  async registerDocument(input: RegisterDocumentInput): Promise<Document> {
    const validated = validateRegisterDocumentInput(input);
    const workspace = this.#storage.getWorkspace(validated.workspaceId);
    if (!workspace) {
      throw new Error(`unknown workspace ${validated.workspaceId}`);
    }

    const inspected = await inspectMarkdownDocument(
      validated.path,
      workspace,
      this.#maxDocumentBytes,
    );
    const id = documentId(validated.workspaceId, inspected.path);
    const existing = this.#storage.getDocument(id);
    const now = new Date().toISOString();
    const contentChanged =
      existing !== undefined && existing.contentHash !== inspected.contentHash;
    const tags =
      validated.tags === undefined
        ? (existing?.tags ?? [])
        : normalizeTags(validated.tags);
    const document: StoredDocument = {
      id,
      workspaceId: validated.workspaceId,
      ...(validated.taskId === undefined
        ? existing?.taskId === undefined
          ? {}
          : { taskId: existing.taskId }
        : { taskId: validated.taskId }),
      ...(validated.producer === undefined
        ? existing?.producer === undefined
          ? {}
          : { producer: existing.producer }
        : { producer: validated.producer }),
      kind: validated.kind,
      title: validated.title,
      path: inspected.path,
      attention: validated.attention,
      tags,
      contentHash: inspected.contentHash,
      revision: existing ? existing.revision + (contentChanged ? 1 : 0) : 1,
      openedRevision: existing?.openedRevision ?? null,
      completedRevision: existing?.completedRevision ?? null,
      archivedAt: existing?.archivedAt ?? null,
      missingAt: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.#storage.saveDocument(document);
    return presentDocument(document);
  }

  async markDocumentOpened(id: string): Promise<Document> {
    return this.#updateDocument(id, (document) => ({
      ...document,
      openedRevision: document.revision,
    }));
  }

  async markDocumentRead(id: string): Promise<Document> {
    return this.#updateDocument(id, (document) => ({
      ...document,
      completedRevision: document.revision,
    }));
  }

  async markDocumentUnread(id: string): Promise<Document> {
    return this.#updateDocument(id, (document) => ({
      ...document,
      openedRevision: null,
      completedRevision: null,
    }));
  }

  async setDocumentTags(id: string, tags: string[]): Promise<Document> {
    const normalized = normalizeTags(tags);
    return this.#updateDocument(id, (document) => ({
      ...document,
      tags: normalized,
    }));
  }

  async archiveDocument(id: string): Promise<Document> {
    return this.#updateDocument(id, (document) => ({
      ...document,
      archivedAt: document.archivedAt ?? new Date().toISOString(),
    }));
  }

  async restoreDocument(id: string): Promise<Document> {
    return this.#updateDocument(id, (document) => ({
      ...document,
      archivedAt: null,
    }));
  }

  async markDocumentMissing(id: string): Promise<Document> {
    return this.#updateDocument(id, (document) => ({
      ...document,
      missingAt: document.missingAt ?? new Date().toISOString(),
    }));
  }

  async markDocumentPresent(id: string): Promise<Document> {
    return this.#updateDocument(id, (document) => ({
      ...document,
      missingAt: null,
    }));
  }

  #updateDocument(
    id: string,
    update: (document: StoredDocument) => StoredDocument,
  ): Document {
    validateDocumentId(id);
    const existing = this.#storage.getDocument(id);
    if (!existing) {
      throw new Error(`unknown document ${id}`);
    }
    const updated = update(existing);
    this.#storage.saveDocument(updated);
    return presentDocument(updated);
  }

  async #migrateLegacyState(legacyStatePath: string): Promise<void> {
    const state = await loadLegacyState(legacyStatePath);
    if (!state) {
      return;
    }

    const backupPath = `${legacyStatePath}.migrated`;
    try {
      await access(backupPath);
      throw new Error(`legacy catalog backup already exists: ${backupPath}`);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    const workspaces: Workspace[] = [];
    for (const legacyWorkspace of state.workspaces) {
      const root = await canonicalDirectory(
        legacyWorkspace.root,
        "legacy workspace root",
      );
      const artifactRoots: string[] = [];
      for (const candidate of legacyWorkspace.artifactRoots) {
        const artifactRoot = await canonicalDirectory(
          candidate,
          "legacy artifact root",
        );
        if (!isWithin(root, artifactRoot)) {
          throw new Error("artifact root is outside workspace root");
        }
        if (!artifactRoots.includes(artifactRoot)) {
          artifactRoots.push(artifactRoot);
        }
      }
      workspaces.push({
        id: legacyWorkspace.id,
        name: legacyWorkspace.name,
        root,
        artifactRoots,
      });
    }

    const documents: StoredDocument[] = [];
    for (const legacyDocument of state.documents) {
      const workspace = workspaces.find(
        ({ id }) => id === legacyDocument.workspaceId,
      );
      if (!workspace) {
        throw new Error(
          `document ${legacyDocument.id} references an unknown workspace`,
        );
      }
      const inspected = await inspectMarkdownDocument(
        legacyDocument.path,
        workspace,
        this.#maxDocumentBytes,
      );
      documents.push({
        id: legacyDocument.id,
        workspaceId: legacyDocument.workspaceId,
        ...(legacyDocument.taskId === undefined
          ? {}
          : { taskId: legacyDocument.taskId }),
        kind: legacyDocument.kind,
        title: legacyDocument.title,
        path: inspected.path,
        attention: legacyDocument.attention,
        tags: [],
        contentHash: inspected.contentHash,
        revision: 1,
        openedRevision: null,
        completedRevision: null,
        archivedAt: null,
        missingAt: null,
        createdAt: legacyDocument.createdAt,
        updatedAt: legacyDocument.updatedAt,
      });
    }

    this.#storage.transaction(() => {
      for (const workspace of workspaces) {
        this.#storage.saveWorkspace(workspace);
      }
      for (const document of documents) {
        this.#storage.saveDocument(document);
      }
    });
    await rename(legacyStatePath, backupPath);
    await chmod(backupPath, 0o600);
  }
}

function validateCatalogOptions(options: CatalogOptions): void {
  if (!isRecord(options)) {
    throw new Error("catalog options must be an object");
  }
  if (!hasOnlyKeys(options, ["maxDocumentBytes", "legacyStatePath"])) {
    throw new Error("catalog options contain unknown fields");
  }
  if (
    options.maxDocumentBytes !== undefined &&
    (typeof options.maxDocumentBytes !== "number" ||
      !Number.isSafeInteger(options.maxDocumentBytes) ||
      options.maxDocumentBytes <= 0)
  ) {
    throw new Error("maxDocumentBytes must be a positive integer");
  }
  if (
    options.legacyStatePath !== undefined &&
    options.legacyStatePath !== false &&
    (typeof options.legacyStatePath !== "string" ||
      options.legacyStatePath.trim() === "")
  ) {
    throw new Error("legacyStatePath must be a path or false");
  }
}

function validateAddWorkspaceInput(input: AddWorkspaceInput): void {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["id", "name", "root", "artifactRoots"]) ||
    typeof input.id !== "string" ||
    !WORKSPACE_ID_PATTERN.test(input.id) ||
    typeof input.name !== "string" ||
    input.name.trim() === "" ||
    input.name.length > MAX_TITLE_LENGTH ||
    typeof input.root !== "string" ||
    input.root.trim() === "" ||
    !isStringArray(input.artifactRoots) ||
    input.artifactRoots.length === 0 ||
    input.artifactRoots.some((path) => path.trim() === "")
  ) {
    throw new Error("invalid workspace input");
  }
}

function validateRegisterDocumentInput(
  input: RegisterDocumentInput,
): RegisterDocumentInput {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, [
      "workspaceId",
      "taskId",
      "producer",
      "kind",
      "title",
      "path",
      "attention",
      "tags",
    ]) ||
    typeof input.workspaceId !== "string" ||
    !WORKSPACE_ID_PATTERN.test(input.workspaceId) ||
    (input.taskId !== undefined &&
      (typeof input.taskId !== "string" ||
        input.taskId.trim() === "" ||
        input.taskId.length > MAX_CONTEXT_LENGTH)) ||
    (input.producer !== undefined &&
      (typeof input.producer !== "string" ||
        input.producer.trim() === "" ||
        input.producer.length > MAX_CONTEXT_LENGTH)) ||
    typeof input.kind !== "string" ||
    !isDocumentKind(input.kind) ||
    typeof input.title !== "string" ||
    input.title.trim() === "" ||
    input.title.length > MAX_TITLE_LENGTH ||
    typeof input.path !== "string" ||
    input.path.trim() === "" ||
    typeof input.attention !== "string" ||
    !isAttention(input.attention) ||
    (input.tags !== undefined && !isStringArray(input.tags))
  ) {
    throw new Error("invalid document registration input");
  }
  if (input.tags !== undefined) {
    normalizeTags(input.tags);
  }
  return {
    workspaceId: input.workspaceId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId.trim() }),
    ...(input.producer === undefined
      ? {}
      : { producer: input.producer.trim() }),
    kind: input.kind,
    title: input.title.trim(),
    path: input.path,
    attention: input.attention,
    ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
  };
}

function validateFilters(filters: DocumentFilters): DocumentFilters {
  if (
    !isRecord(filters) ||
    !hasOnlyKeys(filters, [
      "workspaceId",
      "taskId",
      "tag",
      "status",
      "kind",
      "attention",
      "archived",
      "missing",
    ])
  ) {
    throw new Error("invalid document filters");
  }
  if (
    filters.workspaceId !== undefined &&
    (typeof filters.workspaceId !== "string" ||
      !WORKSPACE_ID_PATTERN.test(filters.workspaceId))
  ) {
    throw new Error("invalid workspace filter");
  }
  if (
    filters.taskId !== undefined &&
    (typeof filters.taskId !== "string" || filters.taskId.trim() === "")
  ) {
    throw new Error("invalid task filter");
  }
  if (
    filters.tag !== undefined &&
    (typeof filters.tag !== "string" ||
      !TAG_PATTERN.test(filters.tag.trim().toLowerCase()))
  ) {
    throw new Error("invalid tag filter");
  }
  if (
    filters.status !== undefined &&
    (typeof filters.status !== "string" ||
      !["unread", "reading", "done"].includes(filters.status))
  ) {
    throw new Error("invalid status filter");
  }
  if (
    filters.kind !== undefined &&
    (typeof filters.kind !== "string" || !isDocumentKind(filters.kind))
  ) {
    throw new Error("invalid kind filter");
  }
  if (
    filters.attention !== undefined &&
    (typeof filters.attention !== "string" ||
      !isAttention(filters.attention))
  ) {
    throw new Error("invalid attention filter");
  }
  if (
    (filters.archived !== undefined &&
      typeof filters.archived !== "boolean") ||
    (filters.missing !== undefined && typeof filters.missing !== "boolean")
  ) {
    throw new Error("invalid boolean document filter");
  }
  return {
    ...filters,
    ...(filters.tag === undefined
      ? {}
      : { tag: filters.tag.trim().toLowerCase() }),
  };
}

function normalizeTags(tags: string[]): string[] {
  if (!Array.isArray(tags) || tags.length > 64) {
    throw new Error("document tags must be an array of at most 64 entries");
  }
  const normalized = tags.map((tag) => {
    if (typeof tag !== "string") {
      throw new Error("document tags must be strings");
    }
    const value = tag.trim().toLowerCase();
    if (!TAG_PATTERN.test(value)) {
      throw new Error(
        "tags must use lowercase letters, digits, dots, slashes, underscores, or hyphens",
      );
    }
    return value;
  });
  return [...new Set(normalized)].sort();
}

async function inspectMarkdownDocument(
  inputPath: string,
  workspace: Workspace,
  maxDocumentBytes: number,
): Promise<InspectedDocument> {
  const requestedPath = resolve(inputPath);
  if (extname(requestedPath).toLowerCase() !== ".md") {
    throw new Error("only Markdown files can be registered");
  }
  const requestedInfo = await lstat(requestedPath);
  if (requestedInfo.isSymbolicLink()) {
    throw new Error("document path must not be a symlink");
  }

  const documentPath = await realpath(requestedPath);
  if (
    !workspace.artifactRoots.some((artifactRoot) =>
      isWithin(artifactRoot, documentPath),
    )
  ) {
    throw new Error("document is outside registered artifact roots");
  }

  const content = await readBoundedRegularFile(documentPath, maxDocumentBytes);
  return {
    path: documentPath,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}

async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error("document must be a regular file");
    }
    if (info.size > maxBytes) {
      throw new Error(`document exceeds ${maxBytes} bytes`);
    }

    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new Error(`document exceeds ${maxBytes} bytes`);
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const info = await stat(canonical);
  if (!info.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
  return canonical;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

function documentId(workspaceId: string, path: string): string {
  const hash = createHash("sha256")
    .update(workspaceId)
    .update("\0")
    .update(path)
    .digest("hex")
    .slice(0, 20);
  return `doc-${hash}`;
}

function validateDocumentId(id: string): void {
  if (typeof id !== "string" || !/^doc-[a-f0-9]{20}$/.test(id)) {
    throw new Error("invalid document id");
  }
}

function defaultLegacyStatePath(databasePath: string): string {
  return databasePath.endsWith(".sqlite3")
    ? `${databasePath.slice(0, -".sqlite3".length)}.json`
    : `${databasePath}.json`;
}

async function loadLegacyState(
  path: string,
): Promise<LegacyCatalogState | undefined> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("legacy catalog state must be a regular file");
    }
    if (info.size > MAX_LEGACY_CATALOG_BYTES) {
      throw new Error(
        `legacy catalog state exceeds ${MAX_LEGACY_CATALOG_BYTES} bytes`,
      );
    }
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return validateLegacyState(parsed);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function validateLegacyState(value: unknown): LegacyCatalogState {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "workspaces", "documents"]) ||
    value.schemaVersion !== CATALOG_SCHEMA_VERSION ||
    !Array.isArray(value.workspaces) ||
    !Array.isArray(value.documents)
  ) {
    throw new Error("invalid legacy catalog state");
  }

  const workspaces = value.workspaces.map(validateLegacyWorkspace);
  const workspaceIds = new Set<string>();
  for (const workspace of workspaces) {
    if (workspaceIds.has(workspace.id)) {
      throw new Error(`duplicate workspace ${workspace.id}`);
    }
    workspaceIds.add(workspace.id);
  }

  const documents = value.documents.map(validateLegacyDocument);
  const documentIds = new Set<string>();
  for (const document of documents) {
    if (documentIds.has(document.id)) {
      throw new Error(`duplicate document ${document.id}`);
    }
    documentIds.add(document.id);
    const workspace = workspaces.find(
      ({ id }) => id === document.workspaceId,
    );
    if (!workspace) {
      throw new Error(
        `document ${document.id} references an unknown workspace`,
      );
    }
    if (
      !workspace.artifactRoots.some((root) => isWithin(root, document.path))
    ) {
      throw new Error(
        `document ${document.id} is outside registered artifact roots`,
      );
    }
  }

  return { schemaVersion: 1, workspaces, documents };
}

function validateLegacyWorkspace(value: unknown): Workspace {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "name", "root", "artifactRoots"]) ||
    typeof value.id !== "string" ||
    !WORKSPACE_ID_PATTERN.test(value.id) ||
    typeof value.name !== "string" ||
    value.name.trim() === "" ||
    typeof value.root !== "string" ||
    !isAbsolute(value.root) ||
    !isStringArray(value.artifactRoots) ||
    value.artifactRoots.length === 0 ||
    value.artifactRoots.some(
      (artifactRoot) =>
        !isAbsolute(artifactRoot) ||
        !isWithin(value.root as string, artifactRoot),
    )
  ) {
    throw new Error("invalid workspace entry in legacy catalog state");
  }
  return {
    id: value.id,
    name: value.name,
    root: value.root,
    artifactRoots: [...value.artifactRoots],
  };
}

function validateLegacyDocument(value: unknown): LegacyDocument {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "workspaceId",
      "taskId",
      "kind",
      "title",
      "path",
      "attention",
      "createdAt",
      "updatedAt",
    ]) ||
    typeof value.id !== "string" ||
    !/^doc-[a-f0-9]{20}$/.test(value.id) ||
    typeof value.workspaceId !== "string" ||
    (value.taskId !== undefined && typeof value.taskId !== "string") ||
    typeof value.kind !== "string" ||
    !isDocumentKind(value.kind) ||
    typeof value.title !== "string" ||
    value.title.trim() === "" ||
    typeof value.path !== "string" ||
    !isAbsolute(value.path) ||
    extname(value.path).toLowerCase() !== ".md" ||
    typeof value.attention !== "string" ||
    !isAttention(value.attention) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt)
  ) {
    throw new Error("invalid document entry in legacy catalog state");
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
    kind: value.kind,
    title: value.title,
    path: value.path,
    attention: value.attention,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
