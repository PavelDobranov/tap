import { readFileSync } from "node:fs";

/**
 * The version of the installed package. Read from package.json at runtime so
 * there is one source of truth and no generated constant to fall out of date.
 */
export function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string") {
    throw new Error("package.json has no version");
  }
  return manifest.version;
}
