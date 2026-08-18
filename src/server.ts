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

import { renderMarkdown } from "mdmaid";
import { renderMarkdownToTui } from "mdmaid/tui";
import sanitizeHtml from "sanitize-html";

import {
  type AddWorkspaceInput,
  type Catalog,
  type Document,
  type DocumentFilters,
  DocumentSourceLinkNotFoundError,
  DocumentSourceMissingError,
  LinkedSourceMissingError,
  LinkedSourceUnavailableError,
  type RegisterDocumentInput,
  type Workspace,
} from "./catalog.js";
import { WEB_STYLES } from "./web-styles.js";
import { sanitizeTerminalText } from "./terminal-text.js";

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
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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
        error: { code: normalized.code, message: normalized.message },
      });
    });
  });

  await listen(server, host, port);
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
      data: { service: "mdmaid.desk", status: "ok", version: API_VERSION },
    });
    return;
  }

  if (
    request.method === "GET" &&
    (url.pathname === "/" ||
      /^\/d\/doc-[a-f0-9]{20}$/.test(url.pathname) ||
      /^\/w\/[a-z0-9][a-z0-9-]{0,63}$/.test(url.pathname)) &&
    url.searchParams.has("token")
  ) {
    const candidate = url.searchParams.get("token") ?? "";
    if (!safeEqual(candidate, token)) {
      throw new HttpError(401, "unauthorized", "Authentication required");
    }
    response.statusCode = 303;
    response.setHeader("location", url.pathname);
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

  const sourceMatch = url.pathname.match(
    /^\/d\/(doc-[a-f0-9]{20})\/source\/(source-[a-f0-9]{20})$/,
  );
  if (request.method === "GET" && sourceMatch) {
    try {
      const source = await catalog.readDocumentSource(
        sourceMatch[1] ?? "",
        sourceMatch[2] ?? "",
      );
      sendHtml(
        response,
        200,
        sourceViewerHtml(source.document.id, source.name, source.content),
      );
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  if (
    request.method === "GET" &&
    (url.pathname === "/" ||
      /^\/d\/doc-[a-f0-9]{20}$/.test(url.pathname) ||
      /^\/w\/[a-z0-9][a-z0-9-]{0,63}$/.test(url.pathname))
  ) {
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

  if (request.method === "GET" && url.pathname === "/api/v1/workspaces") {
    const documents = catalog.listDocuments();
    sendJson(response, 200, {
      data: catalog.listWorkspaces().flatMap((workspace) => {
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
      events.publish("catalog", {
        action: "workspace-added",
        workspaceId: workspace.id,
      });
    } catch (error) {
      if (error instanceof Error) {
        throw new HttpError(
          422,
          "validation_error",
          "Invalid workspace registration",
        );
      }
      throw error;
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/documents") {
    const filters = parseDocumentFilters(url.searchParams);
    sendJson(response, 200, {
      data: catalog.listDocuments(filters).map(publicDocument),
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
      response.setHeader("location", `/api/v1/documents/${document.id}`);
      sendJson(response, 201, { data: publicDocument(document) });
      events.publish("catalog", { action: "registered", documentId: document.id });
    } catch (error) {
      if (error instanceof Error) {
        throw new HttpError(
          422,
          "validation_error",
          "Invalid document registration",
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
      events.publish("catalog", { action: "imported", documentId: document.id });
    } catch (error) {
      if (error instanceof Error) {
        throw new HttpError(
          422,
          "validation_error",
          "Invalid document import",
        );
      }
      throw error;
    }
    return;
  }

  const documentMatch = url.pathname.match(
    /^\/api\/v1\/documents\/(doc-[a-f0-9]{20})$/,
  );
  if (request.method === "GET" && documentMatch) {
    const document = catalog.getDocument(documentMatch[1] ?? "");
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
    const id = renderMatch[1] ?? "";
    const target = url.searchParams.get("target");
    if (target !== "web" && target !== "terminal") {
      throw new HttpError(400, "invalid_target", "Unknown render target");
    }
    const { content, document } = await readDocument(catalog, id);
    if (target === "web") {
      const documentTargets = catalog.resolveDocumentSourceTargets(document.id);
      const rendered = sanitizeRenderedHtml(
        await renderMarkdown(content, { sanitize: false }),
        document,
        documentTargets,
      );
      sendJson(response, 200, {
        data: {
          document: publicDocument(document),
          target,
          content: rendered,
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
    const rendered = await renderMarkdownToTui(content, {
      backend: "beautiful-mermaid",
      color,
      unicode,
      width,
    });
    sendJson(response, 200, {
      data: {
        document: publicDocument(document),
        target,
        content: sanitizeTerminalText(rendered.output, { preserveSgr: true }),
        backend: rendered.backend,
        warnings: rendered.warnings.map((warning) => sanitizeTerminalText(warning)),
      },
    });
    return;
  }

  const actionMatch = url.pathname.match(
    /^\/api\/v1\/documents\/(doc-[a-f0-9]{20})\/(opened|read|unread|archive|restore|missing|present)$/,
  );
  if (request.method === "POST" && actionMatch) {
    const id = actionMatch[1] ?? "";
    const action = actionMatch[2] ?? "";
    const actions: Record<string, () => Promise<Document>> = {
      opened: () => catalog.markDocumentOpened(id),
      read: () => catalog.markDocumentRead(id),
      unread: () => catalog.markDocumentUnread(id),
      archive: () => catalog.archiveDocument(id),
      restore: () => catalog.restoreDocument(id),
      missing: () => catalog.markDocumentMissing(id),
      present: () => catalog.markDocumentPresent(id),
    };
    const operation = actions[action];
    if (!operation) {
      throw new HttpError(404, "not_found", "Action not found");
    }
    try {
      const document = await operation();
      sendJson(response, 200, { data: publicDocument(document) });
      events.publish("catalog", {
        action,
        documentId: document.id,
      });
    } catch (error) {
      throw mapCatalogError(error);
    }
    return;
  }

  const tagsMatch = url.pathname.match(
    /^\/api\/v1\/documents\/(doc-[a-f0-9]{20})\/tags$/,
  );
  if (request.method === "PUT" && tagsMatch) {
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
      );
      sendJson(response, 200, { data: publicDocument(document) });
      events.publish("catalog", {
        action: "tags",
        documentId: document.id,
      });
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
): ReturnType<Catalog["readDocument"]> {
  try {
    return await catalog.readDocument(id);
  } catch (error) {
    throw mapCatalogError(error);
  }
}

function mapCatalogError(error: unknown): HttpError {
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
  if (error instanceof Error) {
    return new HttpError(422, "validation_error", error.message);
  }
  return new HttpError(500, "internal_error", "Internal server error");
}

function publicDocument(document: Document): Record<string, unknown> {
  return {
    id: document.id,
    workspaceId: document.workspaceId,
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
      span: ["class", "aria-hidden"],
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
                  ? registeredDocumentRoute(targetDocumentId, link.href)
                  : documentSourceRoute(document.id, link),
              }
            : attribs,
        };
      },
    },
  });
}

function registeredDocumentRoute(documentId: string, href: string): string {
  const fragmentIndex = href.indexOf("#");
  const fragment = fragmentIndex === -1 ? "" : href.slice(fragmentIndex);
  return `/d/${documentId}${fragment}`;
}

function documentSourceRoute(
  documentId: string,
  link: Document["sourceLinks"][number],
): string {
  const line = link.href.match(/#(L[1-9][0-9]*)$/)?.[1];
  return `/d/${documentId}/source/${link.id}${line ? `#${line}` : ""}`;
}

function sourceViewerHtml(
  documentId: string,
  name: string,
  content: string,
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
      <div class="brand">
        <strong>mdmaid.desk</strong>
        <span>workspace source</span>
      </div>
      <a class="action" href="/d/${documentId}">← document</a>
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
    hasOnlyKeys(value, [...required, "taskId", "producer", "tags"]) &&
    required.every((key) => typeof value[key] === "string") &&
    (value.taskId === undefined || typeof value.taskId === "string") &&
    (value.producer === undefined || typeof value.producer === "string") &&
    (value.tags === undefined ||
      (Array.isArray(value.tags) &&
        value.tags.every((tag) => typeof tag === "string")))
  );
}

function isWorkspaceRegistration(value: unknown): value is AddWorkspaceInput {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasOnlyKeys(value, ["id", "name", "root", "artifactRoots"]) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.root === "string" &&
    Array.isArray(value.artifactRoots) &&
    value.artifactRoots.every((root) => typeof root === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function workspaceHtml(pathname: string): string {
  const documentId = pathname.startsWith("/d/") ? pathname.slice(3) : "";
  const workspaceId = pathname.startsWith("/w/") ? pathname.slice(3) : "";
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
  <body data-document-id="${documentId}" data-workspace-id="${workspaceId}">
    <header class="topbar">
      <div class="brand">
        <strong>mdmaid.desk</strong>
        <span>document workspace</span>
      </div>
      <div class="top-actions">
        <span id="live-status" class="live offline">○ connecting</span>
        <button id="theme-toggle" class="icon-button" type="button" aria-label="Toggle theme">◐</button>
      </div>
    </header>
    <div class="workspace">
      <aside class="sidebar">
        <h2>projects</h2>
        <nav id="project-nav" class="project-nav" data-testid="project-nav"></nav>
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
                <span class="eyebrow">persistent reading queue</span>
                <h1>What needs your eyes?</h1>
              </div>
              <p>opening means reading · only you mark done</p>
            </div>
            <div class="controls">
              <input id="search" class="search" type="search" placeholder="search title, task, tag, producer…" autocomplete="off">
              <div class="status-filters" aria-label="Reading status">
                <button class="status-filter active" type="button" data-status-filter="all">all <span class="count">0</span></button>
                <button class="status-filter" type="button" data-status-filter="unread">unread <span class="count">0</span></button>
                <button class="status-filter" type="button" data-status-filter="reading">reading <span class="count">0</span></button>
                <button class="status-filter" type="button" data-status-filter="done">done <span class="count">0</span></button>
              </div>
            </div>
          </div>
          <div id="document-queue" class="document-queue" data-testid="document-queue"></div>
          <div id="queue-empty" class="empty" hidden>No documents match this view.</div>
          <div id="queue-error" class="empty error-state" data-testid="queue-error" hidden>
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
              <button id="print" class="action" type="button">print</button>
              <button id="archive" class="action" type="button">archive</button>
            </div>
          </div>
          <header class="reader-heading">
            <span class="eyebrow">document</span>
            <h1 id="reader-title">Document</h1>
            <p id="reader-meta"></p>
          </header>
          <div id="reader-content" class="reader-content"></div>
        </article>
      </main>
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
