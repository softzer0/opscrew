// Feature 025 (T2521): one approval request, bound to its hash, with the refusal it says.
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../testing";
import { PlanRefusedError, requestApproval } from "./approvals";

const HASH = "a".repeat(64);

describe("requestApproval", () => {
  it("asks a remote-exec approval bound to the hash, with the typed name, and returns it", async () => {
    const handler = new ScriptedApprovalHandler(() => ({ approved: true, confirmation: "shop" }));
    const deps = await createTestPhaseDeps({ approvalHandler: handler });
    const approval = await requestApproval(deps, {
      title: "Rotate the credentials of db in prod",
      details: "the plan",
      hash: HASH,
      guard: { allowDestroy: true, confirmPhrase: "shop" },
      refused: {
        plan: "rotation of db",
        unchanged: "Nothing was changed.",
        again: "opscrew rotate db",
      },
    });
    expect(approval).toMatchObject({ approved: true, kind: "remote-exec", planHash: HASH });
    expect(handler.requests).toEqual([
      {
        kind: "remote-exec",
        title: "Rotate the credentials of db in prod",
        details: "the plan",
        planHash: HASH,
        allowDestroy: true,
        confirmPhrase: "shop",
      },
    ]);
  });

  it("throws the refusal, naming the hash for a script unless it is not one's", async () => {
    const deps = await createTestPhaseDeps({
      approvalHandler: new ScriptedApprovalHandler(() => false),
    });
    const ask = {
      title: "Rotate the token",
      details: "the plan",
      hash: HASH,
      refused: {
        plan: "rotation of db",
        unchanged: "Nothing was changed.",
        again: "opscrew rotate db",
      },
    };
    const refused = await requestApproval(deps, ask).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PlanRefusedError);
    expect(refused).toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringMatching(
        /^The rotation of db was not approved.* Nothing was changed\.$/,
      ),
      hint: `Run \`opscrew rotate db\` again when you are ready (in a script: --approve ${HASH}).`,
    });
    const unscripted = await requestApproval(deps, {
      ...ask,
      refused: { ...ask.refused, scripted: false },
    }).catch((e: unknown) => e);
    expect(unscripted).toMatchObject({ hint: "Run `opscrew rotate db` again when you are ready." });
  });
});
