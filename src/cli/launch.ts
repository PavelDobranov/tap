import {
  CLAUDE,
  findUnsupportedConfiguration,
  readInvocation,
  UnknownAgentError,
} from "../agent/claude.ts";
import { AgentNotFoundError, describeOutcome, runAgent } from "../agent/run.ts";
import { startProxy } from "../proxy/proxy.ts";
import { resolveUpstream } from "../proxy/upstream.ts";
import { createCapture } from "../record/capture.ts";
import { createRecord } from "../record/record.ts";
import { DEFAULT_UI_PORT, PortInUseError, startUi } from "../ui/server.ts";
import { exitOnInterrupt, ignoreSigint, restoreSigint } from "../signals.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type Io } from "./io.ts";
import { OptionError, readLaunchOptions } from "./options.ts";

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
 * The UI server has the opposite lifetime. It is bound first, so that a port
 * clash ends the launch before an agent has been started and abandoned, and it
 * is never closed: serving the record is what the frozen phase is for.
 *
 * SIGINT is held from before the agent is spawned until the frozen session
 * takes it over, so there is no instant at which a Ctrl+C meant for the agent
 * can end Tap first.
 *
 * A configuration Tap cannot see through is refused before any of that: no
 * port is bound and no agent is spawned, so the developer is left exactly
 * where they were rather than in a session that would show nothing.
 */
export async function launch(argv: readonly string[], io: Io): Promise<number> {
  let options;
  let invocation;
  try {
    options = readLaunchOptions(argv);
    invocation = readInvocation(options.rest);
  } catch (error) {
    if (error instanceof OptionError) {
      io.stderr.write(`tap: ${error.message}\n`);
      return EXIT_USAGE;
    }
    if (!(error instanceof UnknownAgentError)) throw error;
    io.stderr.write(
      `tap: ${error.message}\n` + `The only agent tap can launch is ${CLAUDE}.\n`,
    );
    return EXIT_USAGE;
  }

  const unsupported = findUnsupportedConfiguration(process.env);
  if (unsupported !== undefined) {
    io.stderr.write(
      `tap: ${unsupported} is set, which points ${CLAUDE} at a cloud provider\n` +
        `tap v0 supports only direct Anthropic API traffic.\n` +
        `Unset it to run ${CLAUDE} through tap.\n`,
    );
    return EXIT_USAGE;
  }

  const upstream = resolveUpstream(process.env);
  const record = createRecord();

  let ui;
  try {
    ui = await startUi(record, options.port ?? DEFAULT_UI_PORT);
  } catch (error) {
    if (!(error instanceof PortInUseError)) throw error;
    io.stderr.write(
      `tap: ${error.message}\n` +
        `Another tap may already be running; use --port to pick another.\n`,
    );
    return EXIT_FAILURE;
  }

  // The proxy is bound before SIGINT is held: until there is an agent, a
  // Ctrl+C is meant for Tap, and a failed bind should end it like any other
  // startup failure.
  const proxy = await startProxy(upstream, createCapture(record));

  // The one line Tap writes before the agent has the terminal, and the last
  // until the agent gives it back.
  io.stderr.write(`tap: inspect this session at ${ui.url}\n`);

  let outcome;
  ignoreSigint();
  try {
    outcome = await runAgent(invocation, { ANTHROPIC_BASE_URL: proxy.baseUrl });
  } catch (error) {
    restoreSigint();
    // Both ports go with the session: there is no agent to record and no
    // record worth serving, and a Tap left holding them would never exit.
    await ui.close();
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
