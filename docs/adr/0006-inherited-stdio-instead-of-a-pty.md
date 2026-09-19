# Inherited stdio instead of a PTY

Tap spawns the agent with its stdio inherited: the agent gets Tap's real
terminal file descriptors, and Tap relays nothing. The alternative — allocating
a PTY and shuttling bytes between it and the terminal — is rejected.

A PTY would be the obvious choice for a tool that wanted the agent's *terminal
output*. Tap does not want it. What Tap records is the traffic between the
agent and the provider, which it sees at the proxy; the rendered transcript
adds nothing the record does not already hold, and reconstructing it means
parsing a live-updating TUI's escape sequences. Against that, every PTY library
on npm is a native module, and a native module is the install fragility this
project exists without: `npm i -g tap` must never compile anything.

Inheriting also gets fidelity for free. Colours, raw mode, keyboard input,
resize and job control are the terminal's, not something Tap re-implements
imperfectly — a developer cannot tell from the terminal that Tap is there.

## Consequences

Tap must be silent while the agent runs, because both write to the same
terminal and Tap has no way to place its own output. Anything Tap wants to say
about a live session goes to the UI; the terminal is the agent's until it
exits, after which Tap may speak.

Tap and the agent share a process group, so Ctrl+C reaches both. Tap ignores
SIGINT while the agent is running and lets the agent handle its own interrupt;
once the session is frozen, an interrupt ends Tap, which exits by re-raising
the signal so the shell sees an ordinary Ctrl+C death.

Tap cannot capture anything from the terminal, including the user's prompts and
the agent's rendered replies. Everything Tap knows comes from the wire.
