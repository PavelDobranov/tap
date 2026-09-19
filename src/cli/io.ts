/** The CLI's output and exit-code contract, shared by the entry point and every command. */
export interface Io {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

/** Exit codes. Usage errors are distinguished from a command that ran and failed. */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
