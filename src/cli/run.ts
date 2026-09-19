import { COMMANDS, commandNames, findCommand } from "./commands.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type Io } from "./io.ts";
import { readVersion } from "../version.ts";

export function usage(): string {
  const lines = [
    "Usage: tap <command> [options]",
    "",
    "Commands:",
  ];
  for (const command of COMMANDS) {
    lines.push(`  ${command.synopsis}`, `      ${command.summary}`);
  }
  lines.push(
    "",
    "Options:",
    "  --version  Print the version",
    "  --help     Print this usage",
    "",
  );
  return lines.join("\n");
}

/**
 * Parses argv and dispatches. Returns the process exit code rather than
 * exiting, so the entry point owns process control and tests do not have to.
 */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const first = argv[0];

  if (first === undefined || first === "--help" || first === "-h") {
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

  const command = findCommand(first);
  if (command === undefined) {
    io.stderr.write(
      `tap: unknown command: ${first}\n` +
        `Valid commands are: ${commandNames().join(", ")}\n` +
        `Run 'tap --help' for usage.\n`,
    );
    return EXIT_USAGE;
  }

  if (command.run === undefined) {
    io.stderr.write(`tap: ${command.name} is not implemented yet.\n`);
    return EXIT_FAILURE;
  }

  return command.run(argv.slice(1), io);
}
