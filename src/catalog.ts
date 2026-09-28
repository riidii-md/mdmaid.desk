import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
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
  isReviewKind,
  isReviewOutcome,
  isReviewStatus,
  presentDocument,
  presentReviewRequest,
  projectDisplayName,
  type Attention,
  type ContentScope,
  type Document,
  type DocumentFilters,
  type DocumentKind,
  type DocumentSourceLink,
  type DocumentStorage,
  type Project,
  type RepositoryInventoryItem,
  type RepositoryIdentity,
  type ReviewKind,
  type ReviewFeedbackItem,
  type ReviewOutcome,
  type ReviewRequest,
  type ReviewRequestFilters,
  type ReviewResponse,
  type StoredReviewRequest,
  type StoredDocument,
  type Space,
  type SpaceMatcher,
  type Workspace,
} from "./domain.js";
import { SqliteCatalogStorage } from "./sqlite-storage.js";
import type { CatalogStorage } from "./storage.js";
import { syncDirectory } from "./fs-durability.js";
import { assertValidMermaidMarkdown } from "./mermaid-validation.js";
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
  ContentScope,
  ReadingStatus,
  ReviewKind,
  ReviewFeedbackItem,
  ReviewOutcome,
  ReviewRequest,
  ReviewRequestFilters,
  ReviewResponse,
  ReviewStatus,
  Workspace,
  Project,
  RepositoryInventoryItem,
  Space,
  SpaceMatcher,
} from "./domain.js";

export const CATALOG_SCHEMA_VERSION = 1;
const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_LEGACY_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_TITLE_LENGTH = 512;
const MAX_CONTEXT_LENGTH = 256;
const MAX_FEATURE_NAME_LENGTH = 96;
const MAX_REPOSITORY_LENGTH = 512;
const MAX_LINKED_SOURCE_LINES = 50_000;
const MAX_REVIEW_MESSAGE_LENGTH = 16 * 1024;
const MAX_REVIEW_FEEDBACK_ITEMS = 32;
const MAX_REVIEW_FEEDBACK_MESSAGE_LENGTH = 512;
const MAX_REVIEW_FEEDBACK_PATH_LENGTH = 1_024;
const MAX_SPACE_MATCHERS = 64;
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
  repository?: string;
  repositoryName?: string;
}

export interface SpaceMatcherInput {
  kind: string;
  value: string;
}

export interface CreateSpaceInput {
  id: string;
  name: string;
  matchers: SpaceMatcherInput[];
}

export interface ReplaceSpaceMatchersInput {
  matchers: SpaceMatcherInput[];
}

export interface RegisterDocumentInput {
  workspaceId: string;
  taskId?: string;
  featureName?: string;
  producer?: string;
  kind: DocumentKind;
  title: string;
  path: string;
  attention: Attention;
  tags?: string[];
}

export type ImportDocumentInput = RegisterDocumentInput;

export interface CreateReviewRequestInput {
  documentId: string;
  documentRevision?: number;
  kind: ReviewKind;
  requestMessage: string;
}

export interface RespondToReviewRequestInput {
  outcome: ReviewOutcome;
  message: string;
  items?: ReviewFeedbackItem[];
}

export interface DocumentSource {
  content: string;
  document: Document;
  name: string;
}

export interface DocumentMedia {
  content: Buffer;
  contentType: "image/svg+xml";
  document: Document;
  name: string;
}

export type ReferenceDocumentReconciliationAction =
  | "unchanged"
  | "source-changed"
  | "source-missing"
  | "source-restored";

export interface ReferenceDocumentReconciliation {
  action: ReferenceDocumentReconciliationAction;
  content: string | null;
  document: Document;
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

export class ReviewConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewConflictError";
  }
}

export class SpaceNotFoundError extends Error {
  constructor(readonly spaceId: string) {
    super(`unknown space ${spaceId}`);
    this.name = "SpaceNotFoundError";
  }
}

export class SpaceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpaceConflictError";
  }
}

export class Catalog {
  readonly #storage: CatalogStorage;
  readonly #maxDocumentBytes: number;
  readonly #managedRoot: string;
  readonly #referenceReconciliations = new Map<
    string,
    Promise<ReferenceDocumentReconciliation>
  >();
  readonly #invalidationListeners = new Set<() => void>();

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
      await recoverManagedPurges(catalog.#managedRoot, storage);
      return catalog;
    } catch (error) {
      storage.close();
      throw error;
    }
  }

  close(): void {
    this.#storage.close();
  }

  subscribeInvalidation(listener: () => void): () => void {
    this.#invalidationListeners.add(listener);
    return () => this.#invalidationListeners.delete(listener);
  }

  #emitInvalidation(): void {
    for (const listener of this.#invalidationListeners) {
      try {
        listener();
      } catch {
        // A notification observer must not change the mutation outcome.
      }
    }
  }

  listSpaces(): Space[] {
    return structuredClone(this.#storage.listSpaces());
  }

  getSpace(id: string): Space | undefined {
    validateSpaceId(id);
    const space = this.#storage.getSpace(id);
    return space ? structuredClone(space) : undefined;
  }

  createSpace(input: CreateSpaceInput): Space {
    const space = normalizeSpaceInput(input);
    if (this.#storage.getSpace(space.id)) {
      throw new SpaceConflictError(`space ${space.id} already exists`);
    }
    this.#storage.saveSpace(space);
    this.#emitInvalidation();
    return structuredClone(space);
  }

  renameSpace(id: string, name: string): Space {
    validateSpaceId(id);
    const existing = this.#storage.getSpace(id);
    if (!existing) {
      throw new SpaceNotFoundError(id);
    }
    const updated = { ...existing, name: normalizeSpaceName(name) };
    if (updated.name === existing.name) {
      return structuredClone(existing);
    }
    this.#storage.saveSpace(updated);
    this.#emitInvalidation();
    return structuredClone(updated);
  }

  replaceSpaceMatchers(
    id: string,
    input: ReplaceSpaceMatchersInput,
  ): Space {
    validateSpaceId(id);
    if (!isRecord(input) || !hasOnlyKeys(input, ["matchers"])) {
      throw new Error("invalid Space matcher replacement");
    }
    const existing = this.#storage.getSpace(id);
    if (!existing) {
      throw new SpaceNotFoundError(id);
    }
    const updated = {
      ...existing,
      matchers: normalizeSpaceMatchers(input.matchers),
    };
    if (sameSpaceMatchers(updated.matchers, existing.matchers)) {
      return structuredClone(existing);
    }
    this.#storage.saveSpace(updated);
    this.#emitInvalidation();
    return structuredClone(updated);
  }

  deleteSpace(id: string): { id: string } {
    validateSpaceId(id);
    if (!this.#storage.deleteSpace(id)) {
      throw new SpaceNotFoundError(id);
    }
    this.#emitInvalidation();
    return { id };
  }

  listRepositories(): RepositoryInventoryItem[] {
    return structuredClone(this.#storage.listRepositories());
  }

  listWorkspaces(scope: ContentScope = {}): Workspace[] {
    return structuredClone(this.#storage.listWorkspaces(this.#resolveScope(scope)));
  }

  listDocuments(
    filters: DocumentFilters = {},
    scope: ContentScope = {},
  ): Document[] {
    const validated = validateFilters(filters);
    return this.#storage
      .listDocuments(validated, this.#resolveScope(scope))
      .map((document) => presentDocument(document));
  }

  getDocument(id: string, scope: ContentScope = {}): Document | undefined {
    validateDocumentId(id);
    const document = this.#storage.getDocument(id, this.#resolveScope(scope));
    return document ? presentDocument(document) : undefined;
  }

  #resolveScope(scope: ContentScope): ContentScope {
    if (
      !isRecord(scope) ||
      !hasOnlyKeys(scope, ["spaceId"]) ||
      (scope.spaceId !== undefined && typeof scope.spaceId !== "string")
    ) {
      throw new Error("invalid content scope");
    }
    if (scope.spaceId === undefined) {
      return {};
    }
    validateSpaceId(scope.spaceId);
    if (!this.#storage.getSpace(scope.spaceId)) {
      throw new SpaceNotFoundError(scope.spaceId);
    }
    return { spaceId: scope.spaceId };
  }

  async #inspectStoredDocument(
    document: StoredDocument,
  ): Promise<InspectedDocument> {
    const workspace = this.#storage.getWorkspace(document.workspaceId);
    if (!workspace) {
      throw new Error(`unknown workspace ${document.workspaceId}`);
    }
    return document.storage === "managed"
      ? await inspectManagedMarkdownDocument(
          document.path,
          this.#managedRoot,
          this.#maxDocumentBytes,
        )
      : await inspectMarkdownDocument(
          document.path,
          workspace,
          this.#maxDocumentBytes,
        );
  }

  listReviewRequests(
    filters: ReviewRequestFilters = {},
    scope: ContentScope = {},
  ): ReviewRequest[] {
    const validated = validateReviewRequestFilters(filters);
    return this.#storage
      .listReviewRequests(validated, this.#resolveScope(scope))
      .map((request) => presentReviewRequest(request));
  }

  getReviewRequest(
    id: string,
    scope: ContentScope = {},
  ): ReviewRequest | undefined {
    validateReviewRequestId(id);
    const request = this.#storage.getReviewRequest(
      id,
      this.#resolveScope(scope),
    );
    return request ? presentReviewRequest(request) : undefined;
  }

  async createReviewRequest(
    input: CreateReviewRequestInput,
    scope: ContentScope = {},
  ): Promise<ReviewRequest> {
    const validated = validateCreateReviewRequestInput(input);
    const resolvedScope = this.#resolveScope(scope);
    const initialDocument = this.#storage.getDocument(
      validated.documentId,
      resolvedScope,
    );
    if (!initialDocument) {
      throw new Error(`unknown document ${validated.documentId}`);
    }
    if (initialDocument.archivedAt !== null) {
      throw new ReviewConflictError("document is archived");
    }
    if (
      validated.kind === "change-decision" &&
      initialDocument.kind !== "change-review"
    ) {
      throw new ReviewConflictError(
        "change-decision requires a change-review document",
      );
    }
    if (
      initialDocument.kind === "change-review" &&
      validated.kind !== "change-decision"
    ) {
      throw new ReviewConflictError(
        "change-review documents require a change-decision",
      );
    }
    if (
      validated.documentRevision !== undefined &&
      validated.documentRevision !== initialDocument.revision
    ) {
      throw new ReviewConflictError("document revision changed");
    }
    let inspected: InspectedDocument;
    try {
      inspected = await this.#inspectStoredDocument(initialDocument);
    } catch {
      throw new ReviewConflictError(
        "document source is unavailable; re-register before requesting review",
      );
    }
    if (inspected.contentHash !== initialDocument.contentHash) {
      throw new ReviewConflictError(
        "document content changed; re-register before requesting review",
      );
    }
    const result = this.#storage.transaction((): {
      request: ReviewRequest;
      changed: boolean;
    } => {
      const document = this.#storage.getDocument(
        validated.documentId,
        resolvedScope,
      );
      if (!document) {
        throw new Error(`unknown document ${validated.documentId}`);
      }
      if (
        document.revision !== initialDocument.revision ||
        document.contentHash !== inspected.contentHash ||
        document.missingAt !== null ||
        document.archivedAt !== null ||
        validated.documentRevision !== undefined &&
        validated.documentRevision !== document.revision
      ) {
        throw new ReviewConflictError("document revision changed");
      }
      const pending = this.#storage.listReviewRequests({
        documentId: document.id,
        status: "pending",
      }, resolvedScope)[0];
      if (pending) {
        if (
          pending.documentRevision === document.revision &&
          pending.documentContentHash === document.contentHash &&
          pending.kind === validated.kind &&
          pending.requestMessage === validated.requestMessage
        ) {
          return { request: presentReviewRequest(pending), changed: false };
        }
        throw new ReviewConflictError(
          "document already has a pending review request",
        );
      }

      let id: string;
      do {
        id = `review-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      } while (this.#storage.getReviewRequest(id));
      const request: StoredReviewRequest = {
        id,
        documentId: document.id,
        documentRevision: document.revision,
        documentContentHash: document.contentHash,
        kind: validated.kind,
        requestMessage: validated.requestMessage,
        status: "pending",
        response: null,
        staleAt: null,
        createdAt: new Date().toISOString(),
      };
      this.#storage.saveReviewRequest(request);
      return { request: presentReviewRequest(request), changed: true };
    });
    if (result.changed) {
      this.#emitInvalidation();
    }
    return result.request;
  }

  async respondToReviewRequest(
    id: string,
    input: RespondToReviewRequestInput,
    scope: ContentScope = {},
  ): Promise<ReviewRequest> {
    validateReviewRequestId(id);
    const validated = validateRespondToReviewRequestInput(input);
    const resolvedScope = this.#resolveScope(scope);

    const initial = this.#storage.getReviewRequest(id, resolvedScope);
    if (!initial) {
      throw new Error(`unknown review request ${id}`);
    }
    if (initial.response !== null) {
      if (
        initial.response.outcome === validated.outcome &&
        sameReviewResponse(initial.response, validated)
      ) {
        return presentReviewRequest(initial);
      }
      throw new ReviewConflictError(
        "review request already has a different response",
      );
    }
    if (initial.status === "stale") {
      throw new ReviewConflictError("review request is stale");
    }
    const initialDocument = this.#storage.getDocument(
      initial.documentId,
      resolvedScope,
    );
    if (!initialDocument) {
      throw new Error(`unknown review request ${id}`);
    }
    if (
      initialDocument.revision !== initial.documentRevision ||
      initialDocument.contentHash !== initial.documentContentHash ||
      initialDocument.missingAt !== null
    ) {
      this.#staleReviewRequest(id, resolvedScope);
      throw new ReviewConflictError("review request is stale");
    }
    try {
      const inspected = await this.#inspectStoredDocument(initialDocument);
      if (inspected.contentHash !== initial.documentContentHash) {
        this.#staleReviewRequest(id, resolvedScope);
        throw new ReviewConflictError("review request is stale");
      }
    } catch (error) {
      if (error instanceof ReviewConflictError) {
        throw error;
      }
      if (error instanceof Error && error.message.startsWith("unknown review request")) {
        throw error;
      }
      this.#staleReviewRequest(id, resolvedScope);
      throw new ReviewConflictError("review request is stale");
    }

    const result = this.#storage.transaction(():
      | { kind: "responded"; request: ReviewRequest; changed: boolean }
      | { kind: "stale"; changed: boolean } => {
      const request = this.#storage.getReviewRequest(id, resolvedScope);
      if (!request) {
        throw new Error(`unknown review request ${id}`);
      }
      if (request.response !== null) {
        if (
          request.response.outcome === validated.outcome &&
          sameReviewResponse(request.response, validated)
        ) {
          return {
            kind: "responded",
            request: presentReviewRequest(request),
            changed: false,
          };
        }
        throw new ReviewConflictError(
          "review request already has a different response",
        );
      }
      if (request.status === "stale") {
        throw new ReviewConflictError("review request is stale");
      }
      const document = this.#storage.getDocument(
        request.documentId,
        resolvedScope,
      );
      if (
        !document ||
        document.revision !== request.documentRevision ||
        document.contentHash !== request.documentContentHash ||
        document.missingAt !== null
      ) {
        if (!document) {
          throw new Error(`unknown review request ${id}`);
        }
        return {
          kind: "stale",
          changed: this.#storage.staleReviewRequest(id, new Date().toISOString()),
        };
      }
      const responded: StoredReviewRequest = {
        ...request,
        status: validated.outcome,
        response: {
          outcome: validated.outcome,
          message: validated.message,
          ...(validated.items === undefined ? {} : { items: validated.items }),
          createdAt: new Date().toISOString(),
        },
      };
      if (this.#storage.completeReviewRequest(responded)) {
        return {
          kind: "responded",
          request: presentReviewRequest(responded),
          changed: true,
        };
      }
      const winner = this.#storage.getReviewRequest(id);
      if (
        winner?.response?.outcome === validated.outcome &&
        sameReviewResponse(winner.response, validated)
      ) {
        return {
          kind: "responded",
          request: presentReviewRequest(winner),
          changed: false,
        };
      }
      throw new ReviewConflictError(
        winner?.status === "stale"
          ? "review request is stale"
          : "review request already has a different response",
      );
    });
    if (result.kind === "stale") {
      if (result.changed) {
        this.#emitInvalidation();
      }
      throw new ReviewConflictError("review request is stale");
    }
    if (result.changed) {
      this.#emitInvalidation();
    }
    return result.request;
  }

  #staleReviewRequest(id: string, scope: ContentScope): void {
    const changed = this.#storage.transaction(() => {
      if (!this.#storage.getReviewRequest(id, scope)) {
        throw new Error(`unknown review request ${id}`);
      }
      return this.#storage.staleReviewRequest(id, new Date().toISOString());
    });
    if (changed) {
      this.#emitInvalidation();
    }
  }

  async readDocument(
    id: string,
    scope: ContentScope = {},
  ): Promise<{ content: string; document: Document }> {
    validateDocumentId(id);
    const resolvedScope = this.#resolveScope(scope);
    const stored = this.#storage.getDocument(id, resolvedScope);
    if (!stored) {
      throw new Error(`unknown document ${id}`);
    }
    if (stored.storage === "reference") {
      const reconciled = await this.reconcileReferenceDocument(id, resolvedScope);
      if (reconciled.document.missingAt !== null || reconciled.content === null) {
        throw new DocumentSourceMissingError(reconciled.document);
      }
      return {
        content: reconciled.content,
        document: reconciled.document,
      };
    }
    let inspected: InspectedDocument;
    try {
      inspected = await this.#inspectStoredDocument(stored);
    } catch (error) {
      if (
        isNodeError(error) &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        const missing = await this.markDocumentMissing(id, resolvedScope);
        throw new DocumentSourceMissingError(missing);
      }
      throw error;
    }
    const current = this.#storage.getDocument(id, resolvedScope);
    if (!current) {
      throw new Error(`unknown document ${id}`);
    }
    const document = current.missingAt === null
      ? presentDocument(current)
      : await this.markDocumentPresent(id, resolvedScope);
    return {
      content: inspected.content.toString("utf8"),
      document,
    };
  }

  async reconcileReferenceDocument(
    id: string,
    scope: ContentScope = {},
  ): Promise<ReferenceDocumentReconciliation> {
    validateDocumentId(id);
    const resolvedScope = this.#resolveScope(scope);
    const reconciliationKey = `${id}\0${resolvedScope.spaceId ?? ""}`;
    const previous = this.#referenceReconciliations.get(reconciliationKey);
    const operation = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.#reconcileReferenceDocument(id, resolvedScope));
    this.#referenceReconciliations.set(reconciliationKey, operation);
    try {
      return await operation;
    } finally {
      if (this.#referenceReconciliations.get(reconciliationKey) === operation) {
        this.#referenceReconciliations.delete(reconciliationKey);
      }
    }
  }

  async #reconcileReferenceDocument(
    id: string,
    scope: ContentScope,
  ): Promise<ReferenceDocumentReconciliation> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const initial = this.#storage.getDocument(id, scope);
      if (!initial) {
        throw new Error(`unknown document ${id}`);
      }
      if (initial.storage !== "reference") {
        throw new Error("managed document is not a live reference");
      }
      const workspace = this.#storage.getWorkspace(initial.workspaceId);
      if (!workspace) {
        throw new Error(`unknown workspace ${initial.workspaceId}`);
      }

      let inspected: InspectedDocument;
      try {
        inspected = await inspectMarkdownDocument(
          initial.path,
          workspace,
          this.#maxDocumentBytes,
        );
      } catch (error) {
        if (
          isNodeError(error) &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        ) {
          const missing = this.#storage.transaction(() => {
            const current = this.#storage.getDocument(id, scope);
            if (!current || !sameReconciliationVersion(current, initial)) {
              return undefined;
            }
            if (current.missingAt !== null) {
              return {
                action: "unchanged" as const,
                content: null,
                document: presentDocument(current),
              };
            }
            const now = new Date().toISOString();
            const updated: StoredDocument = {
              ...current,
              missingAt: now,
              updatedAt: now,
            };
            this.#storage.saveDocument(updated);
            return {
              action: "source-missing" as const,
              content: null,
              document: presentDocument(updated),
            };
          });
          if (missing) {
            if (missing.action !== "unchanged") {
              this.#emitInvalidation();
            }
            return missing;
          }
          continue;
        }
        throw error;
      }

      await assertValidMermaidMarkdown(inspected.content.toString("utf8"));
      const sourceLinks = await discoverDocumentSourceLinks({
        content: inspected.content,
        documentId: initial.id,
        documentPath: inspected.path,
        workspaceRoot: workspace.root,
      });
      const reconciled = this.#storage.transaction(() => {
        const current = this.#storage.getDocument(id, scope);
        if (!current || !sameReconciliationVersion(current, initial)) {
          return undefined;
        }
        const content = inspected.content.toString("utf8");
        const contentChanged = current.contentHash !== inspected.contentHash;
        const restored = current.missingAt !== null;
        if (!contentChanged && !restored) {
          return {
            action: "unchanged" as const,
            content,
            document: presentDocument(current),
          };
        }
        const updated: StoredDocument = {
          ...current,
          sourceLinks,
          contentHash: inspected.contentHash,
          revision: current.revision + (contentChanged ? 1 : 0),
          missingAt: null,
          updatedAt: new Date().toISOString(),
        };
        this.#storage.saveDocument(updated);
        return {
          action: restored ? "source-restored" as const : "source-changed" as const,
          content,
          document: presentDocument(updated),
        };
      });
      if (reconciled) {
        if (reconciled.action !== "unchanged") {
          this.#emitInvalidation();
        }
        return reconciled;
      }
    }
    throw new Error("document changed during reconciliation");
  }

  async readDocumentSource(
    documentId: string,
    sourceLinkId: string,
    scope: ContentScope = {},
  ): Promise<DocumentSource> {
    validateDocumentId(documentId);
    validateSourceLinkId(sourceLinkId);
    const resolvedScope = this.#resolveScope(scope);
    const stored = this.#storage.getDocument(documentId, resolvedScope);
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
    const current = this.#storage.getDocument(documentId, resolvedScope);
    const currentSourceLink = current?.sourceLinks.find(
      ({ id }) => id === sourceLinkId,
    );
    if (!current || !currentSourceLink) {
      throw new DocumentSourceLinkNotFoundError();
    }
    return {
      content,
      document: presentDocument(current),
      name: basename(source.path),
    };
  }

  async readDocumentMedia(
    documentId: string,
    sourceLinkId: string,
    scope: ContentScope = {},
  ): Promise<DocumentMedia> {
    validateDocumentId(documentId);
    validateSourceLinkId(sourceLinkId);
    const resolvedScope = this.#resolveScope(scope);
    const stored = this.#storage.getDocument(documentId, resolvedScope);
    const sourceLink = stored?.sourceLinks.find(({ id }) => id === sourceLinkId);
    if (!stored || !sourceLink) {
      throw new DocumentSourceLinkNotFoundError();
    }
    const workspace = this.#storage.getWorkspace(stored.workspaceId);
    if (!workspace) {
      throw new DocumentSourceLinkNotFoundError();
    }
    const media = await inspectLinkedSource(
      sourceLink,
      workspace,
      this.#maxDocumentBytes,
    );
    if (extname(media.path).toLowerCase() !== ".svg") {
      throw new LinkedSourceUnavailableError(
        "linked document media must be an SVG file",
      );
    }
    assertSvgDocument(media.content);
    const current = this.#storage.getDocument(documentId, resolvedScope);
    const currentSourceLink = current?.sourceLinks.find(
      ({ id }) => id === sourceLinkId,
    );
    if (!current || !currentSourceLink) {
      throw new DocumentSourceLinkNotFoundError();
    }
    return {
      content: media.content,
      contentType: "image/svg+xml",
      document: presentDocument(current),
      name: basename(media.path),
    };
  }

  resolveDocumentSourceTargets(
    documentId: string,
    scope: ContentScope = {},
  ): Map<string, string> {
    validateDocumentId(documentId);
    const resolvedScope = this.#resolveScope(scope);
    const stored = this.#storage.getDocument(documentId, resolvedScope);
    if (!stored) {
      throw new Error(`unknown document ${documentId}`);
    }
    const workspace = this.#storage.getWorkspace(stored.workspaceId);
    if (!workspace) {
      throw new Error(`unknown workspace ${stored.workspaceId}`);
    }

    const targets = new Map<string, string>();
    for (const sourceLink of stored.sourceLinks) {
      const targetPath = resolve(workspace.root, sourceLink.workspacePath);
      if (!isWithin(workspace.root, targetPath)) {
        continue;
      }
      const targetId = this.#storage.getReferenceDocumentIdByPath(
        stored.workspaceId,
        targetPath,
        resolvedScope,
      );
      if (targetId !== undefined) {
        targets.set(sourceLink.id, targetId);
      }
    }
    return targets;
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

    const existingRepository = this.#storage.getWorkspaceRepository(workspace.id);
    const repository = input.repository === undefined &&
        input.repositoryName === undefined && existingRepository
      ? existingRepository
      : repositoryIdentity(input, root);
    if (
      existingRepository &&
      this.#storage.workspaceHasDocuments(workspace.id) &&
      (repository.key !== existingRepository.key ||
        repository.name !== existingRepository.name)
    ) {
      throw new Error(
        "repository identity cannot change after documents exist",
      );
    }
    if (
      existing &&
      existingRepository &&
      sameWorkspace(existing, workspace) &&
      existingRepository.key === repository.key &&
      existingRepository.name === repository.name
    ) {
      return structuredClone(existing);
    }
    this.#storage.saveWorkspace(workspace, repository);
    this.#emitInvalidation();
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
    await assertValidMermaidMarkdown(inspected.content.toString("utf8"));
    const id = documentId(validated.workspaceId, inspected.path);
    const sourceLinks = await discoverDocumentSourceLinks({
      content: inspected.content,
      documentId: id,
      documentPath: inspected.path,
      workspaceRoot: workspace.root,
    });
    const existing = this.#storage.getDocument(id);
    const now = new Date().toISOString();
    const taskId = validated.taskId ?? existing?.taskId;
    const project = this.#projectForDocument(
      validated.workspaceId,
      taskId,
      validated.featureName,
      now,
    );
    const contentChanged =
      existing !== undefined && existing.contentHash !== inspected.contentHash;
    const tags =
      validated.tags === undefined
        ? (existing?.tags ?? [])
        : normalizeTags(validated.tags);
    const document: StoredDocument = {
      id,
      workspaceId: validated.workspaceId,
      projectId: project.id,
      projectName: projectDisplayName(project),
      ...(taskId === undefined ? {} : { taskId }),
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

    const changed = existing === undefined || !sameDocumentState(existing, document);
    this.#storage.saveDocument(document);
    if (changed) {
      this.#emitInvalidation();
    }
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
    await assertValidMermaidMarkdown(inspected.content.toString("utf8"));
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
    const taskId = validated.taskId ?? existing?.taskId;
    const project = this.#projectForDocument(
      validated.workspaceId,
      taskId,
      validated.featureName,
      now,
    );
    const contentChanged =
      existing !== undefined && existing.contentHash !== inspected.contentHash;
    const tags =
      validated.tags === undefined
        ? (existing?.tags ?? [])
        : normalizeTags(validated.tags);
    const document: StoredDocument = {
      id,
      workspaceId: validated.workspaceId,
      projectId: project.id,
      projectName: projectDisplayName(project),
      ...(taskId === undefined ? {} : { taskId }),
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

    const changed = existing === undefined || !sameDocumentState(existing, document);
    this.#storage.saveDocument(document);
    if (changed) {
      this.#emitInvalidation();
    }
    return presentDocument(document);
  }

  #projectForDocument(
    workspaceId: string,
    taskId: string | undefined,
    featureName: string | undefined,
    now: string,
  ): Project {
    const repository = this.#storage.getWorkspaceRepository(workspaceId);
    if (!repository) {
      throw new Error(`workspace ${workspaceId} has no repository identity`);
    }
    const taskKey = taskId ?? "";
    return this.#storage.saveProject({
      id: projectId(repository.key, taskKey),
      repositoryKey: repository.key,
      repositoryName: repository.name,
      taskKey,
      ...(featureName === undefined ? {} : { featureName }),
      createdAt: now,
      updatedAt: now,
    });
  }

  async markDocumentOpened(
    id: string,
    scope: ContentScope = {},
  ): Promise<Document> {
    return this.#updateDocument(id, (document) => ({
      ...document,
      openedRevision: document.revision,
    }), scope);
  }

  async markDocumentRead(
    id: string,
    scope: ContentScope = {},
  ): Promise<Document> {
    return this.#updateDocument(id, (document) => ({
      ...document,
      completedRevision: document.revision,
    }), scope);
  }

  async markDocumentUnread(
    id: string,
    scope: ContentScope = {},
  ): Promise<Document> {
    return this.#updateDocument(id, (document) => ({
      ...document,
      openedRevision: null,
      completedRevision: null,
    }), scope);
  }

  async setDocumentTags(
    id: string,
    tags: string[],
    scope: ContentScope = {},
  ): Promise<Document> {
    const normalized = normalizeTags(tags);
    return this.#updateDocument(id, (document) => ({
      ...document,
      tags: normalized,
    }), scope);
  }

  async archiveDocument(
    id: string,
    scope: ContentScope = {},
  ): Promise<Document> {
    return (await this.archiveDocuments([id], scope))[0]!;
  }

  async archiveDocuments(
    ids: readonly string[],
    scope: ContentScope = {},
  ): Promise<Document[]> {
    const resolvedScope = this.#resolveScope(scope);
    const documents = this.#documentsForMutation(ids, resolvedScope);
    const result = this.#storage.transaction(() => {
      for (const document of documents) {
        if (
          this.#storage.listReviewRequests(
            { documentId: document.id, status: "pending" },
            resolvedScope,
          ).length > 0
        ) {
          throw new ReviewConflictError(
            "document has a pending review request",
          );
        }
      }
      const archivedAt = new Date().toISOString();
      return documents.map(({ id }) => this.#updateDocumentResult(
        id,
        (document) => ({
          ...document,
          archivedAt: document.archivedAt ?? archivedAt,
        }),
        resolvedScope,
      ));
    });
    if (result.some(({ changed }) => changed)) {
      this.#emitInvalidation();
    }
    return result.map(({ document }) => document);
  }

  async restoreDocument(
    id: string,
    scope: ContentScope = {},
  ): Promise<Document> {
    return (await this.restoreDocuments([id], scope))[0]!;
  }

  async restoreDocuments(
    ids: readonly string[],
    scope: ContentScope = {},
  ): Promise<Document[]> {
    const resolvedScope = this.#resolveScope(scope);
    const documents = this.#documentsForMutation(ids, resolvedScope);
    const result = this.#storage.transaction(() => documents.map(({ id }) =>
      this.#updateDocumentResult(id, (document) => ({
        ...document,
        archivedAt: null,
      }), resolvedScope)
    ));
    if (result.some(({ changed }) => changed)) {
      this.#emitInvalidation();
    }
    return result.map(({ document }) => document);
  }

  async purgeDocuments(
    ids: readonly string[],
    scope: ContentScope = {},
  ): Promise<string[]> {
    const resolvedScope = this.#resolveScope(scope);
    const documents = this.#documentsForMutation(ids, resolvedScope);
    const staged = await stageManagedDocumentFiles(this.#managedRoot, documents);
    try {
      const deleted = this.#storage.deleteDocuments(
        documents.map(({ id }) => id),
      );
      if (deleted !== documents.length) {
        throw new Error("document purge was incomplete");
      }
    } catch (error) {
      await restoreStagedManagedFiles(staged);
      throw error;
    }
    await finalizeStagedManagedFiles(staged);
    this.#emitInvalidation();
    return documents.map(({ id }) => id);
  }

  async markDocumentMissing(
    id: string,
    scope: ContentScope = {},
  ): Promise<Document> {
    return this.#updateDocument(id, (document) => ({
      ...document,
      missingAt: document.missingAt ?? new Date().toISOString(),
    }), scope);
  }

  #documentsForMutation(
    ids: readonly string[],
    scope: ContentScope,
  ): StoredDocument[] {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) {
      throw new Error("document ids must contain between 1 and 500 entries");
    }
    const unique = new Set<string>();
    return ids.map((id) => {
      validateDocumentId(id);
      if (unique.has(id)) {
        throw new Error("document ids must be unique");
      }
      unique.add(id);
      const document = this.#storage.getDocument(id, scope);
      if (!document) {
        throw new Error(`unknown document ${id}`);
      }
      return document;
    });
  }

  async markDocumentPresent(
    id: string,
    scope: ContentScope = {},
  ): Promise<Document> {
    return this.#updateDocument(id, (document) => ({
      ...document,
      missingAt: null,
    }), scope);
  }

  #updateDocument(
    id: string,
    update: (document: StoredDocument) => StoredDocument,
    scope: ContentScope = {},
  ): Document {
    const result = this.#updateDocumentResult(id, update, scope);
    if (result.changed) {
      this.#emitInvalidation();
    }
    return result.document;
  }

  #updateDocumentResult(
    id: string,
    update: (document: StoredDocument) => StoredDocument,
    scope: ContentScope = {},
  ): { document: Document; changed: boolean } {
    validateDocumentId(id);
    const resolvedScope = this.#resolveScope(scope);
    const existing = this.#storage.getDocument(id, resolvedScope);
    if (!existing) {
      throw new Error(`unknown document ${id}`);
    }
    const updated = update(existing);
    if (sameDocumentState(existing, updated)) {
      return { document: presentDocument(existing), changed: false };
    }
    this.#storage.saveDocument(updated);
    return { document: presentDocument(updated), changed: true };
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
    const repositories = new Map<string, RepositoryIdentity>();
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
      repositories.set(legacyWorkspace.id, {
        key: `local:${createHash("sha256").update(root).digest("hex")}`,
        name: legacyWorkspace.name,
      });
    }

    const documents: StoredDocument[] = [];
    const projects = new Map<string, Project>();
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
      const repository = repositories.get(legacyDocument.workspaceId);
      if (!repository) {
        throw new Error(
          `workspace ${legacyDocument.workspaceId} has no repository identity`,
        );
      }
      const taskId = legacyDocument.taskId?.trim().toUpperCase();
      const taskKey = taskId ?? "";
      const resolvedProject: Project = {
        id: projectId(repository.key, taskKey),
        repositoryKey: repository.key,
        repositoryName: repository.name,
        taskKey,
        createdAt: legacyDocument.createdAt,
        updatedAt: legacyDocument.updatedAt,
      };
      projects.set(resolvedProject.id, resolvedProject);
      documents.push({
        id: legacyDocument.id,
        workspaceId: legacyDocument.workspaceId,
        projectId: resolvedProject.id,
        projectName: projectDisplayName(resolvedProject),
        ...(taskId === undefined ? {} : { taskId }),
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
        const repository = repositories.get(workspace.id);
        if (!repository) {
          throw new Error(`workspace ${workspace.id} has no repository identity`);
        }
        this.#storage.saveWorkspace(workspace, repository);
      }
      for (const project of projects.values()) {
        this.#storage.saveProject(project);
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
    !hasOnlyKeys(input, [
      "id",
      "name",
      "root",
      "artifactRoots",
      "repository",
      "repositoryName",
    ]) ||
    typeof input.id !== "string" ||
    !WORKSPACE_ID_PATTERN.test(input.id) ||
    typeof input.name !== "string" ||
    input.name.trim() === "" ||
    input.name.length > MAX_TITLE_LENGTH ||
    typeof input.root !== "string" ||
    input.root.trim() === "" ||
    !isStringArray(input.artifactRoots) ||
    input.artifactRoots.length === 0 ||
    input.artifactRoots.some((path) => path.trim() === "") ||
    (input.repository !== undefined &&
      (typeof input.repository !== "string" ||
        input.repository.trim() === "" ||
        input.repository.length > MAX_REPOSITORY_LENGTH)) ||
    (input.repositoryName !== undefined &&
      (typeof input.repositoryName !== "string" ||
        input.repositoryName.trim() === "" ||
        input.repositoryName.length > MAX_CONTEXT_LENGTH))
  ) {
    throw new Error("invalid workspace input");
  }
}

function normalizeSpaceInput(input: CreateSpaceInput): Space {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["id", "name", "matchers"]) ||
    typeof input.id !== "string"
  ) {
    throw new Error("invalid Space input");
  }
  validateSpaceId(input.id);
  return {
    id: input.id,
    name: normalizeSpaceName(input.name),
    matchers: normalizeSpaceMatchers(input.matchers),
  };
}

function validateSpaceId(id: string): void {
  if (typeof id !== "string" || !WORKSPACE_ID_PATTERN.test(id)) {
    throw new Error("invalid Space id");
  }
}

function normalizeSpaceName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("invalid Space name");
  }
  const name = value.trim();
  if (
    name === "" ||
    name.length > MAX_CONTEXT_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new Error("invalid Space name");
  }
  return name;
}

function sameSpaceMatchers(
  left: readonly SpaceMatcher[],
  right: readonly SpaceMatcher[],
): boolean {
  return left.length === right.length && left.every((matcher, index) =>
    matcher.kind === right[index]?.kind && matcher.value === right[index]?.value
  );
}

function sameWorkspace(left: Workspace, right: Workspace): boolean {
  return left.id === right.id &&
    left.name === right.name &&
    left.root === right.root &&
    left.artifactRoots.length === right.artifactRoots.length &&
    left.artifactRoots.every((root, index) => root === right.artifactRoots[index]);
}

function sameDocumentState(
  left: StoredDocument,
  right: StoredDocument,
): boolean {
  const { updatedAt: _leftUpdatedAt, ...leftState } = left;
  const { updatedAt: _rightUpdatedAt, ...rightState } = right;
  return JSON.stringify(leftState) === JSON.stringify(rightState);
}

function normalizeSpaceMatchers(value: unknown): SpaceMatcher[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_SPACE_MATCHERS
  ) {
    throw new Error(
      `a Space requires at least one matcher and at most ${MAX_SPACE_MATCHERS}`,
    );
  }
  const normalized = value.map((candidate): SpaceMatcher => {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ["kind", "value"]) ||
      typeof candidate.kind !== "string" ||
      typeof candidate.value !== "string"
    ) {
      throw new Error("invalid Space matcher");
    }
    if (
      candidate.kind !== "repository" &&
      candidate.kind !== "repository-namespace" &&
      candidate.kind !== "tag"
    ) {
      throw new Error(`unknown Space matcher kind ${candidate.kind}`);
    }
    if (candidate.kind === "tag") {
      return { kind: "tag", value: normalizeTags([candidate.value])[0]! };
    }
    return {
      kind: candidate.kind,
      value: normalizeSpaceRepositoryMatcher(
        candidate.value,
        candidate.kind === "repository-namespace",
      ),
    };
  });
  const unique = new Map<string, SpaceMatcher>();
  for (const matcher of normalized) {
    unique.set(`${matcher.kind}\0${matcher.value}`, matcher);
  }
  return [...unique.values()].sort(compareSpaceMatchers);
}

function normalizeSpaceRepositoryMatcher(
  value: string,
  namespace: boolean,
): string {
  const trimmed = value.trim().toLowerCase();
  if (/^local:[a-f0-9]{64}$/.test(trimmed)) {
    if (namespace) {
      throw new Error("repository namespace cannot use a local repository key");
    }
    return trimmed;
  }
  const key = normalizeRepositoryKey(value);
  if (key.split("/").filter(Boolean).length < 2) {
    throw new Error(
      namespace
        ? "repository namespace must include host and owner"
        : "invalid repository matcher",
    );
  }
  return key;
}

function compareSpaceMatchers(left: SpaceMatcher, right: SpaceMatcher): number {
  return compareText(left.kind, right.kind) || compareText(left.value, right.value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
      "featureName",
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
    (input.featureName !== undefined &&
      (typeof input.featureName !== "string" ||
        input.featureName.trim() === "" ||
        input.featureName.length > MAX_FEATURE_NAME_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(input.featureName))) ||
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
    ...(input.taskId === undefined
      ? {}
      : { taskId: input.taskId.trim().toUpperCase() }),
    ...(input.featureName === undefined
      ? {}
      : { featureName: input.featureName.trim() }),
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

function validateReviewRequestFilters(
  filters: ReviewRequestFilters,
): ReviewRequestFilters {
  if (
    !isRecord(filters) ||
    !hasOnlyKeys(filters, ["documentId", "status"]) ||
    (filters.documentId !== undefined &&
      (typeof filters.documentId !== "string" ||
        !/^doc-[a-f0-9]{20}$/.test(filters.documentId))) ||
    (filters.status !== undefined &&
      (typeof filters.status !== "string" ||
        !isReviewStatus(filters.status)))
  ) {
    throw new Error("invalid review request filters");
  }
  return { ...filters };
}

function validateCreateReviewRequestInput(
  input: CreateReviewRequestInput,
): CreateReviewRequestInput {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, [
      "documentId",
      "documentRevision",
      "kind",
      "requestMessage",
    ]) ||
    typeof input.documentId !== "string" ||
    !/^doc-[a-f0-9]{20}$/.test(input.documentId) ||
    (input.documentRevision !== undefined &&
      (!Number.isSafeInteger(input.documentRevision) ||
        input.documentRevision <= 0)) ||
    typeof input.kind !== "string" ||
    !isReviewKind(input.kind) ||
    typeof input.requestMessage !== "string"
  ) {
    throw new Error("invalid review request input");
  }
  return {
    documentId: input.documentId,
    ...(input.documentRevision === undefined
      ? {}
      : { documentRevision: input.documentRevision }),
    kind: input.kind,
    requestMessage: normalizeReviewMessage(input.requestMessage),
  };
}

function validateRespondToReviewRequestInput(
  input: RespondToReviewRequestInput,
): RespondToReviewRequestInput {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["outcome", "message", "items"]) ||
    typeof input.outcome !== "string" ||
    !isReviewOutcome(input.outcome) ||
    typeof input.message !== "string"
  ) {
    throw new Error("invalid review response input");
  }
  const message = normalizeReviewMessage(input.message);
  const items = validateReviewFeedbackItems(input.items);
  if (
    input.outcome === "changes_requested" &&
    message.trim() === "" &&
    items.length === 0
  ) {
    throw new Error(
      "response message or anchored feedback is required for requested changes",
    );
  }
  if (
    items.length > 0 &&
    input.outcome !== "changes_requested" &&
    input.outcome !== "approved"
  ) {
    throw new Error(
      "feedback items require an approved or changes_requested outcome",
    );
  }
  return {
    outcome: input.outcome,
    message,
    ...(items.length === 0 ? {} : { items }),
  };
}

function validateReviewFeedbackItems(value: unknown): ReviewFeedbackItem[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_REVIEW_FEEDBACK_ITEMS) {
    throw new Error("invalid review feedback items");
  }
  return value.map((item) => {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, [
        "id",
        "kind",
        "path",
        "hunkId",
        "line",
        "endLine",
        "side",
        "message",
      ]) ||
      typeof item.id !== "string" ||
      !/^feedback-[a-f0-9]{20}$/.test(item.id) ||
      (item.kind !== "feedback" && item.kind !== "todo") ||
      typeof item.path !== "string" ||
      !isSafeReviewPath(item.path) ||
      typeof item.message !== "string" ||
      item.message.trim() === "" ||
      item.message.length > MAX_REVIEW_FEEDBACK_MESSAGE_LENGTH ||
      (item.hunkId !== undefined &&
        (typeof item.hunkId !== "string" ||
          !/^hunk-[a-f0-9]{20}$/.test(item.hunkId))) ||
      (item.line !== undefined &&
        (typeof item.line !== "number" ||
          !Number.isSafeInteger(item.line) ||
          item.line <= 0)) ||
      (item.endLine !== undefined &&
        (typeof item.endLine !== "number" ||
          !Number.isSafeInteger(item.endLine) ||
          item.endLine <= 0)) ||
      (item.side !== undefined && item.side !== "old" && item.side !== "new") ||
      ((item.line === undefined) !== (item.side === undefined)) ||
      (item.endLine !== undefined &&
        (item.line === undefined || item.endLine <= item.line)) ||
      (item.line !== undefined && item.hunkId === undefined) ||
      (item.kind === "todo" &&
        (item.hunkId !== undefined ||
          item.line !== undefined ||
          item.endLine !== undefined ||
          item.side !== undefined))
    ) {
      throw new Error("invalid review feedback item");
    }
    const message = normalizeReviewMessage(item.message);
    const hunkId = item.hunkId;
    const line = item.line;
    const endLine = item.endLine;
    const side = item.side;
    return {
      id: item.id,
      kind: item.kind,
      path: item.path,
      ...(typeof hunkId === "string" ? { hunkId } : {}),
      ...(typeof line === "number" ? { line } : {}),
      ...(typeof endLine === "number" ? { endLine } : {}),
      ...(side === "old" || side === "new" ? { side } : {}),
      message,
    };
  });
}

function isSafeReviewPath(value: string): boolean {
  if (
    value === "" ||
    value.length > MAX_REVIEW_FEEDBACK_PATH_LENGTH ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  return value
    .replaceAll("\\", "/")
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function sameReviewResponse(
  response: ReviewResponse,
  input: RespondToReviewRequestInput,
): boolean {
  return response.outcome === input.outcome &&
    response.message === input.message &&
    JSON.stringify(response.items ?? []) === JSON.stringify(input.items ?? []);
}

function normalizeReviewMessage(value: string): string {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (
    normalized.length > MAX_REVIEW_MESSAGE_LENGTH ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error(
      `review messages must contain at most ${MAX_REVIEW_MESSAGE_LENGTH} safe characters`,
    );
  }
  return normalized;
}

function validateReviewRequestId(id: string): void {
  if (typeof id !== "string" || !/^review-[a-f0-9]{20}$/.test(id)) {
    throw new Error("invalid review request id");
  }
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

function sameReconciliationVersion(
  current: StoredDocument,
  initial: StoredDocument,
): boolean {
  return (
    current.id === initial.id &&
    current.workspaceId === initial.workspaceId &&
    current.storage === initial.storage &&
    current.path === initial.path &&
    current.contentHash === initial.contentHash &&
    current.revision === initial.revision &&
    current.missingAt === initial.missingAt &&
    current.updatedAt === initial.updatedAt
  );
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

function assertSvgDocument(content: Buffer): void {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new LinkedSourceUnavailableError(
      "linked document media must contain UTF-8 SVG",
    );
  }
  if (
    !/^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(source) ||
    !/<\/svg>\s*$/i.test(source)
  ) {
    throw new LinkedSourceUnavailableError(
      "linked document media must contain a complete SVG document",
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

interface StagedManagedFile {
  directory: string;
  originalPath: string;
  stagedPath: string;
}

async function stageManagedDocumentFiles(
  managedRoot: string,
  documents: readonly StoredDocument[],
): Promise<StagedManagedFile[]> {
  const managed = documents.filter(({ storage }) => storage === "managed");
  if (managed.length === 0) {
    return [];
  }
  const canonicalRoot = await authorizedManagedRoot(managedRoot);
  const staged: StagedManagedFile[] = [];
  try {
    const documentsByDirectory = new Map<string, Set<string>>();
    for (const document of managed) {
      const directory = await authorizedManagedDirectory(
        canonicalRoot,
        dirname(document.path),
      );
      const ids = documentsByDirectory.get(directory) ?? new Set<string>();
      ids.add(document.id);
      documentsByDirectory.set(directory, ids);
    }
    for (const [directory, ids] of documentsByDirectory) {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const match = /^(doc-[a-f0-9]{20})-[a-f0-9]{64}\.md$/.exec(
          entry.name,
        );
        if (!match || !ids.has(match[1]!)) {
          continue;
        }
        const originalPath = join(directory, entry.name);
        const info = await lstat(originalPath);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new Error("managed document path must be a regular, non-symlink file");
        }
        const stagedPath = join(
          directory,
          `.${entry.name}.${randomUUID()}.purging`,
        );
        await rename(originalPath, stagedPath);
        staged.push({ directory, originalPath, stagedPath });
      }
      await syncDirectory(directory);
    }
    return staged;
  } catch (error) {
    await restoreStagedManagedFiles(staged);
    throw error;
  }
}

async function restoreStagedManagedFiles(
  staged: readonly StagedManagedFile[],
): Promise<void> {
  const directories = new Set<string>();
  for (const file of [...staged].reverse()) {
    await rename(file.stagedPath, file.originalPath);
    directories.add(file.directory);
  }
  for (const directory of directories) {
    await syncDirectory(directory);
  }
}

async function finalizeStagedManagedFiles(
  staged: readonly StagedManagedFile[],
): Promise<void> {
  const directories = new Set<string>();
  await Promise.all(staged.map(async (file) => {
    directories.add(file.directory);
    try {
      await rm(file.stagedPath, { force: true });
    } catch {
      // A private purge marker is retried when the catalog next opens.
    }
  }));
  for (const directory of directories) {
    try {
      await syncDirectory(directory);
    } catch {
      // The committed purge remains successful; recovery removes any marker.
    }
  }
}

async function recoverManagedPurges(
  managedRoot: string,
  storage: CatalogStorage,
): Promise<void> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await authorizedManagedRoot(managedRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const workspaces = await readdir(canonicalRoot, { withFileTypes: true });
  for (const workspace of workspaces) {
    if (!workspace.isDirectory() || workspace.isSymbolicLink()) {
      continue;
    }
    const directory = await authorizedManagedDirectory(
      canonicalRoot,
      join(canonicalRoot, workspace.name),
    );
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const match = /^\.(doc-[a-f0-9]{20})-[a-f0-9]{64}\.md\.[0-9a-f-]+\.purging$/.exec(
        entry.name,
      );
      if (!match || !entry.isFile() || entry.isSymbolicLink()) {
        continue;
      }
      const stagedPath = join(directory, entry.name);
      const suffix = entry.name.slice(1, entry.name.lastIndexOf("."));
      const originalName = suffix.slice(0, suffix.lastIndexOf("."));
      const originalPath = join(directory, originalName);
      const document = storage.getDocument(match[1]!);
      const documentDirectory = document?.storage === "managed"
        ? await authorizedManagedDirectory(
            canonicalRoot,
            dirname(document.path),
          )
        : undefined;
      if (
        document?.storage === "managed" &&
        documentDirectory === directory
      ) {
        try {
          await lstat(originalPath);
          await rm(stagedPath, { force: true });
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") {
            throw error;
          }
          await rename(stagedPath, originalPath);
        }
      } else {
        await rm(stagedPath, { force: true });
      }
    }
    await syncDirectory(directory);
  }
}

async function authorizedManagedRoot(managedRoot: string): Promise<string> {
  const info = await lstat(managedRoot);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("managed document storage must be a non-symlink directory");
  }
  return realpath(managedRoot);
}

async function authorizedManagedDirectory(
  canonicalRoot: string,
  directory: string,
): Promise<string> {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("managed document directory must be a non-symlink directory");
  }
  const canonicalDirectory = await realpath(directory);
  if (!isWithin(canonicalRoot, canonicalDirectory)) {
    throw new Error("managed document is outside private storage");
  }
  return canonicalDirectory;
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

function projectId(repositoryKey: string, taskKey: string): string {
  const hash = createHash("sha256")
    .update(repositoryKey)
    .update("\0")
    .update(taskKey)
    .digest("hex")
    .slice(0, 20);
  return `project-${hash}`;
}

function repositoryIdentity(
  input: AddWorkspaceInput,
  canonicalRoot: string,
): RepositoryIdentity {
  const key = input.repository === undefined
    ? `local:${createHash("sha256").update(canonicalRoot).digest("hex")}`
    : normalizeRepositoryKey(input.repository);
  const name = input.repositoryName?.trim() ??
    (input.repository === undefined
      ? input.name.trim()
      : repositoryNameFromKey(key));
  if (
    name === "" ||
    name.length > MAX_CONTEXT_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new Error("invalid repository name");
  }
  return { key, name };
}

function normalizeRepositoryKey(input: string): string {
  const trimmed = input.trim();
  if (
    trimmed === "" ||
    trimmed.length > MAX_REPOSITORY_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    throw new Error("invalid repository identity");
  }

  let value = trimmed;
  const scp = value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp && !value.includes("://")) {
    value = `${scp[1]}/${scp[2]}`;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("invalid repository identity");
    }
    if (parsed.hostname === "" || parsed.pathname === "") {
      throw new Error("invalid repository identity");
    }
    value = `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
  }

  value = value.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (
    value === "" ||
    value.includes("@") ||
    value.includes("?") ||
    value.includes("#") ||
    !/^[A-Za-z0-9._:/-]+$/.test(value)
  ) {
    throw new Error("invalid repository identity");
  }
  return value.toLowerCase();
}

function repositoryNameFromKey(key: string): string {
  const name = key.split("/").at(-1)?.replace(/\.git$/i, "").trim();
  if (!name) {
    throw new Error("repository identity has no name");
  }
  return name;
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
