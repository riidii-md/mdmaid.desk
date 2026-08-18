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

export interface DocumentOutlineItem {
  id: string;
  level: number;
  text: string;
}

export interface WebLoadFailure {
  guidance: string;
  liveStatus: string;
  title: string;
}

interface DocumentHeading {
  id: string;
  tagName: string;
  textContent: string | null;
}

interface PrintTarget {
  print(): void;
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
      document.storage,
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
  const readerToc = element("reader-toc");
  const readerTocList = element("reader-toc-list");
  const readerTitle = element("reader-title");
  const readerMeta = element("reader-meta");
  const markRead = element("mark-read") as HTMLButtonElement;
  const markUnread = element("mark-unread") as HTMLButtonElement;
  const print = element("print") as HTMLButtonElement;
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
        item.workspaceId,
        item.taskId,
        item.kind,
        item.storage,
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
    readerToc.setAttribute("hidden", "");
    readerTocList.replaceChildren();
    setMissingReader(false);
    readerContent.textContent = "Rendering…";
    const selected = state.documents.find((item) => item.id === id);
    readerTitle.textContent = selected?.title ?? "Document";
    readerMeta.textContent = selected
      ? [
          selected.workspaceId,
          selected.taskId,
          selected.kind,
          selected.storage,
        ]
          .filter(Boolean)
          .join(" / ")
      : "";
    try {
      const rendered = await api<RenderedDocument>(
        `/api/v1/documents/${id}/render?target=web`,
      );
      readerContent.innerHTML = rendered.content;
      renderDocumentOutline();
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
      if (error instanceof WebApiError && error.code === "source_missing") {
        try {
          state.documents = await api<WebDocument[]>("/api/v1/documents");
          render();
        } catch {
          // The safe missing-source state remains actionable without a refresh.
        }
        const missing =
          state.documents.find((item) => item.id === id) ?? selected;
        if (missing) {
          showMissingSource(missing);
          if (pushHistory) {
            history.pushState({ documentId: id }, "", missing.route);
          }
          return;
        }
      }
      readerContent.textContent =
        error instanceof Error ? error.message : "Could not render document";
    }
  }

  function showMissingSource(item: WebDocument): void {
    setMissingReader(true);
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
    state.selectedId = undefined;
    reader.setAttribute("hidden", "");
    readerToc.setAttribute("hidden", "");
    readerTocList.replaceChildren();
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
    const selected = state.documents.find(({ id }) => id === state.selectedId);
    if (action !== "archive" && selected && isSourceMissing(selected)) {
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
  markRead.addEventListener("click", () => void act("read"));
  markUnread.addEventListener("click", () => void act("unread"));
  print.addEventListener("click", () => requestDocumentPrint(window));
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
