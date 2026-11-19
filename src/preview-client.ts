import { request } from "node:http";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { isPreviewInfo, type PreviewInfo } from "./preview-sessions.js";

/** Forward an editor's NDJSON stream over one authenticated local connection. */
export async function pipePreview(
  origin: string, token: string, documentId: string, input: Readable,
  onReceipt: (preview: PreviewInfo) => void, signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request(new URL(`/api/v1/documents/${documentId}/preview`, origin), {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/x-ndjson" },
      ...(signal ? { signal } : {}),
    }, (response) => {
      void (async () => {
        if (response.statusCode !== 200) {
          let message = "";
          for await (const chunk of response) {
            message += chunk.toString();
            if (message.length > 65536) break;
          }
          let reason = "Cannot start editor preview";
          try { reason = (JSON.parse(message) as { error: { message: string } }).error.message; } catch { /* use fallback */ }
          throw new Error(reason);
        }
        for await (const line of createInterface({ input: response })) {
          const value = JSON.parse(line) as { schemaVersion?: number; preview?: PreviewInfo };
          const preview = value.preview;
          if (value.schemaVersion !== 1 || !isPreviewInfo(preview) || preview.documentId !== documentId) {
            throw new Error("Invalid live preview receipt");
          }
          onReceipt(preview);
        }
      })().then(resolve, reject).finally(() => { input.unpipe(req); req.destroy(); });
    });
    const fail = (error: Error): void => { input.unpipe(req); req.destroy(); reject(error); };
    req.on("error", fail);
    input.once("error", fail);
    req.once("close", () => { input.off("error", fail); input.unpipe(req); });
    input.pipe(req);
  });
}
