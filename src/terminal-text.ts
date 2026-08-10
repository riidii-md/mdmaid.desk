const ESC = 0x1b;
const BEL = 0x07;
const CSI = 0x9b;
const ST = 0x9c;
const OSC = 0x9d;
const STRING_CONTROLS = new Set([0x90, 0x98, 0x9e, 0x9f]);

export interface TerminalSanitizeOptions {
  preserveSgr?: boolean;
}

/**
 * Removes terminal operations from boundary text. Trusted renderer-owned SGR
 * styling can be retained, while cursor movement, OSC, clipboard, hyperlinks,
 * C0/C1 controls, and bidi overrides are always discarded.
 */
export function sanitizeTerminalText(
  value: string,
  options: TerminalSanitizeOptions = {},
): string {
  const input = value.replace(/\r\n?/g, "\n");
  let output = "";
  let index = 0;

  while (index < input.length) {
    const code = input.charCodeAt(index);

    if (code === ESC) {
      const scanned = scanEscape(input, index + 1);
      if (options.preserveSgr && scanned.sgr !== undefined) {
        output += scanned.sgr;
      }
      index = scanned.end;
      continue;
    }
    if (code === CSI) {
      index = scanCsi(input, index + 1).end;
      continue;
    }
    if (code === OSC) {
      index = skipString(input, index + 1, true);
      continue;
    }
    if (STRING_CONTROLS.has(code)) {
      index = skipString(input, index + 1, false);
      continue;
    }
    if (code === 0x09) {
      output += "    ";
      index += 1;
      continue;
    }
    if (code === 0x0a) {
      output += "\n";
      index += 1;
      continue;
    }
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      index += 1;
      continue;
    }

    output += input[index];
    index += 1;
  }

  return output;
}

interface EscapeScan {
  end: number;
  sgr?: string;
}

function scanEscape(value: string, index: number): EscapeScan {
  if (index >= value.length) {
    return { end: index };
  }
  const introducer = value.charCodeAt(index);
  if (introducer === 0x5b) {
    return scanCsi(value, index + 1);
  }
  if (introducer === 0x5d) {
    return { end: skipString(value, index + 1, true) };
  }
  if ([0x50, 0x58, 0x5e, 0x5f].includes(introducer)) {
    return { end: skipString(value, index + 1, false) };
  }

  let cursor = index;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    cursor += 1;
    if (code >= 0x30 && code <= 0x7e) {
      return { end: cursor };
    }
    if (code < 0x20 || code > 0x2f) {
      return { end: cursor };
    }
  }
  return { end: cursor };
}

function scanCsi(value: string, index: number): EscapeScan {
  let cursor = index;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    cursor += 1;
    if (code < 0x40 || code > 0x7e) {
      continue;
    }
    const parameters = value.slice(index, cursor - 1);
    if (code === 0x6d && isSafeSgr(parameters)) {
      return { end: cursor, sgr: `\u001b[${parameters}m` };
    }
    return { end: cursor };
  }
  return { end: cursor };
}

function isSafeSgr(parameters: string): boolean {
  if (parameters === "") {
    return true;
  }
  if (!/^\d+(?:;\d+)*$/.test(parameters)) {
    return false;
  }
  const values = parameters.split(";").map(Number);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? -1;
    if (value === 38) {
      const mode = values[index + 1];
      if (mode === 5 && isByte(values[index + 2])) {
        index += 2;
        continue;
      }
      if (
        mode === 2 &&
        isByte(values[index + 2]) &&
        isByte(values[index + 3]) &&
        isByte(values[index + 4])
      ) {
        index += 4;
        continue;
      }
      return false;
    }
    if (
      [0, 1, 2, 3, 4, 7, 9, 22, 23, 24, 27, 29, 39].includes(value) ||
      (value >= 30 && value <= 37) ||
      (value >= 90 && value <= 97)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

function isByte(value: number | undefined): boolean {
  return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 255;
}

function skipString(
  value: string,
  index: number,
  bellTerminates: boolean,
): number {
  let cursor = index;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    if ((bellTerminates && code === BEL) || code === ST) {
      return cursor + 1;
    }
    if (
      code === ESC &&
      cursor + 1 < value.length &&
      value.charCodeAt(cursor + 1) === 0x5c
    ) {
      return cursor + 2;
    }
    cursor += 1;
  }
  return cursor;
}
