/** An option Tap was given that it cannot act on. */
export class OptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptionError";
  }
}

/** What `tap launch` was asked for, before the agent's own arguments begin. */
export interface LaunchOptions {
  /** The UI port, if one was named. */
  readonly port?: number;
  /** Everything left: the agent name, if given, and its arguments. */
  readonly rest: readonly string[];
}

const PORT = "--port";

/**
 * Reads Tap's own options off the front of `launch`'s arguments.
 *
 * Only the front. Everything from the agent name onwards belongs to the agent
 * and is forwarded verbatim, so `tap launch claude --port 3` asks Claude Code
 * for a port and `tap launch --port 3 claude` asks Tap for one. Tap cannot
 * claim an option anywhere on the line without also claiming it from every
 * agent that has one of its own.
 */
export function readLaunchOptions(argv: readonly string[]): LaunchOptions {
  let index = 0;
  let port: number | undefined;

  while (index < argv.length) {
    const argument = argv[index]!;
    if (argument === PORT) {
      port = readPort(argv[index + 1]);
      index += 2;
    } else if (argument.startsWith(`${PORT}=`)) {
      port = readPort(argument.slice(PORT.length + 1));
      index += 1;
    } else {
      break;
    }
  }

  const rest = argv.slice(index);
  return port === undefined ? { rest } : { port, rest };
}

/** The whole range a loopback server can be asked for, ephemeral excluded. */
function readPort(value: string | undefined): number {
  const port = Number(value);
  if (
    value === undefined ||
    value.trim() === "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new OptionError(`${PORT} needs a port between 1 and 65535, not: ${value ?? ""}`);
  }
  return port;
}
