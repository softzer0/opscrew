import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { CANCEL, ScriptedPrompts } from "./__fixtures__/harness";
import { createStorageKeyPrompt } from "./storage-key-prompt";

const question = {
  provider: "Hetzner Object Storage",
  bucket: "shop-uploads",
  steps: ["Open the console.", "Generate credentials."],
};

describe("createStorageKeyPrompt", () => {
  it("shows the console steps, then asks for both parts of the key with masked prompts only", async () => {
    const id = fakeSecret("aws-access-key-id", "prompt");
    const secret = fakeSecret("aws-secret-access-key", "prompt");
    const prompts = new ScriptedPrompts([id, secret]);
    const printed: string[] = [];
    const ask = createStorageKeyPrompt(prompts, (text) => printed.push(text));
    expect(await ask(question)).toEqual({ accessKeyId: id, secretAccessKey: secret });
    expect(prompts.calls).toEqual([
      { kind: "password", message: "Access key ID" },
      { kind: "password", message: "Secret access key" },
    ]);
    const shown = printed.join("");
    expect(shown).toContain("Create a key for the bucket shop-uploads on Hetzner Object Storage:");
    expect(shown).toContain("  1. Open the console.\n  2. Generate credentials.");
    // Nothing typed is ever echoed.
    expect(shown).not.toContain(id);
    expect(shown).not.toContain(secret);
  });

  it("stops plainly when the user cancels", async () => {
    const ask = createStorageKeyPrompt(new ScriptedPrompts([CANCEL]), () => undefined);
    await expect(ask(question)).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: "You cancelled entering the bucket's key.",
    });
  });
});
