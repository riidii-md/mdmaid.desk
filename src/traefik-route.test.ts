import assert from "node:assert/strict";
import test from "node:test";

import {
  dockerCommandCandidates,
  ensureTraefikRoute,
  type CommandRunner,
} from "./traefik-route.js";

interface Call {
  command: string;
  args: readonly string[];
}

test("finds Docker from standard macOS locations under a minimal service PATH", () => {
  assert.deepEqual(dockerCommandCandidates("darwin"), [
    "docker",
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/OrbStack.app/Contents/MacOS/xbin/docker",
  ]);
});

test("returns false without mutating Docker when port 80 is not owned by Traefik", async () => {
  const calls: Call[] = [];
  const runCommand: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === "ps") {
      return { stdout: "web-server\n", stderr: "" };
    }
    return {
      stdout: JSON.stringify([
        {
          Id: "web-server",
          Config: { Image: "nginx:alpine", Cmd: [], Labels: {} },
          State: { Running: true },
          NetworkSettings: { Networks: { proxy: {} } },
        },
      ]),
      stderr: "",
    };
  };

  assert.equal(
    await ensureTraefikRoute({ platform: "darwin", runCommand }),
    false,
  );
  assert.equal(calls.some((call) => call.args[0] === "run"), false);
});

test("creates a labeled Caddy bridge on Traefik's Docker network", async () => {
  const calls: Call[] = [];
  const runCommand: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === "ps") {
      return { stdout: "traefik-id\n", stderr: "" };
    }
    if (args[0] === "inspect" && args[1] === "traefik-id") {
      return {
        stdout: JSON.stringify([
          {
            Id: "traefik-id",
            Config: {
              Image: "traefik:v3.7.8",
              Cmd: [
                "--providers.docker=true",
                "--providers.docker.exposedbydefault=false",
                "--providers.docker.network=proxy",
                "--entrypoints.web.address=:80",
              ],
              Labels: { "org.opencontainers.image.title": "Traefik" },
            },
            State: { Running: true },
            NetworkSettings: { Networks: { proxy: {} } },
          },
        ]),
        stderr: "",
      };
    }
    if (
      args[0] === "inspect" &&
      args[1] === "mdmaid-desk-traefik-route"
    ) {
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    if (args[0] === "run") {
      return { stdout: "route-id\n", stderr: "" };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };

  assert.equal(
    await ensureTraefikRoute({ platform: "darwin", runCommand }),
    true,
  );

  const run = calls.find((call) => call.args[0] === "run");
  assert.ok(run);
  assert.equal(run.command, "docker");
  assert.ok(run.args.includes("proxy"));
  assert.ok(run.args.includes("traefik.enable=true"));
  assert.ok(
    run.args.includes(
      "traefik.http.routers.mdmaid-desk.rule=Host(`mdmaid.desk.localhost`)",
    ),
  );
  assert.ok(
    run.args.includes(
      "traefik.http.services.mdmaid-desk.loadbalancer.server.port=43127",
    ),
  );
  assert.ok(run.args.includes("caddy:2-alpine"));
  assert.deepEqual(run.args.slice(-7), [
    "caddy:2-alpine",
    "caddy",
    "reverse-proxy",
    "--from",
    ":43127",
    "--to",
    "host.docker.internal:43127",
  ]);
});

test("reuses an existing healthy mdmaid route container", async () => {
  const calls: Call[] = [];
  const runCommand: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === "ps") {
      return { stdout: "traefik-id\n", stderr: "" };
    }
    if (args[0] === "inspect" && args[1] === "traefik-id") {
      return {
        stdout: JSON.stringify([traefikInspection()]),
        stderr: "",
      };
    }
    if (
      args[0] === "inspect" &&
      args[1] === "mdmaid-desk-traefik-route"
    ) {
      return {
        stdout: JSON.stringify([
          {
            Id: "route-id",
            Config: {
              Image: "caddy:2-alpine",
              Cmd: [
                "caddy",
                "reverse-proxy",
                "--from",
                ":43127",
                "--to",
                "host.docker.internal:43127",
              ],
              Labels: {
                "dev.mdmaid.desk.role": "traefik-route",
                "traefik.enable": "true",
                "traefik.docker.network": "proxy",
                "traefik.http.routers.mdmaid-desk.entrypoints": "web",
                "traefik.http.routers.mdmaid-desk.rule":
                  "Host(`mdmaid.desk.localhost`)",
                "traefik.http.routers.mdmaid-desk.service": "mdmaid-desk",
                "traefik.http.services.mdmaid-desk.loadbalancer.server.port":
                  "43127",
              },
            },
            State: { Running: true },
            NetworkSettings: { Networks: { proxy: {} } },
          },
        ]),
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };

  assert.equal(
    await ensureTraefikRoute({ platform: "darwin", runCommand }),
    true,
  );
  assert.equal(calls.some((call) => call.args[0] === "run"), false);
});

test("does not attempt the Docker bridge outside macOS", async () => {
  let called = false;
  assert.equal(
    await ensureTraefikRoute({
      platform: "linux",
      runCommand: async () => {
        called = true;
        return { stdout: "", stderr: "" };
      },
    }),
    false,
  );
  assert.equal(called, false);
});

function traefikInspection(): unknown {
  return {
    Id: "traefik-id",
    Config: {
      Image: "traefik:v3.7.8",
      Cmd: [
        "--providers.docker=true",
        "--providers.docker.network=proxy",
        "--entrypoints.web.address=:80",
      ],
      Labels: { "org.opencontainers.image.title": "Traefik" },
    },
    State: { Running: true },
    NetworkSettings: { Networks: { proxy: {} } },
  };
}
