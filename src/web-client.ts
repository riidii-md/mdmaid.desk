/* mdmaid.desk web client */

import type {
  PublicDocument,
  PublicWorkspace,
  ReadingStatus,
} from "./api-types.js";

export type WebReadingStatus = ReadingStatus;
export type WebDocument = PublicDocument;
export type WebWorkspace = PublicWorkspace;

export interface WebFilters {
  workspaceId?: string | undefined;
  status?: WebReadingStatus | "all" | undefined;
  search?: string | undefined;
}

interface RenderedDocument {
  document: WebDocument;
  target: "web";
  content: string;
}

interface WebState {
  documents: WebDocument[];
  filters: WebFilters;
  selectedId: string | undefined;
  workspaces: WebWorkspace[];
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
): WebDocument[] {
  const terms = (filters.search ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return documents.filter((document) => {
    if (
      filters.workspaceId !== undefined &&
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
      document.workspaceId,
      document.taskId ?? "",
      document.producer ?? "",
      document.kind,
      document.attention,
      ...document.tags,
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
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

export function visibleWorkspaces(
  documents: WebDocument[],
  workspaces: WebWorkspace[],
): WebWorkspace[] {
  const counts = new Map<string, number>();
  for (const document of documents) {
    if (document.archivedAt === null) {
      counts.set(
        document.workspaceId,
        (counts.get(document.workspaceId) ?? 0) + 1,
      );
    }
  }
  return workspaces.flatMap((workspace) => {
    const documentCount = counts.get(workspace.id) ?? 0;
    return documentCount === 0 ? [] : [{ ...workspace, documentCount }];
  });
}

async function boot(): Promise<void> {
  const state: WebState = {
    documents: [],
    filters: {
      status: "all",
      workspaceId:
        document.body.dataset.workspaceId === ""
          ? undefined
          : document.body.dataset.workspaceId,
      search: "",
    },
    selectedId:
      document.body.dataset.documentId === ""
        ? undefined
        : document.body.dataset.documentId,
    workspaces: [],
  };

  const projectNav = element("project-nav");
  const queue = element("document-queue");
  const queuePanel = element("queue-panel");
  const reader = element("document-reader");
  const readerContent = element("reader-content");
  const readerTitle = element("reader-title");
  const readerMeta = element("reader-meta");
  const empty = element("queue-empty");
  const search = element("search") as HTMLInputElement;
  const live = element("live-status");
  const statusButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-status-filter]"),
  );

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
      | { error: { message: string } };
    if (!response.ok || !("data" in body)) {
      throw new Error("error" in body ? body.error.message : "Request failed");
    }
    return body.data;
  }

  function renderProjects(): void {
    projectNav.replaceChildren();
    const workspaces = visibleWorkspaces(state.documents, state.workspaces);
    if (
      state.filters.workspaceId !== undefined &&
      !workspaces.some(({ id }) => id === state.filters.workspaceId)
    ) {
      state.filters.workspaceId = undefined;
    }
    const all = projectButton("all projects", state.documents.length, undefined);
    projectNav.append(all);
    for (const workspace of workspaces) {
      projectNav.append(
        projectButton(
          workspace.name,
          workspace.documentCount,
          workspace.id,
        ),
      );
    }
  }

  function projectButton(
    name: string,
    count: number,
    workspaceId: string | undefined,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "project-button";
    if (state.filters.workspaceId === workspaceId) {
      button.classList.add("active");
    }
    button.type = "button";
    const label = document.createElement("span");
    label.textContent = name;
    const badge = document.createElement("span");
    badge.className = "count";
    badge.textContent = String(count);
    button.append(label, badge);
    button.addEventListener("click", () => {
      state.filters.workspaceId = workspaceId;
      render();
    });
    return button;
  }

  function renderStatusCounts(): void {
    const source =
      state.filters.workspaceId === undefined
        ? state.documents
        : state.documents.filter(
            ({ workspaceId }) => workspaceId === state.filters.workspaceId,
          );
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
    const documents = filterQueue(state.documents, state.filters);
    empty.toggleAttribute("hidden", documents.length !== 0);
    for (const item of documents) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `document-card status-${item.status}`;
      card.dataset.documentId = item.id;
      card.setAttribute("aria-label", `Open ${item.title}`);

      const top = document.createElement("span");
      top.className = "card-topline";
      const status = document.createElement("span");
      status.className = "status-label";
      status.textContent = item.status;
      const context = document.createElement("span");
      context.className = "card-context";
      context.textContent = [item.workspaceId, item.taskId, item.kind]
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
      queue.append(card);
    }
  }

  function render(): void {
    renderProjects();
    renderStatusCounts();
    renderQueue();
  }

  async function load(openSelected = true): Promise<void> {
    const [documents, workspaces] = await Promise.all([
      api<WebDocument[]>("/api/v1/documents"),
      api<WebWorkspace[]>("/api/v1/workspaces"),
    ]);
    state.documents = documents;
    state.workspaces = workspaces;
    render();
    if (openSelected && state.selectedId) {
      await openDocument(state.selectedId, false);
    }
  }

  async function openDocument(id: string, pushHistory = true): Promise<void> {
    state.selectedId = id;
    queuePanel.setAttribute("hidden", "");
    reader.removeAttribute("hidden");
    readerContent.textContent = "Rendering…";
    const selected = state.documents.find((item) => item.id === id);
    readerTitle.textContent = selected?.title ?? "Document";
    readerMeta.textContent = selected
      ? [selected.workspaceId, selected.taskId, selected.kind]
          .filter(Boolean)
          .join(" / ")
      : "";
    try {
      const rendered = await api<RenderedDocument>(
        `/api/v1/documents/${id}/render?target=web`,
      );
      readerContent.innerHTML = rendered.content;
      if (window.mermaid) {
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
          fontFamily: "Departure Mono, monospace",
        });
        await window.mermaid.run({
          nodes: Array.from(readerContent.querySelectorAll(".mermaid")),
        });
      }
      const updated = await api<WebDocument>(
        `/api/v1/documents/${id}/opened`,
        { method: "POST" },
      );
      replaceDocument(updated);
      if (pushHistory) {
        history.pushState({ documentId: id }, "", updated.route);
      }
    } catch (error) {
      readerContent.textContent =
        error instanceof Error ? error.message : "Could not render document";
    }
  }

  function closeReader(pushHistory = true): void {
    state.selectedId = undefined;
    reader.setAttribute("hidden", "");
    queuePanel.removeAttribute("hidden");
    if (pushHistory) {
      history.pushState({}, "", "/");
    }
  }

  function replaceDocument(updated: WebDocument): void {
    state.documents = state.documents.map((item) =>
      item.id === updated.id ? updated : item,
    );
    render();
  }

  async function act(action: "read" | "unread" | "archive"): Promise<void> {
    if (!state.selectedId) {
      return;
    }
    const updated = await api<WebDocument>(
      `/api/v1/documents/${state.selectedId}/${action}`,
      { method: "POST" },
    );
    replaceDocument(updated);
    if (action === "archive") {
      state.documents = state.documents.filter(({ id }) => id !== updated.id);
      closeReader();
      render();
    }
  }

  search.addEventListener("input", () => {
    state.filters.search = search.value;
    renderQueue();
  });
  for (const button of statusButtons) {
    button.addEventListener("click", () => {
      state.filters.status =
        button.dataset.statusFilter as WebFilters["status"];
      renderStatusCounts();
      renderQueue();
    });
  }
  element("reader-back").addEventListener("click", () => closeReader());
  element("mark-read").addEventListener("click", () => void act("read"));
  element("mark-unread").addEventListener("click", () => void act("unread"));
  element("archive").addEventListener("click", () => void act("archive"));

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

  window.addEventListener("popstate", () => {
    const match = location.pathname.match(/^\/d\/(doc-[a-f0-9]{20})$/);
    if (match?.[1]) {
      void openDocument(match[1], false);
    } else {
      closeReader(false);
    }
  });

  const events = new EventSource("/api/v1/events");
  events.addEventListener("open", () => {
    live.textContent = "● live";
    live.classList.remove("offline");
  });
  events.addEventListener("catalog", () => void load(false));
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

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => {
    void boot();
  });
}
