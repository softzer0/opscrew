/** Thrown by a command to end the process with `exitCode` after it has printed its own output. */
export class CliExit extends Error {
  constructor(readonly exitCode: number) {
    super(`exit ${exitCode}`);
    this.name = "CliExit";
  }
}
