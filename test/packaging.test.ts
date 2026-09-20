import assert from "node:assert/strict";
import { accessSync, constants, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readManifest, repoRoot, run } from "./helpers/run-tap.ts";

const pkg = readManifest();
const root = fileURLToPath(repoRoot);

// Tap runs its TypeScript sources directly, which needs type stripping without
// a runtime flag: Node 24 onwards.
const MINIMUM_NODE_MAJOR = 24;

test("a minimum supported Node version is declared", () => {
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
  const resolved = fileURLToPath(new URL(binPath, repoRoot));
  accessSync(resolved, constants.X_OK);
  assert.match(readFileSync(resolved, "utf8"), /^#!\/usr\/bin\/env node\n/);
});

test("no native or binary dependency appears in the dependency tree", async () => {
  const result = await run(process.execPath, [path.join(root, "scripts/check-no-native.mjs")]);

  assert.equal(result.code, 0, `check-no-native.mjs failed:\n${result.stderr}`);
});

test("the package installs globally with no compilation step and runs", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "tap-install-"));
  try {
    const packed = await run("npm", ["pack", "--pack-destination", scratch]);
    assert.equal(packed.code, 0, `npm pack failed:\n${packed.stderr}`);
    const tarball = readdirSync(scratch).find((name) => name.endsWith(".tgz"));
    assert.ok(tarball, "npm pack produced no tarball");

    const prefix = path.join(scratch, "prefix");
    const installed = await run("npm", [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--ignore-scripts",
      path.join(scratch, tarball),
    ]);
    assert.equal(installed.code, 0, `global install failed:\n${installed.stderr}`);

    // --ignore-scripts means nothing could have been built or compiled at
    // install time: whatever runs now came out of the tarball as published.
    const version = await run(path.join(prefix, "bin", "tap"), ["--version"]);
    assert.equal(version.code, 0, version.stderr);
    assert.equal(version.stdout.trim(), pkg.version);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the run helper reports a signal death as a signal, not as a code", async () => {
  const killed = await run(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);

  assert.deepEqual(
    { code: killed.code, signal: killed.signal },
    { code: null, signal: "SIGKILL" },
  );
});
