import DOMPurify from "dompurify";
import { fromMarkdown } from "mdast-util-from-markdown";

const MAX_DIAGNOSTIC_LENGTH = 2_000;

export interface MermaidBlock {
  index: number;
  line: number;
  source: string;
}

export interface MermaidValidationIssue {
  block: number;
  line: number;
  message: string;
}

export interface MermaidValidationReport {
  kind: "mermaid";
  valid: boolean;
  diagramCount: number;
  issues: MermaidValidationIssue[];
}

export class MermaidValidationError extends Error {
  readonly issues: MermaidValidationIssue[];

  constructor(readonly report: MermaidValidationReport) {
    super(report.issues.map(formatIssue).join("\n"));
    this.name = "MermaidValidationError";
    this.issues = report.issues;
  }
}

interface MarkdownNode {
  type?: unknown;
  lang?: unknown;
  value?: unknown;
  position?: { start?: { line?: unknown } };
  children?: unknown[];
}

interface ServerPurifier {
  addHook?: (...args: unknown[]) => void;
  removeAllHooks?: () => void;
  sanitize?: (value: string) => string;
}

interface MermaidParser {
  parse(source: string): Promise<unknown>;
}

let parserPromise: Promise<MermaidParser> | undefined;

export function mermaidBlocks(markdown: string): MermaidBlock[] {
  const tree = fromMarkdown(markdown) as MarkdownNode;
  const blocks: MermaidBlock[] = [];
  const visit = (node: MarkdownNode): void => {
    if (
      node.type === "code" &&
      typeof node.lang === "string" &&
      node.lang.toLowerCase() === "mermaid" &&
      typeof node.value === "string"
    ) {
      const line = node.position?.start?.line;
      blocks.push({
        index: blocks.length + 1,
        line: typeof line === "number" ? line : 1,
        source: node.value,
      });
    }
    for (const child of node.children ?? []) {
      if (typeof child === "object" && child !== null) {
        visit(child as MarkdownNode);
      }
    }
  };
  visit(tree);
  return blocks;
}

export async function assertValidMermaidMarkdown(
  markdown: string,
): Promise<void> {
  const report = await validateMermaidMarkdown(markdown);
  if (!report.valid) {
    throw new MermaidValidationError(report);
  }
}

export async function validateMermaidMarkdown(
  markdown: string,
): Promise<MermaidValidationReport> {
  const blocks = mermaidBlocks(markdown);
  if (blocks.length === 0) {
    return {
      kind: "mermaid",
      valid: true,
      diagramCount: 0,
      issues: [],
    };
  }
  const parser = await mermaidParser();
  const issues: MermaidValidationIssue[] = [];
  for (const block of blocks) {
    try {
      await parser.parse(block.source);
    } catch (error) {
      issues.push({
        block: block.index,
        line: block.line,
        message: normalizeDiagnostic(error),
      });
    }
  }
  return {
    kind: "mermaid",
    valid: issues.length === 0,
    diagramCount: blocks.length,
    issues,
  };
}

async function mermaidParser(): Promise<MermaidParser> {
  parserPromise ??= loadMermaidParser();
  return await parserPromise;
}

async function loadMermaidParser(): Promise<MermaidParser> {
  // Mermaid's parsers sanitize labels even when only syntax validation is
  // requested. In Node, dompurify exports a factory until a DOM is supplied.
  // Validation never renders or returns HTML, so an identity sanitizer keeps
  // parsing deterministic without introducing a server-side browser DOM.
  const purifier = DOMPurify as unknown as ServerPurifier;
  purifier.sanitize ??= (value: string): string => value;
  purifier.addHook ??= (): void => {};
  purifier.removeAllHooks ??= (): void => {};
  const mermaidModuleName: string = "mermaid";
  const { default: mermaid } = await import(mermaidModuleName) as {
    default: MermaidParser & {
      initialize(options: Record<string, unknown>): void;
    };
  };
  mermaid.initialize({ securityLevel: "strict", suppressErrorRendering: true });
  return mermaid;
}

function normalizeDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_LENGTH) || "Mermaid parser rejected the diagram";
}

function formatIssue(issue: MermaidValidationIssue): string {
  return `Mermaid diagram ${issue.block} (Markdown line ${issue.line}) is invalid: ${issue.message}`;
}
