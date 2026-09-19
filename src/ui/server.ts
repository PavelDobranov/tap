import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Record } from "../record/record.ts";

/** The address Tap binds. Never a wildcard: this port serves the whole context. */
const LOOPBACK = "127.0.0.1";

/**
 * The UI's port. Fixed rather than ephemeral so the URL is the same one every
 * time and can be left open in a tab; `--port` moves it, which is what lets
 * several sessions run at once.
 */
export const DEFAULT_UI_PORT = 8270;

/** The names that mean "this machine" and so may address the UI. */
const ORIGINS = [LOOPBACK, "localhost"];

export interface Ui {
  /** The whole address a viewer needs, token included. */
  readonly url: string;
  close(): Promise<void>;
}

/** A port that could not be bound, as a message rather than a stack trace. */
export class PortInUseError extends Error {
  readonly port: number;

  constructor(port: number) {
    super(`port ${port} is already in use`);
    this.name = "PortInUseError";
    this.port = port;
  }
}

/**
 * Starts the server that serves the record, and returns the URL to read it at.
 *
 * Read-only by construction: one route, one method, and no code path that
 * mutates the record. The record is the agent's entire context — its source,
 * its secrets, everything in the window — so reaching it takes both the token
 * in the URL and a `Host` naming this machine. Without the `Host` check, any
 * page in the browser could point a script at a name resolving to loopback and
 * read the session; without the token, anything on the machine could.
 *
 * The server outlives the agent. Recording is bound to the agent's life;
 * serving is not, so the record stays readable through the frozen phase until
 * Tap is interrupted.
 */
export async function startUi(record: Record, port: number): Promise<Ui> {
  const served: Served = { record, token: randomBytes(24).toString("base64url"), port };
  const server = createServer((req, res) => answer(req, res, served));

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
    url: `http://${LOOPBACK}:${served.port}/?token=${served.token}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** What one session serves, and the two things that gate reaching it. */
interface Served {
  readonly record: Record;
  readonly token: string;
  readonly port: number;
}

function answer(req: IncomingMessage, res: ServerResponse, served: Served): void {
  const target = new URL(req.url ?? "/", `http://${LOOPBACK}:${served.port}`);

  if (!addressesThisMachine(req.headers.host, served.port)) {
    return refuse(res, 403, "bad host");
  }
  if (!presented(target.searchParams.get("token"), served.token)) {
    return refuse(res, 403, "bad token");
  }
  if (target.pathname !== "/") return refuse(res, 404, "not found");
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Nothing here writes, so nothing here accepts a method that would.
    return refuse(res, 405, "read only");
  }

  const body = JSON.stringify(served.record.snapshot());
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    // The record never leaves the process: no store, no cache, no history
    // entry a later reader could find.
    "cache-control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

/** A refusal says only that it refused: never why, and never the token. */
function refuse(res: ServerResponse, status: number, reason: string): void {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(`tap: ${reason}\n`);
}

/**
 * Whether a `Host` header names Tap's own UI. Anything else is a request that
 * arrived through a name Tap did not bind — which is what a DNS rebinding
 * attack looks like from in here.
 */
function addressesThisMachine(host: string | undefined, port: number): boolean {
  return ORIGINS.some((origin) => host === `${origin}:${port}`);
}

/** Compares the presented token in constant time. */
function presented(offered: string | null, token: string): boolean {
  if (offered === null) return false;
  const a = Buffer.from(offered);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
