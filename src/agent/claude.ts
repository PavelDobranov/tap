/**
 * Claude Code, the only agent Tap launches. Everything Tap knows that is
 * specific to it lives here rather than behind an adapter interface: with one
 * agent, an interface would describe a variation that does not exist.
 */
export const CLAUDE = "claude";

/** The command line Tap hands to the agent, resolved by name through `PATH`. */
export interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
}

/** An agent name Tap has no knowledge of. */
export class UnknownAgentError extends Error {
  readonly agent: string;

  constructor(name: string) {
    super(`unknown agent: ${name}`);
    this.name = "UnknownAgentError";
    this.agent = name;
  }
}

/**
 * Reads `launch`'s arguments as an agent to run and arguments for it.
 *
 * The agent name is optional and defaults to Claude Code, so `tap launch` and
 * `tap launch claude` are the same thing. Everything after it is the agent's,
 * passed through untouched — Tap has no options of its own here, which is what
 * makes `tap launch claude --model opus --resume` work without Tap knowing
 * what any of those mean.
 */
export function readInvocation(argv: readonly string[]): Invocation {
  const named = argv[0] !== undefined && !argv[0].startsWith("-");
  if (!named) return { command: CLAUDE, args: argv };

  const [name, ...args] = argv;
  if (name !== CLAUDE) throw new UnknownAgentError(name!);
  return { command: CLAUDE, args };
}
