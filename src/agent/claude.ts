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

/**
 * The prefix of every Claude Code variable that selects a cloud provider —
 * `CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`, `_ANTHROPIC_AWS`.
 *
 * Matched by prefix rather than by name so that a variable Tap has never heard
 * of refuses too. Getting that wrong in the other direction is the expensive
 * mistake: `ANTHROPIC_BASE_URL` has no effect on any of these configurations,
 * so a session Tap agreed to launch would show nothing at all, and an
 * inspector that quietly shows nothing is worse than one that refuses.
 */
const UNSUPPORTED_PREFIX = "CLAUDE_CODE_USE_";

/**
 * The variable making this environment an unsupported configuration, if one
 * does. Read before anything is bound or spawned: refusing is only better than
 * showing nothing if it costs the developer nothing.
 *
 * A variable present but empty selects nothing, which is the reading Claude
 * Code gives it; every other value, `0` included, selects. Variables are
 * considered in name order, so an environment with several of them always
 * names the same one.
 */
export function findUnsupportedConfiguration(env: NodeJS.ProcessEnv): string | undefined {
  return Object.keys(env)
    .sort()
    .find((variable) => variable.startsWith(UNSUPPORTED_PREFIX) && env[variable] !== "");
}
