import { ScriptedRunner } from "../../testing";

const SHA = "a".repeat(40);

/**
 * git whose `origin` (acme/shop on GitHub) has `branches`: `ls-remote --heads <url> <ref>` lists the
 * ref when the branch is one of them, and every ref asked is recorded in `asked`. Any other
 * command succeeds with no output. Tests only.
 */
export function remoteWith(branches: readonly string[]): ScriptedRunner & { asked: string[] } {
  const asked: string[] = [];
  const runner = new ScriptedRunner((_command, args) => {
    if (args.includes("get-url")) {
      return { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" };
    }
    if (args.includes("ls-remote")) {
      const ref = args.at(-1) ?? "";
      asked.push(ref);
      const listed = branches.some((branch) => ref === `refs/heads/${branch}`);
      return { exitCode: 0, stdout: listed ? `${SHA}\t${ref}\n` : "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  return Object.assign(runner, { asked });
}
