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

// Commands whose milestone has not arrived yet; each one moves out of this
// list as it is implemented. `launch` behaviour lives in launch.test.ts.
const unimplemented: string[] = [];

for (const command of unimplemented) {
  test(`${command} is recognised and reports that it is not implemented yet`, async () => {
    const result = await runTap([command]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not implemented yet/i);
    assert.doesNotMatch(result.stderr, /unknown command/i);
  });
}
