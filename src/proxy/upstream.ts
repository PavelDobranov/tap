/** Where requests go when the environment names no endpoint of its own. */
const DEFAULT_UPSTREAM = "https://api.anthropic.com";

/**
 * Reads the upstream from the environment Tap itself was started in.
 *
 * Tap overwrites `ANTHROPIC_BASE_URL` for the agent, so the inherited value
 * has to be read before that happens: a developer behind a corporate gateway
 * has one set, and forwarding past it would both break their setup and send
 * their credential somewhere they did not choose. The inherited value is also
 * what the test suite sets to put a fake upstream behind Tap, so the suite
 * needs no seam of its own.
 */
export function resolveUpstream(env: NodeJS.ProcessEnv): URL {
  const inherited = env["ANTHROPIC_BASE_URL"]?.trim();
  return new URL(inherited !== undefined && inherited !== "" ? inherited : DEFAULT_UPSTREAM);
}
