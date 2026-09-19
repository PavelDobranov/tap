/** A `tap` subcommand, as it appears in usage and in dispatch. */
export interface Command {
  readonly name: string;
  /** The command line as a user would type it, shown in usage. */
  readonly usage: string;
  readonly summary: string;
}

export const COMMANDS: readonly Command[] = [
  {
    name: "launch",
    usage: "launch [claude] [...agent args]",
    summary: "Run an agent with its provider traffic recorded",
  },
  {
    name: "list",
    usage: "list [--stats]",
    summary: "List this project's recorded sessions",
  },
  {
    name: "show",
    usage: "show [session] [n] [--diff] [--json] [--system] [--tools] [--full] [--all-types]",
    summary: "Render a session's requests, or one request in full",
  },
  {
    name: "export",
    usage: "export [session] [--format md|json]",
    summary: "Write a session's rendering to a file",
  },
  {
    name: "rm",
    usage: "rm <session> | --project",
    summary: "Delete a session's captures, or the whole project's",
  },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((command) => command.name === name);
}

export function commandNames(): string[] {
  return COMMANDS.map((command) => command.name);
}
