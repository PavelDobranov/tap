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

That address opens the live request list. It is reachable only from this
machine, only with the token in the URL, and only under a `Host` naming Tap's
own port, because what it serves is the agent's entire context. The UI is local
HTML, CSS and browser-native JavaScript; it loads no remote code. An
authenticated JSON snapshot remains available at `/api/snapshot`.

Every request that reaches the proxy is in it, in wire order and from the
moment it starts rather than when it finishes, typed `messages`,
`count_tokens` or `other`, with the model, the provider's status, when it
started and finished, how long it took, and the token and cache usage the
provider reported. Requests Tap does not recognise are recorded by method and
path rather than discarded.

The evidence itself is there too. Each request holds its **payload**: the body
byte for byte as the upstream received it, `other` requests included, since the
request Tap cannot read is the one worth having in full. For the requests it
does recognise it holds the response as it streamed, event by event. Events are written down as they
arrive rather than at the end, so a response still in flight is readable as far
as it has got, and one that was cut off leaves what it got rather than nothing,
marked `interrupted` so a partial answer is never read as a complete one.

### How payloads are held

Every `/v1/messages` request resends the whole conversation, so holding each
body verbatim costs the square of the conversation length — several gigabytes
of RAM in a long session. So the record does not hold them verbatim; it holds
them *exactly*, which is not the same thing.

Each payload is split into **units** — the `system` block, the `tools` array,
and each element of `messages[]` — and each unit is stored once, in a **blob**
addressed by the SHA-256 of its canonical JSON. What is left against the
request is a **skeleton**: the bytes that arrived, with each unit replaced by a
reference to its blob. The fiftieth request in a conversation therefore adds one
message to the record rather than fifty.

`cache_control` is cut out before a unit is addressed and recorded in the
skeleton instead. Claude Code moves its cache breakpoints from one request to
the next, and without this an unchanged message would get a new address every
time a breakpoint landed on or left it, which would quietly halve the saving.

**Reconstruction is exact.** A reader joins the skeleton's parts, replacing
each reference with its blob's `json` and splicing that reference's
annotations back in at the offsets given, and gets the bytes the upstream
received — whitespace, key order, escapes and all. Nothing is re-serialised: a
skeleton is the original text with holes in it. A body Tap cannot take apart —
an `other` request, or one that is not JSON — has a skeleton of a single string,
which is the body itself.

The snapshot reports what this is buying under `storage`: what the record
holds in total and how much of that is payload, how many blobs, how many unit
references across every request, and the ratio between the two. On a scripted
80-turn conversation the payload figure is 1.4 MiB for 118.9 MiB forwarded;
`docs/measurements/raw-payload-capture.md` has the numbers and the method.

One request will not take the session down with it: nothing Tap reads grows
past 32MB. A response that reaches the limit keeps what arrived before it; a
request body that would exceed it is dropped whole, because half a payload
presented as a payload is worse than a recorded absence. Either way a
diagnostic says what happened.

### The cap, and what it drops

The record as a whole is capped too, at 256MB by default and wherever
`--record-cap` puts it. Reaching the cap evicts blobs rather than refusing to
capture: the oldest go first, where oldest means the least recently
*referenced*, because every request resends the whole conversation and a
system block first seen in turn one is still in use in turn fifty.

Nothing about that is silent. Every eviction is an event in the snapshot,
`storage` reports how many blobs and bytes have gone, and a skeleton whose
blob is no longer held reconstructs to a marked hole naming the address that
went — never a gap, which would read as a shorter conversation than the one
that happened, and never an error, which would lose the request along with the
unit. Eviction is per blob, so one runaway tool result can go while the
request that carried it stays readable.

Response events are not blobs and are held whole until there is a reassembler
to drop them, so a session whose responses alone exceed the cap will sit above
it with nothing left to evict. `storage` states the cap beside the size, so
that is visible rather than assumed.

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

The browser receives one authoritative snapshot and then live, ordered changes
on the same event stream. A request therefore appears when it starts and its
row advances through response activity and completion without a refresh.
Opening late or reconnecting starts again from a fresh snapshot, and a viewer
that falls behind is disconnected rather than being allowed to delay capture
or the agent.

Run several sessions at once by giving each its own UI port, and move the
record's ceiling with `--record-cap`, which takes bytes or a size:

```sh
tap launch --port 8271 --record-cap 512MB claude
```

Tap reads its own options only in front of the agent name; everything from
`claude` onwards belongs to the agent.

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
