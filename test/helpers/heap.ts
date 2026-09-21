import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

/**
 * Runs a full collection, so a test can ask what is still *held* rather than
 * what has merely been allocated. Two properties need that distinction — a
 * blob must not pin the payload it was read out of, and serving a snapshot
 * must not hold the record — and neither can be seen from any assertion about
 * shape.
 *
 * The flag is turned back off afterwards: it is exposed for this call only,
 * not for whatever the rest of the file does.
 */
export function collectGarbage(): void {
  setFlagsFromString("--expose-gc");
  try {
    (runInNewContext("gc") as () => void)();
  } finally {
    setFlagsFromString("--no-expose-gc");
  }
}
