import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { renderMarkdownToTui, renderMermaidToAscii } from "mdmaid/tui";
import { createMarkdownSourceMap } from "mdmaid";
import stringWidth from "string-width";

import type { TerminalBlock } from "./api-types.js";
import { sanitizeTerminalText } from "./terminal-text.js";

interface LayoutOptions {
  width: number;
  color?: boolean;
  unicode?: boolean;
  omitFencedCodeLanguages?: readonly string[];
}

interface MarkdownNode {
  type: string;
  lang?: string | null | undefined;
  value?: string | undefined;
  children?: MarkdownNode[] | undefined;
  position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } } | undefined;
}

function hasWideContent(node: MarkdownNode): boolean {
  return node.type === "table" || node.type === "code" ||
    (node.children?.some(hasWideContent) ?? false);
}

/** Compose mdmaid rendering primitives into fitted prose and scrollable blocks. */
export async function renderTerminalDocument(markdown: string, options: LayoutOptions) {
  const source = sanitizeTerminalText(markdown);
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const slice = (node: MarkdownNode): string => source.slice(node.position?.start.offset, node.position?.end.offset);
  const definitions = tree.children.filter((node) => node.type === "definition").map(slice).join("\n\n");
  const sections: Array<{ kind: TerminalBlock["kind"]; source: string; node: MarkdownNode }> = [];
  for (const node of tree.children) {
    if (node.type === "definition") continue;
    if (node.type === "code" && options.omitFencedCodeLanguages?.includes(node.lang?.trim().toLowerCase() ?? "")) continue;
    const kind = hasWideContent(node) ? "wide" : "flow";
    const previous = sections.at(-1);
    if (kind === "flow" && previous?.kind === "flow") previous.source += `\n\n${slice(node)}`;
    else sections.push({ kind, source: slice(node), node });
  }
  const blocks: TerminalBlock[] = [];
  const warnings = new Set<string>();
  for (const section of sections) {
    const node = section.node;
    const codeWidth = (node.value ?? "").split("\n").reduce(
      (maximum, line) => Math.min(1_000, Math.max(maximum, stringWidth(line) + 4)),
      Math.max(8, (node.lang?.length ?? 0) + 6),
    );
    const preferences = { backend: "beautiful-mermaid" as const,
      color: options.color === true, unicode: options.unicode !== false,
      width: section.kind === "flow" ? options.width : node.type === "code" ? codeWidth : 1_000 };
    const result = node.type === "code" && node.lang?.trim().toLowerCase() === "mermaid"
      ? await renderMermaidToAscii(node.value ?? "", preferences)
      : await renderMarkdownToTui(`${section.source}\n\n${definitions}`, preferences);
    for (const warning of result.warnings) warnings.add(sanitizeTerminalText(warning));
    const content = sanitizeTerminalText(result.output, { preserveSgr: true }).replace(/\n+$/, "");
    if (content) blocks.push({ kind: section.kind, content });
  }
  return { output: blocks.map((block) => block.content).join("\n\n"),
    backend: "beautiful-mermaid", warnings: [...warnings], blocks,
    sourceMap: await createMarkdownSourceMap(markdown, options) };
}
