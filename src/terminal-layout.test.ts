import assert from "node:assert/strict";
import test from "node:test";
import stringWidth from "string-width";

import { renderTerminalDocument } from "./terminal-layout.js";
import { isTerminalBlocks } from "./api-types.js";

test("keeps all table columns readable beside a much longer description", async () => {
  const markdown = [
    "A normal paragraph stays fitted to the current terminal, even when a table needs more room.", "",
    "| Runtime | Documented host coverage | Integration effort and limits | Assessment |",
    "| --- | --- | --- | --- |",
    `| Microsandbox | App hosts | ${"Named sandboxes, command execution, snapshots, SDKs and CLI. ".repeat(4)} | Best fit |`,
  ].join("\n");
  const result = await renderTerminalDocument(markdown, { width: 78 });
  const table = result.blocks.find((block) => block.kind === "wide");
  assert.ok(table);
  assert.match(table.content, /Runtime/);
  assert.match(table.content, /Documented host coverage/);
  assert.match(table.content, /Assessment/);
  assert.match(table.content, /Microsandbox/);
  assert.ok(table.content.split("\n").length < 20, "headers must not become one-character columns");
  assert.ok(result.blocks.filter((block) => block.kind === "flow").every(
    (block) => block.content.split("\n").every((line) => stringWidth(line) <= 78),
  ));
});

test("preserves wide diagram geometry by default while fitting ordinary text", async () => {
  const result = await renderTerminalDocument([
    "Normal prose should wrap into the terminal viewport without horizontal scrolling.", "",
    "```mermaid", "flowchart LR", "A[First service] --> B[Second service] --> C[Last service]", "```",
    "", "More normal text follows the diagram.",
  ].join("\n"), { width: 30 });
  const diagram = result.blocks.find((block) => block.kind === "wide");
  assert.ok(diagram);
  assert.ok(diagram.content.split("\n").some(
    (line) => line.includes("First service") && line.includes("Last service"),
  ), "connected nodes on one row must remain on that row");
  assert.ok(result.blocks.filter((block) => block.kind === "flow").every(
    (block) => block.content.split("\n").every((line) => stringWidth(line) <= 30),
  ));
  assert.equal(result.output, result.blocks.map((block) => block.content).join("\n\n"));
});

test("keeps code lines and unsupported diagram source available for panning", async () => {
  const code = `const message = "${"long value ".repeat(12)}";`;
  const result = await renderTerminalDocument(`\`\`\`ts\n${code}\n\`\`\`\n\n\`\`\`mermaid\nunsupported diagram syntax\n\`\`\``, { width: 30 });
  assert.match(result.blocks[0]!.content, new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.blocks[1]!.content, /unsupported diagram syntax/);
  assert.ok(result.warnings.length > 0);
});

test("validates block metadata and removes terminal operations from all blocks", async () => {
  for (const value of [null, "blocks", [{ kind: "unknown", content: "text" }],
    [{ kind: "wide", content: 12 }], [{ kind: "flow" }], new Array(65_537).fill({ kind: "flow", content: "" })]) {
    assert.equal(isTerminalBlocks(value), false);
  }
  const result = await renderTerminalDocument([
    "# Safe title\u001b]52;c;clipboard-payload\u0007", "", "```text",
    "\u001b[2Jwide text\u202e", "```",
  ].join("\n"), { width: 30, color: true });
  assert.equal(isTerminalBlocks(result.blocks), true);
  assert.doesNotMatch(result.output, /clipboard-payload|\u001b\[2J|\u202e/);
});
