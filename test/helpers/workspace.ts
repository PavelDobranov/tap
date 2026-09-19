import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { runTap } from "./run-tap.ts";

export interface Workspace {
  /** An isolated HOME, so tests never read or write the developer's own store. */
  readonly home: string;
  /** A scratch directory to build project trees in. */
  readonly root: string;
  /** The environment that points `tap` at this workspace's home. */
  readonly env: NodeJS.ProcessEnv;
  /** Creates a directory under the workspace root and returns its path. */
  mkdir(relative: string): string;
  /** Creates a directory and makes it a git repository. */
  gitInit(relative: string): string;
}

/**
 * A throwaway HOME plus scratch space, removed when the test ends. Overriding
 * HOME is the production mechanism for locating the store, so this needs no
 * test-only hook.
 */
export function makeWorkspace(t: TestContext): Workspace {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "tap-ws-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const home = path.join(base, "home");
  const root = path.join(base, "root");
  mkdirSync(home);
  mkdirSync(root);

  const mkdir = (relative: string): string => {
    const full = path.join(root, relative);
    mkdirSync(full, { recursive: true });
    return full;
  };

  return {
    home,
    root,
    env: { HOME: home },
    mkdir,
    gitInit(relative: string): string {
      const full = mkdir(relative);
      execFileSync("git", ["init", "--quiet"], { cwd: full, stdio: "ignore" });
      return full;
    },
  };
}

/**
 * The store directories that exist in a workspace's home, one per project Tap
 * has seen. Counting them is how a test observes whether two working
 * directories resolved to the same project.
 */
export function projectStores(workspace: Workspace): string[] {
  const dir = path.join(workspace.home, ".tap", "projects");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

const DATABASE_MODULE = new URL("../../src/store/database.ts", import.meta.url).href;

/**
 * Runs a statement against a project's store in a child process, with this
 * workspace's HOME — the same override `tap` itself runs under, so no test has
 * to mutate the test runner's own environment.
 *
 * Most tests assert through the `tap` process boundary. This exists for the
 * handful that cannot: the connection pragmas, and seeding a session before
 * the milestone that records one. The snippet has an open `db` in scope and
 * whatever it logs is returned.
 */
export function inStore(workspace: Workspace, root: string, snippet: string): string {
  const program = [
    `import { openProjectStore } from ${JSON.stringify(DATABASE_MODULE)};`,
    `const db = openProjectStore(${JSON.stringify(root)});`,
    snippet,
    `db.close();`,
  ].join("\n");

  return execFileSync(process.execPath, ["--input-type=module", "-e", program], {
    env: { ...process.env, ...workspace.env },
    encoding: "utf8",
  });
}

/** Runs `tap list` in a directory of the workspace, asserting it succeeded. */
export async function tapList(workspace: Workspace, cwd: string): Promise<string> {
  const result = await runTap(["list"], { cwd, env: workspace.env });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}
