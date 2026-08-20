export const DOCUMENT_KINDS = [
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
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const ATTENTION_STATES = [
  "none",
  "review",
  "approval",
  "failure",
  "changes_requested",
] as const;

export type Attention = (typeof ATTENTION_STATES)[number];
export type ReadingStatus = "unread" | "reading" | "done";
export type DocumentStorage = "reference" | "managed";

export const REVIEW_KINDS = ["plan-decision"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_STATUSES = [
  "pending",
  "approved",
  "changes_requested",
  "rejected",
  "stale",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_OUTCOMES = [
  "approved",
  "changes_requested",
  "rejected",
] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

export interface ReviewResponse {
  outcome: ReviewOutcome;
  message: string;
  createdAt: string;
}

export interface StoredReviewRequest {
  id: string;
  documentId: string;
  documentRevision: number;
  documentContentHash: string;
  kind: ReviewKind;
  requestMessage: string;
  status: ReviewStatus;
  response: ReviewResponse | null;
  staleAt: string | null;
  createdAt: string;
}

export interface ReviewRequest {
  id: string;
  documentId: string;
  documentRevision: number;
  kind: ReviewKind;
  requestMessage: string;
  status: ReviewStatus;
  response: ReviewResponse | null;
  staleAt: string | null;
  createdAt: string;
}

export interface ReviewRequestFilters {
  documentId?: string;
  status?: ReviewStatus;
}

export interface ReadingProgress {
  revision: number;
  openedRevision: number | null;
  completedRevision: number | null;
}

export interface Workspace {
  id: string;
  name: string;
  root: string;
  artifactRoots: string[];
}

export interface DocumentSourceLink {
  id: string;
  href: string;
  workspacePath: string;
}

export interface StoredDocument extends ReadingProgress {
  id: string;
  workspaceId: string;
  taskId?: string;
  producer?: string;
  kind: DocumentKind;
  title: string;
  storage: DocumentStorage;
  path: string;
  sourcePath?: string;
  attention: Attention;
  tags: string[];
  sourceLinks: DocumentSourceLink[];
  contentHash: string;
  archivedAt: string | null;
  missingAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Document extends StoredDocument {
  status: ReadingStatus;
}

export interface DocumentFilters {
  workspaceId?: string;
  taskId?: string;
  tag?: string;
  status?: ReadingStatus;
  kind?: DocumentKind;
  attention?: Attention;
  archived?: boolean;
  missing?: boolean;
}

export function deriveReadingStatus(progress: ReadingProgress): ReadingStatus {
  if (progress.completedRevision === progress.revision) {
    return "done";
  }
  if (progress.openedRevision === progress.revision) {
    return "reading";
  }
  return "unread";
}

export function presentDocument(document: StoredDocument): Document {
  return {
    ...structuredClone(document),
    status: deriveReadingStatus(document),
  };
}

export function presentReviewRequest(
  request: StoredReviewRequest,
): ReviewRequest {
  const { documentContentHash: _privateHash, ...presented } = request;
  return structuredClone(presented);
}

export function isDocumentKind(value: string): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly string[]).includes(value);
}

export function isAttention(value: string): value is Attention {
  return (ATTENTION_STATES as readonly string[]).includes(value);
}

export function isReviewKind(value: string): value is ReviewKind {
  return (REVIEW_KINDS as readonly string[]).includes(value);
}

export function isReviewStatus(value: string): value is ReviewStatus {
  return (REVIEW_STATUSES as readonly string[]).includes(value);
}

export function isReviewOutcome(value: string): value is ReviewOutcome {
  return (REVIEW_OUTCOMES as readonly string[]).includes(value);
}
