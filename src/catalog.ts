import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export const CATALOG_SCHEMA_VERSION = 1;
const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const DOCUMENT_KINDS = new Set<string>([
  "definition",
  "brief",
  "research",
  "decision",
  "plan",
  "contract",
  "handoff",
  "progress",
  "verification",
  "review",
  "pr",
  "showcase",
  "other",
]);
const ATTENTION_STATES = new Set<string>([
  "none",
  "review",
  "approval",
  "failure",
  "changes_requested",
]);

export type DocumentKind =
  | "definition"
  | "brief"
  | "research"
  | "decision"
  | "plan"
  | "contract"
  | "handoff"
  | "progress"
  | "verification"
  | "review"
  | "pr"
  | "showcase"
  | "other";

export type Attention =
  | "none"
  | "review"
  | "approval"
  | "failure"
  | "changes_requested";

export interface Workspace {
  id: string;
  name: string;
  root: string;
  artifactRoots: string[];
}

export interface Document {
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

interface CatalogState {
  schemaVersion: number;
  workspaces: Workspace[];
  documents: Document[];
}

export interface CatalogOptions {
  maxDocumentBytes?: number;
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
  kind: DocumentKind;
  title: string;
  path: string;
  attention: Attention;
}

export class Catalog {
  readonly #statePath: string;
  readonly #maxDocumentBytes: number;
  #state: CatalogState;
  #writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    statePath: string,
    state: CatalogState,
    options: CatalogOptions,
  ) {
    this.#statePath = resolve(statePath);
    this.#state = state;
    this.#maxDocumentBytes =
      options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  }

  static async open(
    statePath: string,
    options: CatalogOptions = {},
  ): Promise<Catalog> {
    if (
      options.maxDocumentBytes !== undefined &&
      (!Number.isSafeInteger(options.maxDocumentBytes) ||
        options.maxDocumentBytes <= 0)
    ) {
      throw new Error("maxDocumentBytes must be a positive integer");
    }
    const state = await loadState(resolve(statePath));
    return new Catalog(statePath, state, options);
  }

  listWorkspaces(): Workspace[] {
    return structuredClone(this.#state.workspaces);
  }

  listDocuments(): Document[] {
    return structuredClone(this.#state.documents);
  }

  async addWorkspace(input: AddWorkspaceInput): Promise<Workspace> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id)) {
      throw new Error(
        "workspace id must use lowercase letters, digits, and hyphens",
      );
    }
    if (input.name.trim() === "") {
      throw new Error("workspace name is required");
    }
    if (input.artifactRoots.length === 0) {
      throw new Error("workspace requires at least one artifact root");
    }

    const root = await canonicalDirectory(input.root, "workspace root");
    const artifactRoots: string[] = [];
    for (const candidate of input.artifactRoots) {
      const artifactRoot = await canonicalDirectory(
        candidate,
        "artifact root",
      );
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
    const excludedDocument = this.#state.documents.find(
      (document) =>
        document.workspaceId === workspace.id &&
        !workspace.artifactRoots.some((artifactRoot) =>
          isWithin(artifactRoot, document.path),
        ),
    );
    if (excludedDocument) {
      throw new Error(
        `workspace update would exclude registered document ${excludedDocument.id}`,
      );
    }
    const existing = this.#state.workspaces.findIndex(
      (entry) => entry.id === workspace.id,
    );
    if (
      existing >= 0 &&
      this.#state.workspaces[existing]?.root !== workspace.root
    ) {
      throw new Error(`workspace ${workspace.id} already uses another root`);
    }
    if (existing >= 0) {
      this.#state.workspaces[existing] = workspace;
    } else {
      this.#state.workspaces.push(workspace);
    }
    await this.#persist();
    return structuredClone(workspace);
  }

  async registerDocument(input: RegisterDocumentInput): Promise<Document> {
    const workspace = this.#state.workspaces.find(
      (entry) => entry.id === input.workspaceId,
    );
    if (!workspace) {
      throw new Error(`unknown workspace ${input.workspaceId}`);
    }
    if (input.title.trim() === "") {
      throw new Error("document title is required");
    }

    const requestedPath = resolve(input.path);
    if (extname(requestedPath).toLowerCase() !== ".md") {
      throw new Error("only Markdown files can be registered");
    }
    const requestedInfo = await lstat(requestedPath);
    if (requestedInfo.isSymbolicLink()) {
      throw new Error("document path must not be a symlink");
    }

    const documentPath = await realpath(requestedPath);
    const documentInfo = await stat(documentPath);
    if (!documentInfo.isFile()) {
      throw new Error("document must be a regular file");
    }
    if (documentInfo.size > this.#maxDocumentBytes) {
      throw new Error(
        `document exceeds ${this.#maxDocumentBytes} bytes`,
      );
    }
    if (
      !workspace.artifactRoots.some((artifactRoot) =>
        isWithin(artifactRoot, documentPath),
      )
    ) {
      throw new Error("document is outside registered artifact roots");
    }

    const id = documentId(input.workspaceId, documentPath);
    const existing = this.#state.documents.find(
      (document) => document.id === id,
    );
    const now = new Date().toISOString();
    const document: Document = {
      id,
      workspaceId: input.workspaceId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      kind: input.kind,
      title: input.title.trim(),
      path: documentPath,
      attention: input.attention,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (existing) {
      const index = this.#state.documents.indexOf(existing);
      this.#state.documents[index] = document;
    } else {
      this.#state.documents.push(document);
    }
    await this.#persist();
    return structuredClone(document);
  }

  async #persist(): Promise<void> {
    const serialized = `${JSON.stringify(this.#state, null, 2)}\n`;
    const operation = this.#writeQueue.then(() =>
      atomicWrite(this.#statePath, serialized),
    );
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
  }
}

async function loadState(path: string): Promise<CatalogState> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("catalog state must be a regular file");
    }
    if (info.size > MAX_CATALOG_BYTES) {
      throw new Error(`catalog state exceeds ${MAX_CATALOG_BYTES} bytes`);
    }
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return validateState(parsed);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        workspaces: [],
        documents: [],
      };
    }
    throw error;
  }
}

function validateState(value: unknown): CatalogState {
  if (!isRecord(value)) {
    throw new Error("catalog state must be an object");
  }
  if (!hasOnlyKeys(value, ["schemaVersion", "workspaces", "documents"])) {
    throw new Error("catalog state contains unknown fields");
  }
  if (value.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new Error(`unsupported catalog schema ${String(value.schemaVersion)}`);
  }
  if (!Array.isArray(value.workspaces) || !Array.isArray(value.documents)) {
    throw new Error("catalog state is missing workspace or document arrays");
  }

  const workspaces = value.workspaces.map(validateWorkspace);
  const workspaceIds = new Set<string>();
  for (const workspace of workspaces) {
    if (workspaceIds.has(workspace.id)) {
      throw new Error(`duplicate workspace ${workspace.id}`);
    }
    workspaceIds.add(workspace.id);
  }

  const documents = value.documents.map(validateDocument);
  const documentIds = new Set<string>();
  for (const document of documents) {
    if (documentIds.has(document.id)) {
      throw new Error(`duplicate document ${document.id}`);
    }
    documentIds.add(document.id);
    const workspace = workspaces.find(
      (entry) => entry.id === document.workspaceId,
    );
    if (!workspace) {
      throw new Error(
        `document ${document.id} references an unknown workspace`,
      );
    }
    if (
      !workspace.artifactRoots.some((root) =>
        isWithin(root, document.path),
      )
    ) {
      throw new Error(
        `document ${document.id} is outside registered artifact roots`,
      );
    }
  }

  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    workspaces,
    documents,
  };
}

function validateWorkspace(value: unknown): Workspace {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "name", "root", "artifactRoots"]) ||
    typeof value.id !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id) ||
    typeof value.name !== "string" ||
    value.name.trim() === "" ||
    typeof value.root !== "string" ||
    !isAbsolute(value.root) ||
    !isStringArray(value.artifactRoots) ||
    value.artifactRoots.length === 0 ||
    value.artifactRoots.some(
      (artifactRoot) =>
        !isAbsolute(artifactRoot) || !isWithin(value.root as string, artifactRoot),
    )
  ) {
    throw new Error("invalid workspace entry in catalog state");
  }
  return {
    id: value.id,
    name: value.name,
    root: value.root,
    artifactRoots: [...value.artifactRoots],
  };
}

function validateDocument(value: unknown): Document {
  const requiredKeys = [
    "id",
    "workspaceId",
    "kind",
    "title",
    "path",
    "attention",
    "createdAt",
    "updatedAt",
  ];
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [...requiredKeys, "taskId"]) ||
    typeof value.id !== "string" ||
    !/^doc-[a-f0-9]{20}$/.test(value.id) ||
    typeof value.workspaceId !== "string" ||
    (value.taskId !== undefined && typeof value.taskId !== "string") ||
    typeof value.kind !== "string" ||
    !DOCUMENT_KINDS.has(value.kind) ||
    typeof value.title !== "string" ||
    value.title.trim() === "" ||
    typeof value.path !== "string" ||
    !isAbsolute(value.path) ||
    extname(value.path).toLowerCase() !== ".md" ||
    typeof value.attention !== "string" ||
    !ATTENTION_STATES.has(value.attention) ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== "string" ||
    Number.isNaN(Date.parse(value.updatedAt))
  ) {
    throw new Error("invalid document entry in catalog state");
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    ...(value.taskId ? { taskId: value.taskId } : {}),
    kind: value.kind as DocumentKind,
    title: value.title,
    path: value.path,
    attention: value.attention as Attention,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
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

async function atomicWrite(path: string, content: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(tempPath, path);
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
