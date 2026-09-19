import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Where a project's captures live. Storage is deliberately outside the
 * repository: captured payloads contain the repository's own source and
 * whatever secrets were in the agent's context, and an in-tree store would be
 * one `git add -A` away from being published.
 */
const STORE_DIR = ".tap";

/** Long enough that collisions between a user's projects are not a concern. */
const PROJECT_KEY_LENGTH = 16;

/** The directory name a project's store is filed under. */
export function projectKey(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, PROJECT_KEY_LENGTH);
}

export function storeRoot(): string {
  return path.join(homedir(), STORE_DIR);
}

export function projectDir(root: string): string {
  return path.join(storeRoot(), "projects", projectKey(root));
}

export function databasePath(root: string): string {
  return path.join(projectDir(root), "tap.db");
}
