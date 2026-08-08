import type {
  Attention,
  DocumentKind,
  ReadingStatus,
} from "./domain.js";

export type { Attention, DocumentKind, ReadingStatus };

export interface PublicDocument {
  id: string;
  workspaceId: string;
  taskId?: string;
  producer?: string;
  kind: DocumentKind;
  title: string;
  attention: Attention;
  tags: string[];
  revision: number;
  openedRevision: number | null;
  completedRevision: number | null;
  status: ReadingStatus;
  archivedAt: string | null;
  missingAt: string | null;
  createdAt: string;
  updatedAt: string;
  route: string;
}

export interface PublicWorkspace {
  id: string;
  name: string;
  documentCount: number;
  route: string;
}

export interface HealthData {
  service: "mdmaid.desk";
  status: "ok";
  version: number;
}

export type RenderTarget = "web" | "terminal";

export interface WebRender {
  document: PublicDocument;
  target: "web";
  content: string;
}

export interface TerminalRender {
  document: PublicDocument;
  target: "terminal";
  content: string;
  backend: string;
  warnings: string[];
}

export type DocumentRender = WebRender | TerminalRender;

export type DocumentAction =
  | "opened"
  | "read"
  | "unread"
  | "archive"
  | "restore"
  | "missing"
  | "present";
