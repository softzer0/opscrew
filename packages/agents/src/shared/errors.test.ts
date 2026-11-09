// Feature 025 (T2521): an error continued with what stays true after it and the way on.
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { continued } from "./errors";

describe("continued", () => {
  it("adds what stays true to the message and the next step after the error's own hint", () => {
    const error = new OpsCrewError("COMMAND_FAILED", "The server did not answer.  ", {
      hint: "Check that it is on.",
    });
    const next = continued(error, { said: "The values stay here.", next: "Then run it again." });
    expect(next).toMatchObject({
      code: "COMMAND_FAILED",
      message: "The server did not answer. The values stay here.",
      hint: "Check that it is on. Then run it again.",
      cause: error,
    });
  });

  it("starts the hint with `fallback` when the error has none, and leaves other errors as they are", () => {
    const error = new OpsCrewError("PHASE_PRECONDITION", "It stopped.");
    expect(
      continued(error, { said: "So it waits.", next: "Then go on.", fallback: "Fix it. " }),
    ).toMatchObject({ code: "PHASE_PRECONDITION", hint: "Fix it. Then go on." });
    expect(continued(error, { said: "", next: "Then go on." })).toMatchObject({
      hint: "Then go on.",
    });
    const bug = new TypeError("x is undefined");
    expect(continued(bug, { said: "", next: "" })).toBe(bug);
  });
});
