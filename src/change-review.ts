import { createHash } from "node:crypto";

const MAX_FILES = 256;
const MAX_HUNKS = 2_048;
const MAX_DIFF_LINES = 50_000;
const MAX_DIFF_LINE_LENGTH = 16 * 1024;
const MAX_PATH_LENGTH = 1_024;

export type ChangeLineKind = "context" | "addition" | "deletion";
export type ChangeFileStatus = "added" | "deleted" | "modified" | "renamed";

export interface ChangeReviewLine {
  kind: ChangeLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface ChangeReviewHunk {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ChangeReviewLine[];
}

export interface ChangeReviewFile {
  path: string;
  previousPath?: string;
  status: ChangeFileStatus;
  hunks: ChangeReviewHunk[];
}

export interface ChangeReviewDiff {
  schemaVersion: 1;
  files: ChangeReviewFile[];
  warnings: string[];
}

export interface ChangedSegments {
  prefix: string;
  oldChanged: string;
  newChanged: string;
  suffix: string;
}

interface ParsedFile {
  path: string;
  previousPath?: string;
  status: ChangeFileStatus;
  hunks: ChangeReviewHunk[];
}

interface ParsedHunk extends Omit<ChangeReviewHunk, "id"> {
  source: string[];
}

export function parseChangeReviewDiffs(markdown: string): ChangeReviewDiff {
  const warnings: string[] = [];
  const files: ChangeReviewFile[] = [];
  let totalHunks = 0;
  let totalLines = 0;

  for (const block of diffFences(markdown)) {
    let currentFile: ParsedFile | undefined;
    let currentHunk: ParsedHunk | undefined;
    let oldLine = 0;
    let newLine = 0;

    const finishHunk = (): void => {
      if (!currentFile || !currentHunk) {
        return;
      }
      if (totalHunks >= MAX_HUNKS) {
        addWarning(warnings, "Additional diff hunks were omitted by the safety limit.");
      } else {
        const identity = [
          currentFile.path,
          currentHunk.header,
          ...currentHunk.source,
        ].join("\n");
        currentFile.hunks.push({
          id: `hunk-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`,
          header: currentHunk.header,
          oldStart: currentHunk.oldStart,
          oldLines: currentHunk.oldLines,
          newStart: currentHunk.newStart,
          newLines: currentHunk.newLines,
          lines: currentHunk.lines,
        });
        totalHunks += 1;
      }
      currentHunk = undefined;
    };

    const finishFile = (): void => {
      finishHunk();
      if (!currentFile) {
        currentFile = undefined;
        return;
      }
      if (files.length >= MAX_FILES) {
        addWarning(warnings, "Additional changed files were omitted by the safety limit.");
      } else {
        files.push(currentFile);
      }
      currentFile = undefined;
    };

    for (const line of block) {
      totalLines += 1;
      if (totalLines > MAX_DIFF_LINES) {
        addWarning(warnings, "Additional diff lines were omitted by the safety limit.");
        break;
      }
      if (line.length > MAX_DIFF_LINE_LENGTH) {
        addWarning(warnings, "An oversized diff line was omitted by the safety limit.");
        continue;
      }

      const fileHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (fileHeader) {
        finishFile();
        const previousPath = fileHeader[1] ?? "";
        const path = fileHeader[2] ?? "";
        if (!isSafeDiffPath(previousPath) || !isSafeDiffPath(path)) {
          addWarning(warnings, "Ignored a diff with an unsafe path.");
          currentFile = undefined;
          continue;
        }
        currentFile = { path, status: "modified", hunks: [] };
        if (previousPath !== path) {
          currentFile.previousPath = previousPath;
          currentFile.status = "renamed";
        }
        continue;
      }
      if (line.startsWith("diff --git ")) {
        finishFile();
        addWarning(warnings, "Ignored a diff with an unsupported file header.");
        continue;
      }
      if (!currentFile) {
        continue;
      }
      if (line.startsWith("new file mode ") || line === "--- /dev/null") {
        currentFile.status = "added";
        continue;
      }
      if (line.startsWith("deleted file mode ") || line === "+++ /dev/null") {
        currentFile.status = "deleted";
        continue;
      }
      if (line.startsWith("rename from ")) {
        const previousPath = line.slice("rename from ".length);
        if (!isSafeDiffPath(previousPath)) {
          addWarning(warnings, "Ignored a diff with an unsafe path.");
          currentFile = undefined;
          currentHunk = undefined;
          continue;
        }
        currentFile.previousPath = previousPath;
        currentFile.status = "renamed";
        continue;
      }
      if (line.startsWith("rename to ")) {
        const path = line.slice("rename to ".length);
        if (!isSafeDiffPath(path)) {
          addWarning(warnings, "Ignored a diff with an unsafe path.");
          currentFile = undefined;
          currentHunk = undefined;
          continue;
        }
        currentFile.path = path;
        currentFile.status = "renamed";
        continue;
      }

      const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
      if (hunkHeader) {
        finishHunk();
        const oldStart = Number(hunkHeader[1]);
        const oldLines = Number(hunkHeader[2] ?? "1");
        const newStart = Number(hunkHeader[3]);
        const newLines = Number(hunkHeader[4] ?? "1");
        if (![oldStart, oldLines, newStart, newLines].every(Number.isSafeInteger)) {
          addWarning(warnings, "Ignored a diff hunk with invalid line numbers.");
          continue;
        }
        oldLine = oldStart;
        newLine = newStart;
        currentHunk = {
          header: line,
          oldStart,
          oldLines,
          newStart,
          newLines,
          lines: [],
          source: [line],
        };
        continue;
      }
      if (!currentHunk || line === "\\ No newline at end of file") {
        continue;
      }
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " ") {
        currentHunk.lines.push({
          kind: "context",
          oldLine,
          newLine,
          text,
        });
        oldLine += 1;
        newLine += 1;
      } else if (marker === "-") {
        currentHunk.lines.push({
          kind: "deletion",
          oldLine,
          newLine: null,
          text,
        });
        oldLine += 1;
      } else if (marker === "+") {
        currentHunk.lines.push({
          kind: "addition",
          oldLine: null,
          newLine,
          text,
        });
        newLine += 1;
      } else {
        continue;
      }
      currentHunk.source.push(line);
    }
    finishFile();
    if (totalLines > MAX_DIFF_LINES) {
      break;
    }
  }

  return { schemaVersion: 1, files, warnings };
}

export function changeReviewNarrative(markdown: string): string {
  const output: string[] = [];
  let fenceLength: number | undefined;
  for (const line of markdown
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")) {
    if (fenceLength === undefined) {
      const opening = /^ {0,3}(`{3,})diff[ \t]*$/.exec(line);
      if (opening) {
        fenceLength = opening[1]!.length;
      } else {
        output.push(line);
      }
      continue;
    }
    const closing = /^ {0,3}(`{3,})[ \t]*$/.exec(line);
    if (closing && closing[1]!.length >= fenceLength) {
      fenceLength = undefined;
    }
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function changedSegments(oldText: string, newText: string): ChangedSegments {
  const oldCharacters = Array.from(oldText);
  const newCharacters = Array.from(newText);
  let prefixLength = 0;
  while (
    prefixLength < oldCharacters.length &&
    prefixLength < newCharacters.length &&
    oldCharacters[prefixLength] === newCharacters[prefixLength]
  ) {
    prefixLength += 1;
  }
  let suffixLength = 0;
  while (
    suffixLength < oldCharacters.length - prefixLength &&
    suffixLength < newCharacters.length - prefixLength &&
    oldCharacters[oldCharacters.length - suffixLength - 1] ===
      newCharacters[newCharacters.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }
  const end = (characters: string[]): number =>
    suffixLength === 0 ? characters.length : characters.length - suffixLength;
  return {
    prefix: oldCharacters.slice(0, prefixLength).join(""),
    oldChanged: oldCharacters.slice(prefixLength, end(oldCharacters)).join(""),
    newChanged: newCharacters.slice(prefixLength, end(newCharacters)).join(""),
    suffix: oldCharacters.slice(end(oldCharacters)).join(""),
  };
}

export function isChangeReviewDiff(value: unknown): value is ChangeReviewDiff {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
      !Array.isArray(value.files) || value.files.length > MAX_FILES ||
      !Array.isArray(value.warnings) ||
      !value.warnings.every((warning) => typeof warning === "string" && warning.length <= 512)) {
    return false;
  }
  let hunks = 0;
  let lines = 0;
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.path !== "string" || !isSafeDiffPath(file.path) ||
        (file.previousPath !== undefined &&
          (typeof file.previousPath !== "string" || !isSafeDiffPath(file.previousPath))) ||
        !["added", "deleted", "modified", "renamed"].includes(String(file.status)) ||
        !Array.isArray(file.hunks)) {
      return false;
    }
    hunks += file.hunks.length;
    if (hunks > MAX_HUNKS) {
      return false;
    }
    for (const hunk of file.hunks) {
      if (!isRecord(hunk) || typeof hunk.id !== "string" ||
          !/^hunk-[a-f0-9]{20}$/.test(hunk.id) || typeof hunk.header !== "string" ||
          !isSafeLineNumber(hunk.oldStart) || !isSafeLineCount(hunk.oldLines)) {
        return false;
      }
      if (!isSafeLineNumber(hunk.newStart) || !isSafeLineCount(hunk.newLines) ||
          !Array.isArray(hunk.lines)) {
        return false;
      }
      lines += hunk.lines.length;
      if (lines > MAX_DIFF_LINES) {
        return false;
      }
      for (const line of hunk.lines) {
        if (!isRecord(line) ||
            !["context", "addition", "deletion"].includes(String(line.kind)) ||
            !isNullableLineNumber(line.oldLine) || !isNullableLineNumber(line.newLine) ||
            typeof line.text !== "string" || line.text.length > MAX_DIFF_LINE_LENGTH) {
          return false;
        }
      }
    }
  }
  return true;
}

function diffFences(markdown: string): string[][] {
  const blocks: string[][] = [];
  let current: { fenceLength: number; lines: string[] } | undefined;
  for (const line of markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    const opening = /^ {0,3}(`{3,})diff[ \t]*$/.exec(line);
    if (!current && opening) {
      current = { fenceLength: opening[1]!.length, lines: [] };
      continue;
    }
    if (current) {
      const closing = /^ {0,3}(`{3,})[ \t]*$/.exec(line);
      if (closing && closing[1]!.length >= current.fenceLength) {
        blocks.push(current.lines);
        current = undefined;
        continue;
      }
      current.lines.push(line);
    }
  }
  return blocks;
}

function isSafeDiffPath(path: string): boolean {
  if (
    path === "" ||
    path.length > MAX_PATH_LENGTH ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    return false;
  }
  const segments = path.replaceAll("\\", "/").split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function addWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) {
    warnings.push(warning);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeLineNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeLineCount(value: unknown): value is number {
  return isSafeLineNumber(value);
}

function isNullableLineNumber(value: unknown): value is number | null {
  return value === null || isSafeLineNumber(value);
}
