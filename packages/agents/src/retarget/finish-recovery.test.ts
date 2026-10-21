import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExecutable, NodeCommandRunner } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { FAKE_SOPS, FakeSops } from "../secrets/__fixtures__/fake-sops";
import { refreshRecoveryCopy } from "../secrets/copy";
import { type MoveHarness, moveHarness, STRIPE, TOKENS } from "../testing";
import { everythingPrinted, run } from "./__fixtures__/assert";
import { finishRetarget } from "./finish";

const git = new NodeCommandRunner();
const COPY_FILES = ["opscrew/secrets.sops.json", "opscrew/.sops.yaml", ".gitattributes"];

/**
 * A move up to the switch, on a project whose recovery copy an earlier provision made and
 * committed (sops is the fake).
 */
async function switchedWithCopy(): Promise<{ h: MoveHarness; identity: string }> {
  const h = await moveHarness();
  const sops = new FakeSops();
  h.deps.runner = sops.runner(h.deps.runner);
  h.deps.env.OPSCREW_SOPS_BIN = FAKE_SOPS;
  await run(h);
  const keyFile = join(await mkdtemp(join(tmpdir(), "opscrew-move-keys-")), "age-key.txt");
  const made = await refreshRecoveryCopy(h.deps, h.plan, {
    repositoryPrivate: async () => true,
    keyOut: async () => keyFile,
  });
  if (!made.changed) throw new Error(`no copy: ${made.warning}`);
  for (const file of made.repositoryFiles) await writeFile(join(h.root, file.path), file.content);
  await git.run("git", ["-C", h.root, "add", ...COPY_FILES]);
  await git.run("git", ["-C", h.root, "commit", "-q", "-m", "the recovery copy"]);
  return { h, identity: (await readFile(keyFile, "utf8")).split("\n")[2] as string };
}

describe.skipIf(!findExecutable("git"))("finishRetarget and the recovery copy", () => {
  it("puts the updated copy in the final pull request", async () => {
    const { h, identity } = await switchedWithCopy();
    const before = await readFile(join(h.root, "opscrew/secrets.sops.json"), "utf8");

    const result = await finishRetarget(h.deps, { services: h.services, confirm: h.confirm });
    expect(result).toMatchObject({ step: "finished", done: true });
    const files = (
      await git.run("git", ["-C", h.root, "show", "--name-only", "--format=", "HEAD"])
    ).stdout.split(/\r?\n/);
    expect(files).toContain("opscrew/secrets.sops.json");
    expect(await readFile(join(h.root, "opscrew/secrets.sops.json"), "utf8")).not.toBe(before);
    expect(h.github.pulls.at(-1)?.body).toContain("`opscrew/secrets.sops.json`");
    const printed = everythingPrinted(h);
    for (const secret of [identity, STRIPE, ...Object.values(TOKENS)]) {
      expect(printed).not.toContain(secret);
    }
  });

  it("another computer's copy: the move is finished, and the next step is a restore first", async () => {
    const { h } = await switchedWithCopy();
    await writeFile(join(h.root, "opscrew/secrets.sops.json"), '{"files":{},"sops":{}}\n');
    await git.run("git", ["-C", h.root, "commit", "-q", "-am", "another computer's copy"]);
    const pulls = h.github.pulls.length;
    const head = (await git.run("git", ["-C", h.root, "rev-parse", "HEAD"])).stdout;

    const result = await finishRetarget(h.deps, { services: h.services, confirm: h.confirm });
    expect(result).toMatchObject({ step: "finished", done: true });
    expect(h.reporter.text()).toContain(
      "The move is finished, but publishing the final files failed: opscrew/secrets.sops.json in the repository is not the copy this computer last wrote",
    );
    expect(result.next[0]).toBe(
      "Run `opscrew secrets restore` first: it shows which files and generated values differ, by name only, and lets you choose which side to keep. Then commit the changed files under opscrew/ and open a pull request into main yourself, so the repository describes the new deployment.",
    );
    // Nothing was committed or opened over the other computer's copy.
    expect(h.github.pulls).toHaveLength(pulls);
    expect((await git.run("git", ["-C", h.root, "rev-parse", "HEAD"])).stdout).toBe(head);
  });
});
