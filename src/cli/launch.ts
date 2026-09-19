import { CLAUDE, readInvocation, UnknownAgentError } from "../agent/claude.ts";
import { AgentNotFoundError, describeOutcome, runAgent } from "../agent/run.ts";
import { startProxy } from "../proxy/proxy.ts";
import { resolveUpstream } from "../proxy/upstream.ts";
import { exitOnInterrupt, ignoreSigint, restoreSigint } from "../signals.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type Io } from "./io.ts";

/**
 * Launches an agent and owns the Tap session around it: live while the agent
 * runs, then frozen — nothing more is captured, and Tap stays up so the record
 * remains readable until it is interrupted.
 *
 * The proxy is in the path for exactly the live phase. It is bound before the
 * agent starts, because the agent is handed its address, and closed the moment
 * the agent is gone: a frozen session has nothing left to forward, and leaving
 * a port open that relays a credential upstream would be the wrong thing to
 * leave lying around for the length of a reading session.
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

  const upstream = resolveUpstream(process.env);

  // The proxy is bound before SIGINT is held: until there is an agent, a
  // Ctrl+C is meant for Tap, and a failed bind should end it like any other
  // startup failure.
  const proxy = await startProxy(upstream);

  let outcome;
  ignoreSigint();
  try {
    outcome = await runAgent(invocation, { ANTHROPIC_BASE_URL: proxy.baseUrl });
  } catch (error) {
    restoreSigint();
    if (!(error instanceof AgentNotFoundError)) throw error;
    io.stderr.write(
      `tap: ${error.message}\n` + `Is ${error.command} installed and on your PATH?\n`,
    );
    return EXIT_FAILURE;
  } finally {
    await proxy.close();
  }

  io.stderr.write(
    `tap: ${describeOutcome(invocation.command, outcome)}\n` +
      `tap: session frozen; press Ctrl+C to exit tap\n`,
  );

  await exitOnInterrupt();
  return EXIT_OK;
}
