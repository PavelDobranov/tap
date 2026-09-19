import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Record, RevisionedEvent, Snapshot } from "../record/record.ts";

/** The address Tap binds. Never a wildcard: this port serves the whole context. */
const LOOPBACK = "127.0.0.1";
export const DEFAULT_UI_PORT = 8270;
const ORIGINS = [LOOPBACK, "localhost"];
const TOKEN_COOKIE = "tap_token";

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
 * Registers before taking the snapshot. If the record changes while the
 * opening frame is being written, this connection is disposed and EventSource
 * reconnects for a fresh snapshot; no viewer owns a catch-up buffer.
 */
async function streamEvents(res: ServerResponse, record: Record): Promise<void> {
  let opening = true;
  let closed = false;
  let view: ReturnType<Record["view"]> | null = null;

  const dispose = (): void => {
    if (closed) return;
    closed = true;
    view?.close();
    if (!res.destroyed) res.destroy();
  };
  const send = ({ revision, event }: RevisionedEvent): void => {
    if (closed) return;
    if (opening) {
      dispose();
      return;
    }
    if (!res.write(frame("delta", revision, event))) dispose();
  };

  view = record.view(send);
  res.once("close", dispose);
  res.once("error", dispose);
  if (!(await writeOpeningFrame(res, view.snapshot))) {
    dispose();
    return;
  }
  opening = false;
}

function frame(event: string, revision: number, data: unknown): string {
  return `event: ${event}\nid: ${revision}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Small writes let the socket expose a genuinely stalled viewer promptly. */
async function writeOpeningFrame(res: ServerResponse, snapshot: Snapshot): Promise<boolean> {
  const text = frame("snapshot", snapshot.revision, { revision: snapshot.revision, snapshot });
  const piece = 8 * 1024;
  for (let at = 0; at < text.length; at += piece) {
    if (res.destroyed || !res.write(text.slice(at, at + piece))) return false;
    await yieldToOtherRequests();
  }
  return true;
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
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", drained);
      res.off("close", closed);
      res.off("error", failed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(new ResponseClosed());
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    res.once("drain", drained);
    res.once("close", closed);
    res.once("error", failed);
  });
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

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tap · live requests</title><link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head>
<body><header><div><strong>tap</strong><span id="connection">connecting</span></div><p id="lifecycle">Live session</p></header>
<main><table><thead><tr><th>Sequence</th><th>Type</th><th>Thread</th><th>Model</th><th>Status</th><th>Started</th><th>Duration</th><th>Tokens / cache</th></tr></thead><tbody id="requests"></tbody></table>
<p id="empty">Waiting for requests…</p></main></body></html>`;

const APP = `(() => {
  "use strict";
  const rows = new Map();
  const body = document.querySelector("#requests");
  const empty = document.querySelector("#empty");
  const connection = document.querySelector("#connection");
  const lifecycle = document.querySelector("#lifecycle");
  const fields = ["seq", "type", "thread", "model", "state", "started", "duration", "usage"];

  const text = (cell, value) => { cell.textContent = value; };
  const usage = (value) => {
    if (!value) return "—";
    const bits = [];
    if (value.inputTokens != null) bits.push("in " + value.inputTokens);
    if (value.outputTokens != null) bits.push("out " + value.outputTokens);
    if (value.cacheReadInputTokens != null) bits.push("cache read " + value.cacheReadInputTokens);
    if (value.cacheCreationInputTokens != null) bits.push("cache write " + value.cacheCreationInputTokens);
    return bits.join(" · ") || "—";
  };
  const state = (request) => {
    const activity = request.rawResponse.length ? " · receiving " + request.rawResponse.length : "";
    if (request.completedAt == null) return request.status == null ? "in flight" + activity : request.status + activity;
    return request.interrupted ? "interrupted" : String(request.status ?? "complete");
  };
  const render = (request) => {
    let held = rows.get(request.seq);
    if (!held) {
      const row = document.createElement("tr");
      row.dataset.seq = String(request.seq);
      const cells = Object.fromEntries(fields.map((name) => {
        const cell = document.createElement("td"); row.append(cell); return [name, cell];
      }));
      held = { request, row, cells }; rows.set(request.seq, held);
      const after = [...body.children].find((candidate) => Number(candidate.dataset.seq) > request.seq);
      body.insertBefore(row, after || null);
    }
    held.request = request;
    text(held.cells.seq, String(request.seq)); text(held.cells.type, request.type);
    text(held.cells.thread, request.thread == null ? "—" : request.thread === 1 ? "main" : "thread " + request.thread);
    text(held.cells.model, request.model ?? "—"); text(held.cells.state, state(request));
    text(held.cells.started, new Date(request.startedAt).toLocaleTimeString());
    text(held.cells.duration, request.durationMs == null ? "—" : request.durationMs + " ms");
    text(held.cells.usage, usage(request.usage)); empty.hidden = rows.size !== 0;
  };
  const freeze = (agent) => {
    lifecycle.textContent = agent.signal ? "Frozen · agent exited by " + agent.signal : "Frozen · agent exited with code " + agent.code;
    document.body.dataset.frozen = "true";
  };
  const snapshot = (value) => {
    rows.clear(); body.replaceChildren(); value.requests.forEach(render);
    if (value.lifecycle.phase === "frozen") freeze(value.lifecycle.agent);
  };
  const delta = (event) => {
    if (event.type === "request-start") render(event.request);
    else if (event.type === "request-change") {
      const held = rows.get(event.seq); if (held) render(Object.assign({}, held.request, event.changes));
    } else if (event.type === "raw-response") {
      const held = rows.get(event.seq); if (held) render(Object.assign({}, held.request, { rawResponse: held.request.rawResponse.concat(event.event) }));
    } else if (event.type === "frozen") freeze(event.agent);
  };

  const token = new URL(location.href).searchParams.get("token");
  const source = new EventSource("/api/events" + (token ? "?token=" + encodeURIComponent(token) : ""));
  source.addEventListener("open", () => { connection.textContent = "connected"; });
  source.addEventListener("error", () => { connection.textContent = "reconnecting"; });
  source.addEventListener("snapshot", (message) => snapshot(JSON.parse(message.data).snapshot));
  source.addEventListener("delta", (message) => delta(JSON.parse(message.data)));
})();`;

const STYLE = `:root{color-scheme:dark;font:14px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;background:#101211;color:#e7ebe8}*{box-sizing:border-box}body{margin:0}header{position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;padding:16px 24px;background:#171a18;border-bottom:1px solid #303632}header div{display:flex;gap:16px;align-items:center}header strong{color:#7ee2a8;font-size:18px}header span{color:#9da7a0}header p{margin:0;color:#7ee2a8}main{padding:24px;overflow:auto}table{width:100%;border-collapse:collapse;background:#151816}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #2b302d;white-space:nowrap}th{color:#98a39c;font-size:11px;text-transform:uppercase;letter-spacing:.08em}tbody tr:hover{background:#1c211e}#empty{color:#7d8780;text-align:center;padding:48px}[data-frozen=true] header p{color:#d8b66a}@media(max-width:800px){th:nth-child(6),td:nth-child(6){display:none}header,main{padding:14px}}`;
