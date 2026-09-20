import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { Capture } from "../record/capture.ts";

/**
 * Headers that describe one hop of a connection rather than the message, and
 * so must not be carried onto the next hop. `host` is here because a reverse
 * proxy owns it: it names the upstream, not Tap.
 *
 * Everything else is forwarded untouched and unread — which is how the
 * credential crosses Tap without being inspected. There is no allowlist to
 * fall behind, and no branch anywhere in this file that looks at a header's
 * value.
 */
const PER_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "host",
]);

/** The address Tap binds. Never a wildcard: this port relays a credential. */
const LOOPBACK = "127.0.0.1";

export interface Proxy {
  /** What the agent's `ANTHROPIC_BASE_URL` is set to. */
  readonly baseUrl: string;
  /** Stops accepting requests and drops what is still connected. */
  close(): Promise<void>;
}

/**
 * Starts the reverse proxy the agent talks to, forwarding everything to
 * `upstream`.
 *
 * The proxy is a byte pipe: response chunks are written on as they arrive, so
 * a streamed response reaches the agent in the chunks and with the pauses the
 * upstream produced. Nothing is buffered, decoded or rewritten.
 *
 * `capture` watches what goes past and is never in the way of it. That is
 * capture's promise to keep and is written down there; all this file owes it
 * is the order — every call is made *after* the bytes have been handed on, so
 * no capture work is ever awaited before a response chunk is forwarded.
 */
export async function startProxy(upstream: URL, capture: Capture): Promise<Proxy> {
  const server = createServer((req, res) => forward(req, res, upstream, capture));

  // Nagle would gather chunks a streaming response deliberately spaced out,
  // making Tap look like a buffering proxy to the agent reading through it.
  server.on("connection", (socket) => socket.setNoDelay(true));
  // A request may take as long as the model does; Tap imposes no deadline of
  // its own, because a timeout here would be Tap altering the agent's traffic.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the proxy did not bind a port");
  }

  return {
    baseUrl: `http://${LOOPBACK}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: URL,
  capture: Capture,
): void {
  const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
  const prefix = upstream.pathname.replace(/\/$/, "");

  const captured = capture.begin(req.method ?? "", req.url ?? "");

  const outbound = send({
    protocol: upstream.protocol,
    host: upstream.hostname,
    port: upstream.port,
    method: req.method,
    path: `${prefix}${req.url ?? ""}`,
    headers: { ...carriedHeaders(req.rawHeaders), host: upstream.host },
  });

  outbound.on("socket", (socket: Socket) => socket.setNoDelay(true));

  outbound.on("response", (upstreamRes) => {
    res.writeHead(
      upstreamRes.statusCode ?? 502,
      upstreamRes.statusMessage,
      carriedRawHeaders(upstreamRes.rawHeaders),
    );
    // Sent before the first chunk, so the agent sees the response begin when
    // the upstream said it began rather than when its first byte arrives.
    res.flushHeaders();

    // Piping first is what keeps the byte pipe a byte pipe: `pipe` installs
    // its handler before this one, so every chunk is on its way to the agent
    // before capture is shown a copy of it, and the agent keeps the
    // backpressure it would have had without Tap.
    upstreamRes.pipe(res);
    upstreamRes.on("data", (chunk: Buffer) => captured.responseChunk(chunk));
    upstreamRes.on("end", () => captured.end("closed"));
    upstreamRes.on("error", () => {
      res.destroy();
      captured.end("cut");
    });

    captured.responseStart(upstreamRes.statusCode ?? 502, upstreamRes.headers);
  });

  outbound.on("error", () => {
    if (res.headersSent) {
      res.destroy();
    } else {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("tap: could not reach the upstream\n");
    }
    // No status is recorded: the upstream never gave one, and inventing Tap's
    // own 502 here would put a provider answer in the record that the provider
    // never sent.
    captured.end("cut");
  });

  // An agent that gives up mid-request must not leave Tap holding the upstream
  // one open.
  res.on("close", () => {
    if (!res.writableEnded) outbound.destroy();
    // A response the upstream already closed has ended by then; reaching here
    // first means the agent hung up on one that had not.
    captured.end("cut");
  });

  req.pipe(outbound);
  req.on("data", (chunk: Buffer) => captured.requestChunk(chunk));
  req.on("end", () => captured.requestEnd());
  req.on("error", () => outbound.destroy());
}

/** Inbound headers, minus the per-hop ones, keeping repeats as repeats. */
function carriedHeaders(raw: readonly string[]): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of carriedPairs(raw)) {
    const existing = headers[name];
    if (existing === undefined) headers[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[name] = [existing, value];
  }
  return headers;
}

/** Response headers, minus the per-hop ones, in the order they came in. */
function carriedRawHeaders(raw: readonly string[]): string[] {
  const headers: string[] = [];
  for (const [name, value] of carriedPairs(raw)) headers.push(name, value);
  return headers;
}

/** The name/value pairs of a raw header list, per-hop ones left behind. */
function* carriedPairs(raw: readonly string[]): Generator<[string, string]> {
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index]!;
    if (PER_HOP.has(name.toLowerCase())) continue;
    yield [name, raw[index + 1]!];
  }
}
