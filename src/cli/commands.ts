import { launch } from "./launch.ts";
import type { Io } from "./io.ts";

/** Runs a command with its own argv (everything after the command name). */
export type Handler = (argv: readonly string[], io: Io) => number | Promise<number>;

/** A `tap` subcommand, as it appears in usage and in dispatch. */
export interface Command {
  readonly name: string;
  /** The command line as a user would type it, shown in the usage screen. */
  readonly synopsis: string;
  readonly summary: string;
  /** Absent until the milestone that implements the command. */
  readonly run?: Handler;
}

/**
 * Tap is one command. The record lives in memory for the life of a session and
 * is read in the browser, so there is nothing to list, show, export or delete.
 */
export const COMMANDS: readonly Command[] = [
  {
    name: "launch",
    synopsis: "launch [claude] [...agent args]",
    summary: "Run an agent and inspect its provider traffic live",
    run: launch,
  },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((command) => command.name === name);
}

export function commandNames(): string[] {
  return COMMANDS.map((command) => command.name);
}
