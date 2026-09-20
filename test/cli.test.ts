import assert from "node:assert/strict";
import { test } from "node:test";
import { readManifest, runTap, runTapFromSource } from "./helpers/run-tap.ts";

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

test("the usage screen lists every launch option", async () => {
  const result = await runTap(["--help"]);

  for (const option of ["--port", "--record-cap"]) {
    assert.match(result.stdout, new RegExp(`^\\s+${option}\\b`, "m"), `${option} is undocumented`);
  }
});

test("no option is named in the synopsis without appearing in the option list", async () => {
  const usage = (await runTap(["--help"])).stdout;
  const synopsis = usage.split("\n").find((line) => /^\s+launch\b/.test(line));
  assert.ok(synopsis, "the usage screen must show a launch synopsis");

  // The two halves of the screen that used to be owned by different modules:
  // whatever the synopsis spells, the option list below it must explain.
  for (const option of synopsis.match(/--[a-z-]+/g) ?? []) {
    assert.match(usage, new RegExp(`^\\s+${option}\\b`, "m"), `${option} is not in the option list`);
  }
});

test("launch --help prints the same usage on stdout and exits 0", async () => {
  const bare = await runTap([]);
  const help = await runTap(["launch", "--help"]);

  assert.equal(help.code, 0);
  assert.equal(help.stdout, bare.stdout);
  assert.equal(help.stderr, "");
});

test("--version reads the same version from a source run as from the built executable", async () => {
  const built = await runTap(["--version"]);
  const sourced = await runTapFromSource(["--version"]);

  assert.equal(sourced.code, 0, sourced.stderr);
  assert.equal(sourced.stdout.trim(), pkg.version);
  assert.equal(sourced.stdout, built.stdout);
});
