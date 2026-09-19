import { execFile } from "node:child_process";

import { FALLBACK_DESK_PORT } from "./service-config.js";

const ROUTE_CONTAINER = "mdmaid-desk-traefik-route";
const ROUTE_IMAGE = "caddy:2-alpine";
const ROUTER_RULE = "Host(`mdmaid.desk.localhost`)";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<CommandResult>;

export interface TraefikRouteOptions {
  platform?: NodeJS.Platform;
  runCommand?: CommandRunner;
}

export async function ensureTraefikRoute(
  options: TraefikRouteOptions = {},
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "darwin") {
    return false;
  }
  const runCommand = options.runCommand ?? run;
  try {
    const ids = splitLines(
      (
        await runCommand("docker", [
          "ps",
          "--filter",
          "publish=80",
          "--format",
          "{{.ID}}",
        ])
      ).stdout,
    );
    for (const id of ids) {
      const owner = await inspectContainer(runCommand, id);
      const network = traefikNetwork(owner);
      if (network === undefined) {
        continue;
      }
      return await ensureRouteContainer(runCommand, network);
    }
  } catch {
    return false;
  }
  return false;
}

async function ensureRouteContainer(
  runCommand: CommandRunner,
  network: string,
): Promise<boolean> {
  let existing: ContainerInspection | undefined;
  try {
    existing = await inspectContainer(runCommand, ROUTE_CONTAINER);
  } catch {
    existing = undefined;
  }
  if (existing !== undefined) {
    if (!isManagedRoute(existing, network)) {
      return false;
    }
    if (!existing.stateRunning) {
      await runCommand("docker", ["start", ROUTE_CONTAINER]);
    }
    return true;
  }

  await runCommand("docker", [
    "run",
    "--detach",
    "--name",
    ROUTE_CONTAINER,
    "--restart",
    "unless-stopped",
    "--network",
    network,
    "--label",
    "dev.mdmaid.desk.role=traefik-route",
    "--label",
    "traefik.enable=true",
    "--label",
    `traefik.docker.network=${network}`,
    "--label",
    "traefik.http.routers.mdmaid-desk.entrypoints=web",
    "--label",
    `traefik.http.routers.mdmaid-desk.rule=${ROUTER_RULE}`,
    "--label",
    "traefik.http.routers.mdmaid-desk.service=mdmaid-desk",
    "--label",
    `traefik.http.services.mdmaid-desk.loadbalancer.server.port=${FALLBACK_DESK_PORT}`,
    ROUTE_IMAGE,
    "caddy",
    "reverse-proxy",
    "--from",
    `:${FALLBACK_DESK_PORT}`,
    "--to",
    `host.docker.internal:${FALLBACK_DESK_PORT}`,
  ]);
  return true;
}

interface ContainerInspection {
  image: string;
  command: string[];
  labels: Record<string, string>;
  networks: string[];
  stateRunning: boolean;
}

async function inspectContainer(
  runCommand: CommandRunner,
  id: string,
): Promise<ContainerInspection> {
  const raw = (await runCommand("docker", ["inspect", id])).stdout;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error("invalid Docker inspection response");
  }
  const value = parsed[0];
  const config = value.Config;
  const state = value.State;
  const networkSettings = value.NetworkSettings;
  if (!isRecord(config) || !isRecord(state) || !isRecord(networkSettings)) {
    throw new Error("invalid Docker inspection response");
  }
  if (typeof config.Image !== "string") {
    throw new Error("invalid Docker image metadata");
  }
  const command = stringArray(config.Cmd);
  const labels = stringRecord(config.Labels);
  const networksValue = networkSettings.Networks;
  if (!isRecord(networksValue)) {
    throw new Error("invalid Docker network metadata");
  }
  return {
    image: config.Image,
    command,
    labels,
    networks: Object.keys(networksValue),
    stateRunning: state.Running === true,
  };
}

function traefikNetwork(container: ContainerInspection): string | undefined {
  const title = container.labels["org.opencontainers.image.title"];
  const imageName = container.image.toLowerCase();
  const isTraefik =
    title?.toLowerCase() === "traefik" ||
    imageName.startsWith("traefik:") ||
    imageName.includes("/traefik:");
  if (!container.stateRunning || !isTraefik) {
    return undefined;
  }
  const dockerProvider = container.command.find((argument) =>
    argument.startsWith("--providers.docker="),
  );
  if (
    dockerProvider !== "--providers.docker=true" ||
    !container.command.includes("--entrypoints.web.address=:80")
  ) {
    return undefined;
  }
  const configured = container.command
    .find((argument) => argument.startsWith("--providers.docker.network="))
    ?.slice("--providers.docker.network=".length);
  if (configured) {
    return container.networks.includes(configured) ? configured : undefined;
  }
  return container.networks[0];
}

function isManagedRoute(
  container: ContainerInspection,
  network: string,
): boolean {
  return (
    container.image === ROUTE_IMAGE &&
    container.labels["dev.mdmaid.desk.role"] === "traefik-route" &&
    container.labels["traefik.http.routers.mdmaid-desk.rule"] === ROUTER_RULE &&
    container.labels["traefik.enable"] === "true" &&
    container.labels["traefik.docker.network"] === network &&
    container.labels["traefik.http.routers.mdmaid-desk.entrypoints"] === "web" &&
    container.labels["traefik.http.routers.mdmaid-desk.service"] ===
      "mdmaid-desk" &&
    container.labels[
      "traefik.http.services.mdmaid-desk.loadbalancer.server.port"
    ] === String(FALLBACK_DESK_PORT) &&
    container.networks.includes(network) &&
    container.command[0] === "caddy" &&
    container.command.includes("reverse-proxy") &&
    container.command.includes(`host.docker.internal:${FALLBACK_DESK_PORT}`)
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("invalid Docker command metadata");
  }
  return value;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return result;
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function dockerCommandCandidates(
  platform: NodeJS.Platform,
): readonly string[] {
  return platform === "darwin"
    ? [
        "docker",
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
        "/Applications/OrbStack.app/Contents/MacOS/xbin/docker",
      ]
    : ["docker"];
}

async function run(
  command: string,
  args: readonly string[],
): Promise<CommandResult> {
  const candidates =
    command === "docker"
      ? dockerCommandCandidates(process.platform)
      : [command];
  for (const candidate of candidates) {
    try {
      return await execute(candidate, args);
    } catch (error) {
      if (
        candidate === candidates[candidates.length - 1] ||
        !isNodeError(error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  throw new Error(`${command} executable not found`);
}

function execute(
  command: string,
  args: readonly string[],
): Promise<CommandResult> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(command, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        rejectRun(error);
        return;
      }
      resolveRun({ stdout, stderr });
    });
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
