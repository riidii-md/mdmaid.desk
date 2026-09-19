import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function readPackageJson(): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

test("publishes a minimal public mdmaid-desk package", async () => {
  const packageJson = await readPackageJson();

  assert.equal(packageJson.name, "mdmaid-desk");
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.license, "MIT");
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "https://github.com/riidii-md/mdmaid.desk",
  });
  assert.deepEqual(packageJson.files, ["dist", "!dist/*.test.*"]);
  assert.deepEqual(packageJson.publishConfig, {
    access: "public",
    provenance: true,
  });

  const engines = packageJson.engines as Record<string, unknown> | undefined;
  assert.equal(engines?.node, ">=22");

  const scripts = packageJson.scripts as Record<string, unknown> | undefined;
  assert.equal(
    scripts?.["package:smoke"],
    "npm run build && node scripts/package-smoke.mjs",
  );
  assert.equal(
    scripts?.prepublishOnly,
    "npm run check && npm run package:smoke",
  );

  await access(join(packageRoot, "LICENSE"));
});

test("release CI verifies packages before trusted publication", async () => {
  const workflow = await readFile(
    join(packageRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );

  assert.match(workflow, /node-version:\s*\[22\.x, 24\.x\]/);
  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /macos-latest/);
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /npm run package:smoke/);
  assert.match(workflow, /environment:\s*prod/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /npm publish --access public/);
  assert.match(workflow, /gh release create/);
});

test("release CI claims a current main commit before publishing", async () => {
  const workflow = await readFile(
    join(packageRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );

  const publishJob = workflow.slice(workflow.indexOf("  publish:\n"));
  const claimPosition = publishJob.indexOf("- name: Claim release commit");
  const npmPublishPosition = publishJob.indexOf("- name: Publish to npm with trusted publishing");
  const tagPosition = publishJob.indexOf("- name: Push release tag");

  assert.match(publishJob, /fetch-depth: 0\n\s+ref: main/);
  assert.match(publishJob, /npm version patch --no-git-tag-version/);
  assert.ok(claimPosition > 0, "release commit must be claimed");
  assert.ok(npmPublishPosition > claimPosition, "claim must precede npm publish");
  assert.ok(tagPosition > npmPublishPosition, "tag must follow npm publish");
  assert.match(publishJob, /bash scripts\/claim-release\.sh/);
  assert.match(publishJob, /mode=skip/);
});
