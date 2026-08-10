import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = mkdtempSync(join(tmpdir(), "mdmaid-desk-package-"));
const npmEnvironment = {
  ...process.env,
  npm_config_cache: join(temporaryRoot, "npm-cache"),
};

function execute(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  }).trim();
}

function executeNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("package smoke must run through npm run package:smoke");
  }
  return execute(process.execPath, [npmCli, ...args], options);
}

function parsePackResult(output) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm pack returned an unexpected result");
  }
  const result = parsed[0];
  if (
    !result ||
    typeof result !== "object" ||
    typeof result.filename !== "string" ||
    !Array.isArray(result.files)
  ) {
    throw new Error("npm pack result is missing its filename or file list");
  }
  return result;
}

function verifyArchive(result) {
  const paths = new Set(
    result.files.flatMap((file) =>
      file && typeof file.path === "string" ? [file.path] : [],
    ),
  );
  for (const required of [
    "LICENSE",
    "README.md",
    "package.json",
    "dist/cli.js",
    "dist/server.js",
    "dist/tui.js",
  ]) {
    if (!paths.has(required)) {
      throw new Error(`published archive is missing ${required}`);
    }
  }
  const leakedTest = [...paths].find((path) =>
    /\.test\.(?:js|d\.ts|js\.map)$/.test(path),
  );
  if (leakedTest) {
    throw new Error(`published archive contains test output: ${leakedTest}`);
  }
}

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not reserve a loopback port");
  }
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHealth(child, port, stderr) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`installed daemon exited before health check: ${stderr()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const payload = await response.json();
        if (
          payload?.data?.service === "mdmaid.desk" &&
          payload.data.status === "ok"
        ) {
          return;
        }
      }
    } catch {
      // The process may still be binding its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`installed daemon did not become healthy: ${stderr()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill();
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("installed daemon did not stop")),
        5_000,
      ),
    ),
  ]);
}

async function main() {
  const packageJson = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  const packResult = parsePackResult(
    executeNpm(
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        temporaryRoot,
      ],
      { cwd: packageRoot, env: npmEnvironment },
    ),
  );
  verifyArchive(packResult);

  const archive = join(temporaryRoot, packResult.filename);
  const installRoot = join(temporaryRoot, "install");
  mkdirSync(installRoot);
  executeNpm(
    [
      "install",
      "--prefix",
      installRoot,
      "--no-audit",
      "--no-fund",
      archive,
    ],
    { cwd: temporaryRoot, env: npmEnvironment },
  );

  const installedRoot = join(installRoot, "node_modules", "mdmaid-desk");
  const installedCli = join(installedRoot, "dist", "cli.js");
  if (!existsSync(installedCli)) {
    throw new Error("installed package does not contain the CLI entrypoint");
  }

  const installedVersion = execute(process.execPath, [
    installedCli,
    "--version",
  ]);
  if (installedVersion !== packageJson.version) {
    throw new Error(
      `installed CLI reported ${installedVersion}, expected ${packageJson.version}`,
    );
  }
  const help = execute(process.execPath, [installedCli, "--help"]);
  if (!help.includes("mdmaid-desk web") || !help.includes("mdmaid-desk tui")) {
    throw new Error("installed CLI help is missing the web or TUI command");
  }

  const stateHome = join(temporaryRoot, "state");
  const installedEnvironment = {
    ...process.env,
    XDG_STATE_HOME: stateHome,
  };
  execute(process.execPath, [installedCli, "workspace", "list"], {
    env: installedEnvironment,
  });
  if (!existsSync(join(stateHome, "mdmaid.desk", "catalog.sqlite3"))) {
    throw new Error("installed CLI did not create its SQLite catalog");
  }

  const port = await reservePort();
  const daemon = spawn(
    process.execPath,
    [installedCli, "web", "--port", String(port)],
    {
      env: installedEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let daemonError = "";
  daemon.stderr.setEncoding("utf8");
  daemon.stderr.on("data", (chunk) => {
    daemonError += chunk;
  });
  try {
    await waitForHealth(daemon, port, () => daemonError.trim());
  } finally {
    await stopChild(daemon);
  }

  console.log(
    `package smoke passed for mdmaid-desk@${packageJson.version} (${process.platform}/${process.arch})`,
  );
}

try {
  await main();
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
