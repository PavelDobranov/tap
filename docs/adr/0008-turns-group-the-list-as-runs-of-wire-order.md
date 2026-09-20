# Turns group the list as runs of wire order

A turn is derived at capture, once, and travels on the request as a number
beside its thread. The UI groups the list by it and can be told to stop. Three
things about that grouping were decided while implementing #22, and none of
them are obvious from the rule in `CONTEXT.md`.

**The derivation is the server's, not the page's.** The rule reads the final
message of a request, and the page has the payload only as a skeleton whose
units may have been evicted: a turn derived in the browser would change when
the record came under its cap, and two viewers of one record could read
different turns from it. Deriving once, from the payload as it was captured,
also means a reload and a live stream agree by construction rather than by two
copies of a rule staying in step.

**A divider marks a run, not a turn.** Requests of one turn need not be
adjacent on the wire: two threads interleave, a `count_tokens` lands
mid-loop, and a filter can hide a member. Grouping is forbidden to reorder the
list, so a turn picked up again after something else gets a second divider,
marked `resumed`, and each divider counts only what is under it. The
alternative — gathering a turn's requests under one heading — would mean
moving rows out of wire order, which is the one thing the list is for.

**A `count_tokens` request is ungrouped.** It repeats a thread's messages to
ask what they cost, so it has a thread but is not work the prompt set off, and
giving it a turn would inflate every count a divider shows. It neither joins a
turn nor advances the count, and shows up between the dividers as itself.

## Consequences

Turn numbering is in the snapshot, so it is part of what the UI's documented
interface promises and something a later reader of the record can rely on. The
cost is that the record now carries an inference it did not before; it is
inert — nothing in capture, storage or eviction reads it — and a viewer can
switch the grouping off entirely and get the flat wire-order list back.

A wrong inference costs a misplaced divider. A compaction that looks
turn-initial opens a turn that no one asked for, and a prompt queued during a
tool loop does not open one at all. Both stay: the evidence to tell either from
the ordinary case is not on the wire, and the grouping is labelled inferred
precisely so that a reader treats a divider as a reading aid rather than as a
fact the record is asserting.

Folding is per viewer and keyed by thread and turn, so folding a turn read in
two runs folds both. Nothing about folding or filtering changes what a request
belongs to, and the counts line says how many requests are hidden behind a
filter and how many are folded away, because a list that quietly holds
something back is the failure this whole surface is built to avoid.
