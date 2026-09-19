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
  /** The byte ceiling for the record, if one was named. */
  readonly recordCap?: number;
  /** Everything left: the agent name, if given, and its arguments. */
  readonly rest: readonly string[];
}

const PORT = "--port";
const RECORD_CAP = "--record-cap";

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
  let recordCap: number | undefined;

  while (index < argv.length) {
    const named = read(argv, index, PORT, readPort);
    if (named !== null) {
      port = named.value;
      index = named.next;
      continue;
    }
    const capped = read(argv, index, RECORD_CAP, readSize);
    if (capped === null) break;
    recordCap = capped.value;
    index = capped.next;
  }

  return {
    ...(port === undefined ? {} : { port }),
    ...(recordCap === undefined ? {} : { recordCap }),
    rest: argv.slice(index),
  };
}

/** An option's value, and where the arguments it took leave off. */
interface Read {
  readonly value: number;
  /** The index of the next argument, past however many this one spelled. */
  readonly next: number;
}

/**
 * Reads one option in both the spellings a user may type, `--name value` and
 * `--name=value`, or null when this argument is not that option. Finding it
 * is the same work for every option, so only the parse of the value differs.
 */
function read(
  argv: readonly string[],
  index: number,
  name: string,
  parse: (value: string | undefined, name: string) => number,
): Read | null {
  const argument = argv[index]!;
  if (argument === name) return { value: parse(argv[index + 1], name), next: index + 2 };
  if (argument.startsWith(`${name}=`)) {
    return { value: parse(argument.slice(name.length + 1), name), next: index + 1 };
  }
  return null;
}

/** The whole range a loopback server can be asked for, ephemeral excluded. */
function readPort(value: string | undefined, name: string): number {
  const port = Number(value);
  if (
    value === undefined ||
    value.trim() === "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new OptionError(`${name} needs a port between 1 and 65535, not: ${value ?? ""}`);
  }
  return port;
}

/** The multipliers a size may be spelled with. Binary, because this is memory. */
const UNITS: readonly { readonly suffix: string; readonly bytes: number }[] = [
  { suffix: "KB", bytes: 1024 },
  { suffix: "MB", bytes: 1024 * 1024 },
  { suffix: "GB", bytes: 1024 * 1024 * 1024 },
];

/**
 * A number of bytes, spelled plainly or with a unit: `64000`, `64KB`, `512MB`.
 *
 * Units because the figure this reads is a memory budget, and a developer
 * asked for one in bytes will mistype a zero sooner or later — into a cap
 * that evicts everything it captures, or one that is no cap at all.
 */
function readSize(value: string | undefined, name: string): number {
  const text = (value ?? "").trim();
  const unit = UNITS.find(({ suffix }) => text.toUpperCase().endsWith(suffix));
  const digits = unit === undefined ? text : text.slice(0, -unit.suffix.length).trim();
  const size = Number(digits) * (unit?.bytes ?? 1);
  if (digits === "" || !/^\d+$/.test(digits) || !Number.isSafeInteger(size) || size < 1) {
    throw new OptionError(`${name} needs a size like 512MB or 64000, not: ${value ?? ""}`);
  }
  return size;
}
