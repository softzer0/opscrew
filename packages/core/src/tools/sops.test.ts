import type { CommandOptions, CommandResult, CommandRunner } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { generateAgeIdentity } from "../crypto/age";
import { NodeCommandRunner } from "../exec";
import { Redactor } from "../redact";
import { fakeSecret } from "../testing";
import { sopsDecrypt, sopsEncrypt } from "./sops";

const BIN = "/cache/sops";
const FILENAME = "opscrew/secrets.sops.json";

interface Call {
  command: string;
  args: readonly string[];
  options: CommandOptions;
}

function fakeExec(result: Partial<CommandResult>): { exec: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    exec: {
      async run(command, args, options = {}) {
        calls.push({ command, args, options });
        return { exitCode: 0, stdout: "", stderr: "", ...result };
      },
    },
  };
}

async function failure(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string; hint?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; hint?: string };
  }
  throw new Error("expected a failure");
}

describe("sopsEncrypt", () => {
  it("passes the plaintext only on stdin, with the arguments of the contract", async () => {
    const secret = fakeSecret("generic-password");
    const plaintext = JSON.stringify({ "home/generated_values.json": secret });
    const { exec, calls } = fakeExec({ stdout: '{"sops":{}}' });
    const recipients = [generateAgeIdentity().recipient, generateAgeIdentity().recipient];
    const env = { PATH: "/usr/bin" };
    const out = await sopsEncrypt(
      BIN,
      { plaintext, recipients, filename: FILENAME },
      { exec, redactor: new Redactor(), env },
    );
    expect(out).toBe('{"sops":{}}');
    expect(calls).toHaveLength(1);
    const [call] = calls as [Call];
    expect(call.command).toBe(BIN);
    expect(call.args).toEqual([
      "encrypt",
      "--input-type",
      "json",
      "--output-type",
      "json",
      "--filename-override",
      FILENAME,
      "--age",
      recipients.join(","),
    ]);
    expect(call.options.input).toBe(plaintext);
    expect(call.options.env).toEqual(env);
    expect(JSON.stringify(call.args)).not.toContain(secret);
  });

  it("fails plainly, with sops's message redacted", async () => {
    const secret = fakeSecret("generic-password");
    const redactor = new Redactor();
    redactor.addLiteral(secret, "app-env");
    const { exec } = fakeExec({ exitCode: 1, stderr: `could not encode ${secret}\n` });
    const error = await failure(
      sopsEncrypt(
        BIN,
        { plaintext: "{}", recipients: ["age1x"], filename: FILENAME },
        { exec, redactor, env: {} },
      ),
    );
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toMatch(
      /^sops could not encrypt opscrew\/secrets\.sops\.json \(could not encode \[REDACTED/,
    );
    expect(error.message).not.toContain(secret);
  });
});

describe("sopsDecrypt", () => {
  it("gives the identity only in SOPS_AGE_KEY and the file only on stdin, and registers what it decrypts", async () => {
    const { identity } = generateAgeIdentity();
    const secret = fakeSecret("generic-password");
    const nested = fakeSecret("hcloud-token");
    const plaintext = JSON.stringify({
      "home/generated_values.json": secret,
      nested: { list: [nested] },
    });
    const { exec, calls } = fakeExec({ stdout: plaintext });
    const redactor = new Redactor();
    const encrypted = '{"data":"ENC[AES256_GCM,data:abc]","sops":{}}';
    const out = await sopsDecrypt(
      BIN,
      { encrypted, identity: `${identity}\n`, filename: FILENAME },
      { exec, redactor, env: { PATH: "/usr/bin" } },
    );
    expect(out).toBe(plaintext);
    const [call] = calls as [Call];
    expect(call.args).toEqual([
      "decrypt",
      "--input-type",
      "json",
      "--output-type",
      "json",
      "--filename-override",
      FILENAME,
    ]);
    expect(call.options.input).toBe(encrypted);
    expect(call.options.env).toEqual({ PATH: "/usr/bin", SOPS_AGE_KEY: identity });
    expect(JSON.stringify(call.args)).not.toContain(identity);

    const shown = redactor.redact(`key ${identity} values ${secret} ${nested}`);
    for (const value of [identity, secret, nested]) expect(shown).not.toContain(value);
  });

  it("maps a rejected key to SECRETS_KEY_REJECTED, without the key", async () => {
    const { identity } = generateAgeIdentity();
    const { exec } = fakeExec({
      exitCode: 128,
      stderr: "Error getting data key: 0 successful groups required, got 0\n",
    });
    const redactor = new Redactor();
    const error = await failure(
      sopsDecrypt(
        BIN,
        { encrypted: "{}", identity, filename: FILENAME },
        { exec, redactor, env: {} },
      ),
    );
    expect(error.code).toBe("SECRETS_KEY_REJECTED");
    expect(error.message).toBe(
      "The age key cannot open opscrew/secrets.sops.json: it is not one of the keys the file was encrypted to.",
    );
    expect(`${error.message} ${error.hint}`).not.toContain(identity);
    expect(redactor.redact(identity)).not.toContain(identity);
  });

  it("fails plainly on other errors and on output that is not JSON, without the output", async () => {
    const { identity } = generateAgeIdentity();
    const broken = fakeExec({ exitCode: 51, stderr: `MAC mismatch for ${identity}` });
    const error = await failure(
      sopsDecrypt(
        BIN,
        { encrypted: "{}", identity, filename: FILENAME },
        { exec: broken.exec, redactor: new Redactor(), env: {} },
      ),
    );
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toMatch(
      /^sops could not decrypt opscrew\/secrets\.sops\.json \(MAC mismatch/,
    );
    expect(error.message).not.toContain(identity);

    const secret = fakeSecret("generic-password");
    const notJson = fakeExec({ stdout: `data: ${secret}` });
    const parse = await failure(
      sopsDecrypt(
        BIN,
        { encrypted: "{}", identity, filename: FILENAME },
        { exec: notJson.exec, redactor: new Redactor(), env: {} },
      ),
    );
    expect(parse.message).toBe("sops did not return JSON for opscrew/secrets.sops.json.");
  });
});

describe("the sops child's environment", () => {
  it("never passes a SOPS_* variable from the caller's environment, on encrypt or decrypt", async () => {
    const { identity, recipient } = generateAgeIdentity();
    const env = {
      PATH: "/usr/bin",
      SOPS_PGP_FP: "FAKE-PGP-FINGERPRINT",
      SOPS_AGE_KEY_FILE: "/home/u/.config/sops/age/keys.txt",
      SOPS_AGE_KEY: "AGE-SECRET-KEY-OTHER",
    };
    const { exec, calls } = fakeExec({ stdout: "{}" });
    const deps = { exec, redactor: new Redactor(), env };
    await sopsEncrypt(BIN, { plaintext: "{}", recipients: [recipient], filename: FILENAME }, deps);
    await sopsDecrypt(BIN, { encrypted: "{}", identity, filename: FILENAME }, deps);
    expect(calls.map((call) => call.options.env)).toEqual([
      { PATH: "/usr/bin" },
      { PATH: "/usr/bin", SOPS_AGE_KEY: identity },
    ]);
  });
});

const SOPS = process.env.OPSCREW_SOPS_BIN;
if (!SOPS) console.warn("OPSCREW_SOPS_BIN is not set: skipping the round trip through real sops.");

describe.skipIf(!SOPS)("real sops", () => {
  const deps = () => ({
    exec: new NodeCommandRunner(),
    redactor: new Redactor(),
    env: process.env,
  });

  it("encrypts to two recipients, decrypts with either key, and rejects another key", async () => {
    const main = generateAgeIdentity();
    const backup = generateAgeIdentity();
    const secret = fakeSecret("generic-password");
    const plaintext = JSON.stringify({
      "home/generated_values.json": secret,
      "state/server.json": "{}",
    });
    const encrypted = await sopsEncrypt(
      SOPS as string,
      { plaintext, recipients: [main.recipient, backup.recipient], filename: FILENAME },
      deps(),
    );
    expect(encrypted).not.toContain(secret);
    const parsed = JSON.parse(encrypted) as { sops: { age: { recipient: string }[] } };
    expect(parsed.sops.age.map((a) => a.recipient).sort()).toEqual(
      [main.recipient, backup.recipient].sort(),
    );
    expect(Object.keys(parsed)).toContain("home/generated_values.json");

    for (const { identity } of [main, backup]) {
      const out = await sopsDecrypt(
        SOPS as string,
        { encrypted, identity, filename: FILENAME },
        deps(),
      );
      expect(JSON.parse(out)).toEqual(JSON.parse(plaintext));
    }
    const error = await failure(
      sopsDecrypt(
        SOPS as string,
        { encrypted, identity: generateAgeIdentity().identity, filename: FILENAME },
        deps(),
      ),
    );
    expect(error.code).toBe("SECRETS_KEY_REJECTED");
  }, 60_000);
});
