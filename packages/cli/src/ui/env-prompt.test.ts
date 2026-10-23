import { describe, expect, it } from "vitest";
import { CANCEL, ScriptedPrompts } from "./__fixtures__/harness";
import { createEnvPrompt } from "./env-prompt";

/** prod's own local file. */
const PROD = { environment: "prod", localFile: ".env" };

const question = (localValueAvailable: boolean, secret = true) => ({
  name: "STRIPE_SECRET_KEY",
  secret,
  ...PROD,
  localValueAvailable,
});

describe("createEnvPrompt", () => {
  it("offers the local .env value and returns the choice", async () => {
    const prompts = new ScriptedPrompts(["use-local", "skip"]);
    const ask = createEnvPrompt(prompts);
    expect(await ask(question(true))).toEqual({ useLocal: true });
    expect(await ask(question(true))).toEqual({ skip: true });
    expect(prompts.calls[0]?.options?.map((o) => o.value)).toEqual(["use-local", "type", "skip"]);
    expect(prompts.calls[0]?.message).toBe("Production value for STRIPE_SECRET_KEY");
    expect(prompts.calls[0]?.options?.map((o) => o.label)).toEqual([
      "Use the value from your local .env",
      "Type a different value for production",
      "Leave it unset",
    ]);
  });

  it("names another environment and its own file, never production or .env", async () => {
    const prompts = new ScriptedPrompts(["type", "typed-secret", ""]);
    const ask = createEnvPrompt(prompts);
    const staging = { environment: "staging", localFile: ".env.staging" };
    expect(await ask({ ...question(true), ...staging })).toEqual({ value: "typed-secret" });
    expect(prompts.calls[0]?.message).toBe(
      "Value for STRIPE_SECRET_KEY in the staging environment",
    );
    expect(prompts.calls[0]?.options?.map((o) => o.label)).toEqual([
      "Use the value from your local .env.staging",
      "Type a different value for the staging environment",
      "Leave it unset",
    ]);
    expect(prompts.calls[1]?.message).toBe(
      "Value for STRIPE_SECRET_KEY in the staging environment (leave empty to skip)",
    );
    expect(await ask({ ...question(false), ...staging })).toEqual({ skip: true });
    expect(JSON.stringify(prompts.calls)).not.toMatch(/Production|local \.env"/);
  });

  it("asks secrets with the masked prompt and plain values with text; empty skips", async () => {
    const prompts = new ScriptedPrompts(["type", "typed-secret", "plain-value", ""]);
    const ask = createEnvPrompt(prompts);
    expect(await ask(question(true))).toEqual({ value: "typed-secret" });
    expect(prompts.calls[1]).toEqual({
      kind: "password",
      message: "Production value for STRIPE_SECRET_KEY (leave empty to skip)",
    });
    expect(await ask(question(false, false))).toEqual({ value: "plain-value" });
    expect(await ask(question(false, false))).toEqual({ skip: true });
    expect(prompts.calls.map((call) => call.kind)).toEqual(["select", "password", "text", "text"]);
  });

  it("says a variable with a default in the code is optional and keeps the default on empty", async () => {
    const prompts = new ScriptedPrompts(["", "skip"]);
    const ask = createEnvPrompt(prompts);
    const debug = { name: "DJANGO_DEBUG", secret: false, optional: true, ...PROD };
    expect(await ask({ ...debug, localValueAvailable: false })).toEqual({ skip: true });
    expect(prompts.calls[0]?.message).toBe(
      "Production value for DJANGO_DEBUG (optional: leave empty to keep the app's default)",
    );
    expect(await ask({ ...debug, localValueAvailable: true })).toEqual({ skip: true });
    expect(prompts.calls[1]?.message).toBe("Production value for DJANGO_DEBUG (optional)");
    expect(prompts.calls[1]?.options?.[2]?.label).toBe("Leave it unset and keep the app's default");
  });

  it("stops with a refusal when the user cancels", async () => {
    const ask = createEnvPrompt(new ScriptedPrompts([CANCEL]));
    await expect(ask(question(false))).rejects.toMatchObject({ code: "APPROVAL_REFUSED" });
  });
});
