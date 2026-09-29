import {
  ATTENTION_STATES,
  DOCUMENT_KINDS,
  REVIEW_KINDS,
  REVIEW_OUTCOMES,
  REVIEW_STATUSES,
} from "./domain.js";
import type { ContentScope } from "./domain.js";
import type {
  BulkDocumentResult,
  DocumentAction,
  DocumentImport,
  DocumentRegistration,
  HealthData,
  PublicDocument,
  PublicProject,
  PublicRepository,
  PublicReviewRequest,
  PublicSpace,
  PublicSpaceMatcher,
  PublicWorkspace,
  PublicWorkspaceReconciliation,
  RenderTarget,
  TerminalRenderPreferences,
  TerminalRender,
  WebRender,
  ReviewRequestRegistration,
  ReviewRequestResponse,
  ReviewStatus,
  WorkspaceRegistration,
  WorkspaceReconciliationRequest,
} from "./api-types.js";
import { isChangeReviewDiff } from "./change-review.js";
import type { MermaidValidationReport } from "./mermaid-validation.js";

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    validation?: MermaidValidationReport;
  };
}

export class DeskApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly validation?: MermaidValidationReport,
  ) {
    super(message);
    this.name = "DeskApiError";
  }
}

export class DaemonHealthCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonHealthCompatibilityError";
  }
}

/** @deprecated Catalog invalidations now arrive as an empty object. */
export interface CatalogEvent {
  action?: string;
  documentId?: string;
  revision?: number;
  reviewRequestId?: string;
  workspaceId?: string;
}

export interface CatalogSubscriptionOptions {
  signal?: AbortSignal;
  onReady?: () => void;
}

export class DeskApiClient {
  readonly #baseUrl: string;
  readonly #token: string;

  constructor(baseUrl: string, token: string) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("daemon URL must use HTTP or HTTPS");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("daemon URL must not contain credentials, query, or fragment");
    }
    if (typeof token !== "string" || token.length < 8) {
      throw new Error("daemon token must contain at least 8 characters");
    }
    this.#baseUrl = parsed.href.replace(/\/$/, "");
    this.#token = token;
  }

  async health(signal?: AbortSignal): Promise<HealthData> {
    const value = await this.#request("/api/v1/health", {
      authenticated: false,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!isCoreHealth(value)) {
      throw new Error("Daemon returned an invalid health response");
    }
    if (
      value.capabilities !== undefined &&
      (!Array.isArray(value.capabilities) ||
        !value.capabilities.every((capability) => typeof capability === "string"))
    ) {
      throw new DaemonHealthCompatibilityError(
        "The running mdmaid.desk daemon has incompatible capabilities; restart it after upgrading",
      );
    }
    return {
      service: "mdmaid.desk",
      status: "ok",
      version: value.version,
      ...(value.capabilities === undefined
        ? {}
        : { capabilities: [...new Set(value.capabilities as string[])] }),
    };
  }

  async requireCapabilities(...required: string[]): Promise<void> {
    const health = await this.health();
    const capabilities = new Set(health.capabilities ?? []);
    const missing = required.filter((capability) => !capabilities.has(capability));
    if (missing.length > 0) {
      throw new DaemonHealthCompatibilityError(
        `The running mdmaid.desk daemon does not support ${missing.join(", ")}; restart it after upgrading`,
      );
    }
  }

  async listDocuments(
    scope: ContentScope = {},
    filters: { archived?: boolean } = {},
  ): Promise<PublicDocument[]> {
    const query = new URLSearchParams();
    if (scope.spaceId !== undefined) {
      assertSpaceId(scope.spaceId);
      query.set("space", scope.spaceId);
    }
    if (filters.archived === true) {
      query.set("archived", "true");
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const value = await this.#request(`/api/v1/documents${suffix}`);
    if (!Array.isArray(value) || !value.every(isPublicDocument)) {
      throw new Error("Daemon returned an invalid document list");
    }
    return value;
  }

  async listWorkspaces(scope: ContentScope = {}): Promise<PublicWorkspace[]> {
    const value = await this.#request(withScope("/api/v1/workspaces", scope));
    if (!Array.isArray(value) || !value.every(isPublicWorkspace)) {
      throw new Error("Daemon returned an invalid workspace list");
    }
    return value;
  }

  async listProjects(scope: ContentScope = {}): Promise<PublicProject[]> {
    const value = await this.#request(withScope("/api/v1/projects", scope));
    if (!Array.isArray(value) || !value.every(isPublicProject)) {
      throw new Error("Daemon returned an invalid project list");
    }
    return value;
  }

  async listSpaces(): Promise<PublicSpace[]> {
    const value = await this.#request("/api/v1/spaces");
    if (!Array.isArray(value) || !value.every(isPublicSpace)) {
      throw new Error("Daemon returned an invalid Space list");
    }
    return value;
  }

  async getSpace(id: string): Promise<PublicSpace> {
    assertSpaceId(id);
    const value = await this.#request(`/api/v1/spaces/${encodeURIComponent(id)}`);
    if (!isPublicSpace(value)) {
      throw new Error("Daemon returned an invalid Space");
    }
    return value;
  }

  async createSpace(input: PublicSpace): Promise<PublicSpace> {
    const value = await this.#request("/api/v1/spaces", {
      method: "POST",
      body: input,
    });
    if (!isPublicSpace(value)) {
      throw new Error("Daemon returned an invalid Space");
    }
    return value;
  }

  async renameSpace(id: string, name: string): Promise<PublicSpace> {
    assertSpaceId(id);
    const value = await this.#request(`/api/v1/spaces/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { name },
    });
    if (!isPublicSpace(value)) {
      throw new Error("Daemon returned an invalid Space");
    }
    return value;
  }

  async replaceSpaceMatchers(
    id: string,
    matchers: PublicSpaceMatcher[],
  ): Promise<PublicSpace> {
    assertSpaceId(id);
    const value = await this.#request(
      `/api/v1/spaces/${encodeURIComponent(id)}/matchers`,
      { method: "PUT", body: { matchers } },
    );
    if (!isPublicSpace(value)) {
      throw new Error("Daemon returned an invalid Space");
    }
    return value;
  }

  async deleteSpace(id: string): Promise<{ id: string }> {
    assertSpaceId(id);
    const value = await this.#request(`/api/v1/spaces/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!isRecord(value) || Object.keys(value).length !== 1 || value.id !== id) {
      throw new Error("Daemon returned an invalid Space deletion response");
    }
    return { id };
  }

  async listRepositories(): Promise<PublicRepository[]> {
    const value = await this.#request("/api/v1/repositories");
    if (!Array.isArray(value) || !value.every(isPublicRepository)) {
      throw new Error("Daemon returned an invalid repository list");
    }
    return value;
  }

  async addWorkspace(input: WorkspaceRegistration): Promise<PublicWorkspace> {
    const value = await this.#request("/api/v1/workspaces", {
      method: "POST",
      body: input,
    });
    if (!isPublicWorkspace(value)) {
      throw new Error("Daemon returned an invalid workspace response");
    }
    return value;
  }

  async reconcileWorkspace(
    sourceWorkspaceId: string,
    input: WorkspaceReconciliationRequest,
  ): Promise<PublicWorkspaceReconciliation> {
    assertWorkspaceId(sourceWorkspaceId);
    const value = await this.#request(
      `/api/v1/workspaces/${encodeURIComponent(sourceWorkspaceId)}/reconcile`,
      { method: "POST", body: input },
    );
    if (!isPublicWorkspaceReconciliation(value)) {
      throw new Error("Daemon returned an invalid workspace reconciliation");
    }
    return value;
  }

  async registerDocument(input: DocumentRegistration): Promise<PublicDocument> {
    const value = await this.#request("/api/v1/documents", {
      method: "POST",
      body: input,
    });
    if (!isPublicDocument(value)) {
      throw new Error("Daemon returned an invalid document response");
    }
    return value;
  }

  async importDocument(input: DocumentImport): Promise<PublicDocument> {
    const value = await this.#request("/api/v1/imports", {
      method: "POST",
      body: input,
    });
    if (!isPublicDocument(value)) {
      throw new Error("Daemon returned an invalid document response");
    }
    return value;
  }

  async listReviewRequests(
    filters: { documentId?: string; status?: ReviewStatus } = {},
    scope: ContentScope = {},
  ): Promise<PublicReviewRequest[]> {
    const query = new URLSearchParams();
    if (filters.documentId !== undefined) {
      assertDocumentId(filters.documentId);
      query.set("document", filters.documentId);
    }
    if (filters.status !== undefined) {
      if (!(REVIEW_STATUSES as readonly string[]).includes(filters.status)) {
        throw new Error("unknown review status");
      }
      query.set("status", filters.status);
    }
    addScope(query, scope);
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const value = await this.#request(`/api/v1/review-requests${suffix}`);
    if (!Array.isArray(value) || !value.every(isPublicReviewRequest)) {
      throw new Error("Daemon returned an invalid review request list");
    }
    return value;
  }

  async getReviewRequest(
    id: string,
    scope: ContentScope = {},
  ): Promise<PublicReviewRequest> {
    assertReviewRequestId(id);
    const value = await this.#request(
      withScope(`/api/v1/review-requests/${encodeURIComponent(id)}`, scope),
    );
    if (!isPublicReviewRequest(value)) {
      throw new Error("Daemon returned an invalid review request");
    }
    return value;
  }

  async createReviewRequest(
    input: ReviewRequestRegistration,
    scope: ContentScope = {},
  ): Promise<PublicReviewRequest> {
    const value = await this.#request(withScope("/api/v1/review-requests", scope), {
      method: "POST",
      body: input,
    });
    if (!isPublicReviewRequest(value)) {
      throw new Error("Daemon returned an invalid review request");
    }
    return value;
  }

  async respondToReviewRequest(
    id: string,
    input: ReviewRequestResponse,
    scope: ContentScope = {},
  ): Promise<PublicReviewRequest> {
    assertReviewRequestId(id);
    const value = await this.#request(
      withScope(
        `/api/v1/review-requests/${encodeURIComponent(id)}/respond`,
        scope,
      ),
      { method: "POST", body: input },
    );
    if (!isPublicReviewRequest(value)) {
      throw new Error("Daemon returned an invalid review request");
    }
    return value;
  }

  async renderDocument(
    id: string,
    target: "terminal",
    width?: number,
    preferences?: TerminalRenderPreferences,
    scope?: ContentScope,
  ): Promise<TerminalRender>;
  async renderDocument(
    id: string,
    target: "web",
    width?: number,
    preferences?: undefined,
    scope?: ContentScope,
  ): Promise<WebRender>;
  async renderDocument(
    id: string,
    target: RenderTarget,
    width = 100,
    preferences: TerminalRenderPreferences = {},
    scope: ContentScope = {},
  ): Promise<TerminalRender | WebRender> {
    assertDocumentId(id);
    if (!Number.isSafeInteger(width) || width < 20 || width > 1_000) {
      throw new Error("render width must be an integer between 20 and 1000");
    }
    const query = new URLSearchParams({ target });
    if (target === "terminal") {
      query.set("width", String(width));
      if (preferences.color !== undefined) {
        query.set("color", String(preferences.color));
      }
      if (preferences.unicode !== undefined) {
        query.set("unicode", String(preferences.unicode));
      }
    }
    addScope(query, scope);
    const value = await this.#request(
      `/api/v1/documents/${encodeURIComponent(id)}/render?${query.toString()}`,
    );
    if (target === "terminal" && isTerminalRender(value)) {
      return value;
    }
    if (target === "web" && isWebRender(value)) {
      return value;
    }
    throw new Error("Daemon returned an invalid render response");
  }

  async act(
    id: string,
    action: DocumentAction,
    scope: ContentScope = {},
  ): Promise<PublicDocument> {
    assertDocumentId(id);
    const value = await this.#request(
      withScope(`/api/v1/documents/${encodeURIComponent(id)}/${action}`, scope),
      { method: "POST" },
    );
    if (!isPublicDocument(value)) {
      throw new Error("Daemon returned an invalid document response");
    }
    return value;
  }

  async bulkAct(
    action: "archive" | "restore",
    ids: string[],
    scope?: ContentScope,
  ): Promise<Extract<BulkDocumentResult, { documents: PublicDocument[] }>>;
  async bulkAct(
    action: "purge",
    ids: string[],
    scope?: ContentScope,
  ): Promise<Extract<BulkDocumentResult, { action: "purge" }>>;
  async bulkAct(
    action: "archive" | "restore" | "purge",
    ids: string[],
    scope: ContentScope = {},
  ): Promise<BulkDocumentResult> {
    assertDocumentIds(ids);
    const value = await this.#request(
      withScope("/api/v1/documents/bulk", scope),
      { method: "POST", body: { action, ids } },
    );
    if (!isBulkDocumentResult(value, action)) {
      throw new Error("Daemon returned an invalid bulk document response");
    }
    return value;
  }

  async purgeDocument(
    id: string,
    scope: ContentScope = {},
  ): Promise<string> {
    assertDocumentId(id);
    const value = await this.#request(
      withScope(`/api/v1/documents/${encodeURIComponent(id)}/purge`, scope),
      { method: "POST" },
    );
    if (!isRecord(value) || value.purgedId !== id) {
      throw new Error("Daemon returned an invalid purge response");
    }
    return value.purgedId;
  }

  async getDocument(
    id: string,
    scope: ContentScope = {},
  ): Promise<PublicDocument> {
    assertDocumentId(id);
    const value = await this.#request(
      withScope(`/api/v1/documents/${encodeURIComponent(id)}`, scope),
    );
    if (!isPublicDocument(value)) {
      throw new Error("Daemon returned an invalid document response");
    }
    return value;
  }

  async setDocumentTags(
    id: string,
    tags: string[],
    scope: ContentScope = {},
  ): Promise<PublicDocument> {
    assertDocumentId(id);
    const value = await this.#request(
      withScope(`/api/v1/documents/${encodeURIComponent(id)}/tags`, scope),
      { method: "PUT", body: { tags } },
    );
    if (!isPublicDocument(value)) {
      throw new Error("Daemon returned an invalid document response");
    }
    return value;
  }

  async subscribeCatalog(
    listener: (event: CatalogEvent) => void,
    options: CatalogSubscriptionOptions = {},
  ): Promise<void> {
    try {
      const response = await fetch(`${this.#baseUrl}/api/v1/events`, {
        headers: { authorization: `Bearer ${this.#token}` },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!response.ok) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new Error(`Daemon event stream failed (${response.status})`);
        }
        if (isErrorEnvelope(body)) {
          throw new Error(body.error.message);
        }
        throw new Error(`Daemon event stream failed (${response.status})`);
      }
      if (!response.body) {
        throw new Error("Daemon returned an empty event stream");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          dispatchEventBlock(block, listener, options.onReady);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (options.signal?.aborted) {
        return;
      }
      throw error;
    }
  }

  async #request(
    path: string,
    options: {
      authenticated?: boolean;
      body?: unknown;
      method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      signal?: AbortSignal;
    } = {},
  ): Promise<unknown> {
    const authenticated = options.authenticated ?? true;
    const headers: Record<string, string> = {};
    if (authenticated) {
      headers.authorization = `Bearer ${this.#token}`;
    }
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: options.method ?? "GET",
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Daemon returned a non-JSON response (${response.status})`);
    }
    if (!response.ok) {
      if (isErrorEnvelope(body)) {
        throw new DeskApiError(
          response.status,
          body.error.code,
          body.error.message,
          body.error.validation,
        );
      }
      throw new Error(`Daemon request failed (${response.status})`);
    }
    if (!isRecord(body) || !("data" in body)) {
      throw new Error("Daemon returned an invalid response envelope");
    }
    return body.data;
  }
}

function isCoreHealth(
  value: unknown,
): value is Omit<HealthData, "capabilities"> & { capabilities?: unknown } {
  return (
    isRecord(value) &&
    value.service === "mdmaid.desk" &&
    value.status === "ok" &&
    typeof value.version === "number"
  );
}

function isPublicSpaceMatcher(value: unknown): value is PublicSpaceMatcher {
  return isRecord(value) &&
    Object.keys(value).length === 2 &&
    (value.kind === "repository" ||
      value.kind === "repository-namespace" ||
      value.kind === "tag") &&
    typeof value.value === "string";
}

function isPublicSpace(value: unknown): value is PublicSpace {
  return isRecord(value) &&
    Object.keys(value).length === 3 &&
    typeof value.id === "string" &&
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id) &&
    typeof value.name === "string" &&
    Array.isArray(value.matchers) &&
    value.matchers.length > 0 &&
    value.matchers.every(isPublicSpaceMatcher);
}

function isPublicRepository(value: unknown): value is PublicRepository {
  return isRecord(value) &&
    Object.keys(value).length === 4 &&
    typeof value.key === "string" &&
    typeof value.name === "string" &&
    Array.isArray(value.workspaceIds) &&
    value.workspaceIds.every((id) => typeof id === "string") &&
    (value.kind === "remote" || value.kind === "local");
}

function isPublicWorkspace(value: unknown): value is PublicWorkspace {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.documentCount === "number" &&
    typeof value.route === "string"
  );
}

function isPublicWorkspaceReconciliation(
  value: unknown,
): value is PublicWorkspaceReconciliation {
  return isRecord(value) &&
    Object.keys(value).length === 7 &&
    typeof value.sourceWorkspaceId === "string" &&
    typeof value.targetWorkspaceId === "string" &&
    typeof value.applied === "boolean" &&
    Array.isArray(value.movedDocumentIds) &&
    value.movedDocumentIds.every((id) => typeof id === "string") &&
    Array.isArray(value.discardedDocumentIds) &&
    value.discardedDocumentIds.every((id) => typeof id === "string") &&
    Array.isArray(value.blockingConflicts) &&
    value.blockingConflicts.every(isPublicWorkspaceReconciliationConflict) &&
    typeof value.reviewRequestCount === "number" &&
    Number.isSafeInteger(value.reviewRequestCount) &&
    value.reviewRequestCount >= 0;
}

function isPublicWorkspaceReconciliationConflict(value: unknown): boolean {
  return isRecord(value) &&
    Object.keys(value).length === 3 &&
    typeof value.sourceDocumentId === "string" &&
    typeof value.targetDocumentId === "string" &&
    (value.reason === "path-conflict" || value.reason === "review-history");
}

function isPublicProject(value: unknown): value is PublicProject {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    /^project-[a-f0-9]{20}$/.test(value.id) &&
    typeof value.name === "string" &&
    typeof value.documentCount === "number" &&
    Number.isSafeInteger(value.documentCount) &&
    value.documentCount >= 0 &&
    typeof value.route === "string"
  );
}

function isPublicDocument(value: unknown): value is PublicDocument {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.workspaceId === "string" &&
    optionalString(value.projectId) &&
    optionalString(value.projectName) &&
    optionalString(value.taskId) &&
    optionalString(value.producer) &&
    typeof value.kind === "string" &&
    (DOCUMENT_KINDS as readonly string[]).includes(value.kind) &&
    typeof value.title === "string" &&
    (value.storage === "reference" || value.storage === "managed") &&
    typeof value.attention === "string" &&
    (ATTENTION_STATES as readonly string[]).includes(value.attention) &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === "string") &&
    isInteger(value.revision) &&
    nullableInteger(value.openedRevision) &&
    nullableInteger(value.completedRevision) &&
    (value.status === "unread" ||
      value.status === "reading" ||
      value.status === "done") &&
    nullableString(value.archivedAt) &&
    nullableString(value.missingAt) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.route === "string"
  );
}

function isBulkDocumentResult(
  value: unknown,
  action: "archive" | "restore" | "purge",
): value is BulkDocumentResult {
  if (!isRecord(value) || value.action !== action) {
    return false;
  }
  return action === "purge"
    ? Array.isArray(value.purgedIds) &&
        value.purgedIds.every((id) => typeof id === "string" && isDocumentId(id))
    : Array.isArray(value.documents) && value.documents.every(isPublicDocument);
}

export function isPublicReviewRequest(value: unknown): value is PublicReviewRequest {
  if (!isRecord(value)) {
    return false;
  }
  const validResponse =
    value.response === null ||
    (isRecord(value.response) &&
      typeof value.response.outcome === "string" &&
      (REVIEW_OUTCOMES as readonly string[]).includes(value.response.outcome) &&
      typeof value.response.message === "string" &&
      (value.response.items === undefined ||
        (Array.isArray(value.response.items) &&
          value.response.items.every(isReviewFeedbackItem))) &&
      typeof value.response.createdAt === "string");
  return (
    typeof value.id === "string" &&
    /^review-[a-f0-9]{20}$/.test(value.id) &&
    typeof value.documentId === "string" &&
    /^doc-[a-f0-9]{20}$/.test(value.documentId) &&
    isInteger(value.documentRevision) &&
    typeof value.kind === "string" &&
    (REVIEW_KINDS as readonly string[]).includes(value.kind) &&
    typeof value.requestMessage === "string" &&
    typeof value.status === "string" &&
    (REVIEW_STATUSES as readonly string[]).includes(value.status) &&
    validResponse &&
    nullableString(value.staleAt) &&
    typeof value.createdAt === "string"
  );
}

function isReviewFeedbackItem(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.path !== "string" ||
    typeof value.message !== "string"
  ) {
    return false;
  }
  const pathSegments = value.path.split("/");
  const validPath =
    value.path.length > 0 &&
    value.path.length <= 1024 &&
    !value.path.startsWith("/") &&
    !value.path.includes("\\") &&
    !/^[A-Za-z]:/.test(value.path) &&
    !/[\u0000-\u001f\u007f]/.test(value.path) &&
    pathSegments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
  const validMessage =
    value.message.trim().length > 0 &&
    value.message.length <= 512 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.message);
  if (!/^feedback-[a-f0-9]{20}$/.test(value.id) || !validPath || !validMessage) {
    return false;
  }
  const validHunk = value.hunkId === undefined ||
    (typeof value.hunkId === "string" && /^hunk-[a-f0-9]{20}$/.test(value.hunkId));
  const validLine = value.line === undefined ||
    (typeof value.line === "number" && Number.isSafeInteger(value.line) && value.line > 0);
  const validEndLine = value.endLine === undefined ||
    (typeof value.endLine === "number" &&
      Number.isSafeInteger(value.endLine) &&
      value.endLine > 0);
  const validSide = value.side === undefined || value.side === "old" || value.side === "new";
  const validRange = value.endLine === undefined ||
    (typeof value.line === "number" &&
      typeof value.endLine === "number" &&
      value.endLine > value.line);
  if (
    !validHunk ||
    !validLine ||
    !validEndLine ||
    !validSide ||
    !validRange ||
    (value.line === undefined) !== (value.side === undefined) ||
    (value.line !== undefined && value.hunkId === undefined)
  ) {
    return false;
  }
  return value.kind === "feedback" ||
    (value.kind === "todo" && value.hunkId === undefined &&
      value.line === undefined && value.endLine === undefined &&
      value.side === undefined);
}

function isWebRender(value: unknown): value is WebRender {
  return (
    isRecord(value) &&
    value.target === "web" &&
    typeof value.content === "string" &&
    (value.changeReview === undefined || isChangeReviewDiff(value.changeReview)) &&
    isPublicDocument(value.document)
  );
}

function isTerminalRender(value: unknown): value is TerminalRender {
  return (
    isRecord(value) &&
    value.target === "terminal" &&
    typeof value.content === "string" &&
    typeof value.backend === "string" &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === "string") &&
    (value.changeReview === undefined || isChangeReviewDiff(value.changeReview)) &&
    isPublicDocument(value.document)
  );
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    (value.error.validation === undefined ||
      isMermaidValidationReport(value.error.validation))
  );
}

function isMermaidValidationReport(
  value: unknown,
): value is MermaidValidationReport {
  if (
    !isRecord(value) ||
    value.kind !== "mermaid" ||
    typeof value.valid !== "boolean" ||
    !isInteger(value.diagramCount) ||
    value.diagramCount < 0 ||
    !Array.isArray(value.issues)
  ) {
    return false;
  }
  const issuesValid = value.issues.every((issue) =>
    isRecord(issue) &&
    isInteger(issue.block) &&
    issue.block >= 1 &&
    issue.block <= (value.diagramCount as number) &&
    isInteger(issue.line) &&
    issue.line >= 1 &&
    typeof issue.message === "string" &&
    issue.message.length > 0 &&
    issue.message.length <= 2_000
  );
  return (
    issuesValid &&
    value.issues.length <= value.diagramCount &&
    value.valid === (value.issues.length === 0)
  );
}

function dispatchEventBlock(
  block: string,
  listener: (event: CatalogEvent) => void,
  onReady: (() => void) | undefined,
): void {
  let type = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      type = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }
  if (type === "ready") {
    onReady?.();
    return;
  }
  if (type !== "catalog-invalidated") {
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(data.join("\n"));
  } catch {
    throw new Error("Daemon returned an invalid catalog event");
  }
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new Error("Daemon returned an invalid catalog event");
  }
  listener({});
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function nullableInteger(value: unknown): boolean {
  return value === null || isInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertDocumentIds(ids: unknown): asserts ids is string[] {
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 500 ||
    !ids.every((id) => typeof id === "string" && isDocumentId(id)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error("document ids must contain between 1 and 500 unique ids");
  }
}

function isDocumentId(value: string): boolean {
  return /^doc-[a-f0-9]{20}$/.test(value);
}

function assertDocumentId(id: string): void {
  if (!/^doc-[a-f0-9]{20}$/.test(id)) {
    throw new Error("invalid document id");
  }
}

function assertReviewRequestId(id: string): void {
  if (!/^review-[a-f0-9]{20}$/.test(id)) {
    throw new Error("invalid review request id");
  }
}

function assertSpaceId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new Error("invalid Space id");
  }
}

function assertWorkspaceId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new Error("invalid workspace id");
  }
}

function addScope(query: URLSearchParams, scope: ContentScope): void {
  if (
    !isRecord(scope) ||
    !Object.keys(scope).every((key) => key === "spaceId") ||
    (scope.spaceId !== undefined && typeof scope.spaceId !== "string")
  ) {
    throw new Error("invalid content scope");
  }
  if (scope.spaceId !== undefined) {
    assertSpaceId(scope.spaceId);
    query.set("space", scope.spaceId);
  }
}

function withScope(path: string, scope: ContentScope): string {
  const url = new URL(path, "http://mdmaid.desk.localhost");
  addScope(url.searchParams, scope);
  return `${url.pathname}${url.search}${url.hash}`;
}
