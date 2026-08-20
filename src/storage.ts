import type {
  DocumentFilters,
  ReviewRequestFilters,
  StoredDocument,
  StoredReviewRequest,
  Workspace,
} from "./domain.js";

export interface CatalogStorage {
  close(): void;
  isEmpty(): boolean;
  transaction<T>(operation: () => T): T;
  listWorkspaces(): Workspace[];
  getWorkspace(id: string): Workspace | undefined;
  saveWorkspace(workspace: Workspace): void;
  listDocuments(filters?: DocumentFilters): StoredDocument[];
  getDocument(id: string): StoredDocument | undefined;
  getReferenceDocumentIdByPath(
    workspaceId: string,
    path: string,
  ): string | undefined;
  saveDocument(document: StoredDocument): void;
  listReviewRequests(filters?: ReviewRequestFilters): StoredReviewRequest[];
  getReviewRequest(id: string): StoredReviewRequest | undefined;
  saveReviewRequest(request: StoredReviewRequest): void;
  completeReviewRequest(request: StoredReviewRequest): boolean;
  staleReviewRequest(id: string, staleAt: string): boolean;
}
