import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Record, RevisionedEvent, Snapshot } from "../record/record.ts";
import { APP, PAGE, STYLE } from "./page.ts";

/** The address Tap binds. Never a wildcard: this port serves the whole context. */
const LOOPBACK = "127.0.0.1";
export const DEFAULT_UI_PORT = 8270;
const ORIGINS = [LOOPBACK, "localhost"];
const TOKEN_COOKIE = "tap_token";

/**
 * How far behind a viewer may fall before it is disposed: the bytes Node is
 * still holding for a socket that has not drained them.
 *
 * `write` returning false is not a stalled viewer. It says only that the last
 * write went past the stream's high-water mark, which a single ordinary
 * response event does on its own — so disposing on that alone drops every
 * viewer the moment the record gets busy, and none of them ever sees the
 * event that did it. What a stalled viewer actually looks like is an
 * outstanding buffer that keeps growing, and this is the ceiling on one.
 *
 * The same ceiling bounds the opening hold, which is the one place a viewer's
 * bytes sit above the socket, and it lives only until the snapshot is out.
 * Outside that window nothing is queued above the socket at all. Reaching the
 * ceiling either way disposes that viewer and no other.
 */
const VIEWER_BACKLOG_LIMIT = 1024 * 1024;

export interface Ui {
  /** The whole address a viewer needs, token included. */
  readonly url: string;
  close(): Promise<void>;
}

export class PortInUseError extends Error {
  readonly port: number;

  constructor(port: number) {
    super(`port ${port} is already in use`);
    this.name = "PortInUseError";
    this.port = port;
  }
}

/** Starts the loopback-only, read-only UI for one Tap session. */
export async function startUi(record: Record, port: number): Promise<Ui> {
  const served: Served = { record, token: randomBytes(24).toString("base64url"), port };
  const server = createServer((req, res) => {
    void answer(req, res, served).catch((error: unknown) => {
      if (error instanceof ResponseClosed || res.destroyed || res.writableEnded) return;
      if (!res.headersSent) refuse(res, 500, "internal error");
      else res.destroy(error instanceof Error ? error : undefined);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new PortInUseError(port) : error);
    });
    server.listen(port, LOOPBACK, () => {
      server.removeAllListeners("error");
      resolve();
    });
  });

  return {
    url: `http://${LOOPBACK}:${port}/?token=${served.token}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

interface Served {
  readonly record: Record;
  readonly token: string;
  readonly port: number;
}

async function answer(req: IncomingMessage, res: ServerResponse, served: Served): Promise<void> {
  const target = new URL(req.url ?? "/", `http://${LOOPBACK}:${served.port}`);
  if (!addressesThisMachine(req.headers.host, served.port)) {
    refuse(res, 403, "bad host");
    return;
  }
  if (!authenticated(req, target, served.token, served.port)) {
    refuse(res, 403, "bad token");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    refuse(res, 405, "read only");
    return;
  }

  const headers = routeHeaders(target.pathname);
  if (headers === null) {
    refuse(res, 404, "not found");
    return;
  }
  if (target.pathname === "/") {
    headers["set-cookie"] = `${TOKEN_COOKIE}_${served.port}=${served.token}; HttpOnly; SameSite=Strict; Path=/`;
  }
  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  switch (target.pathname) {
    case "/":
      res.writeHead(200, headers);
      res.end(PAGE);
      return;
    case "/app.js":
      res.writeHead(200, headers);
      res.end(APP);
      return;
    case "/style.css":
      res.writeHead(200, headers);
      res.end(STYLE);
      return;
    case "/api/snapshot":
      res.writeHead(200, headers);
      await writeSnapshot(res, served.record.snapshot());
      res.end();
      return;
    case "/api/events":
      res.writeHead(200, headers);
      await streamEvents(res, served.record);
      return;
  }
}

function routeHeaders(pathname: string): { [header: string]: string } | null {
  const contentTypes: { [path: string]: string } = {
    "/": "text/html; charset=utf-8",
    "/app.js": "text/javascript; charset=utf-8",
    "/style.css": "text/css; charset=utf-8",
    "/api/snapshot": "application/json; charset=utf-8",
    "/api/events": "text/event-stream; charset=utf-8",
  };
  const contentType = contentTypes[pathname];
  if (contentType === undefined) return null;
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
      "img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...(pathname === "/api/events" ? { connection: "keep-alive" } : {}),
  };
}

/**
 * Registers before taking the snapshot, so nothing that happens after it can
 * be missed, and holds what arrives while the opening frame is still going out
 * until it has gone — the snapshot has to reach the viewer before the deltas
 * that follow it, and a record mid-stream changes many times in the time one
 * takes to write.
 *
 * That hold is the opposite of a catch-up buffer: it is bounded, it exists
 * only until the snapshot is out, and a viewer that overruns it is disposed
 * to re-snapshot rather than being caught up. Disposing on the first change
 * instead would mean a record busy enough to be worth watching could never
 * finish opening at all.
 */
async function streamEvents(res: ServerResponse, record: Record): Promise<void> {
  let opening = true;
  let closed = false;
  let view: ReturnType<Record["view"]> | null = null;
  /** Deltas published while the snapshot is still going out, in order. */
  const waiting: string[] = [];
  let waitingBytes = 0;

  const dispose = (): void => {
    if (closed) return;
    closed = true;
    view?.close();
    if (!res.destroyed) res.destroy();
  };
  // Hands the event straight to the socket and returns: never awaited, so a
  // viewer cannot delay the capture publishing to it. Nothing is queued above
  // the socket except during the opening frame, and that hold is bounded by
  // the same ceiling. A viewer whose backlog has run away is dropped instead.
  const send = ({ revision, event }: RevisionedEvent): void => {
    if (closed) return;
    const text = frame("delta", revision, event);
    if (opening) {
      // Bytes, not characters: what the ceiling and `writableLength` both
      // count is what goes on the wire, which is this text as UTF-8.
      waitingBytes += Buffer.byteLength(text);
      if (waitingBytes > VIEWER_BACKLOG_LIMIT) dispose();
      else waiting.push(text);
      return;
    }
    // Measured before the write, not after: what says a viewer has stalled is
    // that it has not drained what it was already sent, never the size of the
    // event in hand. Checking afterwards would dispose an attentive viewer for
    // the one large blob it asked for and had every chance of reading.
    if (res.destroyed || res.writableLength > VIEWER_BACKLOG_LIMIT) {
      dispose();
      return;
    }
    res.write(text);
  };

  view = record.view(send);
  res.once("close", dispose);
  res.once("error", dispose);
  if (!(await writeOpeningFrame(res, view.snapshot))) {
    dispose();
    return;
  }
  // Nothing is awaited between here and the last write, so no further event
  // can slip in front of what was held: the viewer sees the snapshot, then
  // every revision after it, in order and each exactly once.
  if (closed) return;
  for (const text of waiting) {
    if (res.destroyed) {
      dispose();
      return;
    }
    res.write(text);
  }
  waiting.length = 0;
  opening = false;
}

function frame(event: string, revision: number, data: unknown): string {
  return `event: ${event}\nid: ${revision}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Writes the opening snapshot in small pieces, letting the socket fill and
 * waiting for it only once it is genuinely full, rather than giving up on the
 * first piece that passes the high-water mark: a snapshot is the one thing a
 * viewer cannot do without, and a record big enough to fill a socket is
 * exactly the record worth opening the UI on. Yielding between pieces is what
 * keeps serving it off the path a request crosses.
 */
async function writeOpeningFrame(res: ServerResponse, snapshot: Snapshot): Promise<boolean> {
  const text = frame("snapshot", snapshot.revision, { revision: snapshot.revision, snapshot });
  const piece = 8 * 1024;
  for (let at = 0; at < text.length; at += piece) {
    if (res.destroyed || res.writableEnded) return false;
    res.write(text.slice(at, at + piece));
    // Waiting on every piece would put a round trip between each of them and
    // serve a large record at a crawl. Waiting only once the socket is
    // genuinely full keeps the outstanding bytes bounded by the same ceiling a
    // live viewer is held to, which is the whole of what this connection costs.
    if (res.writableLength > VIEWER_BACKLOG_LIMIT && !(await drained(res))) return false;
    // Only between pieces: a yield after the last one buys nothing and widens
    // the window in which a viewer that already has the whole snapshot is
    // disposed for a delta it could simply have been sent.
    if (at + piece < text.length) await yieldToOtherRequests();
  }
  return true;
}

/**
 * Resolves once the socket has caught up, or false if it went away first.
 * The one place that waits on a socket: both the snapshot routes push until
 * the socket is full and then come here, and they differ only in how they say
 * a viewer has gone.
 */
function drained(res: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    const settle = (answer: boolean) => {
      res.off("drain", ok);
      res.off("close", gone);
      res.off("error", gone);
      resolve(answer);
    };
    const ok = () => settle(true);
    const gone = () => settle(false);
    res.once("drain", ok);
    res.once("close", gone);
    res.once("error", gone);
  });
}

/** A refusal says only that it refused: never why, and never the token. */
function refuse(res: ServerResponse, status: number, reason: string): void {
  res.writeHead(status, {
    ...(routeHeaders("/") ?? {}),
    "content-type": "text/plain; charset=utf-8",
  });
  res.end(`tap: ${reason}\n`);
}

/** Streams a JSON snapshot in record-order pieces, yielding between unbounded lists. */
async function writeSnapshot(res: ServerResponse, snapshot: Snapshot): Promise<void> {
  await writeChunk(res, `{"revision":${snapshot.revision},"lifecycle":${JSON.stringify(snapshot.lifecycle)},"requests":`);
  await writeArray(res, snapshot.requests);
  await writeChunk(res, ',"threads":');
  await writeArray(res, snapshot.threads);
  await writeChunk(res, ',"blobs":');
  await writeBlobMap(res, snapshot.blobs);
  await writeChunk(res, ',"storage":');
  await writeChunk(res, JSON.stringify(snapshot.storage));
  await writeChunk(res, ',"evictions":');
  await writeArray(res, snapshot.evictions);
  await writeChunk(res, ',"diagnostics":');
  await writeArray(res, snapshot.diagnostics);
  await writeChunk(res, "}");
}

async function writeArray(res: ServerResponse, values: readonly unknown[]): Promise<void> {
  await writeChunk(res, "[");
  for (const [index, value] of values.entries()) {
    if (index > 0) await writeChunk(res, ",");
    await writeChunk(res, JSON.stringify(value));
    await yieldToOtherRequests();
  }
  await writeChunk(res, "]");
}

async function writeBlobMap(res: ServerResponse, blobs: Snapshot["blobs"]): Promise<void> {
  await writeChunk(res, "{");
  let first = true;
  for (const [hash, blob] of Object.entries(blobs)) {
    if (!first) await writeChunk(res, ",");
    first = false;
    await writeChunk(res, `${JSON.stringify(hash)}:${JSON.stringify(blob)}`);
    await yieldToOtherRequests();
  }
  await writeChunk(res, "}");
}

function yieldToOtherRequests(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function writeChunk(res: ServerResponse, chunk: string): Promise<void> {
  if (res.destroyed || res.writableEnded) throw new ResponseClosed();
  if (res.write(chunk)) return;
  if (!(await drained(res))) throw new ResponseClosed();
}

class ResponseClosed extends Error {}

function addressesThisMachine(host: string | undefined, port: number): boolean {
  return ORIGINS.some((origin) => host === `${origin}:${port}`);
}

function authenticated(req: IncomingMessage, target: URL, token: string, port: number): boolean {
  const offered =
    target.searchParams.get("token") ?? cookie(req.headers.cookie, `${TOKEN_COOKIE}_${port}`);
  if (offered === null) return false;
  const a = Buffer.from(offered);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookie(header: string | undefined, name: string): string | null {
  for (const field of header?.split(";") ?? []) {
    const [key, ...value] = field.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}
