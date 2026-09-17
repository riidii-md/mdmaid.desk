import assert from "node:assert/strict";
import test from "node:test";

import {
  changeReviewNarrative,
  changedSegments,
  isChangeReviewDiff,
  parseChangeReviewDiffs,
} from "./change-review.js";

const REVIEW = [
  "# Change review",
  "",
  "```diff",
  "diff --git a/src/auth.ts b/src/auth.ts",
  "index 1111111..2222222 100644",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -10,3 +10,4 @@ export function verify(token: string) {",
  "   if (!token) return null;",
  "-  return users.find((user) => user.token == token);",
  "+  return users.find((user) => user.token === token);",
  "+  // Preserve the authenticated user.",
  " }",
  "diff --git a/test/auth.test.ts b/test/auth.test.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/test/auth.test.ts",
  "@@ -0,0 +1,2 @@",
  "+test('rejects missing tokens', () => {",
  "+});",
  "```",
].join("\n");

test("parses bounded git diff fences into stable files and hunks", () => {
  const parsed = parseChangeReviewDiffs(REVIEW);

  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.files[0]?.path, "src/auth.ts");
  assert.equal(parsed.files[0]?.status, "modified");
  assert.match(parsed.files[0]?.hunks[0]?.id ?? "", /^hunk-[a-f0-9]{20}$/);
  assert.deepEqual(
    parsed.files[0]?.hunks[0]?.lines.map((line) => [
      line.kind,
      line.oldLine,
      line.newLine,
    ]),
    [
      ["context", 10, 10],
      ["deletion", 11, null],
      ["addition", null, 11],
      ["addition", null, 12],
      ["context", 12, 13],
    ],
  );
  assert.equal(parsed.files[1]?.status, "added");
  assert.deepEqual(parsed.warnings, []);

  assert.equal(
    parsed.files[0]?.hunks[0]?.id,
    parseChangeReviewDiffs(REVIEW).files[0]?.hunks[0]?.id,
  );
});

test("isolates malformed or unsafe diff entries without exposing them", () => {
  const parsed = parseChangeReviewDiffs([
    "```diff",
    "diff --git a/../../secret.txt b/../../secret.txt",
    "--- a/../../secret.txt",
    "+++ b/../../secret.txt",
    "@@ -1 +1 @@",
    "-secret",
    "+still secret",
    "```",
  ].join("\n"));

  assert.deepEqual(parsed.files, []);
  assert.deepEqual(parsed.warnings, ["Ignored a diff with an unsafe path."]);
});

test("finds intra-line changed segments without losing shared text", () => {
  assert.deepEqual(
    changedSegments(
      "return user.token == token;",
      "return user.token === token;",
    ),
    {
      prefix: "return user.token ==",
      oldChanged: "",
      newChanged: "=",
      suffix: " token;",
    },
  );
});

test("keeps binary and mode-only files in the navigation inventory", () => {
  const parsed = parseChangeReviewDiffs([
    "```diff",
    "diff --git a/assets/logo.png b/assets/logo.png",
    "new file mode 100644",
    "Binary files /dev/null and b/assets/logo.png differ",
    "diff --git a/scripts/review.sh b/scripts/review.sh",
    "old mode 100644",
    "new mode 100755",
    "```",
  ].join("\n"));

  assert.deepEqual(
    parsed.files.map(({ path, status, hunks }) => [path, status, hunks.length]),
    [
      ["assets/logo.png", "added", 0],
      ["scripts/review.sh", "modified", 0],
    ],
  );
});

test("keeps ordinary spaces in unquoted Git paths", () => {
  const parsed = parseChangeReviewDiffs([
    "```diff",
    "diff --git a/docs/review notes.md b/docs/review notes.md",
    "--- a/docs/review notes.md\t",
    "+++ b/docs/review notes.md\t",
    "@@ -1 +1 @@",
    "-old note",
    "+new note",
    "```",
  ].join("\n"));

  assert.equal(parsed.files[0]?.path, "docs/review notes.md");
  assert.equal(parsed.files[0]?.hunks.length, 1);
});

test("supports a longer outer fence when the patch contains Markdown fences", () => {
  const parsed = parseChangeReviewDiffs([
    "````diff",
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1 @@",
    "-```text",
    "+```diff",
    "````",
  ].join("\n"));

  assert.equal(parsed.files[0]?.path, "README.md");
  assert.deepEqual(
    parsed.files[0]?.hunks[0]?.lines.map(({ text }) => text),
    ["```text", "```diff"],
  );
});

test("keeps diff payloads out of the rendered review narrative", () => {
  const narrative = changeReviewNarrative([
    "# Review summary",
    "",
    "The behavior changed.",
    "",
    "```ts",
    "const visible = true;",
    "```",
    "",
    "````diff",
    "diff --git a/src/auth.ts b/src/auth.ts",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1 +1 @@",
    "-return false;",
    "+return true;",
    "````",
  ].join("\n"));

  assert.match(narrative, /Review summary/);
  assert.match(narrative, /const visible = true/);
  assert.doesNotMatch(narrative, /diff --git|return false|return true/);
});

test("validates the bounded diff model at the API trust boundary", () => {
  const parsed = parseChangeReviewDiffs(REVIEW);
  assert.equal(isChangeReviewDiff(parsed), true);
  assert.equal(isChangeReviewDiff({ ...parsed, schemaVersion: 2 }), false);
  assert.equal(isChangeReviewDiff({
    ...parsed,
    files: [{ ...parsed.files[0], path: "../../secret.txt" }],
  }), false);
  assert.equal(isChangeReviewDiff({
    ...parsed,
    files: [{
      ...parsed.files[0],
      hunks: [{ ...parsed.files[0]?.hunks[0], id: "untrusted" }],
    }],
  }), false);
});
