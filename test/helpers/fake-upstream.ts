import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

/**
 * A recorded streamed response: the bytes an upstream sent, in the chunks it
 * sent them in, with the pauses it left between them. The gaps are the point —
 * a proxy that buffers a response is indistinguishable from a transparent one
 * unless the fixture takes its time.
 */
export interface SseFixture {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly chunks: readonly {
    readonly gapMs: number;
    readonly text: string;
    /**
     * How `text` becomes bytes, `utf8` unless said otherwise. `latin1` is how
     * a fixture splits one character across two chunks: the halves are not
     * text in any encoding, and only the bytes matter.
     */
    readonly encoding?: BufferEncoding;
  }[];
}

/** Reads a fixture from `test/fixtures/sse`, by name and without its extension. */
export function readSseFixture(name: string): SseFixture {
  const url = new URL(`../fixtures/sse/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as SseFixture;
}

/** Everything the fixture sends, as one string: what the agent must receive. */
export function fixtureBody(fixture: SseFixture): string {
  return fixture.chunks.map((chunk) => chunk.text).join("");
}

/** What the upstream saw, headers included, for asserting on transparency. */
export interface RecordedRequest {
  readonly method: string;
  /** The request target as it arrived: path and query. */
  readonly url: string;
  readonly headers: NodeJS.Dict<string | string[]>;
  /**
   * Headers as they arrived on the wire: name, value, name, value. `headers`
   * has lost the case and merged the repeats, both of which are alterations a
   * transparency assertion has to be able to see.
   */
  readonly rawHeaders: readonly string[];
  readonly body: string;
}

/**
 * How the fake upstream answers one request: either a replayed fixture or a
 * plain response, which covers both a non-streaming success and an error.
 */
export type UpstreamPlan =
  | {
      readonly stream: SseFixture;
      /**
       * Destroys the connection after the last chunk instead of closing the
       * response: an upstream that went away mid-stream, which is the only
       * honest way to test what Tap keeps of one.
       */
      readonly cut?: boolean;
    }
  | {
      readonly status?: number;
      readonly headers?: Readonly<Record<string, string>>;
      /** A Buffer for a body that is not text, such as a compressed one. */
      readonly body?: string | Buffer;
    };

export interface FakeUpstream {
  /** Point Tap here with `ANTHROPIC_BASE_URL`. */
  readonly baseUrl: string;
  /** Every request received, in arrival order. */
  readonly requests: readonly RecordedRequest[];
  close(): Promise<void>;
}

/**
 * Starts a local stand-in for the Anthropic API. Tap reaches it the way it
 * would reach a corporate gateway — through an inherited `ANTHROPIC_BASE_URL`
 * — so the suite needs no seam of its own.
 */
export async function startFakeUpstream(plan: UpstreamPlan): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];

  const server = createServer((req, res) => {
    void (async () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        body: await readBody(req),
      });

      if ("stream" in plan) {
        const { status, headers, chunks } = plan.stream;
        res.writeHead(status, { ...headers });
        res.flushHeaders();
        for (const chunk of chunks) {
          if (chunk.gapMs > 0) await delay(chunk.gapMs);
          // Awaited so that a cut upstream has demonstrably put every chunk on
          // the wire before it goes away: a chunk still in this server's own
          // buffer would make the test about the fixture rather than Tap.
          await new Promise<void>((flushed) =>
            res.write(Buffer.from(chunk.text, chunk.encoding ?? "utf8"), () => flushed()),
          );
        }
        if (plan.cut === true) {
          await delay(20);
          res.socket?.destroy();
        } else {
          res.end();
        }
        return;
      }

      const body = plan.body ?? "";
      res.writeHead(plan.status ?? 200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        ...plan.headers,
      });
      res.end(body);
    })();
  });

  // The gaps between chunks are what the streaming assertions read, so nothing
  // here may sit on a chunk waiting for company.
  server.on("connection", (socket) => socket.setNoDelay(true));

  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake upstream did not bind a port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}
