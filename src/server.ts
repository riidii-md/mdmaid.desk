import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderMarkdownWithSourceMap } from "mdmaid";
import { renderMarkdownToTuiWithSourceMap } from "mdmaid/tui";
import sanitizeHtml from "sanitize-html";

import {
  type AddWorkspaceInput,
  type Catalog,
  type ContentScope,
  type CreateSpaceInput,
  type Document,
  type DocumentFilters,
  DocumentSourceLinkNotFoundError,
  DocumentSourceMissingError,
  FeedbackConflictError,
  type CreateFeedbackInput,
  LinkedSourceMissingError,
  LinkedSourceUnavailableError,
  type RegisterDocumentInput,
  ReviewConflictError,
  type ReplaceSpaceMatchersInput,
  type ReconcileWorkspaceInput,
  SpaceConflictError,
  SpaceNotFoundError,
  WorkspaceConflictError,
  type ReviewRequest,
  type Workspace,
} from "./catalog.js";
import type {
  ReviewRequestRegistration,
  ReviewRequestResponse,
} from "./api-types.js";
import {
  startLiveSourceCoordinator,
  type LiveSourceCoordinator,
  type LiveSourceCoordinatorOptions,
} from "./live-sources.js";
import { WEB_STYLES } from "./web-styles.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import {
  parseChangeReviewDiffs,
} from "./change-review.js";
import {
  MermaidValidationError,
  type MermaidValidationReport,
} from "./mermaid-validation.js";

const API_VERSION = 1;
const MAX_JSON_BYTES = 64 * 1024;
const SESSION_COOKIE_PREFIX = "mdmaid_desk_session";
const LEGACY_SESSION_COOKIE = SESSION_COOKIE_PREFIX;
const SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const WEB_CLIENT_PATH = fileURLToPath(new URL("./web-client.js", import.meta.url));
const MDMAID_ENTRY = fileURLToPath(import.meta.resolve("mdmaid"));
const MDMAID_ROOT = resolve(dirname(MDMAID_ENTRY), "../..");
const MDMAID_REQUIRE = createRequire(MDMAID_ENTRY);
const MERMAID_PATH = MDMAID_REQUIRE.resolve("mermaid/dist/mermaid.min.js");
const FONT_PATH = resolve(
  MDMAID_ROOT,
  "assets/fonts/DepartureMono-Regular.woff2",
);
const FAVICON_PATH = resolve(MDMAID_ROOT, "assets/icons/favicon.svg");

export interface DeskServerOptions {
  catalog: Catalog;
  host?: string;
  port?: number;
  publicUrl?: string;
  token?: string;
}

export interface DeskServerDependencies {
  readWebClient?: (() => Promise<Buffer>) | undefined;
  startLiveSources?: (
    catalog: Catalog,
    options: LiveSourceCoordinatorOptions,
  ) => LiveSourceCoordinator;
}

export interface RunningDeskServer {
  close(): Promise<void>;
  host: string;
  port: number;
  token: string;
  url: string;
  webUrl: string;
}

interface AuthResult {
  method: "bearer" | "cookie";
}

interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    validation?: MermaidValidationReport;
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly validation?: MermaidValidationReport,
  ) {
    super(message);
  }
}

class EventHub {
  readonly #clients = new Set<ServerResponse>();

  subscribe(request: IncomingMessage, response: ServerResponse): void {
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("connection", "keep-alive");
    response.write("event: ready\ndata: {}\n\n");
    this.#clients.add(response);
    request.on("close", () => {
      this.#clients.delete(response);
    });
  }

  publish(type: string, data: object): void {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.#clients) {
      client.write(payload);
    }
  }

  close(): void {
    for (const client of this.#clients) {
      client.end();
    }
    this.#clients.clear();
  }
}

export async function startDeskServer(
  options: DeskServerOptions,
  dependencies: DeskServerDependencies = {},
): Promise<RunningDeskServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const publicOrigin =
    options.publicUrl === undefined
      ? undefined
      : normalizePublicUrl(options.publicUrl);
  const securePublicOrigin = publicOrigin?.startsWith("https://") ?? false;
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("mdmaid.desk server must bind to a loopback host");
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("server port must be an integer between 0 and 65535");
  }
  const token = options.token ?? randomBytes(32).toString("base64url");
  if (typeof token !== "string" || token.length < 8) {
    throw new Error("server token must contain at least 8 characters");
  }
  const sessionCookie = browserSessionCookieName(token);
  const webClient = await (dependencies.readWebClient ?? (() => readFile(WEB_CLIENT_PATH)))();

  const events = new EventHub();
  const unsubscribeInvalidation = options.catalog.subscribeInvalidation(() => {
    events.publish("catalog-invalidated", {});
  });
  let liveSources: LiveSourceCoordinator | undefined;
  const server = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      options.catalog,
      token,
      sessionCookie,
      events,
      publicOrigin,
      securePublicOrigin,
      webClient,
      liveSources,
    ).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const normalized =
        error instanceof HttpError
          ? error
          : new HttpError(500, "internal_error", "Internal server error");
      sendJson(response, normalized.status, {
        error: {
          code: normalized.code,
          message: normalized.message,
          ...(normalized.validation === undefined
            ? {}
            : { validation: normalized.validation }),
        },
      });
    });
  });

  await listen(server, host, port);
  try {
    liveSources = (dependencies.startLiveSources ?? startLiveSourceCoordinator)(
      options.catalog,
      {
        onEvent: () => undefined,
      },
    );
  } catch (error) {
    unsubscribeInvalidation();
    events.close();
    await closeServer(server);
    throw error;
  }
  const address = server.address() as AddressInfo;
  const urlHost = address.address.includes(":")
    ? `[${address.address}]`
    : address.address;
  const url = `http://${urlHost}:${address.port}`;
  return {
    host: address.address,
    port: address.port,
    token,
    url,
    webUrl: `${publicOrigin ?? url}/?token=${encodeURIComponent(token)}`,
    close: async () => {
      unsubscribeInvalidation();
      await liveSources?.close();
      events.close();
      await closeServer(server);
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  catalog: Catalog,
  token: string,
  sessionCookie: string,
  events: EventHub,
  publicOrigin: string | undefined,
  securePublicOrigin: boolean,
  webClient: Buffer,
  liveSources: LiveSourceCoordinator | undefined,
): Promise<void> {
  applySecurityHeaders(response, securePublicOrigin);
  const baseUrl =
    publicOrigin ?? `http://${request.headers.host ?? "127.0.0.1"}`;
  const url = new URL(request.url ?? "/", baseUrl);

  if (
    request.method === "GET" &&
    url.pathname === "/api/v1/health"
  ) {
    sendJson(response, 200, {
      data: {
        service: "mdmaid.desk",
        status: "ok",
        version: API_VERSION,
        capabilities: [
          "spaces-v1",
          "scoped-content-v1",
          "workspace-reconciliation-v1",
          "document-feedback-v1",
        ],
      },
    });
    return;
  }

  if (
    request.method === "GET" &&
    (url.pathname === "/" ||
      /^\/d\/doc-[a-f0-9]{20}$/.test(url.pathname) ||
      /^\/f\/feedback-[a-f0-9]{20}$/.test(url.pathname) ||
      /^\/w\/[a-z0-9][a-z0-9-]{0,63}$/.test(url.pathname) ||
      /^\/p\/project-[a-f0-9]{20}$/.test(url.pathname)) &&
    url.searchParams.has("token")
  ) {
    const candidate = url.searchParams.get("token") ?? "";
    if (!safeEqual(candidate, token)) {
      throw new HttpError(401, "unauthorized", "Authentication required");
    }
    response.statusCode = 303;
    url.searchParams.delete("token");
    response.setHeader("location", `${url.pathname}${url.search}${url.hash}`);
    response.setHeader(
      "set-cookie",
      `${sessionCookie}=${encodeURIComponent(token)}; HttpOnly;${securePublicOrigin ? " Secure;" : ""} SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    );
    response.end();
    return;
  }

  const auth = authenticate(request, token, sessionCookie);
  if (!auth) {
    throw new HttpError(401, "unauthorized", "Authentication required");
  }
  authorizeOrigin(request, auth, baseUrl);

  const feedbackRouteMatch = url.pathname.match(
    /^\/f\/(feedback-[a-f0-9]{20})$/,
  );
  if (request.method === "GET" && feedbackRouteMatch) {
    const scope = parseWorkspaceQueryState(url.searchParams, catalog);
    const submission = catalog.getFeedback(feedbackRouteMatch[1] ?? "", scope);
    if (!submission) {
      throw new HttpError(404, "not_found", "Feedback not found");
    }
    sendHtml(response, 200, workspaceHtml(url.pathname));
    return;
  }

  const sourceMatch = url.pathname.match(
    /^\/d\/(doc-[a-f0-9]{20})\/source\/(source-[a-f0-9]{20})$/,
  );
  if (request.method === "GET" && sourceMatch) {
    try {
      const scope = parseWorkspaceQueryState(url.searchParams, catalog);
      const source = await catalog.readDocumentSource(
        sourceMatch[1] ?? "",
        sourceMatch[2] ?? "",
        scope,
      );
      sendHtml(
        response,
        200,
        sourceViewerHtml(
          source.document.id,
          source.name,
          source.content,
          workspaceQuerySuffix(url.searchParams, scope),
        ),
      );
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  const mediaMatch = url.pathname.match(
    /^\/d\/(doc-[a-f0-9]{20})\/media\/(source-[a-f0-9]{20})$/,
  );
  if (request.method === "GET" && mediaMatch) {
    try {
      const scope = parseContentScope(url.searchParams, catalog);
      const media = await catalog.readDocumentMedia(
        mediaMatch[1] ?? "",
        mediaMatch[2] ?? "",
        scope,
      );
      sendDocumentMedia(response, media.contentType, media.content);
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  if (
    request.method === "GET" &&
    (url.pathname === "/" ||
      /^\/d\/doc-[a-f0-9]{20}$/.test(url.pathname) ||
      /^\/f\/feedback-[a-f0-9]{20}$/.test(url.pathname) ||
      /^\/w\/[a-z0-9][a-z0-9-]{0,63}$/.test(url.pathname) ||
      /^\/p\/project-[a-f0-9]{20}$/.test(url.pathname))
  ) {
    parseWorkspaceQueryState(url.searchParams, catalog);
    sendHtml(response, 200, workspaceHtml(url.pathname));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/events") {
    events.subscribe(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
    await serveAsset(response, url.pathname, webClient);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/spaces") {
    sendJson(response, 200, { data: catalog.listSpaces() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/spaces") {
    const body = await readJson(request);
    if (!isSpaceRegistration(body)) {
      throw new HttpError(422, "validation_error", "Invalid Space");
    }
    try {
      const space = catalog.createSpace(body);
      response.setHeader("location", `/api/v1/spaces/${space.id}`);
      sendJson(response, 201, { data: space });
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  const spaceMatchersMatch = url.pathname.match(
    /^\/api\/v1\/spaces\/([^/]+)\/matchers$/,
  );
  if (request.method === "PUT" && spaceMatchersMatch) {
    const body = await readJson(request);
    if (!isSpaceMatcherReplacement(body)) {
      throw new HttpError(
        422,
        "validation_error",
        "Invalid Space matcher replacement",
      );
    }
    try {
      sendJson(response, 200, {
        data: catalog.replaceSpaceMatchers(spaceMatchersMatch[1] ?? "", body),
      });
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  const spaceMatch = url.pathname.match(/^\/api\/v1\/spaces\/([^/]+)$/);
  if (request.method === "GET" && spaceMatch) {
    try {
      const space = catalog.getSpace(spaceMatch[1] ?? "");
      if (!space) {
        throw new SpaceNotFoundError(spaceMatch[1] ?? "");
      }
      sendJson(response, 200, { data: space });
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }
  if (request.method === "PATCH" && spaceMatch) {
    const body = await readJson(request);
    if (
      !isRecord(body) ||
      !hasOnlyKeys(body, ["name"]) ||
      typeof body.name !== "string"
    ) {
      throw new HttpError(422, "validation_error", "Invalid Space rename");
    }
    try {
      sendJson(response, 200, {
        data: catalog.renameSpace(spaceMatch[1] ?? "", body.name),
      });
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }
  if (request.method === "DELETE" && spaceMatch) {
    try {
      sendJson(response, 200, {
        data: catalog.deleteSpace(spaceMatch[1] ?? ""),
      });
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/repositories") {
    sendJson(response, 200, { data: catalog.listRepositories() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/workspaces") {
    const scope = parseContentScope(url.searchParams, catalog);
    const documents = catalog.listDocuments({}, scope);
    sendJson(response, 200, {
      data: catalog.listWorkspaces(scope).flatMap((workspace) => {
        const documentCount = documents.filter(
          ({ workspaceId }) => workspaceId === workspace.id,
        ).length;
        return documentCount === 0
          ? []
          : [publicWorkspace(workspace, documentCount)];
      }),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/projects") {
    const scope = parseContentScope(url.searchParams, catalog);
    const projects = new Map<
      string,
      { id: string; name: string; documentCount: number; route: string }
    >();
    for (const document of catalog.listDocuments({}, scope)) {
      const current = projects.get(document.projectId);
      if (current) {
        current.documentCount += 1;
      } else {
        projects.set(document.projectId, {
          id: document.projectId,
          name: document.projectName,
          documentCount: 1,
          route: `/p/${document.projectId}`,
        });
      }
    }
    sendJson(response, 200, { data: [...projects.values()] });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/workspaces") {
    const body = await readJson(request);
    if (!isWorkspaceRegistration(body)) {
      throw new HttpError(
        422,
        "validation_error",
        "Invalid workspace registration",
      );
    }
    try {
      const workspace = await catalog.addWorkspace(body);
      response.setHeader("location", `/api/v1/workspaces/${workspace.id}`);
      sendJson(response, 201, { data: publicWorkspace(workspace, 0) });
    } catch (error) {
      if (error instanceof WorkspaceConflictError) {
        throw mapCatalogError(error);
      }
      throw new HttpError(
        422,
        "validation_error",
        "Invalid workspace registration",
      );
    }
    return;
  }

  const workspaceReconcileMatch = url.pathname.match(
    /^\/api\/v1\/workspaces\/([a-z0-9][a-z0-9-]{0,63})\/reconcile$/,
  );
  if (request.method === "POST" && workspaceReconcileMatch) {
    const body = await readJson(request);
    if (!isWorkspaceReconciliationRequest(body)) {
      throw new HttpError(
        422,
        "validation_error",
        "Invalid workspace reconciliation",
      );
    }
    try {
      sendJson(response, 200, {
        data: catalog.reconcileWorkspace({
          sourceWorkspaceId: workspaceReconcileMatch[1] ?? "",
          ...body,
        }),
      });
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/documents") {
    const filters = parseDocumentFilters(url.searchParams);
    const scope = parseContentScope(url.searchParams, catalog);
    sendJson(response, 200, {
      data: catalog.listDocuments(filters, scope).map(publicDocument),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/documents") {
    const body = await readJson(request);
    if (!isDocumentRegistration(body)) {
      throw new HttpError(
        422,
        "validation_error",
        "Invalid document registration",
      );
    }
    try {
      const document = await catalog.registerDocument(body);
      liveSources?.refresh();
      response.setHeader("location", `/api/v1/documents/${document.id}`);
      sendJson(response, 201, { data: publicDocument(document) });
    } catch (error) {
      if (error instanceof MermaidValidationError) {
        throw new HttpError(
          422,
          "invalid_mermaid",
          error.message,
          error.report,
        );
      }
      if (error instanceof Error) {
        throw new HttpError(
          422,
          "validation_error",
          error.message,
        );
      }
      throw error;
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/imports") {
    const body = await readJson(request);
    if (!isDocumentRegistration(body)) {
      throw new HttpError(
        422,
        "validation_error",
        "Invalid document import",
      );
    }
    try {
      const document = await catalog.importDocument(body);
      response.setHeader("location", `/api/v1/documents/${document.id}`);
      sendJson(response, 201, { data: publicDocument(document) });
    } catch (error) {
      if (error instanceof MermaidValidationError) {
        throw new HttpError(
          422,
          "invalid_mermaid",
          error.message,
          error.report,
        );
      }
      if (error instanceof Error) {
        throw new HttpError(
          422,
          "validation_error",
          error.message,
        );
      }
      throw error;
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/feedback") {
    const scope = parseContentScope(url.searchParams, catalog);
    const documentId = url.searchParams.get("document");
    if (documentId === null) {
      throw new HttpError(400, "validation_error", "document is required");
    }
    const revisionValue = url.searchParams.get("revision");
    const limitValue = url.searchParams.get("limit");
    try {
      sendJson(response, 200, {
        data: catalog.listFeedback({
          documentId,
          ...(revisionValue === null
            ? {}
            : { documentRevision: Number(revisionValue) }),
          ...(limitValue === null ? {} : { limit: Number(limitValue) }),
          ...(url.searchParams.get("cursor") === null
            ? {}
            : { cursor: url.searchParams.get("cursor")! }),
        }, scope),
      });
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/feedback") {
    const scope = parseContentScope(url.searchParams, catalog);
    const body = await readJson(request);
    if (!isRecord(body)) {
      throw new HttpError(422, "validation_error", "Invalid feedback submission");
    }
    try {
      const submission = await catalog.createFeedback(
        body as unknown as CreateFeedbackInput,
        scope,
      );
      response.setHeader("location", `/api/v1/feedback/${submission.id}`);
      sendJson(response, 201, { data: submission });
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  const feedbackMatch = url.pathname.match(
    /^\/api\/v1\/feedback\/(feedback-[a-f0-9]{20})$/,
  );
  if (request.method === "GET" && feedbackMatch) {
    const scope = parseContentScope(url.searchParams, catalog);
    const submission = catalog.getFeedback(feedbackMatch[1] ?? "", scope);
    if (!submission) {
      throw new HttpError(404, "not_found", "Feedback not found");
    }
    sendJson(response, 200, { data: submission });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/review-requests") {
    const scope = parseContentScope(url.searchParams, catalog);
    const documentId = url.searchParams.get("document") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    try {
      sendJson(response, 200, {
        data: catalog
          .listReviewRequests({
            ...(documentId === undefined ? {} : { documentId }),
            ...(status === undefined
              ? {}
              : { status: status as ReviewRequest["status"] }),
          }, scope)
          .map(publicReviewRequest),
      });
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/review-requests") {
    const scope = parseContentScope(url.searchParams, catalog);
    const body = await readJson(request);
    if (!isReviewRequestRegistration(body)) {
      throw new HttpError(
        422,
        "validation_error",
        "Invalid review request",
      );
    }
    try {
      const reviewRequest = await catalog.createReviewRequest(body, scope);
      response.setHeader(
        "location",
        `/api/v1/review-requests/${reviewRequest.id}`,
      );
      sendJson(response, 201, { data: publicReviewRequest(reviewRequest) });
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  const reviewRequestMatch = url.pathname.match(
    /^\/api\/v1\/review-requests\/(review-[a-f0-9]{20})$/,
  );
  if (request.method === "GET" && reviewRequestMatch) {
    const scope = parseContentScope(url.searchParams, catalog);
    const reviewRequest = catalog.getReviewRequest(
      reviewRequestMatch[1] ?? "",
      scope,
    );
    if (!reviewRequest) {
      throw new HttpError(404, "not_found", "Review request not found");
    }
    sendJson(response, 200, { data: publicReviewRequest(reviewRequest) });
    return;
  }

  const reviewResponseMatch = url.pathname.match(
    /^\/api\/v1\/review-requests\/(review-[a-f0-9]{20})\/respond$/,
  );
  if (request.method === "POST" && reviewResponseMatch) {
    const scope = parseContentScope(url.searchParams, catalog);
    const body = await readJson(request);
    if (!isReviewRequestResponse(body)) {
      throw new HttpError(
        422,
        "validation_error",
        "Invalid review response",
      );
    }
    try {
      const reviewRequest = await catalog.respondToReviewRequest(
        reviewResponseMatch[1] ?? "",
        body,
        scope,
      );
      sendJson(response, 200, { data: publicReviewRequest(reviewRequest) });
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  const documentMatch = url.pathname.match(
    /^\/api\/v1\/documents\/(doc-[a-f0-9]{20})$/,
  );
  if (request.method === "GET" && documentMatch) {
    const scope = parseContentScope(url.searchParams, catalog);
    const document = catalog.getDocument(documentMatch[1] ?? "", scope);
    if (!document) {
      throw new HttpError(404, "not_found", "Document not found");
    }
    sendJson(response, 200, { data: publicDocument(document) });
    return;
  }

  const renderMatch = url.pathname.match(
    /^\/api\/v1\/documents\/(doc-[a-f0-9]{20})\/render$/,
  );
  if (request.method === "GET" && renderMatch) {
    const scope = parseWorkspaceQueryState(url.searchParams, catalog);
    const querySuffix = workspaceQuerySuffix(url.searchParams, scope);
    const id = renderMatch[1] ?? "";
    const target = url.searchParams.get("target");
    if (target !== "web" && target !== "terminal") {
      throw new HttpError(400, "invalid_target", "Unknown render target");
    }
    const { content, document } = await readDocument(catalog, id, scope);
    const changeReview = document.kind === "change-review"
      ? parseChangeReviewDiffs(content)
      : undefined;
    if (target === "web") {
      const renderedMarkdown = await renderMarkdownWithSourceMap(content, {
        sanitize: false,
        ...(document.kind === "change-review"
          ? { omitFencedCodeLanguages: ["diff"] }
          : {}),
      });
      const current = catalog.getDocument(id, scope);
      if (!current) {
        throw new HttpError(404, "not_found", "Document not found");
      }
      const documentTargets = catalog.resolveDocumentSourceTargets(current.id, scope);
      const rendered = sanitizeRenderedHtml(
        renderedMarkdown.html,
        current,
        documentTargets,
        querySuffix,
      );
      sendJson(response, 200, {
        data: {
          document: publicDocument(current),
          target,
          content: rendered,
          sourceWitness: catalog.feedbackSourceWitness(current.id, scope),
          sourceMap: renderedMarkdown.sourceMap,
          ...(changeReview === undefined ? {} : { changeReview }),
        },
      });
      return;
    }
    const width = parseWidth(url.searchParams.get("width"));
    const color = parseRenderBoolean(url.searchParams.get("color"), "color", false);
    const unicode = parseRenderBoolean(
      url.searchParams.get("unicode"),
      "unicode",
      true,
    );
    const rendered = await renderMarkdownToTuiWithSourceMap(content, {
      backend: "beautiful-mermaid",
      color,
      unicode,
      width,
      ...(document.kind === "change-review"
        ? { omitFencedCodeLanguages: ["diff"] }
        : {}),
    });
    const current = catalog.getDocument(id, scope);
    if (!current) {
      throw new HttpError(404, "not_found", "Document not found");
    }
    sendJson(response, 200, {
      data: {
        document: publicDocument(current),
        target,
        content: sanitizeTerminalText(rendered.output, { preserveSgr: true }),
        backend: rendered.backend,
        warnings: rendered.warnings.map((warning) => sanitizeTerminalText(warning)),
        sourceWitness: catalog.feedbackSourceWitness(current.id, scope),
        sourceMap: rendered.sourceMap,
        ...(changeReview === undefined ? {} : { changeReview }),
      },
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/documents/bulk") {
    const scope = parseContentScope(url.searchParams, catalog);
    const body = await readJson(request);
    if (!isBulkDocumentAction(body)) {
      throw new HttpError(
        422,
        "validation_error",
        "Bulk document action requires an action and 1-500 unique document ids",
      );
    }
    try {
      if (body.action === "purge") {
        const purgedIds = await catalog.purgeDocuments(body.ids, scope);
        liveSources?.refresh();
        sendJson(response, 200, {
          data: { action: body.action, purgedIds },
        });
      } else {
        const documents = body.action === "archive"
          ? await catalog.archiveDocuments(body.ids, scope)
          : await catalog.restoreDocuments(body.ids, scope);
        liveSources?.refresh();
        sendJson(response, 200, {
          data: {
            action: body.action,
            documents: documents.map(publicDocument),
          },
        });
      }
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  const purgeMatch = url.pathname.match(
    /^\/api\/v1\/documents\/(doc-[a-f0-9]{20})\/purge$/,
  );
  if (request.method === "POST" && purgeMatch) {
    const scope = parseContentScope(url.searchParams, catalog);
    const id = purgeMatch[1] ?? "";
    try {
      const [purgedId] = await catalog.purgeDocuments([id], scope);
      liveSources?.refresh();
      sendJson(response, 200, { data: { purgedId } });
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  const actionMatch = url.pathname.match(
    /^\/api\/v1\/documents\/(doc-[a-f0-9]{20})\/(opened|read|unread|archive|restore|missing|present)$/,
  );
  if (request.method === "POST" && actionMatch) {
    const scope = parseContentScope(url.searchParams, catalog);
    const id = actionMatch[1] ?? "";
    const action = actionMatch[2] ?? "";
    const actions: Record<string, () => Promise<Document>> = {
      opened: () => catalog.markDocumentOpened(id, scope),
      read: () => catalog.markDocumentRead(id, scope),
      unread: () => catalog.markDocumentUnread(id, scope),
      archive: () => catalog.archiveDocument(id, scope),
      restore: () => catalog.restoreDocument(id, scope),
      missing: () => catalog.markDocumentMissing(id, scope),
      present: () => catalog.markDocumentPresent(id, scope),
    };
    const operation = actions[action];
    if (!operation) {
      throw new HttpError(404, "not_found", "Action not found");
    }
    try {
      const document = await operation();
      if (action === "archive" || action === "restore") {
        liveSources?.refresh();
      }
      sendJson(response, 200, { data: publicDocument(document) });
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  const tagsMatch = url.pathname.match(
    /^\/api\/v1\/documents\/(doc-[a-f0-9]{20})\/tags$/,
  );
  if (request.method === "PUT" && tagsMatch) {
    const scope = parseContentScope(url.searchParams, catalog);
    const body = await readJson(request);
    if (
      !isRecord(body) ||
      !hasOnlyKeys(body, ["tags"]) ||
      !Array.isArray(body.tags) ||
      !body.tags.every((tag) => typeof tag === "string")
    ) {
      throw new HttpError(422, "validation_error", "Invalid document tags");
    }
    try {
      const document = await catalog.setDocumentTags(
        tagsMatch[1] ?? "",
        body.tags,
        scope,
      );
      sendJson(response, 200, { data: publicDocument(document) });
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  throw new HttpError(404, "not_found", "Route not found");
}

export function normalizePublicUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "public URL must be an HTTP or HTTPS .localhost origin",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (url.hostname !== "localhost" && !url.hostname.endsWith(".localhost")) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "public URL must be an HTTP or HTTPS .localhost origin",
    );
  }
  return url.origin;
}

function authenticate(
  request: IncomingMessage,
  expectedToken: string,
  sessionCookie: string,
): AuthResult | undefined {
  const authorization = request.headers.authorization;
  if (
    authorization?.startsWith("Bearer ") &&
    safeEqual(authorization.slice("Bearer ".length), expectedToken)
  ) {
    return { method: "bearer" };
  }
  const cookies = parseCookies(request.headers.cookie ?? "");
  if (
    safeEqual(cookies.get(sessionCookie) ?? "", expectedToken) ||
    safeEqual(cookies.get(LEGACY_SESSION_COOKIE) ?? "", expectedToken)
  ) {
    return { method: "cookie" };
  }
  return undefined;
}

function browserSessionCookieName(token: string): string {
  const fingerprint = createHash("sha256")
    .update(token)
    .digest("hex")
    .slice(0, 24);
  return `${SESSION_COOKIE_PREFIX}_${fingerprint}`;
}

function authorizeOrigin(
  request: IncomingMessage,
  auth: AuthResult,
  baseUrl: string,
): void {
  if (
    auth.method === "cookie" &&
    !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "") &&
    request.headers.origin !== baseUrl
  ) {
    throw new HttpError(403, "forbidden_origin", "Request origin is not allowed");
  }
}

function parseCookies(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      continue;
    }
  }
  return cookies;
}

function safeEqual(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseDocumentFilters(search: URLSearchParams): DocumentFilters {
  const allowed = new Set([
    "workspace",
    "task",
    "tag",
    "status",
    "kind",
    "attention",
    "archived",
    "missing",
    "space",
  ]);
  for (const key of search.keys()) {
    if (!allowed.has(key)) {
      throw new HttpError(400, "invalid_filter", `Unknown filter ${key}`);
    }
  }
  const boolean = (key: string): boolean | undefined => {
    const value = search.get(key);
    if (value === null) {
      return undefined;
    }
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
    throw new HttpError(400, "invalid_filter", `Invalid ${key} filter`);
  };
  const value = (key: string): string | undefined =>
    search.get(key) ?? undefined;
  return {
    ...(value("workspace") === undefined
      ? {}
      : { workspaceId: value("workspace") }),
    ...(value("task") === undefined ? {} : { taskId: value("task") }),
    ...(value("tag") === undefined ? {} : { tag: value("tag") }),
    ...(value("status") === undefined
      ? {}
      : { status: value("status") as DocumentFilters["status"] }),
    ...(value("kind") === undefined
      ? {}
      : { kind: value("kind") as DocumentFilters["kind"] }),
    ...(value("attention") === undefined
      ? {}
      : { attention: value("attention") as DocumentFilters["attention"] }),
    ...(boolean("archived") === undefined
      ? {}
      : { archived: boolean("archived") }),
    ...(boolean("missing") === undefined ? {} : { missing: boolean("missing") }),
  } as DocumentFilters;
}

function parseWidth(value: string | null): number {
  if (value === null) {
    return 100;
  }
  const width = Number(value);
  if (!Number.isSafeInteger(width) || width < 20 || width > 1_000) {
    throw new HttpError(400, "invalid_width", "Width must be between 20 and 1000");
  }
  return width;
}

function parseRenderBoolean(
  value: string | null,
  name: string,
  fallback: boolean,
): boolean {
  if (value === null) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new HttpError(
    400,
    "invalid_render_option",
    `${name} must be true or false`,
  );
}

async function readDocument(
  catalog: Catalog,
  id: string,
  scope: ContentScope,
): ReturnType<Catalog["readDocument"]> {
  try {
    return await catalog.readDocument(id, scope);
  } catch (error) {
    throw mapCatalogError(error);
  }
}

function mapCatalogError(error: unknown): HttpError {
  if (error instanceof SpaceNotFoundError) {
    return new HttpError(404, "space_not_found", error.message);
  }
  if (error instanceof SpaceConflictError) {
    return new HttpError(409, "space_conflict", error.message);
  }
  if (error instanceof WorkspaceConflictError) {
    return new HttpError(409, "workspace_conflict", error.message);
  }
  if (error instanceof MermaidValidationError) {
    return new HttpError(
      422,
      "invalid_mermaid",
      error.message,
      error.report,
    );
  }
  if (error instanceof ReviewConflictError) {
    return new HttpError(409, "review_conflict", error.message);
  }
  if (error instanceof FeedbackConflictError) {
    return new HttpError(409, "feedback_conflict", error.message);
  }
  if (error instanceof DocumentSourceMissingError) {
    return new HttpError(410, "source_missing", "Document source is missing");
  }
  if (error instanceof DocumentSourceLinkNotFoundError) {
    return new HttpError(404, "not_found", "Document source link not found");
  }
  if (error instanceof LinkedSourceMissingError) {
    return new HttpError(
      410,
      "linked_source_missing",
      "Linked source is missing",
    );
  }
  if (error instanceof LinkedSourceUnavailableError) {
    return new HttpError(
      410,
      "linked_source_unavailable",
      "Linked source is unavailable",
    );
  }
  if (error instanceof Error && error.message.startsWith("unknown document")) {
    return new HttpError(404, "not_found", "Document not found");
  }
  if (
    error instanceof Error &&
    error.message.startsWith("unknown review request")
  ) {
    return new HttpError(404, "not_found", "Review request not found");
  }
  if (error instanceof Error) {
    return new HttpError(422, "validation_error", error.message);
  }
  return new HttpError(500, "internal_error", "Internal server error");
}

function parseContentScope(
  parameters: URLSearchParams,
  catalog: Catalog,
): ContentScope {
  const values = parameters.getAll("space");
  if (values.length > 1) {
    throw new HttpError(400, "validation_error", "space may be specified once");
  }
  const spaceId = values[0];
  if (spaceId === undefined) {
    return {};
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(spaceId)) {
    throw new HttpError(400, "validation_error", "invalid Space id");
  }
  if (!catalog.getSpace(spaceId)) {
    throw new HttpError(404, "space_not_found", `unknown space ${spaceId}`);
  }
  return { spaceId };
}

function parseWorkspaceQueryState(
  parameters: URLSearchParams,
  catalog: Catalog,
): ContentScope {
  const scope = parseContentScope(parameters, catalog);
  const view = parameters.getAll("view");
  if (
    view.length > 1 ||
    (view[0] !== undefined && view[0] !== "docs" && view[0] !== "change-reviews")
  ) {
    throw new HttpError(400, "validation_error", "invalid view");
  }
  const actions = parameters.getAll("actions");
  if (actions.length > 1 || (actions[0] !== undefined && actions[0] !== "1")) {
    throw new HttpError(400, "validation_error", "invalid actions filter");
  }
  return scope;
}

function workspaceQuerySuffix(
  parameters: URLSearchParams,
  scope: ContentScope,
): string {
  const query = new URLSearchParams();
  if (scope.spaceId !== undefined) {
    query.set("space", scope.spaceId);
  }
  const view = parameters.get("view");
  if (view === "docs" || view === "change-reviews") {
    query.set("view", view);
  }
  if (parameters.get("actions") === "1") {
    query.set("actions", "1");
  }
  const value = query.toString();
  return value === "" ? "" : `?${value}`;
}

function publicDocument(document: Document): Record<string, unknown> {
  return {
    id: document.id,
    workspaceId: document.workspaceId,
    projectId: document.projectId,
    projectName: document.projectName,
    ...(document.taskId === undefined ? {} : { taskId: document.taskId }),
    ...(document.producer === undefined ? {} : { producer: document.producer }),
    kind: document.kind,
    title: document.title,
    storage: document.storage,
    attention: document.attention,
    tags: document.tags,
    revision: document.revision,
    openedRevision: document.openedRevision,
    completedRevision: document.completedRevision,
    status: document.status,
    archivedAt: document.archivedAt,
    missingAt: document.missingAt,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    route: `/d/${document.id}`,
  };
}

function publicReviewRequest(request: ReviewRequest): Record<string, unknown> {
  return structuredClone(request) as unknown as Record<string, unknown>;
}

function publicWorkspace(
  workspace: Workspace,
  documentCount: number,
): Record<string, unknown> {
  return {
    id: workspace.id,
    name: workspace.name,
    documentCount,
    route: `/w/${workspace.id}`,
  };
}

function sanitizeRenderedHtml(
  content: string,
  document: Document,
  documentTargets: ReadonlyMap<string, string>,
  querySuffix: string,
): string {
  const sourceLinks = new Map(
    document.sourceLinks.map((link) => [link.href, link]),
  );
  return sanitizeHtml(content, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "div",
      "img",
    ],
    allowedAttributes: {
      a: ["href", "id", "tabindex", "aria-hidden", "title"],
      code: ["class"],
      div: ["class"],
      h1: ["id"],
      h2: ["id"],
      h3: ["id"],
      h4: ["id"],
      h5: ["id"],
      h6: ["id"],
      img: ["src", "alt", "title", "width", "height"],
      span: ["class", "aria-hidden", "data-mdmaid-source-ref"],
    },
    allowedClasses: {
      code: [/^language-[a-z0-9_-]+$/],
      div: ["mermaid"],
      span: ["icon", "icon-link"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: {
      img: ["http", "https", "data"],
    },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => {
        const link = attribs.href
          ? sourceLinks.get(attribs.href)
          : undefined;
        const targetDocumentId = link
          ? documentTargets.get(link.id)
          : undefined;
        return {
          tagName,
          attribs: link
            ? {
                ...attribs,
                href: targetDocumentId
                  ? registeredDocumentRoute(targetDocumentId, link.href, querySuffix)
                  : documentSourceRoute(document.id, link, querySuffix),
              }
            : attribs,
        };
      },
      img: (tagName, attribs) => {
        const media = attribs.src
          ? sourceLinks.get(attribs.src)
          : undefined;
        return {
          tagName,
          attribs: media
            ? {
                ...attribs,
                src: documentMediaRoute(document.id, media, querySuffix),
              }
            : attribs,
        };
      },
    },
  });
}

function registeredDocumentRoute(
  documentId: string,
  href: string,
  querySuffix: string,
): string {
  const fragmentIndex = href.indexOf("#");
  const fragment = fragmentIndex === -1 ? "" : href.slice(fragmentIndex);
  return `/d/${documentId}${querySuffix}${fragment}`;
}

function documentSourceRoute(
  documentId: string,
  link: Document["sourceLinks"][number],
  querySuffix: string,
): string {
  const line = link.href.match(/#(L[1-9][0-9]*)$/)?.[1];
  return `/d/${documentId}/source/${link.id}${querySuffix}${line ? `#${line}` : ""}`;
}

function documentMediaRoute(
  documentId: string,
  link: Document["sourceLinks"][number],
  querySuffix: string,
): string {
  return `/d/${documentId}/media/${link.id}${querySuffix}`;
}

function sourceViewerHtml(
  documentId: string,
  name: string,
  content: string,
  querySuffix: string,
): string {
  const lines = content.endsWith("\n")
    ? content.slice(0, -1).split("\n")
    : content.split("\n");
  const source = lines
    .map((line, index) => {
      const lineNumber = index + 1;
      return `<span id="L${lineNumber}" class="source-line"><a class="source-line-number" href="#L${lineNumber}" aria-label="Line ${lineNumber}">${lineNumber}</a><code>${escapeHtml(line) || "&#8203;"}</code></span>`;
    })
    .join("");
  const escapedName = escapeHtml(name);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapedName} · mdmaid.desk</title>
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="preload" href="/assets/departure-mono.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/assets/app.css">
  </head>
  <body class="source-page">
    <header class="topbar">
      <a class="brand" href="/">
        <strong>mdmaid.desk</strong>
        <span>workspace source</span>
      </a>
      <a class="action" href="/d/${documentId}${querySuffix}">← document</a>
    </header>
    <main class="source-viewer">
      <span class="eyebrow">linked source</span>
      <h1>${escapedName}</h1>
      <pre class="source-code">${source}</pre>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_JSON_BYTES) {
      throw new HttpError(413, "payload_too_large", "Request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function isDocumentRegistration(value: unknown): value is RegisterDocumentInput {
  if (!isRecord(value)) {
    return false;
  }
  const required = [
    "workspaceId",
    "kind",
    "title",
    "path",
    "attention",
  ];
  return (
    hasOnlyKeys(value, [
      ...required,
      "taskId",
      "featureName",
      "producer",
      "tags",
    ]) &&
    required.every((key) => typeof value[key] === "string") &&
    (value.taskId === undefined || typeof value.taskId === "string") &&
    (value.featureName === undefined ||
      typeof value.featureName === "string") &&
    (value.producer === undefined || typeof value.producer === "string") &&
    (value.tags === undefined ||
      (Array.isArray(value.tags) &&
        value.tags.every((tag) => typeof tag === "string")))
  );
}

function isSpaceMatcher(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, ["kind", "value"]) &&
    typeof value.kind === "string" &&
    typeof value.value === "string";
}

function isSpaceRegistration(value: unknown): value is CreateSpaceInput {
  return isRecord(value) &&
    hasOnlyKeys(value, ["id", "name", "matchers"]) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    Array.isArray(value.matchers) &&
    value.matchers.every(isSpaceMatcher);
}

function isSpaceMatcherReplacement(
  value: unknown,
): value is ReplaceSpaceMatchersInput {
  return isRecord(value) &&
    hasOnlyKeys(value, ["matchers"]) &&
    Array.isArray(value.matchers) &&
    value.matchers.every(isSpaceMatcher);
}

function isWorkspaceRegistration(value: unknown): value is AddWorkspaceInput {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasOnlyKeys(value, [
      "id",
      "name",
      "root",
      "artifactRoots",
      "repository",
      "repositoryName",
    ]) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.root === "string" &&
    (value.repository === undefined || typeof value.repository === "string") &&
    (value.repositoryName === undefined ||
      typeof value.repositoryName === "string") &&
    Array.isArray(value.artifactRoots) &&
    value.artifactRoots.every((root) => typeof root === "string")
  );
}

function isWorkspaceReconciliationRequest(
  value: unknown,
): value is Omit<ReconcileWorkspaceInput, "sourceWorkspaceId"> {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      "targetWorkspaceId",
      "discardArchivedConflicts",
      "apply",
    ]) &&
    typeof value.targetWorkspaceId === "string" &&
    (value.discardArchivedConflicts === undefined ||
      typeof value.discardArchivedConflicts === "boolean") &&
    typeof value.apply === "boolean";
}

function isReviewRequestRegistration(
  value: unknown,
): value is ReviewRequestRegistration {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "documentId",
      "documentRevision",
      "kind",
      "requestMessage",
    ]) &&
    typeof value.documentId === "string" &&
    (value.documentRevision === undefined ||
      (typeof value.documentRevision === "number" &&
        Number.isSafeInteger(value.documentRevision))) &&
    typeof value.kind === "string" &&
    typeof value.requestMessage === "string"
  );
}

function isReviewRequestResponse(
  value: unknown,
): value is ReviewRequestResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["outcome", "message", "items", "feedback"]) &&
    typeof value.outcome === "string" &&
    typeof value.message === "string" &&
    (value.items === undefined || Array.isArray(value.items)) &&
    (value.feedback === undefined || isRecord(value.feedback))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBulkDocumentAction(
  value: unknown,
): value is { action: "archive" | "restore" | "purge"; ids: string[] } {
  return isRecord(value) &&
    hasOnlyKeys(value, ["action", "ids"]) &&
    (value.action === "archive" ||
      value.action === "restore" ||
      value.action === "purge") &&
    Array.isArray(value.ids) &&
    value.ids.length > 0 &&
    value.ids.length <= 500 &&
    value.ids.every((id) =>
      typeof id === "string" && /^doc-[a-f0-9]{20}$/.test(id)
    ) &&
    new Set(value.ids).size === value.ids.length;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function applySecurityHeaders(
  response: ServerResponse,
  securePublicOrigin: boolean,
): void {
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
  if (securePublicOrigin) {
    response.setHeader("strict-transport-security", "max-age=31536000");
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: object | ApiErrorBody,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(body);
}

async function serveAsset(
  response: ServerResponse,
  pathname: string,
  webClient: Buffer,
): Promise<void> {
  if (pathname === "/assets/app.css") {
    sendAsset(response, "text/css; charset=utf-8", WEB_STYLES);
    return;
  }
  if (pathname === "/assets/app.js") {
    sendAsset(response, "text/javascript; charset=utf-8", webClient);
    return;
  }
  if (pathname === "/assets/mermaid.min.js") {
    sendAsset(
      response,
      "text/javascript; charset=utf-8",
      await readFile(MERMAID_PATH),
    );
    return;
  }
  if (pathname === "/assets/departure-mono.woff2") {
    sendAsset(response, "font/woff2", await readFile(FONT_PATH));
    return;
  }
  if (pathname === "/assets/favicon.svg") {
    sendAsset(response, "image/svg+xml", await readFile(FAVICON_PATH));
    return;
  }
  throw new HttpError(404, "not_found", "Asset not found");
}

function sendAsset(
  response: ServerResponse,
  contentType: string,
  body: string | Buffer,
): void {
  response.statusCode = 200;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "private, max-age=300");
  response.end(body);
}

function sendDocumentMedia(
  response: ServerResponse,
  contentType: "image/svg+xml",
  body: Buffer,
): void {
  response.statusCode = 200;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "private, no-cache");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader(
    "content-security-policy",
    "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'",
  );
  response.end(body);
}

function workspaceHtml(pathname: string): string {
  const documentId = pathname.startsWith("/d/") ? pathname.slice(3) : "";
  const feedbackId = pathname.startsWith("/f/") ? pathname.slice(3) : "";
  const workspaceId = pathname.startsWith("/w/") ? pathname.slice(3) : "";
  const projectId = pathname.startsWith("/p/") ? pathname.slice(3) : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>mdmaid.desk</title>
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="preload" href="/assets/departure-mono.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/assets/app.css">
    <script defer src="/assets/mermaid.min.js"></script>
    <script type="module" src="/assets/app.js"></script>
  </head>
  <body data-document-id="${documentId}" data-feedback-id="${feedbackId}" data-workspace-id="${workspaceId}" data-project-id="${projectId}">
    <header class="topbar">
      <a class="brand" href="/">
        <strong>mdmaid.desk</strong>
        <span>reading + change review workspace</span>
      </a>
      <nav class="global-filters" aria-label="Workspace filters">
        <label class="filter-picker" for="project-select">
          <span>project</span>
          <span class="project-combobox">
            <input id="project-select" data-testid="project-select" type="search" role="combobox" aria-label="Project" aria-autocomplete="list" aria-controls="project-options" aria-expanded="false" autocomplete="off" spellcheck="false" placeholder="Search projects…" value="All projects">
            <span id="project-options" class="project-options" role="listbox" hidden></span>
          </span>
        </label>
        <label class="space-picker" for="space-select">
          <span>space</span>
          <select id="space-select"><option value="">All</option></select>
        </label>
        <div class="content-mode-switch" aria-label="Content type">
          <button id="docs-filter" class="content-mode active" type="button" aria-pressed="true">docs</button>
          <button id="change-reviews-filter" class="content-mode" type="button" aria-pressed="false">
            change reviews <span id="change-reviews-count" class="count">0</span>
          </button>
          <button id="archive-filter" class="content-mode" type="button" aria-pressed="false">archive</button>
        </div>
      </nav>
      <div class="top-actions">
        <span id="pending-decisions" class="pending-decisions" role="status" aria-live="polite" hidden>● waiting for decision = <span id="pending-decisions-count">0</span></span>
        <span id="live-status" class="live offline" role="status" aria-live="polite">○ connecting</span>
        <button id="theme-toggle" class="icon-button" type="button" aria-label="Toggle theme">◐</button>
      </div>
    </header>
    <div id="workspace" class="workspace">
      <aside id="sidebar" class="sidebar" hidden>
        <nav id="reader-toc" class="reader-toc" aria-labelledby="reader-toc-title" data-testid="reader-toc" hidden>
          <h2 id="reader-toc-title">contents</h2>
          <ol id="reader-toc-list" class="toc-list"></ol>
        </nav>
        <div class="shortcut-card">
          <div><kbd>/</kbd> search</div>
          <div><kbd>j</kbd> <kbd>k</kbd> scroll</div>
          <div><kbd>m</kbd> mark read</div>
          <div><kbd>u</kbd> unread</div>
          <div><kbd>b</kbd> back</div>
        </div>
      </aside>
      <main class="main">
        <section id="queue-panel">
          <div class="queue-header">
            <div class="queue-title-row">
              <div>
                <span id="queue-eyebrow" class="eyebrow">persistent reading queue</span>
                <h1 id="queue-title">What needs your eyes?</h1>
              </div>
              <p>opening means reading · only you mark done</p>
            </div>
            <div class="controls">
              <input id="search" class="search" type="search" placeholder="search title, task, tag, producer…" autocomplete="off">
              <div class="status-filters" role="group" aria-label="Queue status">
                <button class="status-filter active" type="button" data-status-filter="all" aria-pressed="true">all <span class="count">0</span></button>
                <button id="actions-filter" class="status-filter" type="button" aria-pressed="false">waiting for you <span id="actions-count" class="count">0</span></button>
                <button class="status-filter" type="button" data-status-filter="unread" aria-pressed="false">unread <span class="count">0</span></button>
                <button class="status-filter" type="button" data-status-filter="reading" aria-pressed="false">reading <span class="count">0</span></button>
                <button class="status-filter" type="button" data-status-filter="done" aria-pressed="false">done <span class="count">0</span></button>
              </div>
            </div>
            <div class="grouping-switch" role="group" aria-label="Group documents">
              <span class="grouping-label">view</span>
              <button class="grouping-button active" type="button" data-grouping="project" aria-pressed="true">projects</button>
              <button class="grouping-button" type="button" data-grouping="tag" aria-pressed="false">tags</button>
              <button class="grouping-button" type="button" data-grouping="all" aria-pressed="false">all in order</button>
            </div>
          </div>
          <div id="bulk-actions" class="bulk-actions" hidden>
            <button id="select-visible" class="action" type="button">select all</button>
            <span id="selection-count" role="status" aria-live="polite">0 selected</span>
            <button id="bulk-archive" class="action" type="button" disabled>archive selected</button>
            <button id="bulk-restore" class="action" type="button" disabled hidden>restore selected</button>
            <button id="bulk-purge" class="action danger" type="button" disabled>purge selected</button>
          </div>
          <div id="document-queue" class="document-queue" data-testid="document-queue"></div>
          <div id="queue-empty" class="empty" hidden>No documents match this view.</div>
          <div id="queue-error" class="empty error-state" data-testid="queue-error" role="alert" hidden>
            <strong id="queue-error-title">Could not load documents</strong>
            <p id="queue-error-guidance"></p>
          </div>
        </section>
        <article id="document-reader" class="reader" data-testid="document-reader" hidden>
          <div class="reader-toolbar">
            <button id="reader-back" class="action" type="button">← queue</button>
            <div class="reader-actions">
              <button id="mark-read" class="action" type="button">✓ mark read</button>
              <button id="mark-unread" class="action" type="button">○ unread</button>
              <button id="copy-link" class="action" type="button">copy link</button>
              <button id="print" class="action" type="button">print</button>
              <button id="archive" class="action" type="button">archive</button>
              <button id="restore" class="action" type="button" hidden>restore</button>
              <button id="purge" class="action danger" type="button">purge</button>
            </div>
          </div>
          <header class="reader-heading">
            <span id="reader-eyebrow" class="eyebrow">document</span>
            <h1 id="reader-title">Document</h1>
            <p id="reader-meta"></p>
          </header>
          <div class="change-view-switcher" aria-label="Change review view">
            <button id="change-view-diff" class="action active" type="button" hidden>native diff</button>
            <button id="change-view-document" class="action" type="button" hidden>review document</button>
          </div>
          <section id="change-review-viewer" class="change-review-viewer" aria-label="Native change review" hidden>
            <div class="change-review-toolbar">
              <div class="change-review-navigation">
                <button id="change-file-previous" class="action" type="button">← file</button>
                <button id="change-file-next" class="action" type="button">file →</button>
              </div>
              <span id="change-position" class="change-position"></span>
              <button id="change-layout" class="action" type="button">side-by-side</button>
            </div>
            <div class="change-review-workspace">
              <aside class="change-file-sidebar" aria-label="Changed files">
                <strong>files</strong>
                <nav id="change-file-list" class="change-file-list"></nav>
              </aside>
              <div id="change-diff-stage" class="change-diff-stage"></div>
            </div>
          </section>
          <div id="reader-content" class="reader-content"></div>
          <button id="document-feedback-add-selection" class="action document-feedback-add-selection" type="button" hidden>+ comment on selection</button>
          <section id="feedback-panel" class="review-panel feedback-panel" aria-labelledby="feedback-title" hidden>
            <span class="eyebrow">feedback</span>
            <h2 id="feedback-title">Comment on this document</h2>
            <p class="review-status">Feedback is saved independently. The agent can fetch it by ID or URL.</p>
            <div id="review-feedback-section" class="review-feedback-section" hidden>
              <div class="review-feedback-heading">
                <strong>Specific comments</strong>
                <span>Select document text, or click + beside a diff line.</span>
              </div>
              <div id="review-feedback-list" class="review-feedback-list"></div>
              <div id="review-feedback-composer" class="review-feedback-composer" hidden>
                <label id="review-feedback-anchor" for="review-feedback-message"></label>
                <textarea id="review-feedback-message" rows="3" maxlength="512" placeholder="Describe the specific issue…"></textarea>
                <div class="review-feedback-actions">
                  <button id="review-feedback-save" class="action" type="button">save feedback</button>
                  <button id="review-feedback-cancel" class="action" type="button">cancel</button>
                </div>
              </div>
            </div>
            <label for="feedback-general-message">General feedback</label>
            <textarea id="feedback-general-message" rows="5" maxlength="16384" placeholder="Add overall feedback for the agent…"></textarea>
            <p id="feedback-error" class="review-error" role="alert"></p>
            <div class="review-actions">
              <button id="feedback-send" class="action" type="button">send feedback</button>
            </div>
            <div id="feedback-history" class="feedback-history" hidden></div>
          </section>
          <section id="review-panel" class="review-panel" aria-labelledby="review-title" hidden>
            <span class="eyebrow">action required</span>
            <h2 id="review-title">Human decision</h2>
            <p id="review-request-message" class="review-message"></p>
            <p id="review-status" class="review-status"></p>
            <label for="review-response">Decision note</label>
            <textarea id="review-response" rows="5" maxlength="16384" placeholder="Add overall context for the agent…"></textarea>
            <p id="review-error" class="review-error" role="alert"></p>
            <div id="review-actions" class="review-actions">
              <button id="review-approve" class="action" type="button">approve</button>
              <button id="review-changes" class="action" type="button">request changes</button>
              <button id="review-reject" class="action" type="button">reject</button>
              <button id="review-supersede" class="action" type="button">mark superseded</button>
            </div>
          </section>
        </article>
      </main>
    </div>
    <dialog id="document-action-dialog" class="confirmation-dialog" aria-labelledby="document-action-title">
      <h2 id="document-action-title">Confirm action</h2>
      <p id="document-action-message"></p>
      <div class="confirmation-actions">
        <button id="document-action-cancel" class="action" type="button">cancel</button>
        <button id="document-action-confirm" class="action danger" type="button">confirm</button>
      </div>
    </dialog>
    <div id="archive-undo" class="archive-undo" role="status" aria-live="polite" hidden>
      <span id="archive-undo-message">Document archived.</span>
      <button id="archive-undo-button" class="action" type="button">undo</button>
    </div>
  </body>
</html>`;
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolvePromise();
      }
    });
  });
}
