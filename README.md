# tap

Context forensics for Claude Code. `tap launch claude` records every request
Claude Code sends to the provider, so you can read afterwards what the model was
actually given.

Nothing is implemented yet beyond the CLI skeleton — each command currently
reports that it is not implemented.

## Requirements

Node >= 24. Tap uses the Node runtime's built-in SQLite module and has no native
dependencies, so installing it never compiles anything.

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
