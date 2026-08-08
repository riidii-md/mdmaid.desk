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

export interface StoredDocument extends ReadingProgress {
  id: string;
  workspaceId: string;
  taskId?: string;
  producer?: string;
  kind: DocumentKind;
  title: string;
  path: string;
  attention: Attention;
  tags: string[];
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

export function isDocumentKind(value: string): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly string[]).includes(value);
}

export function isAttention(value: string): value is Attention {
  return (ATTENTION_STATES as readonly string[]).includes(value);
}
