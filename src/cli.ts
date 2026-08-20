#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type Attention,
  type AddWorkspaceInput,
  Catalog,
  type DocumentKind,
  type ImportDocumentInput,
  type RegisterDocumentInput,
  type ReviewKind,
  type ReviewOutcome,
  type ReviewRequest,
} from "./catalog.js";
import { DeskApiClient, DeskApiError } from "./api-client.js";
import {
  connectToDaemon,
  connectToDaemonInfo,
  daemonDescriptorPath,
  descriptorForServer,
  removeDaemonDescriptor,
  writeDaemonDescriptor,
  type DaemonConnection,
} from "./daemon-state.js";
import {
  startDaemon as startBackgroundDaemon,
  stopDaemon as stopBackgroundDaemon,
} from "./daemon-lifecycle.js";
import {
  normalizePublicUrl,
  startDeskServer,
  type DeskServerOptions,
  type RunningDeskServer,
} from "./server.js";
import { readOrCreateAuthToken } from "./auth-state.js";
import { readPackageVersion } from "./package-info.js";
import { runTui as runTerminalWorkspace } from "./tui.js";
import {
  installUserService as installLoginService,
  uninstallUserService as uninstallLoginService,
} from "./user-service.js";

const DOCUMENT_KINDS = new Set<DocumentKind>([
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
]);

const ATTENTION_STATES = new Set<Attention>([
  "none",
  "review",
  "approval",
  "failure",
  "changes_requested",
]);
const REVIEW_KINDS = new Set<ReviewKind>(["plan-decision"]);
const REVIEW_OUTCOMES = new Set<ReviewOutcome>([
  "approved",
  "changes_requested",
  "rejected",
]);

const usage = `mdmaid-desk manages a local catalog of Markdown artifacts.

Usage:
  mdmaid-desk --version
  mdmaid-desk workspace add <root> --id <id> [--name <name>]
      [--artifact-root <path> ...]
  mdmaid-desk workspace list
  mdmaid-desk register <file.md> --workspace <id>
      [--task <id>] [--producer <name>] [--kind <kind>] [--title <title>]
      [--attention <state>] [--tag <tag> ...]
      [--expect plan-decision] [--request-message <text>] [--wait] [--json]
  mdmaid-desk import <file.md> --workspace <id>
      [--task <id>] [--producer <name>] [--kind <kind>] [--title <title>]
      [--attention <state>] [--tag <tag> ...]
      [--expect plan-decision] [--request-message <text>] [--wait] [--json]
  mdmaid-desk review create <document-id> [--revision <number>]
      [--kind plan-decision] [--message <text>] [--json]
  mdmaid-desk review show <review-id> [--json]
  mdmaid-desk review wait <review-id> [--json]
  mdmaid-desk review respond <review-id> --outcome <outcome>
      [--message <text>] [--json]
  mdmaid-desk list [--workspace <id>] [--task <id>]
  mdmaid-desk web [--port <port>]
      [--public-url <http[s]://name.localhost[:port]>]
  mdmaid-desk tui
  mdmaid-desk daemon start [--port <port>]
  mdmaid-desk daemon status
  mdmaid-desk daemon stop
  mdmaid-desk daemon install [--port <port>]
  mdmaid-desk daemon uninstall
`;

interface Writer {
  write(value: string): unknown;
}

export interface RunOptions {
  statePath?: string;
  connectDaemon?: (statePath: string) => Promise<DeskApiClient | undefined>;
  connectDaemonInfo?: (
    statePath: string,
  ) => Promise<DaemonConnection | undefined>;
  startDaemon?: (
    statePath: string,
    port?: number,
  ) => Promise<DaemonConnection>;
  stopDaemon?: (statePath: string) => Promise<boolean>;
  installUserService?: (statePath: string, port?: number) => Promise<unknown>;
  uninstallUserService?: (statePath: string) => Promise<unknown>;
  startServer?: (options: DeskServerOptions) => Promise<RunningDeskServer>;
  runTui?: (client: DeskApiClient) => Promise<void>;
  waitForShutdown?: (server: RunningDeskServer) => Promise<void>;
  signal?: AbortSignal;
  reviewPollIntervalMs?: number;
  allowPortFallback?: boolean;
}

class UsageError extends Error {}

const silentWriter: Writer = { write: () => undefined };

export async function run(
  args: string[],
  stdout: Writer,
  stderr: Writer,
  options: RunOptions = {},
): Promise<number> {
  try {
    if (
      args.length === 0 ||
      args[0] === "help" ||
      args[0] === "--help" ||
      args[0] === "-h"
    ) {
      stdout.write(usage);
      return 0;
    }

    if (
      args.length === 1 &&
      (args[0] === "version" || args[0] === "--version" || args[0] === "-V")
    ) {
      stdout.write(`${readPackageVersion()}\n`);
      return 0;
    }

    let statePath = options.statePath ?? defaultStatePath();
    if (args[0] === "__daemon-serve") {
      const internal = parseArguments(args.slice(1));
      rejectUnknownOptions(internal, new Set(["state-path", "port"]));
      if (internal.positionals.length > 0) {
        throw new UsageError("invalid internal daemon arguments");
      }
      statePath = firstOption(internal, "state-path") ?? statePath;
      const port = firstOption(internal, "port");
      const webArgs = port === undefined ? [] : ["--port", port];
      const catalog = await Catalog.open(statePath);
      try {
        return await runWeb(catalog, statePath, webArgs, silentWriter, {
          ...options,
          allowPortFallback: port === undefined,
        });
      } finally {
        catalog.close();
      }
    }
    if (args[0] === "tui") {
      return await runTerminal(statePath, args.slice(1), options);
    }
    if (args[0] === "daemon") {
      return await runDaemon(statePath, args.slice(1), stdout, options);
    }
    if (args[0] === "web") {
      if (args.length === 1) {
        const running = await (
          options.connectDaemonInfo ?? connectToDaemonInfo
        )(statePath);
        if (running) {
          stdout.write(`mdmaid.desk web: ${daemonWebUrl(running)}\n`);
          return 0;
        }
      }
      const catalog = await Catalog.open(statePath);
      try {
        return await runWeb(catalog, statePath, args.slice(1), stdout, options);
      } finally {
        catalog.close();
      }
    }
    if (args[0] === "workspace" && args[1] === "add") {
      return await runWorkspaceAdd(statePath, args.slice(2), stdout, options);
    }
    if (args[0] === "register") {
      return await runRegister(statePath, args.slice(1), stdout, options);
    }
    if (args[0] === "import") {
      return await runImport(statePath, args.slice(1), stdout, options);
    }
    if (args[0] === "review") {
      return await runReview(statePath, args.slice(1), stdout, options);
    }
    const catalog = await Catalog.open(statePath);
    try {
      const command = args[0];

      if (command === "workspace") {
        return runWorkspaceList(catalog, args.slice(1), stdout);
      }
      if (command === "list") {
        return runList(catalog, args.slice(1), stdout);
      }
      throw new UsageError(`unknown command ${command}`);
    } finally {
      catalog.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`error: ${message}\n`);
    if (error instanceof UsageError) {
      stderr.write(usage);
      return 2;
    }
    return 1;
  }
}

async function runWeb(
  catalog: Catalog,
  statePath: string,
  args: string[],
  stdout: Writer,
  options: RunOptions,
): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed.positionals.length > 0) {
    throw new UsageError("web accepts options only");
  }
  rejectUnknownOptions(parsed, new Set(["port", "public-url"]));
  const configuredPublicUrl = parsePublicUrl(
    firstOption(parsed, "public-url"),
  );
  const configuredPort = firstOption(parsed, "port");
  const port = parsePort(
    configuredPort ?? inferDirectHttpPort(configuredPublicUrl) ?? "43127",
  );
  const publicUrl =
    configuredPublicUrl ??
    (port === 0 ? undefined : `http://mdmaid.desk.localhost:${port}`);
  if (publicUrl !== undefined) {
    validateDirectHttpPort(publicUrl, port);
  }
  const token = await readOrCreateAuthToken(statePath);
  const startServer = options.startServer ?? startDeskServer;
  let server: RunningDeskServer;
  try {
    server = await startServer({
      catalog,
      host: "127.0.0.1",
      port,
      token,
      ...(publicUrl ? { publicUrl } : {}),
    });
  } catch (error) {
    if (!options.allowPortFallback || !isAddressInUse(error)) {
      throw error;
    }
    server = await startServer({
      catalog,
      host: "127.0.0.1",
      port: 0,
      token,
    });
  }
  const descriptor = descriptorForServer(server);
  const descriptorPath = daemonDescriptorPath(statePath);
  try {
    await writeDaemonDescriptor(descriptorPath, descriptor);
    stdout.write(`mdmaid.desk web: ${server.webUrl}\n`);
    if (publicUrl?.startsWith("https://")) {
      stdout.write(`proxy target: ${server.url}\n`);
    }
    stdout.write("Press Ctrl-C to stop the local service.\n");
    await (options.waitForShutdown ?? waitForShutdown)(server);
  } finally {
    try {
      await removeDaemonDescriptor(descriptorPath, descriptor);
    } finally {
      await server.close();
    }
  }
  return 0;
}

async function runTerminal(
  statePath: string,
  args: string[],
  options: RunOptions,
): Promise<number> {
  if (args.length > 0) {
    throw new UsageError("tui accepts no arguments");
  }
  const running = await (options.connectDaemon ?? connectToDaemon)(statePath);
  if (running) {
    await (options.runTui ?? runTerminalWorkspace)(running);
    return 0;
  }
  const catalog = await Catalog.open(statePath);
  const startServer = options.startServer ?? startDeskServer;
  try {
    const server = await startServer({ catalog, host: "127.0.0.1", port: 0 });
    try {
      const client = new DeskApiClient(server.url, server.token);
      await (options.runTui ?? runTerminalWorkspace)(client);
    } finally {
      await server.close();
    }
  } finally {
    catalog.close();
  }
  return 0;
}

async function runDaemon(
  statePath: string,
  args: string[],
  stdout: Writer,
  options: RunOptions,
): Promise<number> {
  const action = args[0];
  if (!action) {
    throw new UsageError(
      "daemon action must be start, status, stop, install, or uninstall",
    );
  }
  const parsed = parseArguments(args.slice(1));
  if (parsed.positionals.length > 0) {
    throw new UsageError(`${action} accepts options only`);
  }

  if (action === "start") {
    rejectUnknownOptions(parsed, new Set(["port"]));
    const selected = firstOption(parsed, "port");
    const port = selected === undefined ? undefined : parsePort(selected);
    const connection = await (
      options.startDaemon ?? startBackgroundDaemon
    )(statePath, port);
    stdout.write(
      `daemon started (pid ${connection.descriptor.pid}, port ${connection.descriptor.port})\n`,
    );
    stdout.write(`mdmaid.desk web: ${daemonWebUrl(connection)}\n`);
    return 0;
  }

  if (action === "status") {
    rejectUnknownOptions(parsed, new Set());
    const connection = await (
      options.connectDaemonInfo ?? connectToDaemonInfo
    )(statePath);
    if (!connection) {
      stdout.write("daemon stopped\n");
      return 1;
    }
    stdout.write(
      `daemon running (pid ${connection.descriptor.pid}, port ${connection.descriptor.port})\n`,
    );
    stdout.write(`mdmaid.desk web: ${daemonWebUrl(connection)}\n`);
    return 0;
  }

  if (action === "stop") {
    rejectUnknownOptions(parsed, new Set());
    const stopped = await (
      options.stopDaemon ?? stopBackgroundDaemon
    )(statePath);
    stdout.write(stopped ? "daemon stopped\n" : "daemon already stopped\n");
    return 0;
  }

  if (action === "install") {
    rejectUnknownOptions(parsed, new Set(["port"]));
    const selected = firstOption(parsed, "port");
    const port = selected === undefined ? undefined : parsePort(selected);
    await (options.installUserService ?? installLoginService)(statePath, port);
    stdout.write("user service installed and started\n");
    return 0;
  }

  if (action === "uninstall") {
    rejectUnknownOptions(parsed, new Set());
    await (options.uninstallUserService ?? uninstallLoginService)(statePath);
    stdout.write("user service uninstalled\n");
    return 0;
  }

  throw new UsageError(
    "daemon action must be start, status, stop, install, or uninstall",
  );
}

function daemonWebUrl(connection: DaemonConnection): string {
  return `http://mdmaid.desk.localhost:${connection.descriptor.port}/?token=${encodeURIComponent(connection.descriptor.token)}`;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new UsageError("port must be an integer between 0 and 65535");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new UsageError("port must be an integer between 0 and 65535");
  }
  return port;
}

function parsePublicUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return normalizePublicUrl(value);
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : "invalid public URL",
    );
  }
}

function inferDirectHttpPort(publicUrl: string | undefined): string | undefined {
  if (!publicUrl?.startsWith("http://")) {
    return undefined;
  }
  return new URL(publicUrl).port || "80";
}

function validateDirectHttpPort(publicUrl: string, port: number): void {
  if (!publicUrl.startsWith("http://")) {
    return;
  }
  const publicPort = Number(new URL(publicUrl).port || "80");
  if (publicPort !== port) {
    throw new UsageError("HTTP public URL port must match server port");
  }
}

function waitForShutdown(_server: RunningDeskServer): Promise<void> {
  return new Promise((resolveShutdown) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolveShutdown();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function runWorkspaceList(
  catalog: Catalog,
  args: string[],
  stdout: Writer,
): number {
  const action = args[0];
  if (action === "list") {
    for (const workspace of catalog.listWorkspaces()) {
      stdout.write(`${workspace.id}\t${workspace.name}\t${workspace.root}\n`);
    }
    return 0;
  }
  throw new UsageError("workspace action must be add or list");
}

async function runWorkspaceAdd(
  statePath: string,
  args: string[],
  stdout: Writer,
  options: RunOptions,
): Promise<number> {
  const parsed = parseArguments(args);
  const root = parsed.positionals[0];
  if (!root) {
    throw new UsageError("workspace root is required");
  }
  if (parsed.positionals.length > 1) {
    throw new UsageError("workspace add accepts one root");
  }
  const id = requiredOption(parsed, "id");
  const name = firstOption(parsed, "name") ?? id;
  const artifactRoots = parsed.options.get("artifact-root") ?? [root];
  rejectUnknownOptions(parsed, new Set(["id", "name", "artifact-root"]));

  const input: AddWorkspaceInput = {
    id,
    name,
    root,
    artifactRoots,
  };
  const client = await (options.connectDaemon ?? connectToDaemon)(statePath);
  if (client) {
    await client.addWorkspace(input);
  } else {
    const catalog = await Catalog.open(statePath);
    try {
      await catalog.addWorkspace(input);
    } finally {
      catalog.close();
    }
  }
  stdout.write(`workspace ${id} added: ${root}\n`);
  return 0;
}

async function runRegister(
  statePath: string,
  args: string[],
  stdout: Writer,
  options: RunOptions,
): Promise<number> {
  const parsed = parseArguments(args, new Set(["wait", "json"]));
  const path = parsed.positionals[0];
  if (!path) {
    throw new UsageError("document path is required");
  }
  if (parsed.positionals.length > 1) {
    throw new UsageError("register accepts one document path");
  }
  rejectUnknownOptions(
    parsed,
    new Set([
      "workspace",
      "task",
      "producer",
      "kind",
      "title",
      "attention",
      "tag",
      "expect",
      "request-message",
      "wait",
      "json",
    ]),
  );

  const kind = (firstOption(parsed, "kind") ?? "other") as DocumentKind;
  if (!DOCUMENT_KINDS.has(kind)) {
    throw new UsageError(`unknown document kind ${kind}`);
  }
  const attention = (firstOption(parsed, "attention") ??
    "none") as Attention;
  if (!ATTENTION_STATES.has(attention)) {
    throw new UsageError(`unknown attention state ${attention}`);
  }

  const taskId = firstOption(parsed, "task");
  const producer = firstOption(parsed, "producer");
  const tags = parsed.options.get("tag");
  const review = parseReviewPublicationOptions(parsed);
  const input: RegisterDocumentInput = {
    workspaceId: requiredOption(parsed, "workspace"),
    ...(taskId ? { taskId } : {}),
    ...(producer ? { producer } : {}),
    kind,
    title: firstOption(parsed, "title") ?? basename(path, ".md"),
    path,
    attention,
    ...(tags === undefined ? {} : { tags }),
  };
  const client = await (options.connectDaemon ?? connectToDaemon)(statePath);
  let document: { id: string; revision: number; route?: string };
  let reviewRequest: ReviewRequest | undefined;
  if (client) {
    document = await client.registerDocument(input);
    if (review.expect !== undefined) {
      reviewRequest = await client.createReviewRequest({
        documentId: document.id,
        documentRevision: document.revision,
        kind: review.expect,
        requestMessage: review.requestMessage,
      });
    }
  } else {
    const catalog = await Catalog.open(statePath);
    try {
      document = await catalog.registerDocument(input);
      if (review.expect !== undefined) {
        reviewRequest = await catalog.createReviewRequest({
          documentId: document.id,
          documentRevision: document.revision,
          kind: review.expect,
          requestMessage: review.requestMessage,
        });
      }
    } finally {
      catalog.close();
    }
  }
  if (review.wait && reviewRequest) {
    reviewRequest = await waitForReviewRequest(
      statePath,
      reviewRequest.id,
      options,
    );
  }
  writePublicationResult(
    stdout,
    "registered",
    path,
    document,
    reviewRequest,
    review.json,
  );
  return 0;
}

async function runImport(
  statePath: string,
  args: string[],
  stdout: Writer,
  options: RunOptions,
): Promise<number> {
  const { input, review } = parseImport(args);
  const client = await (options.connectDaemon ?? connectToDaemon)(statePath);
  let document: { id: string; revision: number; route?: string };
  let reviewRequest: ReviewRequest | undefined;
  if (client) {
    document = await client.importDocument(input);
    if (review.expect !== undefined) {
      reviewRequest = await client.createReviewRequest({
        documentId: document.id,
        documentRevision: document.revision,
        kind: review.expect,
        requestMessage: review.requestMessage,
      });
    }
  } else {
    const catalog = await Catalog.open(statePath);
    try {
      document = await catalog.importDocument(input);
      if (review.expect !== undefined) {
        reviewRequest = await catalog.createReviewRequest({
          documentId: document.id,
          documentRevision: document.revision,
          kind: review.expect,
          requestMessage: review.requestMessage,
        });
      }
    } finally {
      catalog.close();
    }
  }
  if (review.wait && reviewRequest) {
    reviewRequest = await waitForReviewRequest(
      statePath,
      reviewRequest.id,
      options,
    );
  }
  writePublicationResult(
    stdout,
    "imported",
    input.path,
    document,
    reviewRequest,
    review.json,
  );
  return 0;
}

function parseImport(args: string[]): {
  input: ImportDocumentInput;
  review: ReviewPublicationOptions;
} {
  const parsed = parseArguments(args, new Set(["wait", "json"]));
  const path = parsed.positionals[0];
  if (!path) {
    throw new UsageError("document path is required");
  }
  if (parsed.positionals.length > 1) {
    throw new UsageError("import accepts one document path");
  }
  rejectUnknownOptions(
    parsed,
    new Set([
      "workspace",
      "task",
      "producer",
      "kind",
      "title",
      "attention",
      "tag",
      "expect",
      "request-message",
      "wait",
      "json",
    ]),
  );
  const kind = (firstOption(parsed, "kind") ?? "other") as DocumentKind;
  if (!DOCUMENT_KINDS.has(kind)) {
    throw new UsageError(`unknown document kind ${kind}`);
  }
  const attention = (firstOption(parsed, "attention") ?? "none") as Attention;
  if (!ATTENTION_STATES.has(attention)) {
    throw new UsageError(`unknown attention state ${attention}`);
  }
  const taskId = firstOption(parsed, "task");
  const producer = firstOption(parsed, "producer");
  const tags = parsed.options.get("tag");
  const input: ImportDocumentInput = {
    workspaceId: requiredOption(parsed, "workspace"),
    ...(taskId ? { taskId } : {}),
    ...(producer ? { producer } : {}),
    kind,
    title: firstOption(parsed, "title") ?? basename(path, ".md"),
    path,
    attention,
    ...(tags === undefined ? {} : { tags }),
  };
  return { input, review: parseReviewPublicationOptions(parsed) };
}

interface ReviewPublicationOptions {
  expect?: ReviewKind;
  requestMessage: string;
  wait: boolean;
  json: boolean;
}

function parseReviewPublicationOptions(
  parsed: ParsedArguments,
): ReviewPublicationOptions {
  const rawExpectation = firstOption(parsed, "expect");
  const requestMessage = firstOption(parsed, "request-message");
  const wait = hasFlag(parsed, "wait");
  if (rawExpectation === undefined) {
    if (requestMessage !== undefined) {
      throw new UsageError("--request-message requires --expect");
    }
    if (wait) {
      throw new UsageError("--wait requires --expect");
    }
    return { requestMessage: "", wait: false, json: hasFlag(parsed, "json") };
  }
  if (!REVIEW_KINDS.has(rawExpectation as ReviewKind)) {
    throw new UsageError(`unknown review expectation ${rawExpectation}`);
  }
  return {
    expect: rawExpectation as ReviewKind,
    requestMessage: requestMessage ?? "",
    wait,
    json: hasFlag(parsed, "json"),
  };
}

function writePublicationResult(
  stdout: Writer,
  action: "registered" | "imported",
  path: string,
  document: { id: string; revision: number; route?: string },
  reviewRequest: ReviewRequest | undefined,
  json: boolean,
): void {
  if (json) {
    stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        document: {
          id: document.id,
          revision: document.revision,
          route: document.route ?? `/d/${document.id}`,
        },
        ...(reviewRequest === undefined ? {} : { reviewRequest }),
      })}\n`,
    );
    return;
  }
  stdout.write(`${action} ${document.id}: ${path}\n`);
  if (reviewRequest) {
    stdout.write(
      `review ${reviewRequest.id}: ${reviewRequest.status}${
        reviewRequest.response?.message
          ? ` — ${reviewRequest.response.message}`
          : ""
      }\n`,
    );
  }
}

async function runReview(
  statePath: string,
  args: string[],
  stdout: Writer,
  options: RunOptions,
): Promise<number> {
  const action = args[0];
  if (!action) {
    throw new UsageError("review action is required");
  }
  const parsed = parseArguments(args.slice(1), new Set(["json"]));
  const id = parsed.positionals[0];
  if (!id) {
    throw new UsageError(
      action === "create" ? "document id is required" : "review id is required",
    );
  }
  if (parsed.positionals.length > 1) {
    throw new UsageError(`review ${action} accepts one id`);
  }

  let request: ReviewRequest;
  if (action === "create") {
    rejectUnknownOptions(
      parsed,
      new Set(["revision", "kind", "message", "json"]),
    );
    const kind = (firstOption(parsed, "kind") ?? "plan-decision") as ReviewKind;
    if (!REVIEW_KINDS.has(kind)) {
      throw new UsageError(`unknown review kind ${kind}`);
    }
    const revision = optionalPositiveInteger(parsed, "revision");
    const input = {
      documentId: id,
      ...(revision === undefined ? {} : { documentRevision: revision }),
      kind,
      requestMessage: firstOption(parsed, "message") ?? "",
    };
    const client = await (options.connectDaemon ?? connectToDaemon)(statePath);
    if (client) {
      request = await client.createReviewRequest(input);
    } else {
      const catalog = await Catalog.open(statePath);
      try {
        request = await catalog.createReviewRequest(input);
      } finally {
        catalog.close();
      }
    }
  } else if (action === "show") {
    rejectUnknownOptions(parsed, new Set(["json"]));
    request = await loadReviewRequest(statePath, id, options);
  } else if (action === "wait") {
    rejectUnknownOptions(parsed, new Set(["json"]));
    request = await waitForReviewRequest(statePath, id, options);
  } else if (action === "respond") {
    rejectUnknownOptions(parsed, new Set(["outcome", "message", "json"]));
    const outcome = requiredOption(parsed, "outcome") as ReviewOutcome;
    if (!REVIEW_OUTCOMES.has(outcome)) {
      throw new UsageError(`unknown review outcome ${outcome}`);
    }
    const input = {
      outcome,
      message: firstOption(parsed, "message") ?? "",
    };
    const client = await (options.connectDaemon ?? connectToDaemon)(statePath);
    if (client) {
      request = await client.respondToReviewRequest(id, input);
    } else {
      const catalog = await Catalog.open(statePath);
      try {
        request = await catalog.respondToReviewRequest(id, input);
      } finally {
        catalog.close();
      }
    }
  } else {
    throw new UsageError(
      "review action must be create, show, wait, or respond",
    );
  }
  writeReviewResult(stdout, request, hasFlag(parsed, "json"));
  return 0;
}

function writeReviewResult(
  stdout: Writer,
  request: ReviewRequest,
  json: boolean,
): void {
  if (json) {
    stdout.write(
      `${JSON.stringify({ schemaVersion: 1, reviewRequest: request })}\n`,
    );
    return;
  }
  stdout.write(
    `review ${request.id}: ${request.status}${
      request.response?.message ? ` — ${request.response.message}` : ""
    }\n`,
  );
}

async function loadReviewRequest(
  statePath: string,
  id: string,
  options: RunOptions,
): Promise<ReviewRequest> {
  const client = await (options.connectDaemon ?? connectToDaemon)(statePath);
  if (client) {
    return await client.getReviewRequest(id);
  }
  const catalog = await Catalog.open(statePath);
  try {
    const request = catalog.getReviewRequest(id);
    if (!request) {
      throw new Error(`unknown review request ${id}`);
    }
    return request;
  } finally {
    catalog.close();
  }
}

async function waitForReviewRequest(
  statePath: string,
  id: string,
  options: RunOptions,
): Promise<ReviewRequest> {
  const interval = options.reviewPollIntervalMs ?? 1_000;
  while (true) {
    throwIfAborted(options.signal);
    const client = await (options.connectDaemon ?? connectToDaemon)(statePath);
    if (client) {
      try {
        return await waitForReviewEvent(client, id, options.signal);
      } catch (error) {
        if (options.signal?.aborted) {
          throw new Error("review wait cancelled");
        }
        if (error instanceof DeskApiError && error.status < 500) {
          throw error;
        }
        if (
          error instanceof Error &&
          error.message.startsWith("unknown review")
        ) {
          throw error;
        }
      }
    } else {
      const catalog = await Catalog.open(statePath);
      let request: ReviewRequest | undefined;
      try {
        request = catalog.getReviewRequest(id);
      } finally {
        catalog.close();
      }
      if (!request) {
        throw new Error(`unknown review request ${id}`);
      }
      if (request.status !== "pending") {
        return request;
      }
    }
    await abortableDelay(interval, options.signal);
  }
}

async function waitForReviewEvent(
  client: DeskApiClient,
  id: string,
  signal?: AbortSignal,
): Promise<ReviewRequest> {
  const current = await client.getReviewRequest(id);
  if (current.status !== "pending") {
    return current;
  }
  const controller = new AbortController();
  return await new Promise<ReviewRequest>((resolvePromise, reject) => {
    let settled = false;
    let checking = false;
    const finish = (operation: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      controller.abort();
      signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = (): void => {
      finish(() => reject(new Error("review wait cancelled")));
    };
    const check = (): void => {
      if (settled || checking) {
        return;
      }
      checking = true;
      void client
        .getReviewRequest(id)
        .then((request) => {
          if (request.status !== "pending") {
            finish(() => resolvePromise(request));
          }
        })
        .catch((error: unknown) => finish(() => reject(error)))
        .finally(() => {
          checking = false;
        });
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    void client
      .subscribeCatalog(
        (event) => {
          if (
            event.reviewRequestId === id ||
            event.documentId === current.documentId
          ) {
            check();
          }
        },
        { signal: controller.signal, onReady: check },
      )
      .then(() => {
        if (!settled) {
          finish(() => reject(new Error("daemon event stream ended")));
        }
      })
      .catch((error: unknown) => finish(() => reject(error)));
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("review wait cancelled");
  }
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolvePromise, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("review wait cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function optionalPositiveInteger(
  parsed: ParsedArguments,
  name: string,
): number | undefined {
  const raw = firstOption(parsed, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new UsageError(`--${name} must be a positive integer`);
  }
  return value;
}

function runList(
  catalog: Catalog,
  args: string[],
  stdout: Writer,
): number {
  const parsed = parseArguments(args);
  if (parsed.positionals.length > 0) {
    throw new UsageError("list accepts options only");
  }
  rejectUnknownOptions(parsed, new Set(["workspace", "task"]));
  const workspace = firstOption(parsed, "workspace");
  const task = firstOption(parsed, "task");

  const documents = catalog.listDocuments().filter((document) => {
    if (workspace && document.workspaceId !== workspace) {
      return false;
    }
    if (task && document.taskId !== task) {
      return false;
    }
    return true;
  });
  for (const document of documents) {
    stdout.write(
      [
        document.id,
        document.workspaceId,
        document.taskId ?? "-",
        document.kind,
        document.attention,
        document.title,
        document.path,
      ].join("\t") + "\n",
    );
  }
  return 0;
}

interface ParsedArguments {
  positionals: string[];
  options: Map<string, string[]>;
}

function parseArguments(
  args: string[],
  booleanOptions: ReadonlySet<string> = new Set(),
): ParsedArguments {
  const parsed: ParsedArguments = {
    positionals: [],
    options: new Map(),
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === undefined) {
      continue;
    }
    if (!value.startsWith("--")) {
      parsed.positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    if (booleanOptions.has(name)) {
      const values = parsed.options.get(name) ?? [];
      values.push("true");
      parsed.options.set(name, values);
      continue;
    }
    const optionValue = args[index + 1];
    if (!name || optionValue === undefined || optionValue.startsWith("--")) {
      throw new UsageError(`option --${name || "unknown"} requires a value`);
    }
    const values = parsed.options.get(name) ?? [];
    values.push(optionValue);
    parsed.options.set(name, values);
    index += 1;
  }
  return parsed;
}

function hasFlag(parsed: ParsedArguments, name: string): boolean {
  return parsed.options.has(name);
}

function firstOption(
  parsed: ParsedArguments,
  name: string,
): string | undefined {
  return parsed.options.get(name)?.[0];
}

function requiredOption(parsed: ParsedArguments, name: string): string {
  const value = firstOption(parsed, name);
  if (!value) {
    throw new UsageError(`--${name} is required`);
  }
  return value;
}

function rejectUnknownOptions(
  parsed: ParsedArguments,
  allowed: Set<string>,
): void {
  for (const [name, values] of parsed.options) {
    if (!allowed.has(name)) {
      throw new UsageError(`unknown option --${name}`);
    }
    if (name !== "artifact-root" && name !== "tag" && values.length > 1) {
      throw new UsageError(`option --${name} may be used only once`);
    }
  }
}

function isAddressInUse(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}

function defaultStatePath(): string {
  const stateHome =
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return resolve(stateHome, "mdmaid.desk", "catalog.sqlite3");
}

const entryPath = process.argv[1];
if (entryPath && isEntrypoint(import.meta.url, entryPath)) {
  process.exitCode = await run(
    process.argv.slice(2),
    process.stdout,
    process.stderr,
  );
}

export function isEntrypoint(moduleUrl: string, entryPath: string): boolean {
  try {
    return (
      realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(entryPath))
    );
  } catch {
    return moduleUrl === pathToFileURL(resolve(entryPath)).href;
  }
}
