#!/usr/bin/env node
// Measures what capture costs in memory. Every `/v1/messages` request resends
// the whole conversation, so holding payloads verbatim is quadratic in
// conversation length; this replays a multi-turn conversation of a realistic
// shape and reports the peak resident set of the `tap` process that captured
// it, together with what content-addressed storage held it in.
//
// It was written as the #14 baseline and is now the comparison for #15: same
// script, same shape, so the two curves are the same measurement.
//
//   node scripts/measure-capture-baseline.mjs [--turns 40]
//   node scripts/measure-capture-baseline.mjs --pid <pid>   # a live `tap`
//
// The second form is how the same number is taken from real Claude Code
// traffic: start a Tap session, work in it normally, then read the high-water
// mark off the live process before interrupting it.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createFakeAgent } from "../test/helpers/fake-agent.ts";
import { startFakeUpstream } from "../test/helpers/fake-upstream.ts";
import { printedUrl, snapshotAt } from "../test/helpers/snapshot.ts";

const repoRoot = new URL("../", import.meta.url);

/**
 * The shape of one turn, in bytes. Taken from the order of magnitude a real
 * Claude Code conversation shows: a large fixed preamble, and a history that grows
 * mostly through tool results.
 */
const SHAPE = {
  system: 12_000,
  tools: 40_000,
  userMessage: 900,
  assistantMessage: 2_000,
  toolResult: 15_000,
  /** Requests per turn: one to ask for the tool, one after its result. */
  requestsPerTurn: 2,
};

/** Peak resident set of a live process, in bytes, from its high-water mark. */
function peakRss(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const kb = /^VmHWM:\s+(\d+) kB$/m.exec(status)?.[1];
  if (kb === undefined) throw new Error(`no VmHWM for pid ${pid}`);
  return Number(kb) * 1024;
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A stand-in Claude Code that holds a conversation of `turns` turns. */
const CONVERSING_AGENT = `
const { writeFileSync } = require("node:fs");
const http = require("node:http");

const base = new URL(process.env.ANTHROPIC_BASE_URL);
const shape = JSON.parse(process.env.MEASURE_SHAPE);
const turns = Number(process.env.MEASURE_TURNS);
const filler = (bytes) => "x".repeat(bytes);

const system = [{ type: "text", text: filler(shape.system) }];
const tools = Array.from({ length: 20 }, (_, index) => ({
  name: "tool_" + index,
  description: filler(Math.floor(shape.tools / 20)),
  input_schema: { type: "object" },
}));
const messages = [];
let sent = 0;

function ask() {
  const body = JSON.stringify({ model: "claude-opus-5", system, tools, messages, stream: true });
  sent += Buffer.byteLength(body);
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: base.hostname,
        port: base.port,
        method: "POST",
        path: "/v1/messages",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (response) => {
        response.on("data", () => {});
        response.on("end", resolve);
      },
    );
    request.on("error", resolve);
    request.end(body);
  });
}

(async () => {
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ role: "user", content: filler(shape.userMessage) });
    await ask();
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: filler(shape.assistantMessage) },
        { type: "tool_use", id: "toolu_" + turn, name: "tool_0", input: {} },
      ],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_" + turn, content: filler(shape.toolResult) }],
    });
    await ask();
  }
  writeFileSync(process.env.MEASURE_REPORT, JSON.stringify({ sent, requests: turns * 2 }));
  process.exit(0);
})();
`;

/** One Tap session over a conversation of `turns` turns. */
async function measure(turns) {
  const upstream = await startFakeUpstream({
    stream: {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      chunks: [
        {
          gapMs: 0,
          text:
            'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5",' +
            '"usage":{"input_tokens":40000,"output_tokens":1}}}\n\n',
        },
        {
          gapMs: 0,
          text:
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":' +
            `{"type":"text_delta","text":"${"y".repeat(2000)}"}}\n\n`,
        },
        {
          gapMs: 0,
          text:
            'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":500}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        },
      ],
    },
  });

  const agent = createFakeAgent(CONVERSING_AGENT);
  const report = `/tmp/tap-measure-${process.pid}-${turns}.json`;
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("dist/cli.js", repoRoot)), "launch", "--port", String(await freePort()), "claude"],
    {
      cwd: fileURLToPath(repoRoot),
      env: {
        ...process.env,
        PATH: agent.pathEnv,
        ANTHROPIC_BASE_URL: upstream.baseUrl,
        MEASURE_SHAPE: JSON.stringify(SHAPE),
        MEASURE_TURNS: String(turns),
        MEASURE_REPORT: report,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));

  await new Promise((resolve, reject) => {
    const check = () => (/frozen/.test(stderr) ? resolve() : undefined);
    child.stderr.on("data", check);
    child.on("exit", () => reject(new Error(`tap exited early:\n${stderr}`)));
    setTimeout(() => reject(new Error(`timed out:\n${stderr}`)), 600_000).unref();
  });

  const peak = peakRss(child.pid);
  const sent = turns === 0 ? { sent: 0, requests: 0 } : JSON.parse(readFileSync(report, "utf8"));
  // Read before the session is interrupted: the record is the process, and
  // interrupting it is what throws the record away.
  const { storage } = await snapshotAt(printedUrl(stderr));

  child.kill("SIGINT");
  await new Promise((resolve) => child.on("exit", resolve));
  await upstream.close();
  agent.remove();

  return { turns, peak, storage, ...sent };
}

const options = process.argv.slice(2);
const pidAt = options.indexOf("--pid");
if (pidAt !== -1) {
  const pid = Number(options[pidAt + 1]);
  console.log(`tap ${pid}: peak resident set ${mib(peakRss(pid))}`);
  process.exit(0);
}

const turnsAt = options.indexOf("--turns");
const turns = turnsAt === -1 ? 40 : Number(options[turnsAt + 1]);

const idle = await measure(0);
const loaded = await measure(turns);

console.log(`conversation shape: ${JSON.stringify(SHAPE)}`);
console.log(`idle tap (no requests):      peak RSS ${mib(idle.peak)}`);
console.log(
  `${loaded.requests} requests, ${mib(loaded.sent)} of request payload:` +
    ` peak RSS ${mib(loaded.peak)}`,
);
console.log(`cost of capturing them:      ${mib(loaded.peak - idle.peak)}`);
console.log(`per megabyte forwarded:      ${((loaded.peak - idle.peak) / loaded.sent).toFixed(2)}x`);
console.log(
  `payload held:                ${mib(loaded.storage.payloadSize)}` +
    ` in ${loaded.storage.blobCount} blobs`,
);
console.log(
  `units referenced:            ${loaded.storage.referencedUnits}` +
    ` (${loaded.storage.deduplicationRatio}x deduplication)`,
);
