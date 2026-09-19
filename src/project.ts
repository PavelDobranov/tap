import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * The root of the Tap project containing `cwd`, canonical and absolute: a
 * project is its git repository root so that running from a subdirectory reads
 * and writes the same project — which is what a developer means by "my
 * project" — and the working directory when there is no repository.
 * Canonicalising means two paths that reach the same directory through
 * different symlinks are one project.
 */
export function resolveProject(cwd: string): string {
  const from = realpathSync(cwd);
  return enclosingRepositoryRoot(from) ?? from;
}

/**
 * Walks up looking for `.git`, which is a directory in an ordinary clone and a
 * file in a worktree or submodule — either marks the repository root.
 */
function enclosingRepositoryRoot(from: string): string | undefined {
  let current = from;
  for (;;) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
