const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const IMAGE_DATA = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i;

export interface ExportDocument {
  document: { id: string; title: string };
  // HTML sanitized by the authenticated export endpoint.
  content: string;
}

export interface PreparedDocumentExport {
  title: string;
  html: string;
  root: HTMLElement;
  dispose(): void;
}

export function documentExportFilename(title: string): string {
  let name = title
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const characters = Array.from(name).slice(0, 120);
  while (new TextEncoder().encode(characters.join("")).length > 240) characters.pop();
  name = characters.join("").replace(/[.\s]+$/g, "") || "Document";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return `${name}.html`;
}

export function isExportImageSource(source: string, documentId: string): boolean {
  return IMAGE_DATA.test(source) || (
    /^doc-[a-f0-9]{20}$/.test(documentId) &&
    new RegExp(`^/d/${documentId}/media/source-[a-f0-9]{20}$`).test(source)
  );
}

export function selfContainedDocumentHtml(input: {
  title: string;
  theme: "light" | "dark";
  content: string;
  styles: string;
}): string {
  const title = input.title.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
  return `<!doctype html>
<html lang="en" data-theme="${input.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>${input.styles.replace(/</g, "\\3c ")}</style>
</head>
<body class="export-page">${input.content}</body>
</html>`;
}

export async function prepareDocumentExport(
  rendered: ExportDocument,
  theme: "light" | "dark",
): Promise<PreparedDocumentExport> {
  const root = document.createElement("article");
  root.className = "document-export";
  root.inert = true;
  root.setAttribute("aria-hidden", "true");
  const heading = document.createElement("header");
  heading.className = "reader-heading";
  const title = document.createElement("h1");
  title.textContent = rendered.document.title;
  heading.append(title);
  const content = document.createElement("div");
  content.className = "reader-content";
  content.innerHTML = rendered.content;
  root.append(heading, content);
  document.body.append(root);
  try {
    await withTimeout(document.fonts.ready, "The document font is not ready. Reload and try again.");
    const diagrams = Array.from(content.querySelectorAll(".mermaid"));
    if (diagrams.length > 0) {
      if (!window.mermaid) throw new Error("Diagrams are not ready. Reload and try again.");
      window.mermaid.initialize({
        startOnLoad: false, securityLevel: "strict",
        theme: theme === "dark" ? "dark" : "default",
        fontFamily: "Departure Mono, monospace",
      });
      await withTimeout(window.mermaid.run({ nodes: diagrams }), "A diagram could not be rendered for export.");
    }
    // Only document-scoped authenticated media may be fetched. Never turn an
    // arbitrary image URL in Markdown into a server or credentialed browser fetch.
    // Include pictures generated inside Mermaid SVGs as well as Markdown images.
    const images = Array.from(content.querySelectorAll("img, image, feImage"));
    let bytes = 0;
    const embedded = new Map<string, string>();
    for (const image of images) {
      const source = image.getAttribute("src") ?? image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? "";
      if (!isExportImageSource(source, rendered.document.id)) {
        throw new Error("Cannot export this picture. Use a workspace-local PNG, JPEG, GIF, WebP or SVG, or a base64 image.");
      }
      let data = embedded.get(source);
      if (data === undefined) {
        data = source.startsWith("data:") ? source : await imageData(source);
        embedded.set(source, data);
      }
      bytes += data.length;
      if (bytes > MAX_EXPORT_BYTES) throw new Error("Pictures exceed the 32 MiB export limit.");
      const decoder = image instanceof HTMLImageElement ? image : document.createElement("img");
      decoder.src = data;
      if (!(image instanceof HTMLImageElement)) {
        image.setAttribute("href", data);
        image.removeAttribute("xlink:href");
      }
      image.removeAttribute("loading");
      await withTimeout(decoder.decode(), "A picture could not be loaded for export.");
    }
    // Local source links have no destination in the exported file. Heading
    // anchors and deliberate external navigation remain usable offline.
    for (const link of Array.from(content.querySelectorAll("a[href]"))) {
      if (!/^(?:#|https?:|mailto:)/i.test(link.getAttribute("href") ?? "")) {
        link.replaceWith(...Array.from(link.childNodes));
      }
    }
    const [styles, font] = await Promise.all([
      exportAsset("/assets/app.css").then((response) => response.text()),
      exportAsset("/assets/departure-mono.woff2").then((response) => response.blob()),
    ]);
    const embeddedFont = await blobData(new Blob([font], { type: "font/woff2" }));
    const offlineStyles = styles.replace('url("/assets/departure-mono.woff2")', `url("${embeddedFont}")`);
    const snapshot = root.cloneNode(true) as HTMLElement;
    snapshot.removeAttribute("aria-hidden");
    snapshot.removeAttribute("inert");
    return {
      title: rendered.document.title,
      root,
      html: selfContainedDocumentHtml({
        title: rendered.document.title, theme, content: snapshot.outerHTML, styles: offlineStyles,
      }),
      dispose: () => root.remove(),
    };
  } catch (error) {
    root.remove();
    throw error;
  }
}

export function downloadDocumentHtml(prepared: PreparedDocumentExport): void {
  const url = URL.createObjectURL(new Blob([prepared.html], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = documentExportFilename(prepared.title);
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser time to acquire the Blob before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function printDocumentExport(
  prepared: PreparedDocumentExport,
  print: () => void,
): Promise<void> {
  const previousTitle = document.title;
  document.title = documentExportFilename(prepared.title).slice(0, -5);
  document.body.classList.add("printing-export");
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      window.removeEventListener("afterprint", finish);
      document.body.classList.remove("printing-export");
      document.title = previousTitle;
    };
    const finish = (): void => {
      cleanup();
      resolve();
    };
    window.addEventListener("afterprint", finish, { once: true });
    try {
      print();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function exportAsset(path: string): Promise<Response> {
  const response = await fetch(path, {
    credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("An export asset is unavailable. Reload and try again.");
  return response;
}

async function imageData(path: string): Promise<string> {
  const response = await exportAsset(path);
  const blob = await response.blob();
  if (blob.size > MAX_EXPORT_BYTES || !/^image\/(?:png|jpeg|gif|webp|svg\+xml)$/.test(blob.type)) {
    throw new Error("A picture has an unsupported type or is too large for export.");
  }
  const data = await blobData(blob);
  if (!IMAGE_DATA.test(data)) throw new Error("A picture could not be embedded for export.");
  return data;
}

function blobData(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("An export asset could not be embedded."));
    reader.readAsDataURL(blob);
  });
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), 15_000); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
