import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const claimScript = join(packageRoot, "scripts", "claim-release.sh");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("release claim rebases a version commit over a concurrent merge before publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-release-claim-"));
  try {
    const remote = join(root, "remote.git");
    const release = join(root, "release");
    const competitor = join(root, "competitor");
    const bin = join(root, "bin");
    const npmLog = join(root, "npm.log");

    git(root, "init", "--bare", "--initial-branch=main", remote);
    git(root, "clone", remote, release);
    git(release, "config", "user.name", "Release Bot");
    git(release, "config", "user.email", "release@example.test");
    await writeFile(join(release, "package.json"), '{"name":"test","version":"0.1.22"}\n');
    git(release, "add", "package.json");
    git(release, "commit", "-m", "initial");
    git(release, "push", "origin", "HEAD:main");

    git(root, "clone", remote, competitor);
    git(competitor, "config", "user.name", "Other Merger");
    git(competitor, "config", "user.email", "merger@example.test");

    await writeFile(join(release, "package.json"), '{"name":"test","version":"0.1.23"}\n');
    git(release, "add", "package.json");
    git(release, "commit", "-m", "v0.1.23 [skip ci]");

    await writeFile(join(competitor, "new-feature.txt"), "merged while release was running\n");
    git(competitor, "add", "new-feature.txt");
    git(competitor, "commit", "-m", "concurrent merge");
    const mergeCommit = git(competitor, "rev-parse", "HEAD");
    git(competitor, "push", "origin", "HEAD:main");

    await mkdir(bin);
    const mockNpm = join(bin, "npm");
    await writeFile(mockNpm, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CLAIM_TEST_LOG"\n');
    await chmod(mockNpm, 0o755);

    const result = spawnSync("bash", [claimScript], {
      cwd: release,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RELEASE_VERSION: "0.1.23",
        CLAIM_TEST_LOG: npmLog,
      },
    });
    assert.equal(result.status, 0, result.stderr);

    const publishedCommit = git(remote, "rev-parse", "refs/heads/main");
    git(remote, "merge-base", "--is-ancestor", mergeCommit, publishedCommit);
    assert.equal(git(remote, "show", "main:package.json"), '{"name":"test","version":"0.1.23"}');
    assert.equal(git(remote, "show", "main:new-feature.txt"), "merged while release was running");
    assert.equal(await readFile(npmLog, "utf8"), "ci\nrun check\nrun package:smoke\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
