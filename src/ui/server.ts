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
 *
 * It also paces the snapshot route, which serves a reader rather than a
 * viewer and so is never disposed: there it is how much may be outstanding
 * before the writer waits for the socket. One number, because what it
 * measures — bytes a socket has not taken — is the same on both routes.
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
      await writeSnapshot(new SnapshotWriter(res), served.record.snapshot());
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
  return `${frameHead(event, revision)}${JSON.stringify(data)}${FRAME_END}`;
}

/**
 * The envelope of a framed event, up to the start of its data. Written on its
 * own by the opening frame, whose data is too big to be a string before it is
 * a frame, so that both spellings of an event's envelope are this one.
 */
function frameHead(event: string, revision: number): string {
  return `event: ${event}\nid: ${revision}\ndata: `;
}

/** A framed event ends at a blank line, which is what closes its data line. */
const FRAME_END = "\n\n";

/**
 * Writes the opening frame the same way the snapshot route writes its body:
 * serialised as it goes, never stringified whole. The frame is the snapshot
 * plus a few bytes of envelope, so building it as one string and slicing the
 * result meant holding the entire record in memory before a byte of it went
 * out — on the one route every real viewer takes, and on exactly the records
 * big enough for that to matter.
 *
 * Nothing in the snapshot's JSON is a raw newline, so the data line is one
 * line however many pieces it takes to write.
 */
async function writeOpeningFrame(res: ServerResponse, snapshot: Snapshot): Promise<boolean> {
  const writer = new SnapshotWriter(res);
  try {
    await writer.write(
      `${frameHead("snapshot", snapshot.revision)}{"revision":${snapshot.revision},"snapshot":`,
    );
    await writeSnapshot(writer, snapshot);
    await writer.write(`}${FRAME_END}`);
  } catch (error) {
    if (error instanceof ResponseClosed) return false;
    throw error;
  }
  return true;
}

/**
 * The one way a snapshot reaches a socket, and the one rule for when to wait.
 * Whether it is a viewer's opening frame or the snapshot route's body, the
 * bytes are paced the same way.
 *
 * Pieces are pushed until the socket is holding more than a stalled viewer
 * would be allowed to hold, and only then is the socket waited on: waiting on
 * every piece would put a round trip between each of them and serve a large
 * record at a crawl, while giving up on the first piece past the high-water
 * mark would refuse the records the UI exists for. What is outstanding stays
 * bounded by the same ceiling a live viewer is held to, which is the whole of
 * what one connection costs.
 *
 * Both snapshot routes write through this, so neither can grow a backpressure
 * rule of its own, and yielding between pieces — whatever the route — is what
 * keeps serving a large record off the path a request crosses.
 */
class SnapshotWriter {
  readonly #res: ServerResponse;
  /** Bytes written since the last yield: what the next one waits for. */
  #unyielded = 0;

  constructor(res: ServerResponse) {
    this.#res = res;
  }

  /** Throws `ResponseClosed` if the viewer went away mid-snapshot. */
  async write(piece: string): Promise<void> {
    // Yields are spaced by bytes, not by pieces. A snapshot is written in
    // whatever pieces its shape has — a whole request, a separating comma —
    // so yielding on every one would tie the number of event-loop turns to
    // the number of elements, and a record of many small requests would pay
    // two turns each to write a few bytes. What a yield is for is the size of
    // the work between them, which is bytes.
    //
    // Before the piece rather than after it: a yield past the last one buys
    // nothing and widens the window in which a viewer that already has the
    // whole snapshot is disposed for a delta it could simply have been sent.
    if (this.#unyielded >= YIELD_EVERY) {
      this.#unyielded = 0;
      await yieldToOtherRequests();
    }
    if (this.#res.destroyed || this.#res.writableEnded) throw new ResponseClosed();
    this.#res.write(piece);
    this.#unyielded += Buffer.byteLength(piece);
    if (this.#res.writableLength > VIEWER_BACKLOG_LIMIT && !(await drained(this.#res))) {
      throw new ResponseClosed();
    }
  }
}

/**
 * How much of a snapshot goes out between yields. Small enough that nothing
 * else waits a perceptible time behind it — capture is on the same event loop
 * and must never be delayed by a viewer — and large enough that a big record
 * does not cross the loop thousands of times to be served.
 */
const YIELD_EVERY = 8 * 1024;

/**
 * Resolves once the socket has caught up, or false if it went away first.
 * The one place that waits on a socket.
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

/** Streams a JSON snapshot in record-order pieces, one element at a time. */
async function writeSnapshot(writer: SnapshotWriter, snapshot: Snapshot): Promise<void> {
  await writer.write(
    `{"revision":${snapshot.revision},"lifecycle":${JSON.stringify(snapshot.lifecycle)},"requests":`,
  );
  await writeArray(writer, snapshot.requests);
  await writer.write(',"threads":');
  await writeArray(writer, snapshot.threads);
  await writer.write(',"blobs":');
  await writeBlobMap(writer, snapshot.blobs);
  await writer.write(',"storage":');
  await writer.write(JSON.stringify(snapshot.storage));
  await writer.write(',"evictions":');
  await writeArray(writer, snapshot.evictions);
  await writer.write(',"diagnostics":');
  await writeArray(writer, snapshot.diagnostics);
  await writer.write("}");
}

async function writeArray(writer: SnapshotWriter, values: readonly unknown[]): Promise<void> {
  await writer.write("[");
  for (const [index, value] of values.entries()) {
    if (index > 0) await writer.write(",");
    await writer.write(JSON.stringify(value));
  }
  await writer.write("]");
}

async function writeBlobMap(writer: SnapshotWriter, blobs: Snapshot["blobs"]): Promise<void> {
  await writer.write("{");
  let first = true;
  for (const [hash, blob] of Object.entries(blobs)) {
    if (!first) await writer.write(",");
    first = false;
    await writer.write(`${JSON.stringify(hash)}:${JSON.stringify(blob)}`);
  }
  await writer.write("}");
}

function yieldToOtherRequests(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
