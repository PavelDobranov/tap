import assert from "node:assert/strict";
import { test } from "node:test";
import { readManifest, runTap } from "./helpers/run-tap.ts";

const pkg = readManifest();

const commands = ["launch"];

test("with no arguments prints usage and exits 0", async () => {
  const result = await runTap([]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: tap/);
  for (const command of commands) {
    assert.match(result.stdout, new RegExp(`^\\s+${command}\\b`, "m"));
  }
});

test("--help prints the same usage on stdout and exits 0", async () => {
  const bare = await runTap([]);
  const help = await runTap(["--help"]);

  assert.equal(help.code, 0);
  assert.equal(help.stdout, bare.stdout);
});

test("--version prints the package version", async () => {
  const result = await runTap(["--version"]);

  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), pkg.version);
});

test("an unrecognised command exits nonzero naming the valid commands", async () => {
  const result = await runTap(["wat"]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unknown command: wat/i);
  for (const command of commands) {
    assert.match(result.stderr, new RegExp(`\\b${command}\\b`));
  }
  assert.equal(result.stdout, "");
});

test("an unrecognised flag exits nonzero with a clear message", async () => {
  const result = await runTap(["--nope"]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unknown option: --nope/i);
});

test("--record-cap takes a size, in either spelling", async () => {
  const spellings = [
    ["launch", "--record-cap", "notasize", "claude"],
    ["launch", "--record-cap=0"],
  ];
  for (const argv of spellings) {
    const result = await runTap(argv);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--record-cap needs a size/);
  }
});
