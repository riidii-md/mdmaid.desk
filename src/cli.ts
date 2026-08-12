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
  type RegisterDocumentInput,
} from "./catalog.js";
import { DeskApiClient } from "./api-client.js";
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

const usage = `mdmaid-desk manages a local catalog of Markdown artifacts.

Usage:
  mdmaid-desk --version
  mdmaid-desk workspace add <root> --id <id> [--name <name>]
      [--artifact-root <path> ...]
  mdmaid-desk workspace list
  mdmaid-desk register <file.md> --workspace <id>
      [--task <id>] [--producer <name>] [--kind <kind>] [--title <title>]
      [--attention <state>] [--tag <tag> ...]
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
  const parsed = parseArguments(args);
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
  let id: string;
  if (client) {
    id = (await client.registerDocument(input)).id;
  } else {
    const catalog = await Catalog.open(statePath);
    try {
      id = (await catalog.registerDocument(input)).id;
    } finally {
      catalog.close();
    }
  }
  stdout.write(`registered ${id}: ${path}\n`);
  return 0;
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

function parseArguments(args: string[]): ParsedArguments {
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
