import { CLAUDE, readInvocation, UnknownAgentError } from "../agent/claude.ts";
import { AgentNotFoundError, describeOutcome, runAgent } from "../agent/run.ts";
import { exitOnInterrupt, ignoreSigint, restoreSigint } from "../signals.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type Io } from "./io.ts";

/**
 * Launches an agent and owns the Tap session around it: live while the agent
 * runs, then frozen — nothing more is captured, and Tap stays up so the record
 * remains readable until it is interrupted.
 *
 * SIGINT is held from before the agent is spawned until the frozen session
 * takes it over, so there is no instant at which a Ctrl+C meant for the agent
 * can end Tap first.
 */
export async function launch(argv: readonly string[], io: Io): Promise<number> {
  let invocation;
  try {
    invocation = readInvocation(argv);
  } catch (error) {
    if (!(error instanceof UnknownAgentError)) throw error;
    io.stderr.write(
      `tap: ${error.message}\n` + `The only agent tap can launch is ${CLAUDE}.\n`,
    );
    return EXIT_USAGE;
  }

  let outcome;
  ignoreSigint();
  try {
    outcome = await runAgent(invocation);
  } catch (error) {
    restoreSigint();
    if (!(error instanceof AgentNotFoundError)) throw error;
    io.stderr.write(
      `tap: ${error.message}\n` + `Is ${error.command} installed and on your PATH?\n`,
    );
    return EXIT_FAILURE;
  }

  io.stderr.write(
    `tap: ${describeOutcome(invocation.command, outcome)}\n` +
      `tap: session frozen; press Ctrl+C to exit tap\n`,
  );

  await exitOnInterrupt();
  return EXIT_OK;
}
