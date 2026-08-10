import { readFileSync } from "node:fs";

interface PackageMetadata {
  version: string;
}

function isPackageMetadata(value: unknown): value is PackageMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const version = (value as Record<string, unknown>).version;
  return typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version);
}

export function readPackageVersion(): string {
  const packageUrl = new URL("../package.json", import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(packageUrl, "utf8"));
  if (!isPackageMetadata(parsed)) {
    throw new Error("package.json contains an invalid version");
  }
  return parsed.version;
}
