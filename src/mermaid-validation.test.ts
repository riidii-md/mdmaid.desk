import assert from "node:assert/strict";
import test from "node:test";

import {
  MermaidValidationError,
  assertValidMermaidMarkdown,
  mermaidBlocks,
  validateMermaidMarkdown,
} from "./mermaid-validation.js";

test("finds Mermaid blocks with stable document locations", () => {
  assert.deepEqual(
    mermaidBlocks([
      "# Review",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "",
      "~~~mermaid title=states",
      "stateDiagram-v2",
      "  [*] --> Ready",
      "~~~",
    ].join("\n")),
    [
      { index: 1, line: 3, source: "flowchart LR\n  A --> B" },
      { index: 2, line: 8, source: "stateDiagram-v2\n  [*] --> Ready" },
    ],
  );
});

test("accepts valid diagrams and reports the exact invalid block", async () => {
  await assert.doesNotReject(assertValidMermaidMarkdown([
    "```mermaid",
    "classDiagram",
    "  class Review",
    "```",
  ].join("\n")));

  await assert.rejects(
    assertValidMermaidMarkdown([
      "# Review",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "",
      "```mermaid",
      "stateDiagram-v2",
      "  [*] -->",
      "```",
    ].join("\n")),
    (error: unknown) => {
      assert.ok(error instanceof MermaidValidationError);
      assert.equal(error.issues[0]?.block, 2);
      assert.equal(error.issues[0]?.line, 8);
      assert.match(error.message, /Mermaid diagram 2.*line 8/i);
      assert.match(error.message, /parse error/i);
      return true;
    },
  );
});

test("returns a complete structured report for every Mermaid block", async () => {
  const report = await validateMermaidMarkdown([
    "```mermaid",
    "flowchart LR",
    "  A --> B",
    "```",
    "",
    "```mermaid",
    "stateDiagram-v2",
    "  [*] -->",
    "```",
    "",
    "```mermaid",
    "stateDiagram-v2",
    "  Ready -->",
    "```",
  ].join("\n"));

  assert.equal(report.kind, "mermaid");
  assert.equal(report.valid, false);
  assert.equal(report.diagramCount, 3);
  assert.deepEqual(
    report.issues.map(({ block, line }) => ({ block, line })),
    [
      { block: 2, line: 6 },
      { block: 3, line: 11 },
    ],
  );
  assert.ok(report.issues.every(({ message }) => /parse error/i.test(message)));
});
