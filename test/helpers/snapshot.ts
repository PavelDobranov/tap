import { request } from "node:http";

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
  method: string;
  endpoint: string;
  model: string | null;
  status: number | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  } | null;
}

export interface SnapshotDiagnostic {
  at: string;
  seq: number | null;
  detail: string;
}

export interface Snapshot {
  requests: SnapshotRequest[];
  diagnostics: SnapshotDiagnostic[];
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
  const answer = await ask(Number(parsed.port), `${parsed.pathname}${parsed.search}`, {
    headers: { host: parsed.host },
  });
  if (answer.status !== 200) throw new Error(`snapshot refused with ${answer.status}`);
  return JSON.parse(answer.body) as Snapshot;
}
