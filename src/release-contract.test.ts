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
    url: "https://github.com/OleksandrBesan/mdmaid.desk",
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
