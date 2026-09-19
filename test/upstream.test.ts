import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveUpstream } from "../src/proxy/upstream.ts";

/**
 * Where Tap forwards is decided from the environment alone, so it is read
 * here as a value rather than through a session: the default endpoint is the
 * one case no local upstream can stand in for.
 */

test("with no inherited endpoint, requests go to the default Anthropic API", () => {
  assert.equal(resolveUpstream({}).toString(), "https://api.anthropic.com/");
});

test("an inherited endpoint is forwarded to instead of the default", () => {
  const upstream = resolveUpstream({ ANTHROPIC_BASE_URL: "https://gateway.corp.example/llm" });

  assert.equal(upstream.host, "gateway.corp.example");
  assert.equal(upstream.pathname, "/llm");
});

test("an inherited endpoint that is blank names nothing and leaves the default", () => {
  assert.equal(resolveUpstream({ ANTHROPIC_BASE_URL: "   " }).toString(), "https://api.anthropic.com/");
});
