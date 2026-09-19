# Ephemeral in-memory capture with a browser UI

Tap captures into memory for the life of one Tap session and serves it to a
local browser UI. Nothing is written to disk, and when Tap exits the record is
gone. This supersedes ADR-0002 (storage outside the repository) and ADR-0004
(no TUI and no IPC in v0).

The original design was post-hoc: capture into a per-project SQLite store, read
it back later with `tap show`. The reframing is that the valuable thing is
watching the harness talk to the provider *as it happens* — a network tab for
Claude Code — and that a tool which silently accumulates every prompt, every
file the agent read and every secret in its context is a liability to leave
switched on. Ephemerality is therefore a feature statement, not an
implementation detail: it is what makes Tap safe to run permanently.

The browser was chosen over a TUI. ADR-0004 deleted the TUI because a
hand-built two-pane widget is expensive and a pager reads a transcript better;
that reasoning holds against a TUI and not against a browser. Claude Code owns
the terminal, so the viewer has to live elsewhere regardless, and the proxy is
already an HTTP server — serving a page costs one more server rather than a
new IPC layer, and list, detail, search and JSON rendering come from the
platform instead of being written.

## Consequences

Recording is bound to the agent's life; *serving* is not. Tap keeps serving the
frozen record after the agent exits, until it is interrupted, because the
common case is noticing that something was odd once the turn is over.

Cross-session forensics is gone and is the capability deliberately traded away:
there is no way to compare today's behaviour against last Tuesday's, and a Tap
crash loses the session. Project identity, `tap list`, `tap show`, `tap export`
and `tap rm` all go with it, leaving `tap launch` as very nearly the whole CLI.

Two servers on two ports: the agent-facing proxy, and the UI. They are
separated because the UI serves the entire captured context — source, secrets,
everything in the window — and must not share an origin with the endpoint the
agent itself calls. The UI validates the `Host` header and requires a token in
its URL, without which any page open in the browser could read the context.

Memory replaces disk as the scarce resource, so the record is capped and evicts
oldest-first at the blob level, and eviction is shown in the UI. Silent
dropping is the one failure mode that makes a reader draw a wrong conclusion,
which is also why capture failures — previously logged to a session log file
that no longer exists — are surfaced in the UI as diagnostics.

The UI is fed a snapshot and then a live stream, so opening it late or
reloading loses nothing and several viewers can watch at once. A viewer that
falls behind re-snapshots rather than catching up: fail-open still means the
agent's response path is never delayed by a reader.
