import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import { fromMarkdown } from "mdast-util-from-markdown";

import type { DocumentSourceLink } from "./domain.js";

const EXTERNAL_SCHEME = /^(?:https?|mailto):/i;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SOURCE_LINK_ID = /^source-[a-f0-9]{20}$/;
const MAX_SOURCE_LINKS = 512;
const MAX_HREF_LENGTH = 4096;

interface DiscoverSourceLinksInput {
  content: Buffer;
  documentId: string;
  documentPath: string;
  workspaceRoot: string;
}

export async function discoverDocumentSourceLinks(
  input: DiscoverSourceLinksInput,
): Promise<DocumentSourceLink[]> {
  const hrefs = collectLinkHrefs(input.content);
  if (hrefs.length > MAX_SOURCE_LINKS) {
    throw new Error(`document contains more than ${MAX_SOURCE_LINKS} links`);
  }
  const links: DocumentSourceLink[] = [];

  for (const href of hrefs) {
    if (href.length > MAX_HREF_LENGTH) {
      throw new Error("document source link is too long");
    }
    const hrefPath = localHrefPath(href);
    if (hrefPath === undefined) {
      continue;
    }
    const requestedPath = isAbsolute(hrefPath)
      ? resolve(hrefPath)
      : resolve(dirname(input.documentPath), hrefPath);
    if (!isWithin(input.workspaceRoot, requestedPath)) {
      throw new Error("local source link is outside workspace root");
    }

    try {
      const info = await lstat(requestedPath);
      if (info.isSymbolicLink()) {
        throw new Error("local source link must not be a symlink");
      }
      if (!info.isFile()) {
        throw new Error("local source link must target a regular file");
      }
      const canonicalPath = await realpath(requestedPath);
      if (!isWithin(input.workspaceRoot, canonicalPath)) {
        throw new Error("local source link is outside workspace root");
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }

    const workspacePath = relative(input.workspaceRoot, requestedPath);
    links.push({
      id: sourceLinkId(input.documentId, href),
      href,
      workspacePath,
    });
  }

  return links.sort((left, right) => left.href.localeCompare(right.href));
}

export function validateSourceLinkId(id: string): void {
  if (typeof id !== "string" || !SOURCE_LINK_ID.test(id)) {
    throw new Error("invalid document source link id");
  }
}

export function isSafeWorkspacePath(path: string): boolean {
  if (path === "" || isAbsolute(path)) {
    return false;
  }
  const normalized = relative(".", path);
  return (
    normalized !== ".." &&
    !normalized.startsWith(`..${sep}`) &&
    !isAbsolute(normalized)
  );
}

function collectLinkHrefs(content: Buffer): string[] {
  const tree = fromMarkdown(content);
  const hrefs = new Set<string>();
  const definitions = new Map<string, string>();
  const references = new Set<string>();
  const visit = (node: unknown): void => {
    if (!isRecord(node)) {
      return;
    }
    if (node.type === "link" && typeof node.url === "string") {
      hrefs.add(node.url);
    }
    if (
      node.type === "definition" &&
      typeof node.identifier === "string" &&
      typeof node.url === "string"
    ) {
      definitions.set(node.identifier, node.url);
    }
    if (
      node.type === "linkReference" &&
      typeof node.identifier === "string"
    ) {
      references.add(node.identifier);
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(tree);
  for (const identifier of references) {
    const href = definitions.get(identifier);
    if (href !== undefined) {
      hrefs.add(href);
    }
  }
  return [...hrefs];
}

function localHrefPath(href: string): string | undefined {
  if (
    href === "" ||
    href.startsWith("#") ||
    href.startsWith("//") ||
    EXTERNAL_SCHEME.test(href) ||
    URI_SCHEME.test(href)
  ) {
    return undefined;
  }
  const hash = href.indexOf("#");
  const query = href.indexOf("?");
  const end = Math.min(
    hash === -1 ? href.length : hash,
    query === -1 ? href.length : query,
  );
  const encodedPath = href.slice(0, end);
  if (encodedPath === "") {
    return undefined;
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    throw new Error("local source link contains invalid encoding");
  }
  if (decodedPath.includes("\0")) {
    throw new Error("local source link contains invalid characters");
  }
  return decodedPath;
}

function sourceLinkId(documentId: string, href: string): string {
  const hash = createHash("sha256")
    .update(documentId)
    .update("\0")
    .update(href)
    .digest("hex")
    .slice(0, 20);
  return `source-${hash}`;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
