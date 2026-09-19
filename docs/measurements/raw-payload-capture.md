# What capture costs in memory

Baseline for #14, and the number #15 (content-addressed payload storage) had to
beat. The second table is #15 measured against it. Taken with
`scripts/measure-capture-baseline.mjs` on Linux, Node 24, reading `VmHWM` —
the high-water mark of the resident set — off the `tap`
process once the Tap session had frozen.

Every `/v1/messages` request resends the whole conversation, so a record that
holds payloads verbatim grows with the square of the conversation length. The
measurement replays a scripted multi-turn conversation rather than a live
Claude Code one: 20 tools and a system block totalling ~52 KB resent every
time, two requests per turn, and a history growing by roughly 18 KB of message and tool
result per turn. The dimensions are the order of magnitude a real conversation
shows; the numbers below are what Tap's *capture* costs for traffic of that
shape, which is the part #15 changes.

| Turns | Requests | Request payload forwarded | Peak RSS | Cost of capture | Per byte forwarded |
| ----- | -------- | ------------------------- | -------- | --------------- | ------------------ |
| 0     | 0        | 0                         | 67.5 MiB  | —               | —                  |
| 20    | 40       | 9.0 MiB                   | 95.8 MiB  | 28.3 MiB        | 3.2x               |
| 40    | 80       | 31.8 MiB                  | 142.7 MiB | 75.3 MiB        | 2.4x               |
| 80    | 160      | 118.9 MiB                 | 285.8 MiB | 218.2 MiB       | 1.8x               |

Two things to read off it.

**The growth is quadratic in turns, as predicted.** Doubling the turn count
roughly quadruples both the bytes forwarded and the memory held: 9 → 32 → 119
MiB of payload across 20 → 40 → 80 turns. Nothing here is a surprise; it is
recorded so that #15 can be held to a materially sub-linear curve on the same
script rather than on an impression.

**Capture costs more than the bytes it holds**, roughly 1.8–3.2x. Payloads are
held as JavaScript strings, which are two bytes per character for this content,
and the constant overhead of the idle process and the per-request entries
dominate at small sizes. The ratio falls as the conversation grows because the
fixed ~67 MiB floor is amortised. So the figure to compare against is the
*cost of capture* column, not peak RSS.

An 80-turn conversation against a large context is not unusual, and 286 MiB
for one is the argument for #15 in a line.

## After content-addressed storage (#15)

Same script, same shape, same machine, so the two tables are the same
measurement. The script now also reads the snapshot's `storage` before the
session is interrupted, which is where the last three columns come from.

| Turns | Requests | Request payload forwarded | Peak RSS | Cost of capture | Payload held | Blobs | Deduplication |
| ----- | -------- | ------------------------- | --------- | --------------- | ------------ | ----- | ------------- |
| 0     | 0        | 0                         | 67.3 MiB  | —               | —            | —     | —             |
| 20    | 40       | 9.0 MiB                   | 99.2 MiB  | 31.7 MiB        | 0.4 MiB      | 43    | 30.2x         |
| 40    | 80       | 31.8 MiB                  | 137.0 MiB | 69.5 MiB        | 0.7 MiB      | 83    | 60.2x         |
| 80    | 160      | 118.9 MiB                 | 180.2 MiB | 112.8 MiB       | 1.4 MiB      | 163   | 120.2x        |

**The record is no longer quadratic; it is barely there.** 118.9 MiB of payload
forwarded is held in 1.4 MiB, because 19,600 referenced units are 163 distinct
ones. The held figure grows linearly with the conversation — 0.4 → 0.7 → 1.4
MiB across 20 → 40 → 80 turns — which is the curve the scheme promised.
Blob count is 163 against 19,600 units for the same reason.

**Peak RSS falls by half at 80 turns, and no further, because what is left is
not the record.** The cost of capture drops 218.2 → 112.8 MiB, and the growth
in it is now roughly linear in turns rather than quadratic: doubling the turns
multiplied it by 2.2 and then 1.6, against 3.5 and 3.7 for the bytes forwarded.
What remains is transient rather than held — each request's body is decoded to
a string and parsed once for its model, and at 80 turns that body is 1.5 MB, so
the high-water mark tracks the garbage created reading a request rather than
anything the record keeps. Shrinking it further means reading less per request,
not holding less, and that is a separate piece of work.

For the record itself, the number to read is **payload held**: 1.4 MiB where
verbatim capture held 118.9 MiB.

### One thing this measurement caught

The first run of this table showed 214.5 MiB — no improvement at all — while
reporting the same 1.4 MiB held. A substring in V8 is a *slice* that keeps the
string it was cut from alive, so every blob taken out of a payload was pinning
that entire payload: the record deduplicated perfectly and freed nothing. Blobs,
skeleton text and cut annotations are now detached from the payload they were
read out of, and `test/blobs.test.ts` measures the heap to keep it that way.
The scheme is worth exactly nothing without it, and nothing about the shape of
a skeleton reveals it, which is why the measurement is part of the ticket
rather than a footnote to it.

## Redoing this against real traffic

The scripted conversation is a stand-in for the shape, not for the traffic. To
take the same number from a real Claude Code conversation, start a Tap session,
work in it normally, and read the high-water mark off the live `tap` process
before interrupting it:

```
tap launch claude          # in one terminal
pgrep -f 'dist/cli.js launch'
node scripts/measure-capture-baseline.mjs --pid <pid>
```

That is #18, and it is still open. Deduplication is precisely the thing that
behaves differently on real traffic than on `"x".repeat(...)` filler — repeated
tool schemas and a stable system block are what it exploits, and moving cache
breakpoints are what it has to survive — so the 120x above is the shape of the
script as much as of the scheme. The two tables are comparable to each other;
neither is yet a claim about a real conversation.
