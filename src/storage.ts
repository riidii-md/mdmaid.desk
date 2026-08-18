import type {
  DocumentFilters,
  StoredDocument,
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
}
