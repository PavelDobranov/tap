# Two test seams, and the line between them

The test suite has two seams, not one. The built `tap` executable is the seam
for anything whose subject is the process; starting Tap's modules in-process is
the seam for anything whose subject is the record or the viewer. Both are
sanctioned, and what decides between them is the subject of the test, never the
convenience of the author.

This is recorded because the suite's own helper said the opposite — that the
executable is *"the one seam the test suite uses"* — while four test files were
already starting the record in-process, one of them wiring the record, the UI
server, the proxy and a capture together by hand and reaching the frozen phase
by fabricating an agent exit. The comment described an intention; the suite had
outgrown it. A reader who believed the comment would conclude that naming the
in-process seam was a new departure, when it was a decision already taken in
four places and never written down.

## The line

**The executable seam** carries everything that is true of Tap only because it
is a process: the agent owning the terminal with Tap silent on it (ADR-0006),
the SIGINT hold and the group hand-over to a frozen session, an agent missing
from `PATH`, an unsupported configuration refused before any port is bound,
exit codes, and packaging.

**The in-process seam** carries everything whose subject is the record or the
viewer: eviction and the cap, blob interning and addressing, thread and turn
derivation, what a snapshot contains, what a viewer receives and when it is
disposed. None of that is process-shaped. Spawning a process to observe it buys
nothing, and costs the ten-second waits and stderr-matching that observing a
process through its own output requires.

The test asks what its subject is. If the answer is "the record", it does not
spawn.

## Considered options

**Delete the in-process usage and push those four files out through the
executable.** Rejected. It would make every assertion about eviction, turns and
evidence pay for a spawn, a port, a fake agent and a freeze it has no interest
in, and it would express properties of an in-memory data structure as regular
expressions over an English sentence. It is also the option the suite has
already declined four times in practice.

**Keep the in-process usage unnamed.** Rejected, and this is the status quo the
ADR ends. Unnamed, the seam is rebuilt by hand at each site, which is why one
of them reaches the frozen phase by forging an agent exit — the real transition
being a single line inside a function that also spawns a process and then never
returns.

## Consequences

The in-process seam never exercises the spawn. Nothing that happens only when
Tap hands a real agent a real terminal is covered by it, which is why the
executable seam keeps the list above rather than shrinking to packaging alone.

Two ways to start a session could drift, with the in-process one passing while
the real one breaks. The guard is not a third test but a constraint on the
shape of the code: the `launch` command holds no lifecycle logic of its own.
The bind order, the Enter gate, the SIGINT hold and the two servers' opposite
lifetimes live inside the Tap session module, so both adapters inherit them and
there is nothing for them to disagree about. If that constraint is ever
relaxed — if `launch` grows an ordering rule the session module does not have —
this decision stops being safe and should be revisited rather than worked
around.

The helper's comment has been amended to describe the suite as it is.
