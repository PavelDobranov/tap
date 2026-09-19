import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  bin: Record<string, string>;
  dependencies?: Record<string, string>;
  engines?: { node?: string };
  scripts?: Record<string, string>;
};

// node:sqlite is available without a runtime flag from Node 24 onwards, and
// Tap's persistence depends on it.
const MINIMUM_NODE_MAJOR = 24;

test("a minimum Node version supporting the built-in SQLite module is declared", () => {
  const range = pkg.engines?.node;
  assert.ok(range, "package.json must declare engines.node");
  const match = /^>=\s*(\d+)/.exec(range);
  assert.ok(match, `engines.node must be a '>=' range, got ${range}`);
  assert.ok(
    Number(match[1]) >= MINIMUM_NODE_MAJOR,
    `engines.node must require at least Node ${MINIMUM_NODE_MAJOR}, got ${range}`,
  );
});

test("the package declares no install hooks of its own", () => {
  for (const hook of ["preinstall", "install", "postinstall"]) {
    assert.equal(pkg.scripts?.[hook], undefined, `unexpected ${hook} script`);
  }
});

test("the bin entry points at a built, executable file", () => {
  const binPath = pkg.bin["tap"];
  assert.ok(binPath, "package.json must declare a 'tap' bin entry");
  const resolved = fileURLToPath(new URL(binPath, root));
  accessSync(resolved, constants.X_OK);
  assert.match(readFileSync(resolved, "utf8"), /^#!\/usr\/bin\/env node\n/);
});

test("no native or binary dependency appears in the dependency tree", async () => {
  const code = await new Promise<number>((resolve) => {
    execFile(
      process.execPath,
      [fileURLToPath(new URL("scripts/check-no-native.mjs", root))],
      { cwd: fileURLToPath(root) },
      (error) => resolve(error && typeof error.code === "number" ? error.code : 0),
    );
  });

  assert.equal(code, 0, "scripts/check-no-native.mjs reported native code");
});
