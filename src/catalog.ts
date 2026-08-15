import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import {
  dirname,
  basename,
  extname,
  isAbsolute,
  join,
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
  type DocumentSourceLink,
  type DocumentStorage,
  type StoredDocument,
  type Workspace,
} from "./domain.js";
import { SqliteCatalogStorage } from "./sqlite-storage.js";
import type { CatalogStorage } from "./storage.js";
import { syncDirectory } from "./fs-durability.js";
import {
  discoverDocumentSourceLinks,
  isSafeWorkspacePath,
  validateSourceLinkId,
} from "./source-links.js";

export type {
  Attention,
  Document,
  DocumentFilters,
  DocumentKind,
  DocumentSourceLink,
  DocumentStorage,
  ReadingStatus,
  Workspace,
} from "./domain.js";

export const CATALOG_SCHEMA_VERSION = 1;
const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_LEGACY_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_TITLE_LENGTH = 512;
const MAX_CONTEXT_LENGTH = 256;
const MAX_LINKED_SOURCE_LINES = 50_000;
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

export type ImportDocumentInput = RegisterDocumentInput;

export interface DocumentSource {
  content: string;
  document: Document;
  name: string;
}

interface InspectedDocument {
  path: string;
  contentHash: string;
  content: Buffer;
}

export class DocumentSourceMissingError extends Error {
  constructor(readonly document: Document) {
    super("Document source is missing");
    this.name = "DocumentSourceMissingError";
  }
}

export class DocumentSourceLinkNotFoundError extends Error {
  constructor() {
    super("unknown document source link");
    this.name = "DocumentSourceLinkNotFoundError";
  }
}

export class LinkedSourceMissingError extends Error {
  constructor() {
    super("linked source is missing");
    this.name = "LinkedSourceMissingError";
  }
}

export class LinkedSourceUnavailableError extends Error {
  constructor(message = "linked source is unavailable") {
    super(message);
    this.name = "LinkedSourceUnavailableError";
  }
}

export class Catalog {
  readonly #storage: CatalogStorage;
  readonly #maxDocumentBytes: number;
  readonly #managedRoot: string;

  private constructor(
    storage: CatalogStorage,
    options: CatalogOptions,
    managedRoot: string,
  ) {
    this.#storage = storage;
    this.#maxDocumentBytes =
      options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
    this.#managedRoot = managedRoot;
  }

  static async open(
    databasePath: string,
    options: CatalogOptions = {},
  ): Promise<Catalog> {
    validateCatalogOptions(options);
    if (typeof databasePath !== "string" || databasePath.trim() === "") {
      throw new Error("database path is required");
    }

    const canonicalDatabasePath = resolve(databasePath);
    const storage = SqliteCatalogStorage.open(canonicalDatabasePath);
    const catalog = new Catalog(
      storage,
      options,
      join(dirname(canonicalDatabasePath), "managed"),
    );
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

  getDocument(id: string): Document | undefined {
    validateDocumentId(id);
    const document = this.#storage.getDocument(id);
    return document ? presentDocument(document) : undefined;
  }

  async readDocument(
    id: string,
  ): Promise<{ content: string; document: Document }> {
    validateDocumentId(id);
    const stored = this.#storage.getDocument(id);
    if (!stored) {
      throw new Error(`unknown document ${id}`);
    }
    const workspace = this.#storage.getWorkspace(stored.workspaceId);
    if (!workspace) {
      throw new Error(`unknown workspace ${stored.workspaceId}`);
    }
    let inspected: InspectedDocument;
    try {
      inspected =
        stored.storage === "managed"
          ? await inspectManagedMarkdownDocument(
              stored.path,
              this.#managedRoot,
              this.#maxDocumentBytes,
            )
          : await inspectMarkdownDocument(
              stored.path,
              workspace,
              this.#maxDocumentBytes,
            );
    } catch (error) {
      if (
        isNodeError(error) &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        const missing = await this.markDocumentMissing(id);
        throw new DocumentSourceMissingError(missing);
      }
      throw error;
    }
    const document = stored.missingAt === null
      ? presentDocument(stored)
      : await this.markDocumentPresent(id);
    return {
      content: inspected.content.toString("utf8"),
      document,
    };
  }

  async readDocumentSource(
    documentId: string,
    sourceLinkId: string,
  ): Promise<DocumentSource> {
    validateDocumentId(documentId);
    validateSourceLinkId(sourceLinkId);
    const stored = this.#storage.getDocument(documentId);
    const sourceLink = stored?.sourceLinks.find(({ id }) => id === sourceLinkId);
    if (!stored || !sourceLink) {
      throw new DocumentSourceLinkNotFoundError();
    }
    const workspace = this.#storage.getWorkspace(stored.workspaceId);
    if (!workspace) {
      throw new DocumentSourceLinkNotFoundError();
    }
    const source = await inspectLinkedSource(
      sourceLink,
      workspace,
      this.#maxDocumentBytes,
    );
    if (source.content.includes(0)) {
      throw new LinkedSourceUnavailableError(
        "linked source must contain UTF-8 text",
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(source.content);
    } catch {
      throw new LinkedSourceUnavailableError(
        "linked source must contain UTF-8 text",
      );
    }
    if (content.split("\n").length > MAX_LINKED_SOURCE_LINES) {
      throw new LinkedSourceUnavailableError(
        `linked source exceeds ${MAX_LINKED_SOURCE_LINES} lines`,
      );
    }
    return {
      content,
      document: presentDocument(stored),
      name: basename(source.path),
    };
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
        document.storage === "reference" &&
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
    const sourceLinks = await discoverDocumentSourceLinks({
      content: inspected.content,
      documentId: id,
      documentPath: inspected.path,
      workspaceRoot: workspace.root,
    });
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
      storage: "reference",
      path: inspected.path,
      attention: validated.attention,
      tags,
      sourceLinks,
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

  async importDocument(input: ImportDocumentInput): Promise<Document> {
    const validated = validateRegisterDocumentInput(input, "import");
    const workspace = this.#storage.getWorkspace(validated.workspaceId);
    if (!workspace) {
      throw new Error(`unknown workspace ${validated.workspaceId}`);
    }

    const inspected = await inspectImportSource(
      validated.path,
      this.#maxDocumentBytes,
    );
    const id = documentId(
      validated.workspaceId,
      `managed\0${inspected.path}`,
    );
    const existing = this.#storage.getDocument(id);
    if (existing && existing.storage !== "managed") {
      throw new Error("document id conflicts with a referenced document");
    }
    const sourceLinks = await discoverDocumentSourceLinks({
      content: inspected.content,
      documentId: id,
      documentPath: inspected.path,
      workspaceRoot: workspace.root,
    });
    const managedPath = await writeManagedCopy(
      this.#managedRoot,
      validated.workspaceId,
      id,
      inspected,
    );
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
      storage: "managed",
      path: managedPath,
      sourcePath: inspected.path,
      attention: validated.attention,
      tags,
      sourceLinks,
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
        storage: "reference",
        path: inspected.path,
        attention: legacyDocument.attention,
        tags: [],
        sourceLinks: await discoverDocumentSourceLinks({
          content: inspected.content,
          documentId: legacyDocument.id,
          documentPath: inspected.path,
          workspaceRoot: workspace.root,
        }),
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
  operation: "registration" | "import" = "registration",
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
    throw new Error(`invalid document ${operation} input`);
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
    content,
  };
}

async function inspectImportSource(
  inputPath: string,
  maxDocumentBytes: number,
): Promise<InspectedDocument> {
  const requestedPath = resolve(inputPath);
  if (extname(requestedPath).toLowerCase() !== ".md") {
    throw new Error("only Markdown files can be imported");
  }
  const requestedInfo = await lstat(requestedPath);
  if (requestedInfo.isSymbolicLink()) {
    throw new Error("document path must not be a symlink");
  }
  const documentPath = await realpath(requestedPath);
  const content = await readBoundedRegularFile(documentPath, maxDocumentBytes);
  return {
    path: documentPath,
    contentHash: createHash("sha256").update(content).digest("hex"),
    content,
  };
}

async function inspectManagedMarkdownDocument(
  inputPath: string,
  managedRoot: string,
  maxDocumentBytes: number,
): Promise<InspectedDocument> {
  const requestedPath = resolve(inputPath);
  if (!isWithin(managedRoot, requestedPath)) {
    throw new Error("managed document is outside private storage");
  }
  const rootInfo = await lstat(managedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("managed document storage must be a non-symlink directory");
  }
  const requestedInfo = await lstat(requestedPath);
  if (requestedInfo.isSymbolicLink()) {
    throw new Error("managed document path must not be a symlink");
  }
  const canonicalRoot = await realpath(managedRoot);
  const documentPath = await realpath(requestedPath);
  if (!isWithin(canonicalRoot, documentPath)) {
    throw new Error("managed document is outside private storage");
  }
  const content = await readBoundedRegularFile(documentPath, maxDocumentBytes);
  return {
    path: documentPath,
    contentHash: createHash("sha256").update(content).digest("hex"),
    content,
  };
}

async function inspectLinkedSource(
  link: DocumentSourceLink,
  workspace: Workspace,
  maxBytes: number,
): Promise<{ content: Buffer; path: string }> {
  if (!isSafeWorkspacePath(link.workspacePath)) {
    throw new LinkedSourceUnavailableError();
  }
  const requestedPath = resolve(workspace.root, link.workspacePath);
  if (!isWithin(workspace.root, requestedPath)) {
    throw new LinkedSourceUnavailableError();
  }

  let requestedInfo;
  try {
    requestedInfo = await lstat(requestedPath);
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      throw new LinkedSourceMissingError();
    }
    throw new LinkedSourceUnavailableError();
  }
  if (requestedInfo.isSymbolicLink()) {
    throw new LinkedSourceUnavailableError(
      "linked source must not be a symlink",
    );
  }
  if (!requestedInfo.isFile()) {
    throw new LinkedSourceUnavailableError(
      "linked source must be a regular file",
    );
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(requestedPath);
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      throw new LinkedSourceMissingError();
    }
    throw new LinkedSourceUnavailableError();
  }
  if (!isWithin(workspace.root, canonicalPath)) {
    throw new LinkedSourceUnavailableError(
      "linked source is outside workspace root",
    );
  }

  try {
    return {
      content: await readBoundedRegularFile(
        canonicalPath,
        maxBytes,
        "linked source",
      ),
      path: canonicalPath,
    };
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      throw new LinkedSourceMissingError();
    }
    throw new LinkedSourceUnavailableError(
      error instanceof Error ? error.message : undefined,
    );
  }
}

async function writeManagedCopy(
  managedRoot: string,
  workspaceId: string,
  id: string,
  inspected: InspectedDocument,
): Promise<string> {
  await ensurePrivateDirectory(managedRoot);
  const workspaceRoot = join(managedRoot, workspaceId);
  await ensurePrivateDirectory(workspaceRoot);
  const destination = join(
    workspaceRoot,
    `${id}-${inspected.contentHash}.md`,
  );
  const temporary = join(workspaceRoot, `.${id}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(inspected.content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    await chmod(destination, 0o600);
    await syncDirectory(workspaceRoot);
    return destination;
  } catch (error) {
    await handle?.close();
    await rm(temporary, { force: true });
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("managed document storage must be a non-symlink directory");
  }
  await chmod(path, 0o700);
}

async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  label = "document",
): Promise<Buffer> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
    if (info.size > maxBytes) {
      throw new Error(`${label} exceeds ${maxBytes} bytes`);
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
      throw new Error(`${label} exceeds ${maxBytes} bytes`);
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
