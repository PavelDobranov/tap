import { readFileSync } from "node:fs";
import { launch } from "./launch.ts";
import { EXIT_OK, EXIT_USAGE, type Io } from "./io.ts";
import { PORT, RECORD_CAP } from "./options.ts";

/**
 * Tap is one command. The record lives in memory for the life of a session and
 * is read in the browser, so there is nothing to list, show, export or delete,
 * and dispatch is a name and an `if` rather than a table with one row.
 */
const LAUNCH = "launch";

/**
 * The options `tap launch` takes before the agent name. The synopsis and the
 * list that explains it are both written from here, so an option cannot appear
 * in one and be missing from the other — which is how `--record-cap` came to
 * be in the synopsis and nowhere else. The names are the parser's own, so the
 * screen cannot name an option the reader does not answer to either.
 */
const LAUNCH_OPTIONS: readonly { readonly spelling: string; readonly summary: string }[] = [
  { spelling: `${PORT} <n>`, summary: "Serve the UI on this port instead of the default" },
  { spelling: `${RECORD_CAP} <size>`, summary: "Hold the record under this ceiling, e.g. 512MB" },
];

/** Both spellings of the request for usage, wherever Tap reads one. */
const HELP: readonly string[] = ["--help", "-h"];

export function usage(): string {
  const width = Math.max(...LAUNCH_OPTIONS.map(({ spelling }) => spelling.length));
  const optional = LAUNCH_OPTIONS.map(({ spelling }) => `[${spelling}]`).join(" ");
  return [
    "Usage: tap <command> [options]",
    "",
    "Commands:",
    `  ${LAUNCH} ${optional} [claude] [...agent args]`,
    "      Run an agent and inspect its upstream traffic live",
    "",
    "Launch options, which must come before the agent name:",
    ...LAUNCH_OPTIONS.map(({ spelling, summary }) => `  ${spelling.padEnd(width)}  ${summary}`),
    "",
    "Options:",
    "  --version  Print the version",
    "  --help     Print this usage",
    "",
  ].join("\n");
}

/**
 * The version of the installed package. Read from package.json at runtime so
 * there is one source of truth and no generated constant to fall out of date.
 *
 * The path is this module's own: `src/cli/` in a source run, `dist/cli/` in
 * the built tree, and the package root two directories up from either.
 */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error("package.json has no version");
  return manifest.version;
}

/**
 * Parses argv and dispatches. Returns the process exit code rather than
 * exiting, so the entry point owns process control and tests do not have to.
 */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const first = argv[0];

  if (first === undefined || HELP.includes(first)) {
    io.stdout.write(usage());
    return EXIT_OK;
  }

  if (first === "--version" || first === "-v") {
    io.stdout.write(`${readVersion()}\n`);
    return EXIT_OK;
  }

  if (first.startsWith("-")) {
    io.stderr.write(`tap: unknown option: ${first}\n\n${usage()}`);
    return EXIT_USAGE;
  }

  if (first !== LAUNCH) {
    io.stderr.write(
      `tap: unknown command: ${first}\n` +
        `Valid commands are: ${LAUNCH}\n` +
        `Run 'tap --help' for usage.\n`,
    );
    return EXIT_USAGE;
  }

  const rest = argv.slice(1);
  // `tap launch --help` is Tap's help; `tap launch claude --help` is the
  // agent's, like everything from the agent name onwards. Tap claims it as the
  // first word after `launch` and nowhere else, so an agent with a `--help` of
  // its own keeps it everywhere Tap is not being asked.
  if (rest[0] !== undefined && HELP.includes(rest[0])) {
    io.stdout.write(usage());
    return EXIT_OK;
  }

  return launch(rest, io);
}
