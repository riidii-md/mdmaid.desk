import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DeskApiClient } from "./api-client.js";
import { Catalog } from "./catalog.js";
import { isEntrypoint, run } from "./cli.js";
import {
  daemonDescriptorPath,
  readDaemonDescriptor,
  type DaemonConnection,
} from "./daemon-state.js";
import type {
  DeskServerOptions,
  RunningDeskServer,
} from "./server.js";

function output(): {
  write: (value: string) => void;
  text: () => string;
} {
  const chunks: string[] = [];
  return {
    write: (value) => {
      chunks.push(value);
    },
    text: () => chunks.join(""),
  };
}

test("adds a workspace, registers a document, and lists it", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-"));
  const workspace = join(root, "workspace");
  const statePath = join(root, "state", "catalog.sqlite3");
  const documentPath = join(workspace, "plan.md");
  await mkdir(workspace);
  await writeFile(documentPath, "# Plan\n", "utf8");
  const stdout = output();
  const stderr = output();

  assert.equal(
    await run(
      [
        "workspace",
        "add",
        workspace,
        "--id",
        "example",
        "--name",
        "Example",
        "--repository",
        "github.com/riidii-md/eywizards",
        "--repository-name",
        "EyWizards",
      ],
      stdout,
      stderr,
      { statePath },
    ),
    0,
  );
  assert.equal(
    await run(
      [
        "register",
        documentPath,
        "--workspace",
        "example",
        "--kind",
        "plan",
        "--task",
        "PROJECT-123",
        "--feature-name",
        "Durable Project Naming",
        "--attention",
        "approval",
      ],
      stdout,
      stderr,
      { statePath },
    ),
    0,
  );
  assert.equal(
    await run(
      ["list", "--workspace", "example", "--task", "PROJECT-123"],
      stdout,
      stderr,
      { statePath },
    ),
    0,
  );
  assert.equal(
    await run(["workspace", "list"], stdout, stderr, { statePath }),
    0,
  );

  assert.match(stdout.text(), /workspace example added/);
  assert.match(stdout.text(), /registered doc-/);
  assert.match(stdout.text(), /PROJECT-123/);
  assert.equal(stderr.text(), "");

  const catalog = await Catalog.open(statePath, { legacyStatePath: false });
  assert.equal(
    catalog.listDocuments()[0]?.projectName,
    "EyWizards / PROJECT-123 (Durable Project Naming)",
  );
  catalog.close();
});

test("preflights Mermaid and returns every issue as JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-validate-"));
  const documentPath = join(root, "review.md");
  await writeFile(documentPath, [
    "```mermaid",
    "flowchart LR",
    "  A --> B",
    "```",
    "",
    "```mermaid",
    "stateDiagram-v2",
    "  [*] -->",
    "```",
    "",
    "```mermaid",
    "stateDiagram-v2",
    "  Ready -->",
    "```",
  ].join("\n"), "utf8");
  const stdout = output();
  const stderr = output();

  assert.equal(
    await run(["validate", documentPath, "--json"], stdout, stderr, {
      statePath: join(root, "unused.sqlite3"),
    }),
    1,
  );
  const result = JSON.parse(stdout.text()) as {
    schemaVersion: number;
    validation: {
      kind: string;
      valid: boolean;
      diagramCount: number;
      issues: Array<{ block: number; line: number; message: string }>;
    };
  };
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.validation.kind, "mermaid");
  assert.equal(result.validation.valid, false);
  assert.equal(result.validation.diagramCount, 3);
  assert.deepEqual(
    result.validation.issues.map(({ block, line }) => ({ block, line })),
    [
      { block: 2, line: 6 },
      { block: 3, line: 11 },
    ],
  );
  assert.equal(stderr.text(), "");
});

test("returns structured Mermaid failures from JSON registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-register-mermaid-"));
  const workspace = join(root, "workspace");
  const statePath = join(root, "state", "catalog.sqlite3");
  const documentPath = join(workspace, "broken.md");
  await mkdir(workspace);
  await writeFile(documentPath, [
    "```mermaid",
    "stateDiagram-v2",
    "  [*] -->",
    "```",
    "",
    "```mermaid",
    "stateDiagram-v2",
    "  Ready -->",
    "```",
  ].join("\n"), "utf8");
  assert.equal(
    await run(
      ["workspace", "add", workspace, "--id", "example"],
      output(),
      output(),
      { statePath },
    ),
    0,
  );
  const stdout = output();
  const stderr = output();

  assert.equal(
    await run([
      "register",
      documentPath,
      "--workspace",
      "example",
      "--json",
    ], stdout, stderr, { statePath }),
    1,
  );
  const result = JSON.parse(stderr.text()) as {
    schemaVersion: number;
    error: {
      code: string;
      validation: {
        diagramCount: number;
        issues: Array<{ block: number; line: number }>;
      };
    };
  };
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.error.code, "invalid_mermaid");
  assert.equal(result.error.validation.diagramCount, 2);
  assert.deepEqual(
    result.error.validation.issues.map(({ block, line }) => ({ block, line })),
    [
      { block: 1, line: 1 },
      { block: 2, line: 6 },
    ],
  );
  assert.equal(stdout.text(), "");
});

test("publishes an explicit review gate and returns its response as JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-review-"));
  const workspace = join(root, "workspace");
  const statePath = join(root, "state", "catalog.sqlite3");
  const documentPath = join(workspace, "plan.md");
  await mkdir(workspace);
  await writeFile(documentPath, "# Plan\n", "utf8");
  const stderr = output();
  assert.equal(
    await run(
      ["workspace", "add", workspace, "--id", "example"],
      output(),
      stderr,
      { statePath },
    ),
    0,
  );

  const publishedOutput = output();
  assert.equal(
    await run(
      [
        "register",
        documentPath,
        "--workspace",
        "example",
        "--kind",
        "plan",
        "--expect",
        "plan-decision",
        "--request-message",
        "Verify rollback before approval.",
        "--json",
      ],
      publishedOutput,
      stderr,
      { statePath },
    ),
    0,
  );
  const published = JSON.parse(publishedOutput.text()) as {
    document: { id: string; revision: number };
    reviewRequest: { id: string; requestMessage: string; status: string };
    schemaVersion: number;
  };
  assert.equal(published.schemaVersion, 1);
  assert.equal(published.reviewRequest.status, "pending");
  assert.equal(
    published.reviewRequest.requestMessage,
    "Verify rollback before approval.",
  );

  const responseOutput = output();
  assert.equal(
    await run(
      [
        "review",
        "respond",
        published.reviewRequest.id,
        "--outcome",
        "changes_requested",
        "--message",
        "Add a restore verification step.",
        "--json",
      ],
      responseOutput,
      stderr,
      { statePath },
    ),
    0,
  );
  assert.equal(
    JSON.parse(responseOutput.text()).reviewRequest.response.message,
    "Add a restore verification step.",
  );

  const waitOutput = output();
  assert.equal(
    await run(
      ["review", "wait", published.reviewRequest.id, "--json"],
      waitOutput,
      stderr,
      { statePath },
    ),
    0,
  );
  const waited = JSON.parse(waitOutput.text());
  assert.equal(waited.reviewRequest.status, "changes_requested");
  assert.equal(
    waited.reviewRequest.requestMessage,
    "Verify rollback before approval.",
  );

  const createdOutput = output();
  assert.equal(
    await run(
      [
        "review",
        "create",
        published.document.id,
        "--kind",
        "plan-decision",
        "--message",
        "Verify the follow-up plan.",
        "--json",
      ],
      createdOutput,
      stderr,
      { statePath },
    ),
    0,
  );
  const created = JSON.parse(createdOutput.text());
  assert.equal(created.reviewRequest.status, "pending");
  assert.equal(
    created.reviewRequest.requestMessage,
    "Verify the follow-up plan.",
  );

  const shownOutput = output();
  assert.equal(
    await run(
      ["review", "show", created.reviewRequest.id, "--json"],
      shownOutput,
      stderr,
      { statePath },
    ),
    0,
  );
  assert.deepEqual(
    JSON.parse(shownOutput.text()).reviewRequest,
    created.reviewRequest,
  );
  assert.equal(stderr.text(), "");
});

test("publishes a change review with a revision-bound change decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-change-review-"));
  const workspace = join(root, "workspace");
  const statePath = join(root, "state", "catalog.sqlite3");
  const documentPath = join(workspace, "change-review.md");
  await mkdir(workspace);
  await writeFile(documentPath, "# Change review\n", "utf8");
  const stderr = output();
  assert.equal(
    await run(
      ["workspace", "add", workspace, "--id", "example"],
      output(),
      stderr,
      { statePath },
    ),
    0,
  );

  const publishedOutput = output();
  assert.equal(
    await run(
      [
        "register",
        documentPath,
        "--workspace",
        "example",
        "--kind",
        "change-review",
        "--attention",
        "approval",
        "--expect",
        "change-decision",
        "--request-message",
        "Review the exact implementation before publication.",
        "--json",
      ],
      publishedOutput,
      stderr,
      { statePath },
    ),
    0,
  );
  const published = JSON.parse(publishedOutput.text());
  assert.equal(published.reviewRequest.kind, "change-decision");
  assert.equal(published.reviewRequest.status, "pending");
  assert.equal(stderr.text(), "");
});

test("waits on daemon events and returns the durable review decision", async () => {
  const pending = {
    id: "review-0123456789abcdefabcd",
    documentId: "doc-0123456789abcdefabcd",
    documentRevision: 1,
    kind: "plan-decision" as const,
    requestMessage: "Check the rollout.",
    status: "pending" as const,
    response: null,
    staleAt: null,
    createdAt: "2026-08-19T09:00:00.000Z",
  };
  const approved = {
    ...pending,
    status: "approved" as const,
    response: {
      outcome: "approved" as const,
      message: "Proceed after the canary check.",
      createdAt: "2026-08-19T09:05:00.000Z",
    },
  };
  let current = pending as typeof pending | typeof approved;
  const client = {
    getReviewRequest: async () => current,
    subscribeCatalog: async (
      onEvent: (event: { action: string; reviewRequestId: string }) => void,
      options: { signal?: AbortSignal; onReady?: () => void },
    ) => {
      options.onReady?.();
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => {
          current = approved;
          onEvent({
            action: "review-responded",
            reviewRequestId: pending.id,
          });
        }, 1);
        options.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolvePromise();
          },
          { once: true },
        );
      });
    },
  } as unknown as DeskApiClient;
  const stdout = output();
  const stderr = output();

  assert.equal(
    await run(
      ["review", "wait", pending.id, "--json"],
      stdout,
      stderr,
      {
        statePath: "/unused/catalog.sqlite3",
        connectDaemon: async () => client,
      },
    ),
    0,
  );
  const result = JSON.parse(stdout.text());
  assert.equal(result.reviewRequest.status, "approved");
  assert.equal(
    result.reviewRequest.response.message,
    "Proceed after the canary check.",
  );
  assert.equal(stderr.text(), "");
});

test("returns a superseded review so a waiting agent can ignore it", async () => {
  const request = {
    id: "review-0123456789abcdefabcd",
    documentId: "doc-0123456789abcdefabcd",
    documentRevision: 1,
    kind: "change-decision" as const,
    requestMessage: "Review the old implementation.",
    status: "superseded" as const,
    response: {
      outcome: "superseded" as const,
      message: "A newer change review is available.",
      createdAt: "2026-09-18T09:05:00.000Z",
    },
    staleAt: null,
    createdAt: "2026-09-18T09:00:00.000Z",
  };
  const client = {
    getReviewRequest: async () => request,
  } as unknown as DeskApiClient;
  const stdout = output();

  assert.equal(
    await run(["review", "wait", request.id, "--json"], stdout, output(), {
      statePath: "/unused/catalog.sqlite3",
      connectDaemon: async () => client,
    }),
    0,
  );
  assert.equal(JSON.parse(stdout.text()).reviewRequest.status, "superseded");
});

test("hands an active review wait to the updated CLI when its installed version changes", async () => {
  const pending = {
    id: "review-0123456789abcdefabcd",
    documentId: "doc-0123456789abcdefabcd",
    documentRevision: 1,
    kind: "change-decision" as const,
    requestMessage: "Review the exact implementation.",
    status: "pending" as const,
    response: null,
    staleAt: null,
    createdAt: "2026-09-18T14:59:03.835Z",
  };
  const changed = {
    ...pending,
    status: "changes_requested" as const,
    response: {
      outcome: "changes_requested" as const,
      message: "Keep the migration plan unchanged.",
      items: [{
        id: "feedback-cf4ac9f1f7fe422f8076",
        kind: "feedback" as const,
        path: "docs/ai/agentic/harness-migration-plan.md",
        message: "Remove this file from the change.",
      }],
      createdAt: "2026-09-18T19:59:27.931Z",
    },
  };
  let installedVersion = "0.1.17";
  let subscriptionStarted: (() => void) | undefined;
  const subscribed = new Promise<void>((resolvePromise) => {
    subscriptionStarted = resolvePromise;
  });
  let subscriptionAborted = false;
  const client = {
    getReviewRequest: async () => pending,
    subscribeCatalog: async (
      _onEvent: (event: { action: string; reviewRequestId: string }) => void,
      options: { signal?: AbortSignal; onReady?: () => void },
    ) => {
      options.onReady?.();
      subscriptionStarted?.();
      await new Promise<void>((resolvePromise) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            subscriptionAborted = true;
            resolvePromise();
          },
          { once: true },
        );
      });
    },
  } as unknown as DeskApiClient;
  const resumed: string[] = [];
  const stdout = output();
  const stderr = output();

  const waiting = run(
    ["review", "wait", pending.id, "--json"],
    stdout,
    stderr,
    {
      statePath: "/unused/catalog.sqlite3",
      connectDaemon: async () => client,
      reviewPollIntervalMs: 1,
      runningPackageVersion: "0.1.17",
      readInstalledPackageVersion: () => installedVersion,
      resumeReviewWait: async (id) => {
        resumed.push(id);
        return changed;
      },
    },
  );
  await subscribed;
  installedVersion = "0.1.18";

  assert.equal(await waiting, 0);
  assert.deepEqual(resumed, [pending.id]);
  assert.equal(subscriptionAborted, true);
  assert.deepEqual(JSON.parse(stdout.text()).reviewRequest, changed);
  assert.equal(stderr.text(), "");
});

test("continues the wait through the updated CLI entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-update-"));
  const entryPath = join(root, "updated-cli.mjs");
  await writeFile(
    entryPath,
    [
      "const id = process.argv[4];",
      "if (process.argv.slice(2, 4).join(' ') !== 'review wait' || process.argv[5] !== '--json') process.exit(2);",
      "process.stdout.write(JSON.stringify({",
      "  schemaVersion: 1,",
      "  reviewRequest: {",
      "    id,",
      "    documentId: 'doc-0123456789abcdefabcd',",
      "    documentRevision: 1,",
      "    kind: 'change-decision',",
      "    requestMessage: 'Review the exact implementation.',",
      "    status: 'changes_requested',",
      "    response: { outcome: 'changes_requested', message: 'Keep the migration plan unchanged.',",
      "      items: [{ id: 'feedback-11111111111111111111', kind: 'feedback',",
      "        path: 'docs/ai/agentic/harness-migration-plan.md', message: 'Leave this file unchanged.' }],",
      "      createdAt: '2026-09-18T20:00:00.000Z' },",
      "    staleAt: null,",
      "    createdAt: '2026-09-18T14:59:03.835Z'",
      "  }",
      "}) + '\\n');",
    ].join("\n"),
    "utf8",
  );
  const stdout = output();
  const stderr = output();
  const id = "review-0123456789abcdefabcd";

  assert.equal(
    await run(
      ["review", "wait", id, "--json"],
      stdout,
      stderr,
      {
        statePath: "/unused/catalog.sqlite3",
        runningPackageVersion: "0.1.17",
        readInstalledPackageVersion: () => "0.1.18",
        updatedCliEntryPath: entryPath,
      },
    ),
    0,
  );
  const result = JSON.parse(stdout.text());
  assert.equal(result.reviewRequest.id, id);
  assert.equal(result.reviewRequest.status, "changes_requested");
  assert.equal(result.reviewRequest.response.items[0].path, "docs/ai/agentic/harness-migration-plan.md");
  assert.equal(stderr.text(), "");
});

test("rejects an invalid decision returned by the updated CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-update-invalid-"));
  const entryPath = join(root, "updated-cli.mjs");
  await writeFile(
    entryPath,
    "process.stdout.write(JSON.stringify({ schemaVersion: 1, reviewRequest: { id: process.argv[4], status: 'approved' } }) + '\\n');\n",
    "utf8",
  );
  const stdout = output();
  const stderr = output();

  assert.equal(
    await run(
      ["review", "wait", "review-0123456789abcdefabcd", "--json"],
      stdout,
      stderr,
      {
        statePath: "/unused/catalog.sqlite3",
        runningPackageVersion: "0.1.17",
        readInstalledPackageVersion: () => "0.1.18",
        updatedCliEntryPath: entryPath,
      },
    ),
    1,
  );
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /invalid review request/);
});

test("preserves register output without repeating publication during waiter handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-update-register-"));
  const documentPath = join(root, "change-review.md");
  await writeFile(documentPath, "# Change review\n", "utf8");
  const id = "review-0123456789abcdefabcd";
  const pending = {
    id,
    documentId: "doc-0123456789abcdefabcd",
    documentRevision: 1,
    kind: "change-decision" as const,
    requestMessage: "Review this change.",
    status: "pending" as const,
    response: null,
    staleAt: null,
    createdAt: "2026-09-18T14:59:03.835Z",
  };
  const approved = {
    ...pending,
    status: "approved" as const,
    response: {
      outcome: "approved" as const,
      message: "Ship it.",
      createdAt: "2026-09-18T20:00:00.000Z",
    },
  };
  let registrations = 0;
  let reviewCreations = 0;
  const client = {
    registerDocument: async () => {
      registrations += 1;
      return { id: pending.documentId, revision: 1 };
    },
    createReviewRequest: async () => {
      reviewCreations += 1;
      return pending;
    },
  } as unknown as DeskApiClient;
  const stdout = output();
  const stderr = output();

  assert.equal(
    await run(
      [
        "register",
        documentPath,
        "--workspace",
        "example",
        "--kind",
        "change-review",
        "--expect",
        "change-decision",
        "--request-message",
        pending.requestMessage,
        "--wait",
        "--json",
      ],
      stdout,
      stderr,
      {
        statePath: "/unused/catalog.sqlite3",
        connectDaemon: async () => client,
        runningPackageVersion: "0.1.17",
        readInstalledPackageVersion: () => "0.1.18",
        resumeReviewWait: async (reviewId) => {
          assert.equal(reviewId, id);
          return approved;
        },
      },
    ),
    0,
  );
  const result = JSON.parse(stdout.text());
  assert.equal(registrations, 1);
  assert.equal(reviewCreations, 1);
  assert.equal(result.document.id, pending.documentId);
  assert.deepEqual(result.reviewRequest, approved);
  assert.equal(stderr.text(), "");
});

test("keeps attention-only documents passive and validates review flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-passive-"));
  const workspace = join(root, "workspace");
  const statePath = join(root, "state", "catalog.sqlite3");
  const documentPath = join(workspace, "plan.md");
  await mkdir(workspace);
  await writeFile(documentPath, "# Plan\n", "utf8");
  await run(
    ["workspace", "add", workspace, "--id", "example"],
    output(),
    output(),
    { statePath },
  );
  assert.equal(
    await run(
      [
        "register",
        documentPath,
        "--workspace",
        "example",
        "--attention",
        "approval",
      ],
      output(),
      output(),
      { statePath },
    ),
    0,
  );
  const catalog = await Catalog.open(statePath);
  assert.deepEqual(catalog.listReviewRequests(), []);
  catalog.close();

  const stderr = output();
  assert.equal(
    await run(
      [
        "register",
        documentPath,
        "--workspace",
        "example",
        "--wait",
      ],
      output(),
      stderr,
      { statePath },
    ),
    2,
  );
  assert.match(stderr.text(), /--wait requires --expect/);
});

test("routes producer writes through a live daemon without opening local storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-producer-"));
  const statePath = join(root, "missing", "catalog.sqlite3");
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "review.md");
  await mkdir(workspace);
  await writeFile(documentPath, "# Review\n", "utf8");
  const calls: unknown[] = [];
  const client = {
    addWorkspace: async (input: unknown) => {
      calls.push(["workspace", input]);
      return { id: "example", name: "Example", documentCount: 0, route: "/w/example" };
    },
    registerDocument: async (input: unknown) => {
      calls.push(["document", input]);
      return {
        id: "doc-0123456789abcdefabcd",
        workspaceId: "example",
        producer: "codex",
        kind: "review",
        title: "Review",
        attention: "review",
        tags: ["agent"],
        revision: 1,
        openedRevision: null,
        completedRevision: null,
        status: "unread",
        archivedAt: null,
        missingAt: null,
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
        route: "/d/doc-0123456789abcdefabcd",
      };
    },
    importDocument: async (input: unknown) => {
      calls.push(["import", input]);
      return {
        id: "doc-fedcba9876543210abcd",
        workspaceId: "example",
        storage: "managed",
        kind: "brief",
        title: "Review",
        attention: "review",
        tags: [],
        revision: 1,
        openedRevision: null,
        completedRevision: null,
        status: "unread",
        archivedAt: null,
        missingAt: null,
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
        route: "/d/doc-fedcba9876543210abcd",
      };
    },
  } as unknown as DeskApiClient;
  const stdout = output();
  const stderr = output();
  const options = { statePath, connectDaemon: async () => client };

  assert.equal(
    await run(
      ["workspace", "add", workspace, "--id", "example", "--name", "Example"],
      stdout,
      stderr,
      options,
    ),
    0,
  );
  assert.equal(
    await run(
      [
        "import",
        documentPath,
        "--workspace",
        "example",
        "--kind",
        "brief",
        "--attention",
        "review",
      ],
      stdout,
      stderr,
      options,
    ),
    0,
  );
  assert.equal(
    await run(
      [
        "register",
        documentPath,
        "--workspace",
        "example",
        "--live",
        "--kind",
        "review",
        "--attention",
        "review",
        "--producer",
        "codex",
        "--tag",
        "agent",
      ],
      stdout,
      stderr,
      options,
    ),
    0,
  );

  assert.deepEqual(calls, [
    ["workspace", { id: "example", name: "Example", root: workspace, artifactRoots: [workspace] }],
    ["import", {
      workspaceId: "example",
      kind: "brief",
      title: "review",
      path: documentPath,
      attention: "review",
    }],
    ["document", {
      workspaceId: "example",
      producer: "codex",
      kind: "review",
      title: "review",
      path: documentPath,
      attention: "review",
      tags: ["agent"],
    }],
  ]);
  await assert.rejects(readFile(statePath), /ENOENT/);
  assert.equal(stderr.text(), "");
  assert.match(stdout.text(), /imported doc-fedcba9876543210abcd/);
});

test("resolves relative document paths before sending them to a live daemon", async () => {
  const relativePath = ".agent-runs/review.md";
  const calls: Array<[string, { path: string }]> = [];
  const client = {
    registerDocument: async (input: { path: string }) => {
      calls.push(["register", input]);
      return { id: "doc-0123456789abcdefabcd", revision: 1 };
    },
    importDocument: async (input: { path: string }) => {
      calls.push(["import", input]);
      return { id: "doc-fedcba9876543210abcd", revision: 1 };
    },
  } as unknown as DeskApiClient;
  const options = {
    statePath: "/unused/catalog.sqlite3",
    connectDaemon: async () => client,
  };

  assert.equal(
    await run(
      ["register", relativePath, "--workspace", "example"],
      output(),
      output(),
      options,
    ),
    0,
  );
  assert.equal(
    await run(
      ["import", relativePath, "--workspace", "example"],
      output(),
      output(),
      options,
    ),
    0,
  );

  assert.deepEqual(
    calls.map(([action, input]) => [action, input.path]),
    [
      ["register", resolve(relativePath)],
      ["import", resolve(relativePath)],
    ],
  );
  assert.ok(calls.every(([, input]) => isAbsolute(input.path)));
});

test("returns a usage error for incomplete commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-error-"));
  const stdout = output();
  const stderr = output();

  assert.equal(
    await run(["workspace", "add"], stdout, stderr, {
      statePath: join(root, "catalog.sqlite3"),
    }),
    2,
  );
  assert.match(stderr.text(), /workspace root is required/);
});

test("documents live registration in global and command help", async () => {
  const stdout = output();
  const stderr = output();

  assert.equal(await run(["--help"], stdout, stderr), 0);
  assert.match(stdout.text(), /mdmaid-desk/);
  assert.match(stdout.text(), /\[--live\]/);
  assert.match(stdout.text(), /register.*live reference/is);
  assert.match(stdout.text(), /import.*managed snapshot/is);
  assert.doesNotMatch(stdout.text(), /mdmaid-show/);
  assert.equal(stderr.text(), "");

  const registerHelp = output();
  assert.equal(await run(["register", "--help"], registerHelp, stderr), 0);
  assert.match(registerHelp.text(), /--live/);
  assert.match(registerHelp.text(), /default live-reference behavior/i);
  assert.equal(stderr.text(), "");
});

test("prints the published package version without opening the catalog", async () => {
  const stdout = output();
  const stderr = output();
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as { version?: unknown };

  assert.equal(await run(["--version"], stdout, stderr), 0);
  assert.equal(stdout.text(), `${packageJson.version}\n`);
  assert.equal(stderr.text(), "");
});

test("recognizes an installed entrypoint reached through a filesystem alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-entrypoint-"));
  const realDirectory = join(root, "real");
  const aliasDirectory = join(root, "alias");
  const realEntrypoint = join(realDirectory, "cli.js");
  await mkdir(realDirectory);
  await writeFile(realEntrypoint, "// entrypoint\n", "utf8");
  await symlink(
    realDirectory,
    aliasDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );

  assert.equal(
    isEntrypoint(pathToFileURL(realEntrypoint).href, join(aliasDirectory, "cli.js")),
    true,
  );
});

test("runs the web service until shutdown and prints its browser URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-web-"));
  const stdout = output();
  const stderr = output();
  let started: DeskServerOptions | undefined;
  let closed = false;

  const exit = await run(["web", "--port", "43121"], stdout, stderr, {
    statePath: join(root, "catalog.sqlite3"),
    startServer: async (options) => {
      started = options;
      return fakeServer(
        () => {
          closed = true;
        },
        {
          webUrl: `${options.publicUrl}/?token=test-token`,
        },
      );
    },
    waitForShutdown: async () => {
      const descriptor = await readDaemonDescriptor(
        daemonDescriptorPath(join(root, "catalog.sqlite3")),
      );
      assert.equal(descriptor?.port, 43121);
      assert.equal(descriptor?.token, "test-token");
    },
  });

  assert.equal(exit, 0);
  assert.equal(started?.host, "127.0.0.1");
  assert.equal(started?.port, 43121);
  assert.equal(started?.publicUrl, "http://mdmaid.desk.localhost:43121");
  assert.match(started?.token ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.match(
    stdout.text(),
    /mdmaid\.desk web: http:\/\/mdmaid\.desk\.localhost:43121\/\?token=/,
  );
  assert.equal(stderr.text(), "");
  assert.equal(closed, true);
  assert.equal(
    await readDaemonDescriptor(
      daemonDescriptorPath(join(root, "catalog.sqlite3")),
    ),
    undefined,
  );
});

test("reuses a running daemon when opening the web workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-web-live-"));
  const stdout = output();
  const stderr = output();
  const connection = fakeConnection();

  const exit = await run(["web"], stdout, stderr, {
    statePath: join(root, "catalog.sqlite3"),
    connectDaemonInfo: async () => connection,
    startServer: async () => {
      throw new Error("must not start another daemon");
    },
  });

  assert.equal(exit, 0);
  assert.equal(
    stdout.text(),
    "mdmaid.desk web: http://mdmaid.desk.localhost:43121/?token=test-token\n",
  );
  assert.equal(stderr.text(), "");
});

test("prints the portless canonical URL when reusing the default daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-web-default-"));
  const stdout = output();
  const stderr = output();
  const connection = fakeConnection(80);

  const exit = await run(["web"], stdout, stderr, {
    statePath: join(root, "catalog.sqlite3"),
    connectDaemonInfo: async () => connection,
    startServer: async () => {
      throw new Error("must not start another daemon");
    },
  });

  assert.equal(exit, 0);
  assert.equal(
    stdout.text(),
    "mdmaid.desk web: http://mdmaid.desk.localhost/?token=test-token\n",
  );
  assert.equal(stderr.text(), "");
});

test("reuses the default daemon when its port is selected explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-web-selected-"));
  const stdout = output();
  const stderr = output();
  const connection = fakeConnection(80);

  const exit = await run(["web", "--port", "80"], stdout, stderr, {
    statePath: join(root, "catalog.sqlite3"),
    connectDaemonInfo: async () => connection,
    startServer: async () => {
      throw new Error("must not start another daemon");
    },
  });

  assert.equal(exit, 0);
  assert.equal(
    stdout.text(),
    "mdmaid.desk web: http://mdmaid.desk.localhost/?token=test-token\n",
  );
  assert.equal(stderr.text(), "");
});

test("rejects a second web server on a different port for the same state", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-web-conflict-"));
  const stdout = output();
  const stderr = output();
  const connection = fakeConnection(80);

  const exit = await run(["web", "--port", "43128"], stdout, stderr, {
    statePath: join(root, "catalog.sqlite3"),
    connectDaemonInfo: async () => connection,
    startServer: async () => {
      throw new Error("must not start another daemon");
    },
  });

  assert.equal(exit, 1);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /daemon is already running on port 80/);
});

test("exposes explicit daemon lifecycle and user-service commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-daemon-"));
  const statePath = join(root, "catalog.sqlite3");
  const stdout = output();
  const stderr = output();
  const connection = fakeConnection();
  const calls: string[] = [];
  const options = {
    statePath,
    connectDaemonInfo: async () => connection,
    startDaemon: async (_statePath: string, port?: number) => {
      calls.push(`start:${port ?? "auto"}`);
      return connection;
    },
    stopDaemon: async () => {
      calls.push("stop");
      return true;
    },
    installUserService: async (_statePath: string, port?: number) => {
      calls.push(`install:${port ?? "auto"}`);
    },
    uninstallUserService: async () => {
      calls.push("uninstall");
    },
  };

  assert.equal(
    await run(["daemon", "start", "--port", "43210"], stdout, stderr, options),
    0,
  );
  assert.equal(await run(["daemon", "status"], stdout, stderr, options), 0);
  assert.equal(await run(["daemon", "stop"], stdout, stderr, options), 0);
  assert.equal(
    await run(["daemon", "install", "--port", "43211"], stdout, stderr, options),
    0,
  );
  assert.equal(await run(["daemon", "uninstall"], stdout, stderr, options), 0);

  assert.deepEqual(calls, [
    "start:43210",
    "stop",
    "install:43211",
    "uninstall",
  ]);
  assert.match(stdout.text(), /daemon started/);
  assert.match(stdout.text(), /daemon running/);
  assert.match(stdout.text(), /daemon stopped/);
  assert.match(stdout.text(), /user service installed/);
  assert.match(stdout.text(), /user service uninstalled/);
  assert.equal(stderr.text(), "");
});

test("uses the canonical direct localhost HTTP origin by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-http-"));
  const stdout = output();
  const stderr = output();
  let started: DeskServerOptions | undefined;

  const exit = await run(["web"], stdout, stderr, {
    statePath: join(root, "catalog.sqlite3"),
    startServer: async (options) => {
      started = options;
      return fakeServer(() => undefined, {
        port: options.port ?? 0,
        webUrl: `${options.publicUrl}/?token=${options.token ?? ""}`,
      });
    },
    waitForShutdown: async () => undefined,
  });

  assert.equal(exit, 0);
  assert.equal(started?.host, "127.0.0.1");
  assert.equal(started?.port, 80);
  assert.equal(
    started?.publicUrl,
    "http://mdmaid.desk.localhost",
  );
  assert.match(
    stdout.text(),
    /mdmaid\.desk web: http:\/\/mdmaid\.desk\.localhost\/\?token=/,
  );
  assert.doesNotMatch(stdout.text(), /proxy target/);
  assert.equal(stderr.text(), "");
});

test("does not move the daemon to a random port when the default is occupied", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-open-port-"));
  const statePath = join(root, "catalog.sqlite3");
  const stdout = output();
  const stderr = output();
  const attempted: number[] = [];

  const exit = await run(
    ["__daemon-serve", "--state-path", statePath],
    stdout,
    stderr,
    {
      startServer: async (options) => {
        attempted.push(options.port ?? -1);
        const error = new Error("address in use") as NodeJS.ErrnoException;
        error.code = "EADDRINUSE";
        throw error;
      },
    },
  );

  assert.equal(exit, 1);
  assert.deepEqual(attempted, [80]);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /address in use/);
});

test("runs the terminal workspace through the same daemon API", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-tui-"));
  const stdout = output();
  const stderr = output();
  let clientSeen: DeskApiClient | undefined;
  let closed = false;

  const exit = await run(["tui"], stdout, stderr, {
    statePath: join(root, "catalog.sqlite3"),
    startServer: async () => fakeServer(() => {
      closed = true;
    }),
    runTui: async (client) => {
      clientSeen = client;
    },
  });

  assert.equal(exit, 0);
  assert.ok(clientSeen);
  assert.equal(stderr.text(), "");
  assert.equal(closed, true);
});

test("reuses the running daemon for the terminal workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-tui-live-"));
  const stdout = output();
  const stderr = output();
  const sharedClient = new (await import("./api-client.js")).DeskApiClient(
    "http://127.0.0.1:43121",
    "shared-token",
  );
  let clientSeen: DeskApiClient | undefined;

  const exit = await run(["tui"], stdout, stderr, {
    statePath: join(root, "catalog.sqlite3"),
    connectDaemon: async () => sharedClient,
    startServer: async () => {
      throw new Error("must not start another daemon");
    },
    runTui: async (client) => {
      clientSeen = client;
    },
  });

  assert.equal(exit, 0);
  assert.equal(clientSeen, sharedClient);
  assert.equal(stderr.text(), "");
});

test("validates web command arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-web-error-"));
  const stdout = output();
  const stderr = output();
  const statePath = join(root, "catalog.sqlite3");

  assert.equal(await run(["web", "extra"], stdout, stderr, { statePath }), 2);
  assert.equal(
    await run(["web", "--port", "70000"], stdout, stderr, { statePath }),
    2,
  );
  assert.equal(
    await run(
      ["web", "--public-url", "http://example.com"],
      stdout,
      stderr,
      { statePath },
    ),
    2,
  );
  assert.equal(
    await run(
      [
        "web",
        "--port",
        "43127",
        "--public-url",
        "http://mdmaid.desk.localhost:43128",
      ],
      stdout,
      stderr,
      { statePath },
    ),
    2,
  );
  assert.match(stderr.text(), /web accepts options only/);
  assert.match(stderr.text(), /port must be an integer between 0 and 65535/);
  assert.match(
    stderr.text(),
    /public URL must be an HTTP or HTTPS \.localhost origin/,
  );
  assert.match(stderr.text(), /HTTP public URL port must match server port/);
});

test("reports usage errors for invalid commands and options", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-cli-usage-"));
  const statePath = join(root, "catalog.sqlite3");
  const cases: Array<{ args: string[]; message: RegExp }> = [
    { args: ["unknown"], message: /unknown command/ },
    { args: ["workspace", "remove"], message: /action must be add or list/ },
    {
      args: ["workspace", "add", root, root, "--id", "example"],
      message: /accepts one root/,
    },
    { args: ["workspace", "add", root], message: /--id is required/ },
    {
      args: ["workspace", "add", root, "--id"],
      message: /option --id requires a value/,
    },
    {
      args: ["workspace", "add", root, "--id", "example", "--unknown", "x"],
      message: /unknown option/,
    },
    {
      args: [
        "workspace",
        "add",
        root,
        "--id",
        "example",
        "--id",
        "again",
      ],
      message: /may be used only once/,
    },
    { args: ["register"], message: /document path is required/ },
    {
      args: ["register", "one.md", "two.md", "--workspace", "example"],
      message: /accepts one document path/,
    },
    {
      args: ["register", "one.md", "--workspace", "example", "--kind", "unknown"],
      message: /unknown document kind/,
    },
    {
      args: [
        "register",
        "one.md",
        "--workspace",
        "example",
        "--attention",
        "unknown",
      ],
      message: /unknown attention state/,
    },
    { args: ["list", "extra"], message: /list accepts options only/ },
  ];

  for (const entry of cases) {
    const stdout = output();
    const stderr = output();
    assert.equal(
      await run(entry.args, stdout, stderr, { statePath }),
      2,
      entry.args.join(" "),
    );
    assert.match(stderr.text(), entry.message);
  }
});

function fakeServer(
  onClose: () => void,
  overrides: Partial<RunningDeskServer> = {},
): RunningDeskServer {
  return {
    host: "127.0.0.1",
    port: 43121,
    token: "test-token",
    url: "http://127.0.0.1:43121",
    webUrl: "http://127.0.0.1:43121/?token=test-token",
    close: async () => {
      onClose();
    },
    ...overrides,
  };
}

function fakeConnection(port = 43121): DaemonConnection {
  return {
    client: new DeskApiClient(`http://127.0.0.1:${port}`, "test-token"),
    descriptor: {
      protocolVersion: 1,
      pid: process.pid,
      host: "127.0.0.1",
      port,
      token: "test-token",
      startedAt: "2026-08-12T00:00:00.000Z",
    },
    url: `http://127.0.0.1:${port}`,
  };
}
