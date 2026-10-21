import type { CommandOptions, CommandResult, CommandRunner } from "@opscrew/contracts";
import { ageRecipientOf } from "@opscrew/core";

/** The command name tests put in `OPSCREW_SOPS_BIN`, answered by {@link FakeSops}. */
export const FAKE_SOPS = "fake-sops";

/** One sops run: its arguments, stdin and environment. */
export interface SopsCall {
  args: string[];
  input?: string;
  env?: Record<string, string | undefined>;
}

/**
 * sops for tests: `encrypt` seals stdin's JSON for the `--age` recipients and prints a sops-shaped
 * file whose values hide the plaintext; `decrypt` opens such a file only with an identity of a
 * recipient (`SOPS_AGE_KEY`), else exits 128 as sops does. Every run is recorded.
 */
export class FakeSops {
  readonly calls: SopsCall[] = [];
  private readonly sealed = new Map<string, { plaintext: string; recipients: string[] }>();

  /** `base` with {@link FAKE_SOPS} answered by this fake. */
  runner(base: CommandRunner): CommandRunner {
    return {
      run: async (command, args, options) =>
        command === FAKE_SOPS ? this.run([...args], options) : base.run(command, args, options),
    };
  }

  private run(args: string[], options: CommandOptions = {}): CommandResult {
    this.calls.push({
      args,
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
    const input = options.input ?? "";
    if (args[0] === "encrypt") {
      const recipients = (args[args.indexOf("--age") + 1] ?? "").split(",");
      const id = `fake-${this.sealed.size + 1}`;
      this.sealed.set(id, { plaintext: input, recipients });
      const { files } = JSON.parse(input) as { files: Record<string, string> };
      const sealed = Object.fromEntries(
        Object.keys(files).map((path, i) => [path, `ENC[AES256_GCM,data:${id}-${i},type:str]`]),
      );
      const sops = {
        age: recipients.map((recipient) => ({ recipient, enc: `sealed for ${recipient}` })),
        lastmodified: "2026-10-21T10:00:00Z",
        mac: id,
        version: "3.13.3",
      };
      return { exitCode: 0, stdout: `${JSON.stringify({ files: sealed, sops }, null, 2)}\n`, stderr: "" };
    }
    const { sops } = JSON.parse(input) as { sops: { mac: string } };
    const entry = this.sealed.get(sops.mac);
    const key = options.env?.SOPS_AGE_KEY;
    if (entry === undefined || key === undefined || !entry.recipients.includes(ageRecipientOf(key))) {
      return {
        exitCode: 128,
        stdout: "",
        stderr: "Error getting data key: 0 successful groups required, got 0\n",
      };
    }
    return { exitCode: 0, stdout: entry.plaintext, stderr: "" };
  }
}
