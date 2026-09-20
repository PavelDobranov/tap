import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { waitForEnter } from "../src/cli/prompt.ts";
import type { Io } from "../src/cli/io.ts";

/** A stream a test can read what was written to, terminal or not. */
function sink(isTTY: boolean): NodeJS.WritableStream & { written(): string } {
  let written = "";
  const stream = new PassThrough();
  stream.on("data", (chunk: Buffer) => {
    written += chunk.toString("utf8");
  });
  return Object.assign(stream, { isTTY, written: () => written });
}

/** stdin as `waitForEnter` sees it: a readable that says whether it is a tty. */
function input(isTTY: boolean): PassThrough & { isTTY: boolean } {
  return Object.assign(new PassThrough(), { isTTY });
}

function io(stderr: NodeJS.WritableStream): Io {
  return { stdout: new PassThrough(), stderr };
}

/** Rejects if `promise` has not settled by the time the loop next turns over. */
async function settled(promise: Promise<void>): Promise<boolean> {
  const pending = Symbol("pending");
  const tick = new Promise<typeof pending>((resolve) => setImmediate(() => resolve(pending)));
  return (await Promise.race([promise.then(() => true), tick])) === true;
}

test("at a terminal the launch waits, and the prompt says what for", async () => {
  const stderr = sink(true);
  const stdin = input(true);

  const waiting = waitForEnter("tap: press Enter to start it. ", io(stderr), stdin);

  assert.equal(await settled(waiting), false, "must not fall through the wait");
  assert.match(stderr.written(), /press Enter/);

  stdin.write("\n");
  await waiting;
});

test("typing ahead of the newline does not end the wait", async () => {
  const stdin = input(true);
  const waiting = waitForEnter("prompt", io(sink(true)), stdin);

  stdin.write("not a newline");

  assert.equal(await settled(waiting), false);

  stdin.write("\r\n");
  await waiting;
});

test("end of input ends the wait, so a closed terminal cannot hang Tap", async () => {
  const stdin = input(true);
  const waiting = waitForEnter("prompt", io(sink(true)), stdin);

  stdin.end();

  await waiting;
});

for (const [name, stdinTty, stderrTty] of [
  ["stdin is not a terminal", false, true],
  ["stderr is not a terminal", true, false],
  ["neither is a terminal", false, false],
] as const) {
  test(`nothing is waited for or written when ${name}`, async () => {
    const stderr = sink(stderrTty);

    await waitForEnter("prompt", io(stderr), input(stdinTty));

    assert.equal(stderr.written(), "", "Tap must keep to its one line");
  });
}

test("input past the newline is left unread, not handed to the agent", async () => {
  const stdin = input(true);
  const waiting = waitForEnter("prompt", io(sink(true)), stdin);

  stdin.write("\nwhatever was typed ahead");
  await waiting;

  assert.equal(stdin.isPaused(), true, "stdin must be left for the agent's fd");
  assert.equal(stdin.listenerCount("data"), 0, "and left with no reader of Tap's");
});
