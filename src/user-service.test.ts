import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { userServiceDefinition } from "./user-service.js";

test("renders a macOS login service with a selected daemon port", () => {
  const definition = userServiceDefinition({
    platform: "darwin",
    home: "/Users/example",
    execPath: "/opt/node/bin/node",
    entrypoint: "/opt/mdmaid-desk/cli.js",
    statePath: "/Users/example/.local/state/mdmaid.desk/catalog.sqlite3",
    port: 43210,
  });

  assert.equal(
    definition.path,
    "/Users/example/Library/LaunchAgents/dev.mdmaid.desk.plist",
  );
  assert.match(definition.content, /<string>--state-path<\/string>/);
  assert.match(definition.content, /<string>43210<\/string>/);
  assert.match(definition.content, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(
    definition.content,
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
  );
});

test("renders a Linux systemd user service that restarts at login", () => {
  const home = "/home/example";
  const definition = userServiceDefinition({
    platform: "linux",
    home,
    execPath: "/usr/bin/node",
    entrypoint: "/usr/lib/mdmaid-desk/cli.js",
    statePath: join(home, ".local/state/mdmaid.desk/catalog.sqlite3"),
  });

  assert.equal(
    definition.path,
    "/home/example/.config/systemd/user/mdmaid-desk.service",
  );
  assert.match(definition.content, /ExecStart="\/usr\/bin\/node"/);
  assert.match(definition.content, /__daemon-serve/);
  assert.match(definition.content, /Restart=on-failure/);
  assert.match(definition.content, /WantedBy=default.target/);
});

test("escapes systemd specifiers and line breaks in generated arguments", () => {
  const definition = userServiceDefinition({
    platform: "linux",
    home: "/home/example",
    execPath: "/opt/100%/node",
    entrypoint: "/opt/mdmaid\ndesk/cli.js",
    statePath: "/home/example/state/catalog.sqlite3",
  });
  assert.match(definition.content, /100%%/);
  assert.doesNotMatch(definition.content, /mdmaid\ndesk/);
  assert.match(definition.content, /mdmaid\\ndesk/);
});

test("rejects unsupported automatic-start platforms", () => {
  assert.throws(
    () =>
      userServiceDefinition({
        platform: "win32",
        home: "C:\\Users\\example",
        execPath: "node.exe",
        entrypoint: "cli.js",
        statePath: "catalog.sqlite3",
      }),
    /not yet supported on win32/,
  );
});
