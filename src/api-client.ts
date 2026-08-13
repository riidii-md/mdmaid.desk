import {
  ATTENTION_STATES,
  DOCUMENT_KINDS,
} from "./domain.js";
import type {
  DocumentAction,
  DocumentImport,
  DocumentRegistration,
  HealthData,
  PublicDocument,
  PublicWorkspace,
  RenderTarget,
  TerminalRenderPreferences,
  TerminalRender,
  WebRender,
  WorkspaceRegistration,
} from "./api-types.js";

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

export class DeskApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeskApiError";
  }
}

export interface CatalogEvent {
  action: string;
  documentId?: string;
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
    if (!isHealth(value)) {
      throw new Error("Daemon returned an invalid health response");
    }
    return value;
  }

  async listDocuments(): Promise<PublicDocument[]> {
    const value = await this.#request("/api/v1/documents");
    if (!Array.isArray(value) || !value.every(isPublicDocument)) {
      throw new Error("Daemon returned an invalid document list");
    }
    return value;
  }

  async listWorkspaces(): Promise<PublicWorkspace[]> {
    const value = await this.#request("/api/v1/workspaces");
    if (!Array.isArray(value) || !value.every(isPublicWorkspace)) {
      throw new Error("Daemon returned an invalid workspace list");
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

  async renderDocument(
    id: string,
    target: "terminal",
    width?: number,
    preferences?: TerminalRenderPreferences,
  ): Promise<TerminalRender>;
  async renderDocument(
    id: string,
    target: "web",
    width?: number,
  ): Promise<WebRender>;
  async renderDocument(
    id: string,
    target: RenderTarget,
    width = 100,
    preferences: TerminalRenderPreferences = {},
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

  async act(id: string, action: DocumentAction): Promise<PublicDocument> {
    assertDocumentId(id);
    const value = await this.#request(
      `/api/v1/documents/${encodeURIComponent(id)}/${action}`,
      { method: "POST" },
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
      method?: "GET" | "POST";
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

function isHealth(value: unknown): value is HealthData {
  return (
    isRecord(value) &&
    value.service === "mdmaid.desk" &&
    value.status === "ok" &&
    typeof value.version === "number"
  );
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

function isPublicDocument(value: unknown): value is PublicDocument {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.workspaceId === "string" &&
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

function isWebRender(value: unknown): value is WebRender {
  return (
    isRecord(value) &&
    value.target === "web" &&
    typeof value.content === "string" &&
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
    isPublicDocument(value.document)
  );
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
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
  if (type !== "catalog") {
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(data.join("\n"));
  } catch {
    throw new Error("Daemon returned an invalid catalog event");
  }
  if (
    !isRecord(value) ||
    typeof value.action !== "string" ||
    (value.documentId !== undefined &&
      (typeof value.documentId !== "string" ||
        !/^doc-[a-f0-9]{20}$/.test(value.documentId))) ||
    (value.workspaceId !== undefined &&
      (typeof value.workspaceId !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.workspaceId))) ||
    (value.documentId === undefined && value.workspaceId === undefined)
  ) {
    throw new Error("Daemon returned an invalid catalog event");
  }
  listener({
    action: value.action,
    ...(value.documentId === undefined
      ? {}
      : { documentId: value.documentId as string }),
    ...(value.workspaceId === undefined
      ? {}
      : { workspaceId: value.workspaceId as string }),
  });
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function nullableInteger(value: unknown): boolean {
  return value === null || isInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertDocumentId(id: string): void {
  if (!/^doc-[a-f0-9]{20}$/.test(id)) {
    throw new Error("invalid document id");
  }
}
