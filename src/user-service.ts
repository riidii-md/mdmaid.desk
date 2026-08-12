import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stopDaemon } from "./daemon-lifecycle.js";
import { syncDirectory } from "./fs-durability.js";

const SERVICE_LABEL = "dev.mdmaid.desk";

export interface UserServiceOptions {
  platform: NodeJS.Platform;
  home: string;
  execPath: string;
  entrypoint: string;
  statePath: string;
  port?: number;
}

export interface UserServiceDefinition {
  path: string;
  content: string;
}

export function userServiceDefinition(
  options: UserServiceOptions,
): UserServiceDefinition {
  const arguments_ = [
    options.execPath,
    options.entrypoint,
    "__daemon-serve",
    "--state-path",
    resolve(options.statePath),
    ...(options.port === undefined ? [] : ["--port", String(options.port)]),
  ];
  if (options.platform === "darwin") {
    const logPath = join(dirname(resolve(options.statePath)), "daemon.log");
    return {
      path: join(
        resolve(options.home),
        "Library",
        "LaunchAgents",
        `${SERVICE_LABEL}.plist`,
      ),
      content: renderLaunchAgent(arguments_, logPath),
    };
  }
  if (options.platform === "linux") {
    return {
      path: join(
        resolve(options.home),
        ".config",
        "systemd",
        "user",
        "mdmaid-desk.service",
      ),
      content: renderSystemdUnit(arguments_),
    };
  }
  throw new Error(
    `automatic user-service installation is not yet supported on ${options.platform}`,
  );
}

export async function installUserService(
  statePath: string,
  port?: number,
): Promise<string> {
  await stopDaemon(statePath);
  await prepareServiceState(statePath);
  const definition = currentDefinition(statePath, port);
  await writeUserOnlyFile(definition.path, definition.content);
  if (process.platform === "darwin") {
    const uid = requireUid();
    const domain = `gui/${uid}`;
    await runCommand("launchctl", [
      "bootout",
      `${domain}/${SERVICE_LABEL}`,
    ], true);
    await runCommand("launchctl", ["bootstrap", domain, definition.path]);
    await runCommand("launchctl", [
      "enable",
      `${domain}/${SERVICE_LABEL}`,
    ]);
    await runCommand("launchctl", [
      "kickstart",
      "-k",
      `${domain}/${SERVICE_LABEL}`,
    ]);
  } else if (process.platform === "linux") {
    await runCommand("systemctl", ["--user", "daemon-reload"]);
    await runCommand("systemctl", [
      "--user",
      "enable",
      "--now",
      "mdmaid-desk.service",
    ]);
  }
  return definition.path;
}

export async function uninstallUserService(
  statePath: string,
): Promise<string> {
  const definition = currentDefinition(statePath);
  if (process.platform === "darwin") {
    const uid = requireUid();
    await runCommand(
      "launchctl",
      ["bootout", `gui/${uid}/${SERVICE_LABEL}`],
      true,
    );
  } else if (process.platform === "linux") {
    await runCommand(
      "systemctl",
      ["--user", "disable", "--now", "mdmaid-desk.service"],
      true,
    );
  }
  await unlinkIfPresent(definition.path);
  if (process.platform === "linux") {
    await runCommand("systemctl", ["--user", "daemon-reload"]);
  }
  await stopDaemon(statePath);
  return definition.path;
}

function currentDefinition(
  statePath: string,
  port?: number,
): UserServiceDefinition {
  return userServiceDefinition({
    platform: process.platform,
    home: homedir(),
    execPath: process.execPath,
    entrypoint: fileURLToPath(new URL("./cli.js", import.meta.url)),
    statePath,
    ...(port === undefined ? {} : { port }),
  });
}

function renderLaunchAgent(arguments_: string[], logPath: string): string {
  const values = arguments_
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${values}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logPath)}</string>
  </dict>
</plist>
`;
}

function renderSystemdUnit(arguments_: string[]): string {
  return `[Unit]
Description=mdmaid.desk local document service

[Service]
Type=simple
ExecStart=${arguments_.map(systemdQuote).join(" ")}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function systemdQuote(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}"`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function writeUserOnlyFile(path: string, content: string): Promise<void> {
  const destination = resolve(path);
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertReplaceable(destination);
  const temporary = join(
    directory,
    `.${basename(destination)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let created = false;
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    created = false;
    await syncDirectory(directory);
  } finally {
    if (created) {
      await unlinkIfPresent(temporary);
    }
  }
}

async function prepareServiceState(statePath: string): Promise<void> {
  const directory = dirname(resolve(statePath));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const logPath = join(directory, "daemon.log");
  const handle = await open(
    logPath,
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY,
    0o600,
  );
  await handle.close();
  await chmod(logPath, 0o600);
}

async function assertReplaceable(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("user service file must be a regular, non-symlink file");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("user service file must be owned by the current user");
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function requireUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("cannot determine current user id");
  }
  return process.getuid();
}

function runCommand(
  command: string,
  args: string[],
  ignoreFailure = false,
): Promise<void> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(command, args, { encoding: "utf8" }, (error) => {
      if (error && !ignoreFailure) {
        rejectCommand(error);
        return;
      }
      resolveCommand();
    });
  });
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
