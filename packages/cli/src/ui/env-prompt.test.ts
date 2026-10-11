import { describe, expect, it } from "vitest";
import { CANCEL, ScriptedPrompts } from "./__fixtures__/harness";
import { createEnvPrompt } from "./env-prompt";

const question = (localValueAvailable: boolean, secret = true) => ({
  name: "STRIPE_SECRET_KEY",
  secret,
  localValueAvailable,
});

describe("createEnvPrompt", () => {
  it("offers the local .env value and returns the choice", async () => {
    const prompts = new ScriptedPrompts(["use-local", "skip"]);
    const ask = createEnvPrompt(prompts);
    expect(await ask(question(true))).toEqual({ useLocal: true });
    expect(await ask(question(true))).toEqual({ skip: true });
    expect(prompts.calls[0]?.options?.map((o) => o.value)).toEqual(["use-local", "type", "skip"]);
  });

  it("asks secrets with the masked prompt and plain values with text; empty skips", async () => {
    const masked: string[] = [];
    const prompts = new ScriptedPrompts(["type", "plain-value", ""]);
    const ask = createEnvPrompt(prompts, async ({ message }) => {
      masked.push(message);
      return "typed-secret";
    });
    expect(await ask(question(true))).toEqual({ value: "typed-secret" });
    expect(masked).toEqual(["Production value for STRIPE_SECRET_KEY (leave empty to skip)"]);
    expect(await ask(question(false, false))).toEqual({ value: "plain-value" });
    expect(await ask(question(false, false))).toEqual({ skip: true });
  });

  it("stops with a refusal when the user cancels", async () => {
    const ask = createEnvPrompt(new ScriptedPrompts([CANCEL]));
    await expect(ask(question(false))).rejects.toMatchObject({ code: "APPROVAL_REFUSED" });
  });
});
