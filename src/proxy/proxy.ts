import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";

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
 */
export async function startProxy(upstream: URL): Promise<Proxy> {
  const server = createServer((req, res) => forward(req, res, upstream));

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

function forward(req: IncomingMessage, res: ServerResponse, upstream: URL): void {
  const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
  const prefix = upstream.pathname.replace(/\/$/, "");

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
    upstreamRes.pipe(res);
    upstreamRes.on("error", () => res.destroy());
  });

  outbound.on("error", () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("tap: could not reach the upstream\n");
  });

  // An agent that gives up mid-request must not leave Tap holding the upstream
  // one open.
  res.on("close", () => {
    if (!res.writableEnded) outbound.destroy();
  });

  req.pipe(outbound);
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
