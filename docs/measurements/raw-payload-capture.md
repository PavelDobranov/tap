# What verbatim capture costs in memory

Baseline for #14, and the number #15 (content-addressed payload storage) has to
beat. Taken with `scripts/measure-capture-baseline.mjs` on Linux, Node 24,
reading `VmHWM` — the high-water mark of the resident set — off the `tap`
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
