/* mdmaid.desk web client */

import type {
  ChangeReviewDiff,
  PublicDocument,
  PublicReviewRequest,
  PublicWorkspace,
  ReadingStatus,
  ReviewFeedbackItem,
  ReviewOutcome,
} from "./api-types.js";
import type {
  ChangeLineKind,
  ChangeReviewHunk,
  ChangeReviewLine,
} from "./change-review.js";

export type WebReadingStatus = ReadingStatus;
export type WebDocument = PublicDocument;
export type WebWorkspace = PublicWorkspace;
export type WebReviewRequest = PublicReviewRequest;
export type WebQueueGrouping = "project" | "tag" | "all";

export interface WebFilters {
  workspaceId?: string | undefined;
  status?: WebReadingStatus | "all" | undefined;
  search?: string | undefined;
  actionsOnly?: boolean | undefined;
  changeReviewsOnly?: boolean | undefined;
}

export interface WebProjectQueueSelection {
  filters: WebFilters;
  route: string;
}

export interface WebDiffCell {
  kind: ChangeLineKind;
  line: number | null;
  prefix: string;
  changed: string;
  suffix: string;
}

export interface WebDiffRow {
  old?: WebDiffCell;
  new?: WebDiffCell;
}

export interface WebDiffLineControlModel {
  lineText: string;
  feedbackMarker?: string;
  feedbackLabel?: string;
}

export const WEB_LINE_FEEDBACK_HINT =
  "Line feedback: click + beside a line; Shift-click another same-side line for a range.";

export function webDiffLineControlModel(
  line: number | null,
  side: "old" | "new",
  feedbackEnabled: boolean,
): WebDiffLineControlModel {
  if (line === null) {
    return { lineText: "" };
  }
  const lineText = String(line);
  return feedbackEnabled
    ? {
        lineText,
        feedbackMarker: "+",
        feedbackLabel: `Add feedback on ${side} line ${line}`,
      }
    : { lineText };
}

export type WebSyntaxKind =
  | "plain"
  | "comment"
  | "function"
  | "keyword"
  | "literal"
  | "number"
  | "operator"
  | "property"
  | "string"
  | "type";

export interface WebSyntaxToken {
  kind: WebSyntaxKind;
  text: string;
}

export interface WebMermaidRenderer {
  run(options: { nodes: Element[] }): Promise<void>;
}

export interface DocumentOutlineItem {
  id: string;
  level: number;
  text: string;
}

export interface HeadingPosition {
  id: string;
  top: number;
}

export interface LiveSourceCatalogEvent {
  action: "source-changed" | "source-missing" | "source-restored";
  documentId: string;
  revision: number;
}

export interface WebDocumentGroup {
  key: string;
  label?: string;
  documents: WebDocument[];
}

export interface WebLoadFailure {
  guidance: string;
  liveStatus: string;
  title: string;
}

export interface ReviewDraftStorage {
  readonly length?: number;
  key?(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WebReviewDraft {
  message: string;
  items: ReviewFeedbackItem[];
}

export interface WebReviewDraftActivation {
  requestId: string;
  resetComposer: true;
  draft: WebReviewDraft;
}

interface DocumentHeading {
  id: string;
  tagName: string;
  textContent: string | null;
}

interface PrintTarget {
  print(): void;
}

type SyntaxLanguage =
  | "c-like"
  | "css"
  | "go"
  | "javascript"
  | "json"
  | "markup"
  | "markdown"
  | "python"
  | "ruby"
  | "rust"
  | "shell"
  | "sql"
  | "yaml";

const SYNTAX_LANGUAGE_BY_EXTENSION: Readonly<Record<string, SyntaxLanguage>> = {
  bash: "shell",
  c: "c-like",
  cc: "c-like",
  cjs: "javascript",
  cpp: "c-like",
  cs: "c-like",
  css: "css",
  cts: "javascript",
  go: "go",
  h: "c-like",
  hpp: "c-like",
  htm: "markup",
  html: "markup",
  java: "c-like",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "c-like",
  kts: "c-like",
  less: "css",
  md: "markdown",
  markdown: "markdown",
  mjs: "javascript",
  mts: "javascript",
  php: "c-like",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "css",
  sh: "shell",
  sql: "sql",
  svg: "markup",
  swift: "c-like",
  ts: "javascript",
  tsx: "javascript",
  xml: "markup",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shell",
};

const SYNTAX_KEYWORDS: Readonly<Record<SyntaxLanguage, ReadonlySet<string>>> = {
  "c-like": new Set([
    "abstract", "as", "async", "await", "break", "case", "catch", "class",
    "const", "continue", "default", "do", "else", "enum", "extends", "final",
    "finally", "for", "foreach", "if", "implements", "import", "in", "interface",
    "namespace", "new", "override", "package", "private", "protected", "public",
    "return", "static", "struct", "switch", "throw", "throws", "try", "using",
    "var", "while", "yield",
  ]),
  css: new Set(["@import", "@media", "from", "to"]),
  go: new Set([
    "break", "case", "chan", "const", "continue", "default", "defer", "else",
    "fallthrough", "for", "func", "go", "goto", "if", "import", "interface",
    "map", "package", "range", "return", "select", "struct", "switch", "type",
    "var",
  ]),
  javascript: new Set([
    "as", "async", "await", "break", "case", "catch", "class", "const",
    "continue", "debugger", "default", "delete", "do", "else", "export",
    "extends", "finally", "for", "from", "function", "get", "if", "implements",
    "import", "in", "instanceof", "interface", "let", "new", "of", "private",
    "protected", "public", "readonly", "return", "set", "static", "switch",
    "throw", "try", "type", "typeof", "var", "void", "while", "with", "yield",
  ]),
  json: new Set(),
  markdown: new Set(),
  markup: new Set(),
  python: new Set([
    "and", "as", "assert", "async", "await", "break", "class", "continue",
    "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
    "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass",
    "raise", "return", "try", "while", "with", "yield",
  ]),
  ruby: new Set([
    "alias", "begin", "break", "case", "class", "def", "defined", "do", "else",
    "elsif", "end", "ensure", "for", "if", "in", "module", "next", "redo",
    "rescue", "retry", "return", "self", "super", "then", "undef", "unless",
    "until", "when", "while", "yield",
  ]),
  rust: new Set([
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else",
    "enum", "extern", "fn", "for", "if", "impl", "in", "let", "loop", "match",
    "mod", "move", "mut", "pub", "ref", "return", "self", "static", "struct",
    "super", "trait", "type", "unsafe", "use", "where", "while",
  ]),
  shell: new Set([
    "case", "do", "done", "elif", "else", "esac", "export", "fi", "for",
    "function", "if", "in", "local", "readonly", "select", "then", "until",
    "while",
  ]),
  sql: new Set([
    "alter", "and", "as", "asc", "begin", "by", "case", "create", "delete",
    "desc", "distinct", "drop", "else", "end", "from", "group", "having",
    "in", "index", "inner", "insert", "into", "is", "join", "left", "limit",
    "not", "null", "offset", "on", "or", "order", "outer", "returning", "right",
    "select", "set", "table", "then", "union", "update", "values", "when", "where",
  ]),
  yaml: new Set(),
};

const SYNTAX_LITERALS = new Set([
  "false", "nil", "none", "null", "true", "undefined",
]);
const SYNTAX_TYPES = new Set([
  "any", "bool", "boolean", "byte", "char", "double", "error", "float",
  "int", "integer", "never", "number", "object", "short", "string", "symbol",
  "unknown", "void",
]);

export function highlightDiffLine(path: string, source: string): WebSyntaxToken[] {
  const basename = path.split("/").at(-1)?.toLowerCase() ?? "";
  const extension = basename.includes(".") ? basename.split(".").at(-1) ?? "" : "";
  const language = basename === "dockerfile" || basename === "makefile"
    ? "shell"
    : SYNTAX_LANGUAGE_BY_EXTENSION[extension];
  if (!language || source === "") {
    return source === "" ? [] : [{ kind: "plain", text: source }];
  }

  const tokens: WebSyntaxToken[] = [];
  const push = (kind: WebSyntaxKind, text: string): void => {
    if (text === "") return;
    const previous = tokens.at(-1);
    if (previous?.kind === kind) previous.text += text;
    else tokens.push({ kind, text });
  };
  const lineComment = language === "python" || language === "ruby" ||
      language === "shell" || language === "yaml"
    ? "#"
    : language === "sql"
      ? "--"
      : language === "javascript" || language === "c-like" ||
          language === "go" || language === "rust"
        ? "//"
        : undefined;
  const keywords = SYNTAX_KEYWORDS[language];
  let cursor = 0;
  while (cursor < source.length) {
    if (lineComment && source.startsWith(lineComment, cursor)) {
      push("comment", source.slice(cursor));
      break;
    }
    if (source.startsWith("/*", cursor)) {
      const close = source.indexOf("*/", cursor + 2);
      const end = close === -1 ? source.length : close + 2;
      push("comment", source.slice(cursor, end));
      cursor = end;
      continue;
    }

    const character = source[cursor] ?? "";
    if (character === '"' || character === "'" || character === "`") {
      let end = cursor + 1;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        const candidate = source[end];
        end += 1;
        if (candidate === character) break;
      }
      push("string", source.slice(cursor, end));
      cursor = end;
      continue;
    }

    const tail = source.slice(cursor);
    const number = tail.match(/^(?:0[xob][\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i)?.[0];
    if (number) {
      push("number", number);
      cursor += number.length;
      continue;
    }
    const identifier = tail.match(/^[A-Za-z_$][\w$]*/)?.[0];
    if (identifier) {
      const after = source.slice(cursor + identifier.length);
      const normalized = language === "sql" ? identifier.toLowerCase() : identifier;
      let kind: WebSyntaxKind = "plain";
      if (keywords.has(normalized)) kind = "keyword";
      else if (SYNTAX_LITERALS.has(normalized.toLowerCase())) kind = "literal";
      else if (SYNTAX_TYPES.has(normalized.toLowerCase()) || /^[A-Z][\w$]*$/.test(identifier)) {
        kind = "type";
      } else if (/^\s*\(/.test(after)) kind = "function";
      else if (/^\s*:/.test(after)) kind = "property";
      push(kind, identifier);
      cursor += identifier.length;
      continue;
    }
    if (/[{}()[\],;:?=+\-*/%<>!&|^~@]/.test(character)) {
      push("operator", character);
    } else {
      push("plain", character);
    }
    cursor += 1;
  }
  return tokens;
}

interface RenderedDocument {
  document: WebDocument;
  target: "web";
  content: string;
  changeReview?: ChangeReviewDiff;
}

interface WebState {
  documents: WebDocument[];
  filters: WebFilters;
  grouping: WebQueueGrouping;
  reviewRequests: WebReviewRequest[];
  selectedId: string | undefined;
  workspaces: WebWorkspace[];
}

export interface WebFeedbackAnchor {
  path: string;
  hunkId?: string;
  line?: number;
  endLine?: number;
  side?: "old" | "new";
}

class WebApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WebApiError";
  }
}

declare global {
  interface Window {
    mermaid?: {
      initialize(options: Record<string, unknown>): void;
      run(options: { nodes: Element[] }): Promise<void>;
    };
  }
}

export function filterQueue(
  documents: WebDocument[],
  filters: WebFilters,
  reviewRequests: WebReviewRequest[] = [],
): WebDocument[] {
  const terms = (filters.search ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return documents.filter((document) => {
    if (
      filters.changeReviewsOnly === true &&
      document.kind !== "change-review"
    ) {
      return false;
    }
    if (
      filters.changeReviewsOnly !== true &&
      filters.actionsOnly !== true &&
      document.kind === "change-review"
    ) {
      return false;
    }
    if (
      filters.actionsOnly === true &&
      pendingReviewForDocument(reviewRequests, document.id) === undefined
    ) {
      return false;
    }
    if (
      filters.workspaceId !== undefined &&
      (document.projectId ?? document.workspaceId) !== filters.workspaceId &&
      document.workspaceId !== filters.workspaceId
    ) {
      return false;
    }
    if (
      filters.status !== undefined &&
      filters.status !== "all" &&
      document.status !== filters.status
    ) {
      return false;
    }
    if (terms.length === 0) {
      return true;
    }
    const haystack = [
      document.title,
      document.projectName ?? "",
      document.workspaceId,
      document.taskId ?? "",
      document.producer ?? "",
      document.kind,
      document.storage,
      document.attention,
      ...document.tags,
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function projectQueueSelection(
  filters: WebFilters,
  workspace: Pick<WebWorkspace, "id" | "route"> | undefined,
): WebProjectQueueSelection {
  return {
    filters: {
      ...filters,
      workspaceId: workspace?.id,
      actionsOnly: false,
      changeReviewsOnly: false,
    },
    route: workspace?.route ?? "/",
  };
}

export function projectQueueRoute(
  workspaceId: string | undefined,
  workspaces: readonly WebWorkspace[],
): string {
  return workspaces.find(({ id }) => id === workspaceId)?.route ?? "/";
}

export function queueHistoryState(
  filters: WebFilters,
): { space?: "actions" | "change-reviews" } {
  if (filters.changeReviewsOnly === true) {
    return { space: "change-reviews" };
  }
  return filters.actionsOnly === true ? { space: "actions" } : {};
}

export function documentHistoryState(
  documentId: string,
  filters: WebFilters,
  workspaces: readonly WebWorkspace[],
): { documentId: string; queueRoute: string; space?: "actions" | "change-reviews" } {
  return {
    documentId,
    queueRoute: projectQueueRoute(filters.workspaceId, workspaces),
    ...queueHistoryState(filters),
  };
}

export function projectQueueSelectionForReaderHistory(
  filters: WebFilters,
  historyState: unknown,
  workspaces: readonly WebWorkspace[],
): WebProjectQueueSelection | undefined {
  if (!isRecord(historyState) || typeof historyState.queueRoute !== "string") {
    return undefined;
  }
  return projectQueueSelectionForRoute(
    filters,
    historyState.queueRoute,
    workspaces,
    historyState,
  );
}

export function actionsQueueTransition(
  filters: WebFilters,
  readerOpen: boolean,
  workspaces: readonly WebWorkspace[],
): WebProjectQueueSelection & {
  historyState: { space?: "actions" | "change-reviews" };
  pushHistory: boolean;
} {
  const actionsOnly = filters.actionsOnly !== true;
  const nextFilters = { ...filters, actionsOnly, changeReviewsOnly: false };
  return {
    filters: nextFilters,
    route: projectQueueRoute(filters.workspaceId, workspaces),
    historyState: queueHistoryState(nextFilters),
    pushHistory: readerOpen,
  };
}

export function projectQueueSelectionForRoute(
  filters: WebFilters,
  route: string,
  workspaces: readonly WebWorkspace[],
  historyState?: unknown,
): WebProjectQueueSelection | undefined {
  let selection: WebProjectQueueSelection | undefined;
  if (route === "/") {
    selection = projectQueueSelection(filters, undefined);
  } else {
    const workspace = workspaces.find((candidate) => candidate.route === route);
    if (workspace) {
      selection = projectQueueSelection(filters, workspace);
    } else if (
      /^\/w\/[a-z0-9][a-z0-9-]{0,63}$/.test(route) ||
      /^\/p\/project-[a-f0-9]{20}$/.test(route)
    ) {
      selection = projectQueueSelection(filters, undefined);
    }
  }
  if (!selection || !isRecord(historyState)) {
    return selection;
  }
  if (route === "/" && historyState.space === "change-reviews") {
    return {
      ...selection,
      filters: { ...selection.filters, changeReviewsOnly: true },
    };
  }
  if (historyState.space === "actions") {
    return {
      ...selection,
      filters: { ...selection.filters, actionsOnly: true },
    };
  }
  return selection;
}

export function webDiffRows(hunk: ChangeReviewHunk): WebDiffRow[] {
  const rows: WebDiffRow[] = [];
  for (let index = 0; index < hunk.lines.length; index += 1) {
    const line = hunk.lines[index]!;
    const next = hunk.lines[index + 1];
    if (line.kind === "deletion" && next?.kind === "addition") {
      const segments = webChangedSegments(line.text, next.text);
      rows.push({
        old: diffCell(line, segments.prefix, segments.oldChanged, segments.suffix),
        new: diffCell(next, segments.prefix, segments.newChanged, segments.suffix),
      });
      index += 1;
    } else if (line.kind === "context") {
      rows.push({
        old: diffCell(line, line.text, "", ""),
        new: diffCell(line, line.text, "", ""),
      });
    } else if (line.kind === "deletion") {
      rows.push({ old: diffCell(line, line.text, "", "") });
    } else {
      rows.push({ new: diffCell(line, line.text, "", "") });
    }
  }
  return rows;
}

export function changeReviewApprovalError(
  changeReview: ChangeReviewDiff | undefined,
): string | undefined {
  if (changeReview && changeReview.warnings.length > 0) {
    return "This native diff is incomplete and cannot be approved.";
  }
  if (!changeReview || changeReview.files.length === 0) {
    return "A complete native diff is required before approval.";
  }
  return undefined;
}

function diffCell(
  line: ChangeReviewLine,
  prefix: string,
  changed: string,
  suffix: string,
): WebDiffCell {
  return {
    kind: line.kind,
    line: line.kind === "addition" ? line.newLine : line.oldLine,
    prefix,
    changed,
    suffix,
  };
}

function webChangedSegments(oldText: string, newText: string): {
  prefix: string;
  oldChanged: string;
  newChanged: string;
  suffix: string;
} {
  const oldCharacters = Array.from(oldText);
  const newCharacters = Array.from(newText);
  let prefixLength = 0;
  while (
    prefixLength < oldCharacters.length &&
    prefixLength < newCharacters.length &&
    oldCharacters[prefixLength] === newCharacters[prefixLength]
  ) {
    prefixLength += 1;
  }
  let suffixLength = 0;
  while (
    suffixLength < oldCharacters.length - prefixLength &&
    suffixLength < newCharacters.length - prefixLength &&
    oldCharacters[oldCharacters.length - suffixLength - 1] ===
      newCharacters[newCharacters.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }
  return {
    prefix: oldCharacters.slice(0, prefixLength).join(""),
    oldChanged: oldCharacters
      .slice(prefixLength, oldCharacters.length - suffixLength)
      .join(""),
    newChanged: newCharacters
      .slice(prefixLength, newCharacters.length - suffixLength)
      .join(""),
    suffix: suffixLength === 0
      ? ""
      : oldCharacters.slice(oldCharacters.length - suffixLength).join(""),
  };
}

export function pendingReviewForDocument(
  reviewRequests: WebReviewRequest[],
  documentId: string,
): WebReviewRequest | undefined {
  return reviewRequests.find(
    (request) =>
      request.documentId === documentId && request.status === "pending",
  );
}

export function feedbackAnchorLabel(anchor: WebFeedbackAnchor): string {
  if (anchor.line !== undefined && anchor.side !== undefined) {
    const lines = anchor.endLine === undefined
      ? String(anchor.line)
      : `${anchor.line}-${anchor.endLine}`;
    return `${anchor.path}:${lines} (${anchor.side})`;
  }
  return anchor.hunkId ? `${anchor.path}#${anchor.hunkId}` : anchor.path;
}

export function feedbackAnchorContainsLine(
  feedback: WebFeedbackAnchor,
  anchor: Required<Pick<WebFeedbackAnchor, "path" | "hunkId" | "line" | "side">>,
): boolean {
  return feedback.path === anchor.path &&
    feedback.hunkId === anchor.hunkId &&
    feedback.side === anchor.side &&
    feedback.line !== undefined &&
    feedback.line <= anchor.line &&
    (feedback.endLine ?? feedback.line) >= anchor.line;
}

export function feedbackEndingAtLine<T extends ReviewFeedbackItem>(
  items: readonly T[],
  anchor: Required<Pick<WebFeedbackAnchor, "path" | "hunkId" | "line" | "side">>,
): T[] {
  return items.filter((item) =>
    item.path === anchor.path &&
    item.hunkId === anchor.hunkId &&
    item.side === anchor.side &&
    (item.endLine ?? item.line) === anchor.line
  );
}

export function reviewResponseError(
  outcome: ReviewOutcome,
  message: string,
  items: readonly ReviewFeedbackItem[] = [],
): string | undefined {
  return outcome === "changes_requested" &&
      message.trim() === "" &&
      items.length === 0
    ? "Explain what needs to change."
    : undefined;
}

export function upsertReviewDraftFeedback(
  draft: WebReviewDraft,
  item: ReviewFeedbackItem,
): WebReviewDraft {
  const index = draft.items.findIndex(({ id }) => id === item.id);
  return {
    message: draft.message,
    items: index < 0
      ? [...draft.items, item]
      : draft.items.map((candidate, candidateIndex) =>
        candidateIndex === index ? item : candidate
      ),
  };
}

export function removeReviewDraftFeedback(
  draft: WebReviewDraft,
  itemId: string,
): WebReviewDraft {
  return {
    message: draft.message,
    items: draft.items.filter(({ id }) => id !== itemId),
  };
}

export function reviewFeedbackItemsForOutcome(
  outcome: ReviewOutcome,
  items: readonly ReviewFeedbackItem[],
): ReviewFeedbackItem[] | undefined {
  return (outcome === "changes_requested" || outcome === "approved") &&
      items.length > 0
    ? [...items]
    : undefined;
}

export function loadReviewDraft(
  storage: ReviewDraftStorage,
  request: WebReviewRequest,
): WebReviewDraft {
  const empty = { message: "", items: [] };
  if (request.status !== "pending") {
    return empty;
  }
  try {
    const raw = storage.getItem(reviewDraftStorageKey(request.id));
    if (raw === null) {
      return empty;
    }
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, [
        "version",
        "documentId",
        "documentRevision",
        "message",
        "items",
      ]) ||
      value.version !== 1 ||
      value.documentId !== request.documentId ||
      value.documentRevision !== request.documentRevision ||
      typeof value.message !== "string" ||
      value.message.length > 16 * 1024 ||
      !isSafeReviewMessage(value.message) ||
      !Array.isArray(value.items) ||
      value.items.length > 32 ||
      !value.items.every(isStoredReviewFeedbackItem)
    ) {
      return empty;
    }
    return {
      message: value.message,
      items: value.items.map((item) => ({ ...item })),
    };
  } catch {
    return empty;
  }
}

export function activateReviewDraft(
  storage: ReviewDraftStorage,
  request: WebReviewRequest,
  activeRequestId: string | undefined,
): WebReviewDraftActivation | undefined {
  if (request.status !== "pending" || activeRequestId === request.id) {
    return undefined;
  }
  return {
    requestId: request.id,
    resetComposer: true,
    draft: loadReviewDraft(storage, request),
  };
}

export function persistReviewDraft(
  storage: ReviewDraftStorage,
  request: WebReviewRequest,
  draft: WebReviewDraft,
): void {
  const key = reviewDraftStorageKey(request.id);
  if (draft.message === "" && draft.items.length === 0) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, JSON.stringify({
    version: 1,
    documentId: request.documentId,
    documentRevision: request.documentRevision,
    message: draft.message,
    items: draft.items,
  }));
}

export function cleanupReviewDrafts(
  storage: ReviewDraftStorage,
  terminalRequestIds: ReadonlySet<string>,
): void {
  if (storage.length === undefined || storage.key === undefined) {
    return;
  }
  const keys = Array.from(
    { length: storage.length },
    (_, index) => storage.key?.(index) ?? null,
  );
  for (const key of keys) {
    if (
      key?.startsWith(REVIEW_DRAFT_STORAGE_PREFIX) &&
      terminalRequestIds.has(key.slice(REVIEW_DRAFT_STORAGE_PREFIX.length))
    ) {
      storage.removeItem(key);
    }
  }
}

function reviewDraftStorageKey(requestId: string): string {
  return `${REVIEW_DRAFT_STORAGE_PREFIX}${requestId}`;
}

const REVIEW_DRAFT_STORAGE_PREFIX = "mdmaid-desk-review-draft:";

function isStoredReviewFeedbackItem(
  value: unknown,
): value is ReviewFeedbackItem {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "kind",
      "path",
      "hunkId",
      "line",
      "endLine",
      "side",
      "message",
    ]) ||
    typeof value.id !== "string" ||
    !/^feedback-[a-f0-9]{20}$/.test(value.id) ||
    (value.kind !== "feedback" && value.kind !== "todo") ||
    typeof value.path !== "string" ||
    !isSafeReviewPath(value.path) ||
    typeof value.message !== "string" ||
    value.message.trim() === "" ||
    value.message.length > 512 ||
    !isSafeReviewMessage(value.message) ||
    (value.hunkId !== undefined &&
      (typeof value.hunkId !== "string" ||
        !/^hunk-[a-f0-9]{20}$/.test(value.hunkId))) ||
    (value.line !== undefined &&
      (typeof value.line !== "number" ||
        !Number.isSafeInteger(value.line) ||
        value.line <= 0)) ||
    (value.endLine !== undefined &&
      (typeof value.endLine !== "number" ||
        !Number.isSafeInteger(value.endLine) ||
        value.endLine <= 0)) ||
    (value.side !== undefined && value.side !== "old" && value.side !== "new") ||
    ((value.line === undefined) !== (value.side === undefined)) ||
    (value.endLine !== undefined &&
      (value.line === undefined || value.endLine <= value.line)) ||
    (value.line !== undefined && value.hunkId === undefined) ||
    (value.kind === "todo" &&
      (value.hunkId !== undefined ||
        value.line !== undefined ||
        value.endLine !== undefined ||
        value.side !== undefined))
  ) {
    return false;
  }
  return true;
}

function isSafeReviewMessage(value: string): boolean {
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function isSafeReviewPath(value: string): boolean {
  if (
    value === "" ||
    value.length > 1_024 ||
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

export async function renderMermaidNodes(
  renderer: WebMermaidRenderer,
  nodes: Element[],
  onError: (node: Element, error: unknown) => void,
  fontsReady: PromiseLike<unknown> = Promise.resolve(),
): Promise<void> {
  await fontsReady;
  for (const node of nodes) {
    try {
      await renderer.run({ nodes: [node] });
    } catch (error) {
      onError(node, error);
    }
  }
}

export function mermaidErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    if (
      "message" in error &&
      typeof error.message === "string" &&
      error.message.trim() !== ""
    ) {
      return error.message;
    }
    if (
      "str" in error &&
      typeof error.str === "string" &&
      error.str.trim() !== ""
    ) {
      return error.str;
    }
  }
  return String(error);
}

export async function withVisibleMermaidLayout(
  container: HTMLElement,
  operation: () => Promise<void>,
): Promise<void> {
  const wasHidden = container.hasAttribute("hidden");
  if (!wasHidden) {
    await operation();
    return;
  }
  const previousVisibility = container.style.visibility;
  container.style.visibility = "hidden";
  container.removeAttribute("hidden");
  try {
    await operation();
  } finally {
    container.setAttribute("hidden", "");
    container.style.visibility = previousVisibility;
  }
}

export function queueCounts(
  documents: WebDocument[],
): Record<"all" | WebReadingStatus, number> {
  return documents.reduce(
    (counts, document) => {
      counts.all += 1;
      counts[document.status] += 1;
      return counts;
    },
    { all: 0, unread: 0, reading: 0, done: 0 },
  );
}

export function queueGroupingPreference(
  value: string | null,
): WebQueueGrouping {
  return value === "tag" || value === "all" || value === "project"
    ? value
    : "project";
}

export function groupQueue(
  documents: WebDocument[],
  grouping: WebQueueGrouping,
  workspaces: WebWorkspace[],
): WebDocumentGroup[] {
  if (grouping === "all") {
    return [{ key: "all", documents }];
  }

  if (grouping === "project") {
    const names = new Map(workspaces.map(({ id, name }) => [id, name]));
    const groups = new Map<string, WebDocumentGroup>();
    for (const document of documents) {
      const projectId = document.projectId ?? document.workspaceId;
      let group = groups.get(projectId);
      if (!group) {
        group = {
          key: `project:${projectId}`,
          label: document.projectName ??
            names.get(document.workspaceId) ??
            document.workspaceId,
          documents: [],
        };
        groups.set(projectId, group);
      }
      group.documents.push(document);
    }
    return [...groups.values()];
  }

  const tagged = new Map<string, WebDocument[]>();
  const untagged: WebDocument[] = [];
  for (const document of documents) {
    if (document.tags.length === 0) {
      untagged.push(document);
      continue;
    }
    for (const tag of new Set(document.tags)) {
      const matches = tagged.get(tag) ?? [];
      matches.push(document);
      tagged.set(tag, matches);
    }
  }
  const groups = [...tagged.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tag, matches]) => ({
      key: `tag:${tag}`,
      label: `#${tag}`,
      documents: matches,
    }));
  if (untagged.length > 0) {
    groups.push({
      key: "tag:untagged",
      label: "untagged",
      documents: untagged,
    });
  }
  return groups;
}

export function visibleWorkspaces(
  documents: WebDocument[],
  workspaces: WebWorkspace[],
): WebWorkspace[] {
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  const workspaceNames = new Map(workspaces.map(({ id, name }) => [id, name]));
  for (const document of documents) {
    if (document.archivedAt === null) {
      const projectId = document.projectId ?? document.workspaceId;
      counts.set(
        projectId,
        (counts.get(projectId) ?? 0) + 1,
      );
      labels.set(
        projectId,
        document.projectName ??
          workspaceNames.get(document.workspaceId) ??
          document.workspaceId,
      );
    }
  }
  return [...counts].map(([id, documentCount]) => ({
    id,
    name: labels.get(id) ?? id,
    documentCount,
    route: documents.some(({ projectId }) => projectId === id)
      ? `/p/${id}`
      : `/w/${id}`,
  }));
}

export function isSourceMissing(document: WebDocument): boolean {
  return document.missingAt !== null;
}

export function documentOutline(
  headings: readonly DocumentHeading[],
): DocumentOutlineItem[] {
  return headings.flatMap((heading) => {
    const level = /^H([1-6])$/.exec(heading.tagName.toUpperCase())?.[1];
    const text = heading.textContent?.trim() ?? "";
    return heading.id === "" || level === undefined || text === ""
      ? []
      : [{ id: heading.id, level: Number(level), text }];
  });
}

export function documentFragmentId(hash: string): string | undefined {
  if (!hash.startsWith("#") || hash.length === 1) {
    return undefined;
  }
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return undefined;
  }
}

export function parseLiveSourceCatalogEvent(
  data: string,
): LiveSourceCatalogEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      ["action", "documentId", "revision"].includes(key),
    ) ||
    (value.action !== "source-changed" &&
      value.action !== "source-missing" &&
      value.action !== "source-restored") ||
    typeof value.documentId !== "string" ||
    !/^doc-[a-f0-9]{20}$/.test(value.documentId) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  ) {
    return undefined;
  }
  return {
    action: value.action,
    documentId: value.documentId,
    revision: value.revision,
  };
}

export function shouldRefreshWebReader(
  event: LiveSourceCatalogEvent | undefined,
  selectedId: string | undefined,
  renderedRevision: number | undefined,
): boolean {
  return Boolean(
    event &&
      selectedId === event.documentId &&
      (event.action !== "source-changed" ||
        renderedRevision === undefined ||
        event.revision > renderedRevision),
  );
}

export function nearestHeadingPosition(
  headings: readonly HeadingPosition[],
): HeadingPosition | undefined {
  let nearest: HeadingPosition | undefined;
  for (const heading of headings) {
    if (heading.id === "" || heading.top > 24) {
      continue;
    }
    if (!nearest || heading.top > nearest.top) {
      nearest = heading;
    }
  }
  return nearest ? { ...nearest } : undefined;
}

export function sourceModeLabel(
  storage: WebDocument["storage"],
): "live source" | "snapshot" {
  return storage === "reference" ? "live source" : "snapshot";
}

export function requestDocumentPrint(target: PrintTarget): void {
  target.print();
}

export function webLoadFailure(code?: string): WebLoadFailure {
  return code === "unauthorized"
    ? {
        guidance:
          "Run mdmaid-desk web and open the authenticated URL it prints in this browser.",
        liveStatus: "○ session expired",
        title: "Browser session expired",
      }
    : {
        guidance:
          "Check that the local mdmaid.desk service is running, then reload.",
        liveStatus: "○ unavailable",
        title: "Could not load documents",
      };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

async function boot(): Promise<void> {
  const state: WebState = {
    documents: [],
    reviewRequests: [],
    filters: {
      status: "all",
      workspaceId:
        document.body.dataset.projectId !== ""
          ? document.body.dataset.projectId
          : document.body.dataset.workspaceId === ""
            ? undefined
            : document.body.dataset.workspaceId,
      search: "",
    },
    grouping: queueGroupingPreference(
      localStorage.getItem("mdmaid-desk-queue-grouping"),
    ),
    selectedId:
      document.body.dataset.documentId === ""
        ? undefined
        : document.body.dataset.documentId,
    workspaces: [],
  };

  const projectNav = element("project-nav");
  const changeReviewsFilter = element("change-reviews-filter") as HTMLButtonElement;
  const changeReviewsCount = element("change-reviews-count");
  const actionsFilter = element("actions-filter") as HTMLButtonElement;
  const actionsCount = element("actions-count");
  const queue = element("document-queue");
  const queueEyebrow = element("queue-eyebrow");
  const queueTitle = element("queue-title");
  const queuePanel = element("queue-panel");
  const reader = element("document-reader");
  const readerContent = element("reader-content");
  const readerEyebrow = element("reader-eyebrow");
  const changeReviewViewer = element("change-review-viewer");
  const changeFileList = element("change-file-list");
  const changeDiffStage = element("change-diff-stage");
  const changePosition = element("change-position");
  const changeFilePrevious = element("change-file-previous") as HTMLButtonElement;
  const changeFileNext = element("change-file-next") as HTMLButtonElement;
  const changeLayout = element("change-layout") as HTMLButtonElement;
  const changeViewDiff = element("change-view-diff") as HTMLButtonElement;
  const changeViewDocument = element("change-view-document") as HTMLButtonElement;
  const readerToc = element("reader-toc");
  const readerTocList = element("reader-toc-list");
  const readerTitle = element("reader-title");
  const readerMeta = element("reader-meta");
  const reviewPanel = element("review-panel");
  const reviewRequestMessage = element("review-request-message");
  const reviewStatus = element("review-status");
  const reviewResponse = element("review-response") as HTMLTextAreaElement;
  const reviewFeedbackSection = element("review-feedback-section");
  const reviewFeedbackList = element("review-feedback-list");
  const reviewFeedbackComposer = element("review-feedback-composer");
  const reviewFeedbackAnchor = element("review-feedback-anchor");
  const reviewFeedbackMessage = element("review-feedback-message") as HTMLTextAreaElement;
  const reviewFeedbackSave = element("review-feedback-save") as HTMLButtonElement;
  const reviewFeedbackCancel = element("review-feedback-cancel") as HTMLButtonElement;
  const reviewError = element("review-error");
  const reviewActions = element("review-actions");
  const reviewApprove = element("review-approve") as HTMLButtonElement;
  const reviewChanges = element("review-changes") as HTMLButtonElement;
  const reviewReject = element("review-reject") as HTMLButtonElement;
  const reviewSupersede = element("review-supersede") as HTMLButtonElement;
  const markRead = element("mark-read") as HTMLButtonElement;
  const markUnread = element("mark-unread") as HTMLButtonElement;
  const copyLink = element("copy-link") as HTMLButtonElement;
  const print = element("print") as HTMLButtonElement;
  const empty = element("queue-empty");
  const search = element("search") as HTMLInputElement;
  const live = element("live-status");
  const statusButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-status-filter]"),
  );
  const groupingButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-grouping]"),
  );
  let renderedRevision: number | undefined;
  let renderedChangeReview: ChangeReviewDiff | undefined;
  let changeFileIndex = 0;
  let changeReviewLayout: "unified" | "side-by-side" = "side-by-side";
  let changeReviewView: "diff" | "document" = "diff";
  let feedbackItems: ReviewFeedbackItem[] = [];
  let feedbackDraft: WebFeedbackAnchor | undefined;
  let feedbackRangeStart: WebFeedbackAnchor | undefined;
  let feedbackEditingId: string | undefined;
  let activeReviewDraftId: string | undefined;
  let renderSequence = 0;
  let catalogRefresh = Promise.resolve();

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
    const body = (await response.json()) as
      | { data: T }
      | { error: { code: string; message: string } };
    if (!response.ok || !("data" in body)) {
      if ("error" in body) {
        throw new WebApiError(body.error.code, body.error.message);
      }
      throw new Error("Request failed");
    }
    return body.data;
  }

  function renderProjects(): void {
    projectNav.replaceChildren();
    const ordinaryDocuments = state.documents.filter(
      ({ kind }) => kind !== "change-review",
    );
    const workspaces = visibleWorkspaces(ordinaryDocuments, state.workspaces);
    if (
      state.filters.workspaceId !== undefined &&
      !workspaces.some(({ id }) => id === state.filters.workspaceId) &&
      !state.workspaces.some(({ id }) => id === state.filters.workspaceId)
    ) {
      state.filters.workspaceId = undefined;
    }
    const all = projectButton("all projects", ordinaryDocuments.length);
    projectNav.append(all);
    for (const workspace of workspaces) {
      projectNav.append(
        projectButton(
          workspace.name,
          workspace.documentCount,
          workspace,
        ),
      );
    }
    const pendingCount = state.reviewRequests.filter(
      ({ status }) => status === "pending",
    ).length;
    actionsCount.textContent = String(pendingCount);
    actionsFilter.classList.toggle("active", state.filters.actionsOnly === true);
    const reviewCount = state.documents.filter(
      ({ archivedAt, kind }) => archivedAt === null && kind === "change-review",
    ).length;
    changeReviewsCount.textContent = String(reviewCount);
    changeReviewsFilter.classList.toggle(
      "active",
      state.filters.changeReviewsOnly === true,
    );
  }

  function projectButton(
    name: string,
    count: number,
    workspace?: WebWorkspace,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "project-button";
    if (
      state.filters.workspaceId === workspace?.id &&
      state.filters.changeReviewsOnly !== true &&
      state.filters.actionsOnly !== true
    ) {
      button.classList.add("active");
    }
    button.type = "button";
    const label = document.createElement("span");
    label.textContent = name;
    const badge = document.createElement("span");
    badge.className = "count";
    badge.textContent = `${count} ${count === 1 ? "doc" : "docs"}`;
    button.append(label, badge);
    button.addEventListener("click", () => {
      const selection = projectQueueSelection(state.filters, workspace);
      state.filters = selection.filters;
      closeReader(false);
      history.pushState({}, "", selection.route);
      render();
      window.scrollTo(0, 0);
    });
    return button;
  }

  function renderStatusCounts(): void {
    const source = filterQueue(state.documents, {
      workspaceId: state.filters.workspaceId,
      status: "all",
      actionsOnly: state.filters.actionsOnly,
      changeReviewsOnly: state.filters.changeReviewsOnly,
    }, state.reviewRequests);
    const counts = queueCounts(source);
    for (const button of statusButtons) {
      const status = button.dataset.statusFilter as keyof typeof counts;
      button.classList.toggle("active", state.filters.status === status);
      const count = button.querySelector(".count");
      if (count) {
        count.textContent = String(counts[status]);
      }
    }
  }

  function renderQueue(): void {
    queue.replaceChildren();
    const documents = filterQueue(
      state.documents,
      state.filters,
      state.reviewRequests,
    );
    const changes = state.filters.changeReviewsOnly === true;
    queueEyebrow.textContent = changes
      ? "implementation review workspace"
      : "persistent reading queue";
    queueTitle.textContent = changes ? "Change Reviews" : "What needs your eyes?";
    empty.toggleAttribute("hidden", documents.length !== 0);
    for (const group of groupQueue(documents, state.grouping, state.workspaces)) {
      const grid = document.createElement("div");
      grid.className = "document-group-grid";
      for (const item of group.documents) {
        grid.append(documentCard(item));
      }
      if (group.label === undefined) {
        queue.append(grid);
        continue;
      }
      const section = document.createElement("section");
      section.className = "document-group";
      section.dataset.groupKey = group.key;
      const heading = document.createElement("h2");
      heading.textContent = group.label;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(group.documents.length);
      heading.append(count);
      section.append(heading, grid);
      queue.append(section);
    }
  }

  function documentCard(item: WebDocument): HTMLButtonElement {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `document-card status-${item.status}`;
    card.classList.toggle("source-missing", isSourceMissing(item));
    card.dataset.documentId = item.id;
    card.setAttribute("aria-label", `Open ${item.title}`);

    const top = document.createElement("span");
    top.className = "card-topline";
    const status = document.createElement("span");
    status.className = "status-label";
    status.textContent = isSourceMissing(item) ? "source missing" : item.status;
    const context = document.createElement("span");
    context.className = "card-context";
    context.textContent = [
      item.projectName ?? item.workspaceId,
      item.taskId,
      item.kind,
      sourceModeLabel(item.storage),
    ]
      .filter(Boolean)
      .join(" / ");
    top.append(status, context);

    const title = document.createElement("strong");
    title.textContent = item.title;
    const detail = document.createElement("span");
    detail.className = "card-detail";
    detail.textContent = [
      item.producer ? `from ${item.producer}` : "",
      item.attention !== "none" ? item.attention.replaceAll("_", " ") : "",
      `rev ${item.revision}`,
    ]
      .filter(Boolean)
      .join(" · ");
    if (pendingReviewForDocument(state.reviewRequests, item.id)) {
      const action = document.createElement("span");
      action.className = "action-required";
      action.textContent = "action required";
      detail.append(
        document.createTextNode(detail.textContent ? " · " : ""),
        action,
      );
    }
    const tags = document.createElement("span");
    tags.className = "tag-row";
    for (const tag of item.tags) {
      const chip = document.createElement("span");
      chip.className = "tag";
      chip.textContent = `#${tag}`;
      tags.append(chip);
    }

    card.append(top, title, detail, tags);
    card.addEventListener("click", () => void openDocument(item.id));
    return card;
  }

  function renderGroupingControls(): void {
    for (const button of groupingButtons) {
      const active = button.dataset.grouping === state.grouping;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  function render(): void {
    renderProjects();
    renderStatusCounts();
    renderGroupingControls();
    renderQueue();
  }

  function renderDocumentOutline(): void {
    readerTocList.replaceChildren();
    const outline = documentOutline(
      Array.from(
        readerContent.querySelectorAll<HTMLElement>(
          "h1, h2, h3, h4, h5, h6",
        ),
      ),
    );
    readerToc.toggleAttribute("hidden", outline.length === 0);
    for (const item of outline) {
      const entry = document.createElement("li");
      entry.className = `toc-item toc-level-${item.level}`;
      const link = document.createElement("a");
      link.href = `#${item.id}`;
      link.textContent = item.text;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        document.getElementById(item.id)?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
      entry.append(link);
      readerTocList.append(entry);
    }
  }

  async function load(openSelected = true): Promise<void> {
    const [documents, workspaces, reviewRequests] = await Promise.all([
      api<WebDocument[]>("/api/v1/documents"),
      api<WebWorkspace[]>("/api/v1/workspaces"),
      api<WebReviewRequest[]>("/api/v1/review-requests"),
    ]);
    state.documents = documents;
    state.workspaces = workspaces;
    state.reviewRequests = reviewRequests;
    if (openSelected || !state.selectedId) {
      const visible = visibleWorkspaces(
        state.documents.filter(({ kind }) => kind !== "change-review"),
        state.workspaces,
      );
      const queueWorkspaces = [...visible, ...state.workspaces];
      const selection = state.selectedId
        ? projectQueueSelectionForReaderHistory(
            state.filters,
            history.state,
            queueWorkspaces,
          )
        : projectQueueSelectionForRoute(
            state.filters,
            location.pathname,
            queueWorkspaces,
            history.state,
          );
      if (selection) {
        state.filters = selection.filters;
        if (!state.selectedId && selection.route !== location.pathname) {
          history.replaceState(queueHistoryState(selection.filters), "", selection.route);
        }
      } else if (state.selectedId) {
        history.replaceState(
          documentHistoryState(state.selectedId, state.filters, queueWorkspaces),
          "",
          location.href,
        );
      }
    }
    try {
      cleanupReviewDrafts(
        localStorage,
        new Set(
          reviewRequests
            .filter(({ status }) => status !== "pending")
            .map(({ id }) => id),
        ),
      );
    } catch {
      // An unavailable browser store must not block loading the workspace.
    }
    render();
    if (openSelected && state.selectedId) {
      await openDocument(state.selectedId, false);
    } else if (state.selectedId) {
      renderReviewPanel(state.selectedId);
    }
  }

  function renderReaderMetadata(selected: WebDocument | undefined): void {
    readerTitle.textContent = selected?.title ?? "Document";
    readerMeta.textContent = selected
      ? [
          selected.projectName ?? selected.workspaceId,
          selected.taskId,
          selected.kind,
          sourceModeLabel(selected.storage),
        ]
          .filter(Boolean)
          .join(" / ")
      : "";
    readerEyebrow.textContent = selected?.kind === "change-review"
      ? "change review"
      : "document";
  }

  function openFeedbackComposer(
    anchor: WebFeedbackAnchor,
    item?: ReviewFeedbackItem,
    rangeStart: WebFeedbackAnchor = anchor,
    preserveMessage = false,
  ): void {
    if (!state.selectedId || !pendingReviewForDocument(
      state.reviewRequests,
      state.selectedId,
    )) {
      return;
    }
    feedbackDraft = anchor;
    feedbackRangeStart = rangeStart;
    if (!preserveMessage) {
      feedbackEditingId = item?.id;
    }
    reviewFeedbackAnchor.textContent = `Feedback on ${feedbackAnchorLabel(anchor)}`;
    if (!preserveMessage) {
      reviewFeedbackMessage.value = item?.message ?? "";
    }
    reviewFeedbackSave.textContent = feedbackEditingId
      ? "update feedback"
      : "save feedback";
    reviewFeedbackComposer.removeAttribute("hidden");
    renderChangeReview();
    reviewFeedbackMessage.focus();
    reviewFeedbackComposer.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function closeFeedbackComposer(): void {
    feedbackDraft = undefined;
    feedbackRangeStart = undefined;
    feedbackEditingId = undefined;
    reviewFeedbackMessage.value = "";
    reviewFeedbackSave.textContent = "save feedback";
    reviewFeedbackComposer.setAttribute("hidden", "");
  }

  function persistCurrentReviewDraft(
    current?: WebReviewRequest,
  ): void {
    const request = current ?? (state.selectedId
      ? pendingReviewForDocument(state.reviewRequests, state.selectedId)
      : undefined);
    if (!request) {
      return;
    }
    try {
      persistReviewDraft(localStorage, request, {
        message: reviewResponse.value,
        items: feedbackItems,
      });
    } catch {
      // An unavailable browser store must not block the review decision.
    }
  }

  function clearStoredReviewDraft(requestId: string): void {
    try {
      localStorage.removeItem(reviewDraftStorageKey(requestId));
    } catch {
      // An unavailable browser store must not block the review decision.
    }
  }

  function renderFeedbackPanel(current: WebReviewRequest | undefined): void {
    const selected = state.documents.find(({ id }) => id === state.selectedId);
    const show = selected?.kind === "change-review" && current !== undefined;
    reviewFeedbackSection.toggleAttribute("hidden", !show);
    reviewFeedbackList.replaceChildren();
    if (feedbackDraft?.line === undefined) {
      reviewFeedbackComposer.classList.remove("diff-inline-composer");
      reviewFeedbackSection.append(reviewFeedbackComposer);
    }
    if (!show || !current) {
      closeFeedbackComposer();
      return;
    }
    const pending = current.status === "pending";
    const items = pending ? feedbackItems : current.response?.items ?? [];
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "review-feedback-item";
      const content = document.createElement("span");
      content.textContent = `${feedbackAnchorLabel(item)} — ${item.message}`;
      row.append(content);
      if (pending) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "action";
        edit.textContent = "edit";
        edit.setAttribute("aria-label", `Edit feedback on ${feedbackAnchorLabel(item)}`);
        edit.setAttribute("aria-label", `Edit feedback on ${feedbackAnchorLabel(item)}`);
        edit.addEventListener("click", () => {
          openFeedbackComposer({
            path: item.path,
            ...(item.hunkId === undefined ? {} : { hunkId: item.hunkId }),
            ...(item.line === undefined ? {} : { line: item.line }),
            ...(item.endLine === undefined ? {} : { endLine: item.endLine }),
            ...(item.side === undefined ? {} : { side: item.side }),
          }, item);
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "action";
        remove.textContent = "remove";
        remove.setAttribute("aria-label", `Remove feedback on ${feedbackAnchorLabel(item)}`);
        remove.setAttribute("aria-label", `Remove feedback on ${feedbackAnchorLabel(item)}`);
        remove.addEventListener("click", () => {
          feedbackItems = removeReviewDraftFeedback({
            message: reviewResponse.value,
            items: feedbackItems,
          }, item.id).items;
          if (feedbackEditingId === item.id) {
            closeFeedbackComposer();
          }
          persistCurrentReviewDraft(current);
          renderFeedbackPanel(current);
          renderChangeReview();
        });
        row.append(edit, remove);
      }
      reviewFeedbackList.append(row);
    }
    reviewFeedbackComposer.toggleAttribute("hidden", !pending || !feedbackDraft);
  }

  function saveFeedback(): void {
    if (!feedbackDraft) {
      return;
    }
    const message = reviewFeedbackMessage.value.trim();
    if (message === "") {
      reviewError.textContent = "Feedback text is required.";
      reviewFeedbackMessage.focus();
      return;
    }
    if (!feedbackEditingId && feedbackItems.length >= 32) {
      reviewError.textContent = "A review can contain at most 32 feedback items.";
      return;
    }
    const item: ReviewFeedbackItem = {
      id: feedbackEditingId ??
        `feedback-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
      kind: "feedback",
      ...feedbackDraft,
      message,
    };
    feedbackItems = upsertReviewDraftFeedback({
      message: reviewResponse.value,
      items: feedbackItems,
    }, item).items;
    reviewError.textContent = "";
    closeFeedbackComposer();
    if (state.selectedId) {
      const current = pendingReviewForDocument(
        state.reviewRequests,
        state.selectedId,
      );
      persistCurrentReviewDraft(current);
      renderFeedbackPanel(current);
      renderChangeReview();
    }
  }

  function renderChangeReview(): void {
    const review = renderedChangeReview;
    const showDiff = Boolean(
      review && review.files.length > 0 && changeReviewView === "diff",
    );
    changeReviewViewer.toggleAttribute("hidden", !showDiff);
    readerContent.toggleAttribute("hidden", showDiff);
    changeViewDiff.classList.toggle("active", showDiff);
    changeViewDocument.classList.toggle("active", !showDiff);
    changeViewDiff.toggleAttribute("hidden", !review);
    changeViewDocument.toggleAttribute("hidden", !review);
    if (showDiff) {
      readerToc.setAttribute("hidden", "");
    } else {
      renderDocumentOutline();
    }
    if (!review || !showDiff) {
      return;
    }
    changeFileIndex = clamp(changeFileIndex, 0, review.files.length - 1);
    const file = review.files[changeFileIndex]!;
    changeFileList.replaceChildren();
    review.files.forEach((candidate, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "change-file-button";
      button.classList.toggle("active", index === changeFileIndex);
      button.textContent = `${changeStatusSymbol(candidate.status)} ${candidate.path}`;
      button.addEventListener("click", () => {
        changeFileIndex = index;
        renderChangeReview();
      });
      changeFileList.append(button);
    });
    changeFilePrevious.disabled = changeFileIndex === 0;
    changeFileNext.disabled = changeFileIndex === review.files.length - 1;
    changeLayout.textContent = changeReviewLayout === "side-by-side"
      ? "side-by-side"
      : "unified";
    changePosition.textContent = `file ${changeFileIndex + 1}/${review.files.length}`;
    changeDiffStage.replaceChildren();
    for (const warning of review.warnings) {
      const warningElement = document.createElement("p");
      warningElement.className = "change-warning";
      warningElement.textContent = `warning: ${warning}`;
      changeDiffStage.append(warningElement);
    }
    const pendingReview = state.selectedId
      ? pendingReviewForDocument(state.reviewRequests, state.selectedId)
      : undefined;
    const requests = state.reviewRequests.filter(
      (request) => request.documentId === state.selectedId,
    );
    const currentReview = pendingReview ?? requests[0];
    const heading = document.createElement("header");
    heading.className = "change-file-heading";
    const path = document.createElement("strong");
    path.textContent = `${changeStatusSymbol(file.status)} ${file.path}`;
    const details = document.createElement("span");
    details.textContent = file.previousPath
      ? `renamed from ${file.previousPath}`
      : file.status;
    heading.append(path, details);
    if (pendingReview) {
      const fileFeedback = document.createElement("button");
      fileFeedback.type = "button";
      fileFeedback.className = "action change-feedback-button";
      fileFeedback.textContent = "feedback on file";
      fileFeedback.addEventListener("click", () => {
        openFeedbackComposer({ path: file.path });
      });
      heading.append(fileFeedback);
    }
    changeDiffStage.append(heading);
    if (pendingReview) {
      const feedbackHint = document.createElement("p");
      feedbackHint.className = "change-line-feedback-hint";
      feedbackHint.textContent = WEB_LINE_FEEDBACK_HINT;
      changeDiffStage.append(feedbackHint);
    }
    if (file.hunks.length === 0) {
      const emptyHunk = document.createElement("p");
      emptyHunk.className = "change-empty";
      emptyHunk.textContent = "No text changes. This is a binary or mode-only change.";
      changeDiffStage.append(emptyHunk);
      restoreDetachedFeedbackComposer();
      return;
    }
    const inlineFeedback = currentReview?.status === "pending"
      ? feedbackItems
      : currentReview?.response?.items ?? [];
    for (const hunk of file.hunks) {
      const region = document.createElement("section");
      region.className = "change-region";
      const regionHeader = document.createElement("div");
      regionHeader.className = "change-region-header";
      regionHeader.textContent = hunk.header;
      region.append(regionHeader);
      const table = document.createElement("div");
      table.className = `native-diff ${changeReviewLayout}`;
      if (changeReviewLayout === "side-by-side") {
        const labels = document.createElement("div");
        labels.className = "diff-labels";
        const oldLabel = document.createElement("span");
        oldLabel.textContent = "old";
        const newLabel = document.createElement("span");
        newLabel.textContent = "new";
        labels.append(oldLabel, newLabel);
        table.append(labels);
        for (const row of webDiffRows(hunk)) {
          const rowElement = document.createElement("div");
          rowElement.className = "diff-row";
          rowElement.append(
            renderDiffCell(row.old, file.path, hunk.id, "old"),
            renderDiffCell(row.new, file.path, hunk.id, "new"),
          );
          table.append(rowElement);
          appendInlineFeedback(table, [
            ...(row.old?.line === null || row.old?.line === undefined
              ? []
              : feedbackEndingAtLine(inlineFeedback, {
                  path: file.path,
                  hunkId: hunk.id,
                  line: row.old.line,
                  side: "old",
                })),
            ...(row.new?.line === null || row.new?.line === undefined
              ? []
              : feedbackEndingAtLine(inlineFeedback, {
                  path: file.path,
                  hunkId: hunk.id,
                  line: row.new.line,
                  side: "new",
                })),
          ], currentReview?.status === "pending");
          appendInlineComposer(table, [
            ...(row.old?.line === null || row.old?.line === undefined
              ? []
              : [{ line: row.old.line, side: "old" as const }]),
            ...(row.new?.line === null || row.new?.line === undefined
              ? []
              : [{ line: row.new.line, side: "new" as const }]),
          ], file.path, hunk.id);
        }
      } else {
        for (const row of webDiffRows(hunk)) {
          if (row.old?.kind === "context") {
            table.append(renderUnifiedCell(row.old, row.new?.line ?? null, file.path, hunk.id));
            appendInlineFeedback(table, unifiedLineFeedback(
              inlineFeedback,
              row.old,
              row.new?.line ?? null,
              file.path,
              hunk.id,
            ), currentReview?.status === "pending");
            appendInlineComposer(table, [
              ...(row.old.line === null
                ? []
                : [{ line: row.old.line, side: "old" as const }]),
              ...(row.new?.line === null || row.new?.line === undefined
                ? []
                : [{ line: row.new.line, side: "new" as const }]),
            ], file.path, hunk.id);
          } else {
            if (row.old) {
              table.append(renderUnifiedCell(row.old, null, file.path, hunk.id));
              appendInlineFeedback(table, unifiedLineFeedback(
                inlineFeedback,
                row.old,
                null,
                file.path,
                hunk.id,
              ), currentReview?.status === "pending");
              appendInlineComposer(table, row.old.line === null ? [] : [
                { line: row.old.line, side: "old" },
              ], file.path, hunk.id);
            }
            if (row.new) {
              table.append(renderUnifiedCell(row.new, row.new.line, file.path, hunk.id));
              appendInlineFeedback(table, unifiedLineFeedback(
                inlineFeedback,
                row.new,
                row.new.line,
                file.path,
                hunk.id,
              ), currentReview?.status === "pending");
              appendInlineComposer(table, row.new.line === null ? [] : [
                { line: row.new.line, side: "new" },
              ], file.path, hunk.id);
            }
          }
        }
      }
      region.append(table);
      changeDiffStage.append(region);
    }
    restoreDetachedFeedbackComposer();
  }

  function restoreDetachedFeedbackComposer(): void {
    if (feedbackDraft && !reviewFeedbackComposer.isConnected) {
      reviewFeedbackComposer.classList.remove("diff-inline-composer");
      reviewFeedbackSection.append(reviewFeedbackComposer);
    }
  }

  function unifiedLineFeedback(
    items: readonly ReviewFeedbackItem[],
    cell: WebDiffCell,
    newLine: number | null,
    path: string,
    hunkId: string,
  ): ReviewFeedbackItem[] {
    const oldLine = cell.kind === "addition" ? null : cell.line;
    const matches = [
      ...(oldLine === null
        ? []
        : feedbackEndingAtLine(items, { path, hunkId, line: oldLine, side: "old" })),
      ...(newLine === null
        ? []
        : feedbackEndingAtLine(items, { path, hunkId, line: newLine, side: "new" })),
    ];
    return matches.filter(
      (item, index) => matches.findIndex((candidate) => candidate.id === item.id) === index,
    );
  }

  function appendInlineFeedback(
    parent: HTMLElement,
    items: readonly ReviewFeedbackItem[],
    editable: boolean,
  ): void {
    for (const item of items) {
      const block = document.createElement("div");
      block.className = "diff-inline-feedback";
      const content = document.createElement("div");
      const label = document.createElement("strong");
      label.textContent = `comment · ${feedbackAnchorLabel(item)}`;
      const message = document.createElement("p");
      message.textContent = item.message;
      content.append(label, message);
      block.append(content);
      if (editable) {
        const actions = document.createElement("div");
        actions.className = "diff-inline-feedback-actions";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "action";
        edit.textContent = "edit";
        edit.addEventListener("click", () => openFeedbackComposer({
          path: item.path,
          ...(item.hunkId === undefined ? {} : { hunkId: item.hunkId }),
          ...(item.line === undefined ? {} : { line: item.line }),
          ...(item.endLine === undefined ? {} : { endLine: item.endLine }),
          ...(item.side === undefined ? {} : { side: item.side }),
        }, item));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "action";
        remove.textContent = "remove";
        remove.addEventListener("click", () => {
          feedbackItems = removeReviewDraftFeedback({
            message: reviewResponse.value,
            items: feedbackItems,
          }, item.id).items;
          if (feedbackEditingId === item.id) closeFeedbackComposer();
          persistCurrentReviewDraft();
          if (state.selectedId) {
            renderFeedbackPanel(pendingReviewForDocument(
              state.reviewRequests,
              state.selectedId,
            ));
          }
          renderChangeReview();
        });
        actions.append(edit, remove);
        block.append(actions);
      }
      parent.append(block);
    }
  }

  function appendInlineComposer(
    parent: HTMLElement,
    endpoints: ReadonlyArray<{ line: number; side: "old" | "new" }>,
    path: string,
    hunkId: string,
  ): void {
    if (
      feedbackDraft?.line === undefined ||
      feedbackDraft.path !== path ||
      feedbackDraft.hunkId !== hunkId ||
      !endpoints.some(({ line, side }) =>
        line === (feedbackDraft?.endLine ?? feedbackDraft?.line) &&
        side === feedbackDraft?.side
      )
    ) return;
    reviewFeedbackComposer.classList.add("diff-inline-composer");
    parent.append(reviewFeedbackComposer);
  }

  function renderDiffCell(
    cell: WebDiffCell | undefined,
    path: string,
    hunkId: string,
    side: "old" | "new",
  ): HTMLElement {
    const value = document.createElement("div");
    value.className = `diff-cell${cell ? ` ${cell.kind}` : " empty-cell"}`;
    if (!cell) return value;
    const line = renderDiffLineControl(cell.line, { path, hunkId, side });
    value.append(line, diffText(cell, path));
    return value;
  }

  function renderUnifiedCell(
    cell: WebDiffCell,
    newLine: number | null,
    path: string,
    hunkId: string,
  ): HTMLElement {
    const value = document.createElement("div");
    value.className = `diff-unified-line ${cell.kind}`;
    const oldLine = cell.kind === "addition" ? null : cell.line;
    const oldNumber = renderDiffLineControl(oldLine, {
      path,
      hunkId,
      side: "old",
    });
    const newNumber = renderDiffLineControl(newLine, {
      path,
      hunkId,
      side: "new",
    });
    value.append(oldNumber, newNumber, diffText(cell, path));
    return value;
  }

  function renderDiffLineControl(
    line: number | null,
    anchor: Pick<WebFeedbackAnchor, "path" | "hunkId"> & {
      side: "old" | "new";
    },
  ): HTMLElement {
    const pending = state.selectedId
      ? pendingReviewForDocument(state.reviewRequests, state.selectedId)
      : undefined;
    const model = webDiffLineControlModel(line, anchor.side, Boolean(pending));
    const value = document.createElement(model.feedbackLabel ? "button" : "span");
    value.className = "diff-line-number";
    const number = document.createElement("span");
    number.className = "diff-line-number-value";
    number.textContent = model.lineText;
    value.append(number);
    if (
      value instanceof HTMLButtonElement &&
      line !== null &&
      model.feedbackLabel &&
      model.feedbackMarker
    ) {
      value.type = "button";
      const clickedAnchor = { ...anchor, line } as Required<
        Pick<WebFeedbackAnchor, "path" | "hunkId" | "line" | "side">
      >;
      value.classList.toggle(
        "selected-range",
        feedbackDraft !== undefined &&
          feedbackAnchorContainsLine(feedbackDraft, clickedAnchor),
      );
      const feedbackLabel = `${model.feedbackLabel}; Shift-click another line to select a range`;
      value.title = feedbackLabel;
      value.setAttribute("aria-label", feedbackLabel);
      const marker = document.createElement("span");
      marker.className = "diff-line-feedback-marker";
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = model.feedbackMarker;
      value.append(marker);
      value.addEventListener("click", (event) => {
        const rangeStart = feedbackRangeStart;
        if (
          event.shiftKey &&
          rangeStart?.line !== undefined &&
          rangeStart.path === clickedAnchor.path &&
          rangeStart.hunkId === clickedAnchor.hunkId &&
          rangeStart.side === clickedAnchor.side
        ) {
          const start = Math.min(rangeStart.line, line);
          const end = Math.max(rangeStart.line, line);
          openFeedbackComposer({
            ...clickedAnchor,
            line: start,
            ...(end === start ? {} : { endLine: end }),
          }, undefined, rangeStart, true);
          return;
        }
        openFeedbackComposer(clickedAnchor, undefined, clickedAnchor);
      });
    }
    return value;
  }

  function diffText(cell: WebDiffCell, path: string): HTMLElement {
    const code = document.createElement("code");
    const marker = cell.kind === "addition" ? "+" : cell.kind === "deletion" ? "−" : " ";
    code.append(document.createTextNode(marker));
    const source = `${cell.prefix}${cell.changed}${cell.suffix}`;
    const changedStart = cell.prefix.length;
    const changedEnd = changedStart + cell.changed.length;
    let emphasis: HTMLElement | undefined;
    let offset = 0;
    for (const token of highlightDiffLine(path, source)) {
      const boundaries = [0, token.text.length];
      for (const boundary of [changedStart - offset, changedEnd - offset]) {
        if (boundary > 0 && boundary < token.text.length) boundaries.push(boundary);
      }
      boundaries.sort((left, right) => left - right);
      for (let index = 0; index < boundaries.length - 1; index += 1) {
        const start = boundaries[index] ?? 0;
        const end = boundaries[index + 1] ?? token.text.length;
        const absoluteStart = offset + start;
        const withinChange = cell.changed !== "" &&
          absoluteStart >= changedStart && absoluteStart < changedEnd;
        let target: HTMLElement = code;
        if (withinChange) {
          if (!emphasis) {
            emphasis = document.createElement("mark");
            code.append(emphasis);
          }
          target = emphasis;
        }
        appendSyntaxToken(target, token.kind, token.text.slice(start, end));
      }
      offset += token.text.length;
    }
    return code;
  }

  function appendSyntaxToken(
    parent: HTMLElement,
    kind: WebSyntaxKind,
    text: string,
  ): void {
    if (kind === "plain") {
      parent.append(document.createTextNode(text));
      return;
    }
    const span = document.createElement("span");
    span.className = `syntax-${kind}`;
    span.textContent = text;
    parent.append(span);
  }

  function captureHeadingPosition(): HeadingPosition | undefined {
    return nearestHeadingPosition(
      Array.from(
        readerContent.querySelectorAll<HTMLElement>(
          "h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]",
        ),
      ).map((heading) => ({
        id: heading.id,
        top: heading.getBoundingClientRect().top,
      })),
    );
  }

  function restoreHeadingPosition(position: HeadingPosition): void {
    const heading = Array.from(
      readerContent.querySelectorAll<HTMLElement>("[id]"),
    ).find(({ id }) => id === position.id);
    if (heading) {
      window.scrollBy({
        top: heading.getBoundingClientRect().top - position.top,
      });
    }
  }

  function pushDocumentHistory(id: string, route: string): void {
    const visible = visibleWorkspaces(
      state.documents.filter(({ kind }) => kind !== "change-review"),
      state.workspaces,
    );
    history.pushState(
      documentHistoryState(id, state.filters, [...visible, ...state.workspaces]),
      "",
      route,
    );
  }

  async function renderSelectedDocument(
    id: string,
    options: {
      markOpened: boolean;
      preserveHeading: boolean;
      pushHistory: boolean;
      showLoading: boolean;
    },
  ): Promise<void> {
    const sequence = ++renderSequence;
    const selected = state.documents.find((item) => item.id === id);
    renderReaderMetadata(selected);
    renderReviewPanel(id);
    if (!options.markOpened && selected && isSourceMissing(selected)) {
      showMissingSource(selected);
      renderedRevision = selected.revision;
      return;
    }
    const headingPosition = options.preserveHeading
      ? captureHeadingPosition()
      : undefined;
    if (options.showLoading) {
      readerContent.textContent = "Rendering…";
    }
    let documentRendered = false;
    try {
      const rendered = await api<RenderedDocument>(
        `/api/v1/documents/${id}/render?target=web`,
      );
      if (sequence !== renderSequence || state.selectedId !== id) {
        return;
      }
      setMissingReader(false);
      renderedChangeReview = rendered.changeReview;
      changeFileIndex = 0;
      changeReviewView = rendered.changeReview ? "diff" : "document";
      readerContent.innerHTML = rendered.content;
      documentRendered = true;
      renderChangeReview();
      if (options.pushHistory) {
        pushDocumentHistory(id, rendered.document.route);
      }
      const mermaid = window.mermaid;
      if (mermaid) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
          fontFamily: "Departure Mono, monospace",
        });
        const nodes = Array.from(
          readerContent.querySelectorAll<HTMLElement>(".mermaid"),
        );
        const sources = new Map(nodes.map((node) => [node, node.textContent ?? ""]));
        await withVisibleMermaidLayout(readerContent, async () => {
          await renderMermaidNodes(mermaid, nodes, (node, error) => {
            const element = node as HTMLElement;
            const diagnostic = mermaidErrorMessage(error);
            element.classList.add("mermaid-error");
            element.removeAttribute("data-processed");
            element.textContent = [
              `Diagram could not render: ${diagnostic}`,
              "",
              sources.get(element) ?? "",
            ].join("\n");
          }, document.fonts.ready);
        });
      }
      if (sequence !== renderSequence || state.selectedId !== id) {
        return;
      }
      if (headingPosition) {
        restoreHeadingPosition(headingPosition);
      } else if (options.markOpened) {
        const fragmentId = documentFragmentId(location.hash);
        Array.from(readerContent.querySelectorAll<HTMLElement>("[id]"))
          .find(({ id: candidate }) => candidate === fragmentId)
          ?.scrollIntoView({ block: "start" });
      }
      renderedRevision = rendered.document.revision;
      if (!options.markOpened) {
        return;
      }
      const updated = await api<WebDocument>(
        `/api/v1/documents/${id}/opened`,
        { method: "POST" },
      );
      if (sequence !== renderSequence || state.selectedId !== id) {
        return;
      }
      replaceDocument(updated);
    } catch (error) {
      if (sequence !== renderSequence || state.selectedId !== id) {
        return;
      }
      if (error instanceof WebApiError && error.code === "source_missing") {
        try {
          const [documents, reviewRequests] = await Promise.all([
            api<WebDocument[]>("/api/v1/documents"),
            api<WebReviewRequest[]>("/api/v1/review-requests"),
          ]);
          if (sequence !== renderSequence || state.selectedId !== id) {
            return;
          }
          state.documents = documents;
          state.reviewRequests = reviewRequests;
          render();
        } catch {
          // The safe missing-source state remains actionable without a refresh.
        }
        if (sequence !== renderSequence || state.selectedId !== id) {
          return;
        }
        const missing =
          state.documents.find((item) => item.id === id) ?? selected;
        if (missing) {
          showMissingSource(missing);
          renderedRevision = missing.revision;
          if (options.pushHistory) {
            pushDocumentHistory(id, missing.route);
          }
          return;
        }
      }
      if (options.markOpened && !documentRendered) {
        readerContent.textContent =
          error instanceof Error ? error.message : "Could not render document";
      }
    }
  }

  async function openDocument(id: string, pushHistory = true): Promise<void> {
    if (state.selectedId !== id) {
      feedbackItems = [];
      activeReviewDraftId = undefined;
      closeFeedbackComposer();
    }
    state.selectedId = id;
    queuePanel.setAttribute("hidden", "");
    reader.removeAttribute("hidden");
    readerToc.setAttribute("hidden", "");
    readerTocList.replaceChildren();
    setMissingReader(false);
    await renderSelectedDocument(id, {
      markOpened: true,
      preserveHeading: false,
      pushHistory,
      showLoading: true,
    });
  }

  async function refreshOpenDocument(id: string): Promise<void> {
    await renderSelectedDocument(id, {
      markOpened: false,
      preserveHeading: true,
      pushHistory: false,
      showLoading: false,
    });
  }

  function renderReviewPanel(documentId: string): void {
    const requests = state.reviewRequests.filter(
      (request) => request.documentId === documentId,
    );
    const current =
      pendingReviewForDocument(requests, documentId) ?? requests[0];
    if (!current) {
      reviewPanel.setAttribute("hidden", "");
      reviewRequestMessage.textContent = "";
      reviewStatus.textContent = "";
      reviewResponse.value = "";
      reviewError.textContent = "";
      renderFeedbackPanel(undefined);
      return;
    }
    reviewPanel.removeAttribute("hidden");
    reviewRequestMessage.textContent = current.requestMessage;
    reviewError.textContent = "";
    const pending = current.status === "pending";
    const activation = activateReviewDraft(
      localStorage,
      current,
      activeReviewDraftId,
    );
    if (activation) {
      closeFeedbackComposer();
      feedbackItems = activation.draft.items;
      reviewResponse.value = activation.draft.message;
      activeReviewDraftId = activation.requestId;
    } else if (!pending) {
      clearStoredReviewDraft(current.id);
      feedbackItems = [];
      activeReviewDraftId = undefined;
      closeFeedbackComposer();
    }
    renderFeedbackPanel(current);
    reviewResponse.toggleAttribute("hidden", !pending);
    reviewActions.toggleAttribute("hidden", !pending);
    if (pending) {
      reviewStatus.textContent = "Waiting for your decision.";
      return;
    }
    reviewStatus.textContent = [
      current.status.replaceAll("_", " "),
      current.response?.message ?? "",
    ]
      .filter(Boolean)
      .join(" — ");
  }

  async function respondToReview(outcome: ReviewOutcome): Promise<void> {
    if (!state.selectedId) {
      return;
    }
    const request = pendingReviewForDocument(
      state.reviewRequests,
      state.selectedId,
    );
    if (!request) {
      return;
    }
    const message = reviewResponse.value;
    const selected = state.documents.find(({ id }) => id === state.selectedId);
    const validation = outcome !== "changes_requested" &&
        outcome !== "approved" && feedbackItems.length > 0
      ? "Request changes or remove the anchored feedback before deciding."
      : selected?.kind === "change-review" && outcome === "approved"
        ? changeReviewApprovalError(renderedChangeReview) ??
          reviewResponseError(outcome, message, feedbackItems)
        : reviewResponseError(outcome, message, feedbackItems);
    if (validation) {
      reviewError.textContent = validation;
      reviewResponse.focus();
      return;
    }
    reviewError.textContent = "";
    for (const button of [
      reviewApprove,
      reviewChanges,
      reviewReject,
      reviewSupersede,
    ]) {
      button.disabled = true;
    }
    const responseItems = reviewFeedbackItemsForOutcome(outcome, feedbackItems);
    try {
      const updated = await api<WebReviewRequest>(
        `/api/v1/review-requests/${request.id}/respond`,
        {
          method: "POST",
          body: JSON.stringify({
            outcome,
            message,
            ...(responseItems === undefined ? {} : { items: responseItems }),
          }),
        },
      );
      state.reviewRequests = state.reviewRequests.map((item) =>
        item.id === updated.id ? updated : item,
      );
      reviewResponse.value = "";
      feedbackItems = [];
      clearStoredReviewDraft(request.id);
      activeReviewDraftId = undefined;
      closeFeedbackComposer();
      render();
      renderReviewPanel(state.selectedId);
      renderChangeReview();
    } catch (error) {
      reviewError.textContent =
        error instanceof Error ? error.message : "Could not submit response";
    } finally {
      for (const button of [
        reviewApprove,
        reviewChanges,
        reviewReject,
        reviewSupersede,
      ]) {
        button.disabled = false;
      }
    }
  }

  function showMissingSource(item: WebDocument): void {
    setMissingReader(true);
    renderedChangeReview = undefined;
    renderChangeReview();
    readerTitle.textContent = item.title;
    readerContent.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = "Source file is missing";
    const guidance = document.createElement("p");
    guidance.textContent =
      "This catalog record is still available. Archive it to remove it from the active queue, or restore the source file and open it again.";
    readerContent.append(title, guidance);
  }

  function setMissingReader(missing: boolean): void {
    readerContent.classList.toggle("source-missing", missing);
    markRead.disabled = missing;
    markUnread.disabled = missing;
    print.disabled = missing;
    if (missing) {
      readerToc.setAttribute("hidden", "");
      readerTocList.replaceChildren();
    }
  }

  function closeReader(pushHistory = true): void {
    renderSequence += 1;
    renderedRevision = undefined;
    renderedChangeReview = undefined;
    state.selectedId = undefined;
    reader.setAttribute("hidden", "");
    readerToc.setAttribute("hidden", "");
    readerTocList.replaceChildren();
    queuePanel.removeAttribute("hidden");
    if (pushHistory) {
      const workspaces = visibleWorkspaces(
        state.documents.filter(({ kind }) => kind !== "change-review"),
        state.workspaces,
      );
      history.pushState(
        queueHistoryState(state.filters),
        "",
        projectQueueRoute(state.filters.workspaceId, [...workspaces, ...state.workspaces]),
      );
    }
  }

  function replaceDocument(updated: WebDocument): void {
    state.documents = state.documents.map((item) =>
      item.id === updated.id ? updated : item,
    );
    render();
  }

  async function act(action: "read" | "unread" | "archive"): Promise<void> {
    const id = state.selectedId;
    if (!id) {
      return;
    }
    const selected = state.documents.find((item) => item.id === id);
    if (action !== "archive" && selected && isSourceMissing(selected)) {
      return;
    }
    const updated = await api<WebDocument>(
      `/api/v1/documents/${id}/${action}`,
      { method: "POST" },
    );
    replaceDocument(updated);
    if (action === "archive") {
      state.documents = state.documents.filter(({ id }) => id !== updated.id);
      if (state.selectedId === id) {
        closeReader();
      }
      render();
    }
  }

  search.addEventListener("input", () => {
    state.filters.search = search.value;
    renderQueue();
  });
  actionsFilter.addEventListener("click", () => {
    const workspaces = visibleWorkspaces(
      state.documents.filter(({ kind }) => kind !== "change-review"),
      state.workspaces,
    );
    const transition = actionsQueueTransition(
      state.filters,
      state.selectedId !== undefined,
      [...workspaces, ...state.workspaces],
    );
    state.filters = transition.filters;
    if (transition.pushHistory) {
      closeReader(false);
      history.pushState(transition.historyState, "", transition.route);
      window.scrollTo(0, 0);
    } else {
      history.replaceState(transition.historyState, "", transition.route);
    }
    render();
  });
  changeReviewsFilter.addEventListener("click", () => {
    state.filters.changeReviewsOnly = true;
    state.filters.actionsOnly = false;
    state.filters.workspaceId = undefined;
    closeReader(false);
    history.pushState({ space: "change-reviews" }, "", "/");
    render();
    window.scrollTo(0, 0);
  });
  changeFilePrevious.addEventListener("click", () => {
    changeFileIndex -= 1;
    renderChangeReview();
  });
  changeFileNext.addEventListener("click", () => {
    changeFileIndex += 1;
    renderChangeReview();
  });
  changeLayout.addEventListener("click", () => {
    changeReviewLayout = changeReviewLayout === "unified" ? "side-by-side" : "unified";
    renderChangeReview();
  });
  changeViewDiff.addEventListener("click", () => {
    changeReviewView = "diff";
    renderChangeReview();
  });
  changeViewDocument.addEventListener("click", () => {
    changeReviewView = "document";
    renderChangeReview();
  });
  for (const button of statusButtons) {
    button.addEventListener("click", () => {
      state.filters.status =
        button.dataset.statusFilter as WebFilters["status"];
      renderStatusCounts();
      renderQueue();
    });
  }
  for (const button of groupingButtons) {
    button.addEventListener("click", () => {
      state.grouping = queueGroupingPreference(button.dataset.grouping ?? null);
      localStorage.setItem("mdmaid-desk-queue-grouping", state.grouping);
      renderGroupingControls();
      renderQueue();
    });
  }
  element("reader-back").addEventListener("click", () => closeReader());
  markRead.addEventListener("click", () => void act("read"));
  markUnread.addEventListener("click", () => void act("unread"));
  copyLink.addEventListener("click", () => {
    const selected = state.documents.find(({ id }) => id === state.selectedId);
    if (!selected) {
      return;
    }
    void navigator.clipboard
      .writeText(new URL(selected.route, location.origin).href)
      .then(() => {
        copyLink.textContent = "copied";
        window.setTimeout(() => {
          copyLink.textContent = "copy link";
        }, 1_500);
      })
      .catch(() => {
        copyLink.textContent = "copy failed";
      });
  });
  print.addEventListener("click", () => requestDocumentPrint(window));
  element("archive").addEventListener("click", () => void act("archive"));
  reviewApprove.addEventListener("click", () =>
    void respondToReview("approved"),
  );
  reviewChanges.addEventListener("click", () =>
    void respondToReview("changes_requested"),
  );
  reviewReject.addEventListener("click", () =>
    void respondToReview("rejected"),
  );
  reviewSupersede.addEventListener("click", () =>
    void respondToReview("superseded"),
  );
  reviewFeedbackSave.addEventListener("click", saveFeedback);
  reviewFeedbackCancel.addEventListener("click", () => {
    closeFeedbackComposer();
    renderChangeReview();
  });
  reviewResponse.addEventListener("input", () => persistCurrentReviewDraft());

  const theme = localStorage.getItem("mdmaid-desk-theme");
  document.documentElement.dataset.theme =
    theme === "dark" || theme === "light"
      ? theme
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  element("theme-toggle").addEventListener("click", () => {
    const next =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("mdmaid-desk-theme", next);
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    if (
      target?.tagName === "INPUT" ||
      target?.tagName === "TEXTAREA" ||
      target?.isContentEditable
    ) {
      if (event.key === "Escape") {
        target.blur();
      }
      return;
    }
    if (event.key === "/") {
      search.focus();
      event.preventDefault();
    } else if (state.selectedId && (event.key === "Escape" || event.key === "b")) {
      closeReader();
    } else if (state.selectedId && event.key === "m") {
      void act("read");
    } else if (state.selectedId && event.key === "u") {
      void act("unread");
    } else if (event.key === "j") {
      scrollBy({ top: 90, behavior: "smooth" });
    } else if (event.key === "k") {
      scrollBy({ top: -90, behavior: "smooth" });
    }
  });

  window.addEventListener("popstate", (event) => {
    const workspaces = visibleWorkspaces(
      state.documents.filter(({ kind }) => kind !== "change-review"),
      state.workspaces,
    );
    const queueWorkspaces = [...workspaces, ...state.workspaces];
    const match = location.pathname.match(/^\/d\/(doc-[a-f0-9]{20})$/);
    if (match?.[1]) {
      const selection = projectQueueSelectionForReaderHistory(
        state.filters,
        event.state,
        queueWorkspaces,
      );
      if (selection) {
        state.filters = selection.filters;
        render();
      }
      void openDocument(match[1], false);
    } else {
      const selection = projectQueueSelectionForRoute(
        state.filters,
        location.pathname,
        queueWorkspaces,
        event.state,
      );
      if (selection) {
        state.filters = selection.filters;
        if (selection.route !== location.pathname) {
          history.replaceState(queueHistoryState(selection.filters), "", selection.route);
        }
      }
      closeReader(false);
      render();
    }
  });

  const events = new EventSource("/api/v1/events");
  events.addEventListener("open", () => {
    live.textContent = "● live";
    live.classList.remove("offline");
  });
  events.addEventListener("catalog", (event) => {
    const liveSourceEvent = parseLiveSourceCatalogEvent(
      (event as MessageEvent<string>).data,
    );
    catalogRefresh = catalogRefresh
      .then(async () => {
        await load(false);
        if (
          shouldRefreshWebReader(
            liveSourceEvent,
            state.selectedId,
            renderedRevision,
          ) && state.selectedId
        ) {
          await refreshOpenDocument(state.selectedId);
        }
      })
      .catch(() => undefined);
  });
  events.addEventListener("error", () => {
    live.textContent = "○ reconnecting";
    live.classList.add("offline");
  });

  await load();
}

function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) {
    throw new Error(`Missing web element #${id}`);
  }
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function changeStatusSymbol(status: ChangeReviewDiff["files"][number]["status"]): string {
  return status === "added"
    ? "A"
    : status === "deleted"
      ? "D"
      : status === "renamed"
        ? "R"
        : "M";
}

function showBootFailure(error: unknown): void {
  const failure = webLoadFailure(
    error instanceof WebApiError ? error.code : undefined,
  );
  element("queue-error-title").textContent = failure.title;
  element("queue-error-guidance").textContent = failure.guidance;
  element("queue-error").removeAttribute("hidden");
  const live = element("live-status");
  live.textContent = failure.liveStatus;
  live.classList.add("offline");
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => {
    void boot().catch(showBootFailure);
  });
}
