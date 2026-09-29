import type {
  ContentScope,
  DocumentFilters,
  ReviewRequestFilters,
  Project,
  RepositoryInventoryItem,
  RepositoryIdentity,
  Space,
  StoredDocument,
  StoredReviewRequest,
  Workspace,
} from "./domain.js";

export interface CatalogStorage {
  close(): void;
  isEmpty(): boolean;
  transaction<T>(operation: () => T): T;
  listSpaces(): Space[];
  getSpace(id: string): Space | undefined;
  saveSpace(space: Space): void;
  deleteSpace(id: string): boolean;
  listRepositories(): RepositoryInventoryItem[];
  listWorkspaces(scope?: ContentScope): Workspace[];
  getWorkspace(id: string): Workspace | undefined;
  getWorkspaceRepository(id: string): RepositoryIdentity | undefined;
  workspaceHasDocuments(id: string): boolean;
  saveWorkspace(workspace: Workspace, repository: RepositoryIdentity): void;
  reconcileWorkspaces(
    sourceWorkspaceId: string,
    targetWorkspaceId: string,
    movedDocumentIds: string[],
    discardedDocumentIds: string[],
  ): void;
  saveProject(project: Project): Project;
  listDocuments(filters?: DocumentFilters, scope?: ContentScope): StoredDocument[];
  getDocument(id: string, scope?: ContentScope): StoredDocument | undefined;
  getReferenceDocumentIdByPath(
    workspaceId: string,
    path: string,
    scope?: ContentScope,
  ): string | undefined;
  saveDocument(document: StoredDocument): void;
  deleteDocuments(ids: readonly string[]): number;
  listReviewRequests(
    filters?: ReviewRequestFilters,
    scope?: ContentScope,
  ): StoredReviewRequest[];
  getReviewRequest(id: string, scope?: ContentScope): StoredReviewRequest | undefined;
  saveReviewRequest(request: StoredReviewRequest): void;
  completeReviewRequest(request: StoredReviewRequest): boolean;
  staleReviewRequest(id: string, staleAt: string): boolean;
}
