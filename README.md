# tap

A live network inspector for Claude Code. `tap launch claude` runs the agent
normally and opens a local web UI showing every request it sends to the
provider and every response that comes back, as it happens.

Nothing is written to disk. The record lives in memory for the life of the
session: when Tap exits, it is gone. That is what makes Tap safe to leave
switched on in a repository full of secrets.

`tap launch claude` — or just `tap launch` — runs Claude Code on your terminal
as it always runs: Tap inherits the terminal rather than emulating one, so
colours, keyboard input and Ctrl+C behave identically, and Tap says nothing
while the agent is running. Arguments are forwarded untouched, so
`tap launch claude --model opus --resume` works.

Recording is bound to the agent's life; Tap is not. When the agent exits the
session is frozen — nothing more is captured, and Tap stays up so the record
remains readable — until you interrupt it.

## Reading the record

Tap prints one line before the agent takes over, with the URL to read the
session at:

```
tap: inspect this session at http://127.0.0.1:8270/?token=...
```

That address serves the record as JSON, and serves nothing else — there is no
write endpoint. It is reachable only from this machine, only with the token in
the URL, and only under a `Host` naming Tap's own port, because what it serves
is the agent's entire context.

Every request that reaches the proxy is in it, in wire order and from the
moment it starts rather than when it finishes, typed `messages`,
`count_tokens` or `other`, with the model, the provider's status, when it
started and finished, how long it took, and the token and cache usage the
provider reported. Requests Tap does not recognise are recorded by method and
path rather than discarded.

*Reaches the proxy* is the limit of what Tap can claim. Some of Claude Code's
calls go to Anthropic whatever `ANTHROPIC_BASE_URL` says and never cross Tap
at all; those are absent from the record, and no diagnostic marks them,
because Tap has no way to know they happened. The record is everything the
agent sent through Tap, not everything the agent sent.

Capture never affects the agent. Response chunks are forwarded before capture
is shown a copy of them, and a capture that fails — a body Tap cannot parse, a
budget it cannot stay inside — becomes a **diagnostic** in the snapshot and
nothing else. The agent's request is not delayed, altered or aborted by it.
A request reports its first capture failure and not the ones after it, so one
unreadable stream leaves one diagnostic rather than one per chunk.

The browser page that renders all this is still to come, and with it the live
stream that follows a snapshot: for now the JSON is the reader, and re-reading
the URL is how you see what has happened since.

Run several sessions at once by giving each its own UI port:

```sh
tap launch --port 8271 claude
```

## Requirements

Node >= 24. Tap has no native dependencies, so installing it never compiles
anything.

## Development

```sh
npm install
npm run build      # TypeScript -> dist/, with an executable dist/cli.js
npm test           # builds, then runs the suite against the built binary
npm run typecheck  # sources, tests and scripts
npm run check:no-native
```

Tests assert external behaviour only, through the one seam the project has: the
`tap` process boundary.
