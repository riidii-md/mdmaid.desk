import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_BYTES = MAX_PREVIEW_BYTES * 6 + 1024;
const MAX_SESSIONS = 32;

export interface PreviewViewport {
  progress: number;
  revision: number;
}
export interface PreviewInfo {
  id: string;
  documentId: string;
  version: number;
  route: string;
  viewport?: PreviewViewport;
}
interface PreviewUpdate { version: number; content?: string; scroll?: number }
interface Preview { info: PreviewInfo; content: string }

export class PreviewError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function copyInfo(info: PreviewInfo): PreviewInfo {
  return { ...info, ...(info.viewport ? { viewport: { ...info.viewport } } : {}) };
}

export function isPreviewInfo(value: unknown): value is PreviewInfo {
  if (typeof value !== "object" || value === null) return false;
  const info = value as Record<string, unknown>;
  const viewport = info.viewport as Partial<PreviewViewport> | undefined;
  return typeof info.id === "string" && /^preview-[a-f0-9]{32}$/.test(info.id)
    && typeof info.documentId === "string" && /^doc-[a-f0-9]{20}$/.test(info.documentId)
    && typeof info.version === "number" && Number.isSafeInteger(info.version) && info.version >= 1
    && info.route === `/d/${info.documentId}?preview=${info.id}`
    && (viewport === undefined || (typeof viewport === "object" && viewport !== null
      && typeof viewport.progress === "number" && Number.isFinite(viewport.progress)
      && viewport.progress >= 0 && viewport.progress <= 1
      && typeof viewport.revision === "number" && Number.isSafeInteger(viewport.revision) && viewport.revision >= 0));
}

export class PreviewSessions {
  readonly #sessions = new Map<string, Preview>();
  readonly #streams = new Set<IncomingMessage>();
  constructor(
    readonly onChange: () => void = () => undefined,
    readonly onScroll: () => void = () => undefined,
  ) {}

  create(documentId: string, value: unknown): PreviewInfo {
    if (!/^doc-[a-f0-9]{20}$/.test(documentId)) {
      throw new PreviewError(422, "invalid_preview", "Invalid document ID");
    }
    const update = validateUpdate(value);
    if (update.content === undefined) {
      throw new PreviewError(422, "invalid_preview", "An initial content snapshot is required");
    }
    if (this.#sessions.size >= MAX_SESSIONS) {
      throw new PreviewError(429, "preview_limit", "Too many live editor previews");
    }
    const id = "preview-" + randomBytes(16).toString("hex");
    const info: PreviewInfo = {
      id, documentId, version: update.version, route: `/d/${documentId}?preview=${id}`,
      viewport: { progress: update.scroll ?? 0, revision: 0 },
    };
    this.#sessions.set(id, { info, content: update.content });
    this.onChange();
    return copyInfo(info);
  }

  update(id: string, value: unknown): PreviewInfo {
    const update = validateUpdate(value);
    const current = this.#sessions.get(id);
    if (!current) throw new PreviewError(404, "preview_closed", "Live editor preview has closed");
    if (update.version < current.info.version) return copyInfo(current.info);
    if (update.version > current.info.version && update.content === undefined) {
      throw new PreviewError(409, "preview_version", "Scroll updates require the current buffer version");
    }
    if (update.version === current.info.version && update.content !== undefined && update.content !== current.content) {
      throw new PreviewError(409, "preview_version", "Changed content requires a newer buffer version");
    }
    const contentChanged = update.version > current.info.version;
    if (contentChanged) {
      current.info.version = update.version;
      current.content = update.content!;
    }
    const viewport = current.info.viewport!;
    const scrollChanged = update.scroll !== undefined && update.scroll !== viewport.progress;
    if (scrollChanged) {
      current.info.viewport = { progress: update.scroll!, revision: viewport.revision + 1 };
    }
    if (contentChanged) this.onChange();
    else if (scrollChanged) this.onScroll();
    return copyInfo(current.info);
  }

  get(id: string, documentId: string): Preview {
    const preview = this.#sessions.get(id);
    if (!preview || preview.info.documentId !== documentId) {
      throw new PreviewError(404, "preview_closed", "Live editor preview has closed; reopen it from your editor");
    }
    return { info: copyInfo(preview.info), content: preview.content };
  }

  delete(id: string): void {
    if (this.#sessions.delete(id)) this.onChange();
  }

  track(request: IncomingMessage): void { this.#streams.add(request); }
  untrack(request: IncomingMessage): void { this.#streams.delete(request); }
  close(): void {
    for (const request of this.#streams) request.destroy();
    this.#streams.clear();
    this.#sessions.clear();
  }
}

function validateUpdate(value: unknown): PreviewUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PreviewError(422, "invalid_preview", "Expected a buffer snapshot or scroll update");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["version", "content", "scroll"].includes(key)) ||
      typeof input.version !== "number" || !Number.isSafeInteger(input.version) || input.version < 1 ||
      (input.content === undefined && input.scroll === undefined) ||
      (input.content !== undefined && typeof input.content !== "string") ||
      (input.scroll !== undefined && (typeof input.scroll !== "number" || !Number.isFinite(input.scroll)
        || input.scroll < 0 || input.scroll > 1))) {
    throw new PreviewError(422, "invalid_preview", "Invalid buffer snapshot or scroll progress");
  }
  if (typeof input.content === "string" && Buffer.byteLength(input.content) > MAX_PREVIEW_BYTES) {
    throw new PreviewError(413, "payload_too_large", "Editor preview exceeds 2 MiB");
  }
  return {
    version: input.version,
    ...(typeof input.content === "string" ? { content: input.content } : {}),
    ...(typeof input.scroll === "number" ? { scroll: input.scroll } : {}),
  };
}

/** The request lifetime owns the draft. EOF, disconnect, or server close releases it. */
export async function servePreview(
  request: IncomingMessage, response: ServerResponse, documentId: string, sessions: PreviewSessions,
): Promise<void> {
  let info: PreviewInfo | undefined;
  let buffered = Buffer.alloc(0);
  const disconnect = (): void => { request.destroy(); };
  response.on("close", disconnect);
  sessions.track(request);
  const frame = async (bytes: Buffer): Promise<void> => {
    if (bytes.length === 0) return;
    if (bytes.length > MAX_FRAME_BYTES) throw new PreviewError(413, "payload_too_large", "Preview update is too large");
    let update: unknown;
    try { update = JSON.parse(bytes.toString("utf8")); }
    catch { throw new PreviewError(400, "invalid_preview", "Preview updates must be newline-delimited JSON"); }
    info = info ? sessions.update(info.id, update) : sessions.create(documentId, update);
    if (!response.headersSent) {
      response.statusCode = 200;
      response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
      response.setHeader("cache-control", "no-store");
    }
    if (!response.write(JSON.stringify({ schemaVersion: 1, preview: info }) + "\n")) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => { response.off("drain", drain); response.off("close", closed); };
        const drain = (): void => { cleanup(); resolve(); };
        const closed = (): void => { cleanup(); reject(new Error("Preview disconnected")); };
        response.once("drain", drain);
        response.once("close", closed);
      });
    }
  };
  try {
    for await (const chunk of request) {
      buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      let boundary = buffered.indexOf(10);
      while (boundary >= 0) {
        await frame(buffered.subarray(0, boundary));
        buffered = buffered.subarray(boundary + 1);
        boundary = buffered.indexOf(10);
      }
      if (buffered.length > MAX_FRAME_BYTES) throw new PreviewError(413, "payload_too_large", "Preview update is too large");
    }
    if (buffered.length) await frame(buffered);
    if (!info) throw new PreviewError(400, "invalid_preview", "An initial buffer update is required");
    response.end();
  } finally {
    response.off("close", disconnect);
    sessions.untrack(request);
    if (info) sessions.delete(info.id);
  }
}
