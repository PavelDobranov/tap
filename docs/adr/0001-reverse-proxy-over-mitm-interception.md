# Reverse proxy over MITM interception

Tap intercepts by binding an HTTP server on `127.0.0.1` and pointing the
launched agent's `ANTHROPIC_BASE_URL` at it.

## Consequences

Tap sees only provider traffic, which is what it wants. But an agent configured
for Bedrock, Vertex or Foundry has no base URL to override, so those
configurations are unsupported: `tap launch` exits with a clear error rather
than recording nothing.