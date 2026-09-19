import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFakeAgent, PROBE_AGENT, type ProbeStep, type ProbeTranscript } from "./fake-agent.ts";
import { startFakeUpstream, type FakeUpstream, type UpstreamPlan } from "./fake-upstream.ts";
import { startLaunch, type TapSession } from "./run-tap.ts";
import { printedUrl, snapshotAt, type Snapshot } from "./snapshot.ts";

/**
 * One Tap session driven by the probe agent, read from both sides Tap has:
 * what the agent received, and what the UI serves. Every suite that needs a
 * running session goes through here, so there is one description of how a
 * session is started and one place that knows how to end one.
 */
export interface Probed {
  readonly session: TapSession;
  /** The UI URL Tap printed, token and all. Available before the agent runs. */
  readonly url: string;
  /** What the agent received. Only once the probe has written it down. */
  transcript(): ProbeTranscript;
  /** The proxy's port, taken from the base URL the agent was handed. */
  proxyPort(): number;
  snapshot(): Promise<Snapshot>;
}

/** When `probe` hands the session back. */
export type Await =
  /** Once the session has frozen: the agent has been and gone. */
  | "frozen"
  /** Once the probe has written its transcript, with the agent still up. */
  | "transcript"
  /** As soon as the UI URL is printed, with the requests still to come. */
  | "url";

/** How a session is driven, where the default is not what a test is about. */
export interface ProbeOptions {
  /**
   * Fires every step at once instead of one after another, so the requests
   * overlap on the wire. Their order at the proxy is then the network's to
   * decide, which is the point.
   */
  readonly concurrently?: boolean;
}

export interface Prober {
  probe(
    script: readonly ProbeStep[],
    upstreamBaseUrl: string,
    until?: Await,
    options?: ProbeOptions,
  ): Promise<Probed>;
  /** A fake upstream, torn down with the prober. */
  upstream(plan: UpstreamPlan): Promise<FakeUpstream>;
  dispose(): Promise<void>;
}

/**
 * Sets up everything one test file needs to run sessions: a fake `claude` on
 * `PATH`, somewhere for probes to write, and the upstreams they talk to.
 * Register `dispose` in an `after` hook.
 */
export function createProber(name: string): Prober {
  const agent = createFakeAgent(PROBE_AGENT);
  const scratch = mkdtempSync(path.join(tmpdir(), `tap-${name}-`));
  const upstreams: FakeUpstream[] = [];
  let files = 0;

  return {
    async upstream(plan) {
      const server = await startFakeUpstream(plan);
      upstreams.push(server);
      return server;
    },

    async probe(script, upstreamBaseUrl, until = "frozen", options = {}) {
      const file = path.join(scratch, `probe-${files++}.json`);
      const session = await startLaunch(["claude"], {
        env: {
          PATH: agent.pathEnv,
          ANTHROPIC_BASE_URL: upstreamBaseUrl,
          FAKE_AGENT_PROBE_FILE: file,
          FAKE_AGENT_PROBE_SCRIPT: JSON.stringify(script),
          ...(until === "transcript" ? { FAKE_AGENT_PROBE_STAY: "1" } : {}),
          ...(options.concurrently === true ? { FAKE_AGENT_PROBE_CONCURRENTLY: "1" } : {}),
        },
      });

      // The URL is printed before the agent takes over, so it is there for
      // every one of these, in-flight assertions included.
      await session.waitForError(/http:\/\//);
      const url = printedUrl(session.stderr())!;

      if (until === "transcript") await waitForFile(file);
      else if (until === "frozen") await session.waitForError(/frozen/);

      const transcript = (): ProbeTranscript =>
        JSON.parse(readFileSync(file, "utf8")) as ProbeTranscript;

      return {
        session,
        url,
        transcript,
        proxyPort: () => Number(new URL(transcript().baseUrl).port),
        snapshot: () => snapshotAt(url),
      };
    },

    async dispose() {
      await Promise.all(upstreams.map((server) => server.close()));
      agent.remove();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

/** Ends a session the way a user does, and waits for Tap to go. */
export async function quit(session: TapSession): Promise<void> {
  await session.waitForError(/frozen/);
  session.interrupt();
  await session.exited;
}

/** The simplest upstream plan: one non-streaming body. */
export function responds(body: string): UpstreamPlan {
  return { body };
}

async function waitForFile(file: string): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 20) {
    if (existsSync(file)) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${file}`);
}
