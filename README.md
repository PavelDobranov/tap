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

Capture itself is not implemented yet.

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
