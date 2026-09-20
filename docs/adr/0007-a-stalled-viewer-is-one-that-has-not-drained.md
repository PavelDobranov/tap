# A stalled viewer is one that has not drained

A viewer is disposed when the bytes its socket is still holding pass a ceiling,
measured before each write. It is not disposed because `write` returned false.
The two are easy to confuse — the second is what "backpressure" means in Node,
and it is the rule #20 originally asked for in prose — but they describe
different things, and only one of them is a viewer that has stopped reading.

`write` returning false says the last write passed the stream's high-water
mark, which defaults to 16 KB. One ordinary captured response event does that
on its own. Implementing the literal rule meant every viewer was dropped by the
first event over about sixteen kilobytes and none of them ever saw it: an
attentive viewer reading continuously was killed by a single 64 KB event. That
makes Tap's headline behaviour — watching a busy agent live — fail exactly when
the record gets interesting, and it makes #20's own criterion *"multiple
viewers receive the same live record independently"* unsatisfiable. What
actually distinguishes a viewer worth keeping is whether it drained what it was
already sent, so that is what is measured, and it is measured before the write
rather than after, because checking after would dispose an attentive viewer for
the one large blob it asked for and had every chance of reading.

The same reasoning produced the opening hold. A record changes many times in
the time one snapshot takes to write, so disposing on any change that landed
mid-snapshot meant a record busy enough to be worth watching could never finish
opening: five connections in a row died mid-snapshot against a record ticking
every twenty milliseconds. Deltas arriving during the opening frame are now
held in order under the same ceiling and flushed the moment the snapshot is
out.

## Consequences

Every load-bearing property of the original rule survives. `send` never awaits,
so a viewer can never delay capture; disposal is per-connection; a disposed
viewer re-snapshots and nothing is replayed to it. What changed is the
threshold, not the guarantee.

The cost is that bytes are retained where the prose said none would be. A
viewer's socket buffer is bounded by the ceiling, and during the opening frame
one connection additionally holds up to that ceiling above the socket. The hold
is the opposite of a catch-up buffer: it lives only until the snapshot has
landed, and a viewer that overruns it is disposed to re-snapshot rather than
being caught up.

Whether re-snapshotting converges under sustained publication is not settled by
this decision and is tracked separately in #24. If it does not, the answer is a
convergence property rather than a larger ceiling, since raising the number
moves the threshold without removing the loop.

The literal rule remains available and is what a reader coming from #20's
original wording will expect. Restoring it means accepting that the
multiple-viewers and live-UI criteria cannot all hold, so the acceptance
criteria would have to be amended rather than the code. #20's prose has been
amended to match this decision.
