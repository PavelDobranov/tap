import { request } from "node:http";
import { reconstruct } from "../../src/record/blobs.ts";

/**
 * The UI's HTTP endpoint as a client sees it. The snapshot is a documented
 * interface rather than a test hook, so the suite reads it the way a browser
 * would and declares the shape it expects here rather than importing Tap's own
 * types — a test that borrowed the implementation's shape could not disagree
 * with it.
 */
export interface SnapshotRequest {
  seq: number;
  type: "messages" | "count_tokens" | "other";
  /**
   * The conversation lineage the request continues, numbered from 1 in order
   * of first appearance, or null when it carried no messages. Thread 1 is the
   * main thread.
   */
  thread: number | null;
  /**
   * The turn of that thread the request is part of, numbered from 1 within
   * the thread, or null when it is not grouped into one: no thread, or not
   * conversation. Inferred from the shape of the messages, never stated.
   */
  turn: number | null;
  method: string;
  endpoint: string;
  model: string | null;
  status: number | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  /**
   * The request body as it was forwarded, held as text interleaved with
   * references into the snapshot's blob map, or null if none was kept.
   */
  skeleton: SnapshotSkeleton | null;
  /** The response as it streamed: one entry per event, in arrival order. */
  rawResponse: string[];
  /** Whether the response ended without the upstream closing it cleanly. */
  interrupted: boolean;
  /**
   * The tool-use blocks the response carried, in the order it opened them,
   * each saying whether it is a subagent invocation.
   */
  toolUses: { id: string; tool: string; subagentInvocation: boolean }[];
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  } | null;
}

/** A stored unit, as the snapshot presents it. */
export interface SnapshotBlob {
  json: string;
  size: number;
}

/** One unit of a skeleton: a blob, plus the annotations cut out of it. */
export interface SnapshotUnit {
  blob: string;
  annotations: { at: number; text: string }[];
}

export type SnapshotSkeleton = (string | SnapshotUnit)[];

export interface SnapshotStorage {
  /** Everything the record holds: payloads and response events both. */
  recordSize: number;
  /** The payload half of it, which is the half that is deduplicated. */
  payloadSize: number;
  responseSize: number;
  blobCount: number;
  referencedUnits: number;
  deduplicationRatio: number;
  /** The byte ceiling the record is held under. */
  cap: number;
  /** What reaching it has cost, exactly, however long the session ran. */
  evictedBlobs: number;
  evictedBytes: number;
}

/** One blob dropped to keep the record under its cap. */
export interface SnapshotEviction {
  at: string;
  blob: string;
  size: number;
  /** The last request that referenced it: the age that made it the one to go. */
  lastSeq: number;
  references: number;
}

export interface SnapshotDiagnostic {
  at: string;
  seq: number | null;
  detail: string;
}

/** One conversation lineage, as the snapshot presents it. */
export interface SnapshotThread {
  id: number;
  /** Whether this is the first thread of the session: the main thread. */
  main: boolean;
  firstSeq: number;
}

export interface Snapshot {
  revision: number;
  lifecycle:
    | { phase: "live" }
    | { phase: "frozen"; agent: { code: number | null; signal: NodeJS.Signals | null } };
  requests: SnapshotRequest[];
  threads: SnapshotThread[];
  blobs: { [hash: string]: SnapshotBlob };
  storage: SnapshotStorage;
  /** The most recent evictions. The exact totals are in `storage`. */
  evictions: SnapshotEviction[];
  diagnostics: SnapshotDiagnostic[];
}

/**
 * The payload a skeleton stands for, by Tap's own reconstruction rule.
 *
 * Imported rather than written out again. The shapes above are declared here
 * on purpose — a test that borrowed the implementation's shape could not
 * disagree with it — but reconstruction is not a shape, it is the rule the
 * page already receives verbatim, and a third spelling of it would only
 * assert that three copies agree.
 */
export function payloadOf(snapshot: Snapshot, request: SnapshotRequest): string | null {
  if (request.skeleton === null) return null;
  return reconstruct(request.skeleton, snapshot.blobs);
}

export interface HttpAnswer {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
}

/**
 * A raw request to the UI. `node:http` rather than `fetch`, because two of the
 * things under test — the `Host` header and a request with no token at all —
 * are precisely what `fetch` will not let a caller control.
 */
export function ask(
  port: number,
  target: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: target,
        headers: options.headers ?? {},
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    call.on("error", reject);
    call.end();
  });
}

/** The UI URL Tap printed, or undefined if it has not printed one yet. */
export function printedUrl(output: string): string | undefined {
  return /(http:\/\/\S+)/.exec(output)?.[1];
}

/** Reads the snapshot from a printed UI URL. */
export async function snapshotAt(url: string): Promise<Snapshot> {
  const parsed = new URL(url);
  const answer = await ask(Number(parsed.port), `/api/snapshot${parsed.search}`, {
    headers: { host: parsed.host },
  });
  if (answer.status !== 200) throw new Error(`snapshot refused with ${answer.status}`);
  return JSON.parse(answer.body) as Snapshot;
}
