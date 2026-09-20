import type { Io } from "./io.ts";

/** A readable that may be a terminal, which is all the wait needs of stdin. */
export interface Input extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
}

const NEWLINE = 0x0a;

/**
 * Holds the launch until the developer has had the address, and says so on
 * `io.stderr`.
 *
 * The agent is a full-screen program: it repaints the terminal as it starts,
 * and the line Tap has just written goes with everything else that was on
 * screen. That line cannot be reconstructed afterwards — the address carries a
 * token minted for this session — so an address that scrolls past unread is a
 * session that cannot be opened at all, for the whole time it is live. This
 * pause is the one moment at which Tap knows the address has been seen.
 *
 * Nothing is held unless both stdin and stderr are terminals: otherwise there
 * is no one to press Enter and no full-screen agent about to take the screen,
 * and a scripted or piped `tap launch` must run to completion on its own. That
 * also keeps Tap to its single line whenever anything is reading its output.
 *
 * stdin is read only as far as the newline that ends the wait and is left
 * paused. The agent inherits the file descriptor itself, so what a hurried
 * developer typed ahead is Tap's to drop rather than the agent's to receive
 * out of the context it was typed in.
 */
export function waitForEnter(
  prompt: string,
  io: Io,
  stdin: Input = process.stdin,
): Promise<void> {
  if (!isTerminal(stdin) || !isTerminal(io.stderr)) return Promise.resolve();

  io.stderr.write(prompt);
  return new Promise<void>((resolve) => {
    const done = (): void => {
      stdin.off("data", onData);
      stdin.off("end", done);
      stdin.pause();
      resolve();
    };
    const onData = (chunk: Buffer | string): void => {
      const typed = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (typed.includes(NEWLINE)) done();
    };
    stdin.on("data", onData);
    stdin.on("end", done);
    stdin.resume();
  });
}

/** Whether a stream is attached to a terminal, for streams typed without it. */
function isTerminal(stream: NodeJS.ReadableStream | NodeJS.WritableStream): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true;
}
