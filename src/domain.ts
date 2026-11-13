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
  "change-review",
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

export const REVIEW_KINDS = ["plan-decision", "change-decision"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_STATUSES = [
  "pending",
  "approved",
  "changes_requested",
  "rejected",
  "superseded",
  "stale",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_OUTCOMES = [
  "approved",
  "changes_requested",
  "rejected",
  "superseded",
] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

export const REVIEW_FEEDBACK_KINDS = ["feedback", "todo"] as const;
export type ReviewFeedbackKind = (typeof REVIEW_FEEDBACK_KINDS)[number];

export const FEEDBACK_COMMENT_INTENTS = ["feedback", "todo"] as const;
export type FeedbackCommentIntent = (typeof FEEDBACK_COMMENT_INTENTS)[number];

export interface MarkdownSourcePoint {
  offset: number;
  line: number;
  column: number;
}

export interface MarkdownFeedbackAnchor {
  kind: "markdown-v1";
  start: MarkdownSourcePoint;
  end: MarkdownSourcePoint;
  exact: string;
  prefix: string;
  suffix: string;
}

export interface DiffFileFeedbackAnchor {
  kind: "diff-file-v1";
  path: string;
}

export interface DiffLinesFeedbackAnchor {
  kind: "diff-lines-v1";
  path: string;
  hunkId: string;
  side: "old" | "new";
  line: number;
  endLine?: number;
}

export type FeedbackAnchor =
  | MarkdownFeedbackAnchor
  | DiffFileFeedbackAnchor
  | DiffLinesFeedbackAnchor;

export interface FeedbackComment {
  id: string;
  intent: FeedbackCommentIntent;
  anchor: FeedbackAnchor;
  message: string;
}

export interface StoredFeedbackSubmission {
  id: string;
  documentId: string;
  documentRevision: number;
  documentContentHash: string;
  generalMessage?: string;
  comments: FeedbackComment[];
  reviewRequestId?: string;
  createdAt: string;
}

export interface FeedbackSubmission {
  id: string;
  documentId: string;
  documentRevision: number;
  generalMessage?: string;
  comments: FeedbackComment[];
  reviewRequestId?: string;
  createdAt: string;
  route: string;
}

export interface FeedbackSubmissionFilters {
  documentId: string;
  documentRevision?: number;
}

export interface FeedbackStorageCursor {
  createdAt: string;
  id: string;
}

export interface FeedbackStoragePage {
  limit: number;
  before?: FeedbackStorageCursor;
}

export interface ReviewFeedbackItem {
  id: string;
  kind: ReviewFeedbackKind;
  path: string;
  hunkId?: string;
  line?: number;
  endLine?: number;
  side?: "old" | "new";
  message: string;
}

export interface ReviewResponse {
  outcome: ReviewOutcome;
  message: string;
  items?: ReviewFeedbackItem[];
  feedbackId?: string;
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

export interface RepositoryIdentity {
  key: string;
  name: string;
}

export const SPACE_MATCHER_KINDS = [
  "repository",
  "repository-namespace",
  "tag",
] as const;

export type SpaceMatcherKind = (typeof SPACE_MATCHER_KINDS)[number];

export type SpaceMatcher =
  | { kind: "repository"; value: string }
  | { kind: "repository-namespace"; value: string }
  | { kind: "tag"; value: string };

export interface Space {
  id: string;
  name: string;
  matchers: SpaceMatcher[];
}

export interface ContentScope {
  spaceId?: string;
}

export interface RepositoryInventoryItem {
  key: string;
  name: string;
  workspaceIds: string[];
  kind: "remote" | "local";
}

export interface Project {
  id: string;
  repositoryKey: string;
  repositoryName: string;
  taskKey: string;
  featureName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentSourceLink {
  id: string;
  href: string;
  workspacePath: string;
}

export interface StoredDocument extends ReadingProgress {
  id: string;
  workspaceId: string;
  projectId: string;
  projectName: string;
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

export function projectDisplayName(
  project: Pick<Project, "repositoryName" | "taskKey" | "featureName">,
): string {
  const task = project.taskKey === "" ? "" : ` / ${project.taskKey}`;
  const feature = project.featureName === undefined
    ? ""
    : ` (${project.featureName})`;
  return `${project.repositoryName}${task}${feature}`;
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

export function presentFeedbackSubmission(
  submission: StoredFeedbackSubmission,
): FeedbackSubmission {
  const { documentContentHash: _privateHash, ...presented } = submission;
  return {
    ...structuredClone(presented),
    route: `/f/${submission.id}`,
  };
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

export function isSpaceMatcherKind(value: string): value is SpaceMatcherKind {
  return (SPACE_MATCHER_KINDS as readonly string[]).includes(value);
}
