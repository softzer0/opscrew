/** Offline checks of the rollback live test's pure helpers (`rollback-support.ts`). No network. */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { textTable } from "../../src/ui/output";
import type { CliRun } from "./harness";
import {
  listedVersions,
  neverAnswering,
  pauseEntryOf,
  RELEASE_COMMAND,
  RELEASE_MARKER,
  ROLLBACK_GATE,
  ROLLBACK_VARIABLES,
  rollbackApproval,
  runIdIn,
  shownRollback,
  statusDeploys,
} from "./rollback-support";
import { missingVariables } from "./support";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const A = { commit: hex(20), digest: `sha256:${hex(32)}` };
const B = { commit: hex(20), digest: `sha256:${hex(32)}` };
const C = { commit: hex(20), digest: `sha256:${hex(32)}` };
const HASH = hex(32);

/** A server rollback's output in a script, as the CLI prints it (no colours without a terminal). */
const SHOWN = [
  "◆ Reading prod's versions in GitHub Container Registry",
  `  Now: ${B.commit.slice(0, 7)} "e2e: change B", built 2026-11-01T10:20:00Z (${B.digest.slice(0, 19)})`,
  `Back to: ${A.commit.slice(0, 7)} "e2e: examples/nextjs-postgres", built 2026-11-01T10:00:00Z (${A.digest.slice(0, 19)})`,
  `Image: ghcr.io/owner/repo@${A.digest}, built by https://github.com/owner/repo/actions/runs/101`,
  `Rollback hash: ${HASH}`,
  "",
  "✗ The rollback was not approved (not interactive). Nothing was changed.",
  `  To roll back later without prompts, run: opscrew rollback --env prod --to ${A.digest} --approve ${HASH}`,
].join("\n");

describe("the rollback live test's helpers", () => {
  it("reads the rollback a script is asked to approve: the version, the hash, Now and Back to", () => {
    expect(rollbackApproval(SHOWN)).toEqual({
      to: A.digest,
      hash: HASH,
      now: `${B.commit.slice(0, 7)} "e2e: change B", built 2026-11-01T10:20:00Z (${B.digest.slice(0, 19)})`,
      backTo: `${A.commit.slice(0, 7)} "e2e: examples/nextjs-postgres", built 2026-11-01T10:00:00Z (${A.digest.slice(0, 19)})`,
    });
  });

  it("reads a site's rollback, also with --allow-old-secrets, and the last command printed", () => {
    const other = hex(32);
    const output = [
      `run: opscrew rollback --env prod --to 4f1c --approve ${other}`,
      `To roll back later without prompts, run: opscrew rollback --app web --env prod --to 9a8b7c --allow-old-secrets STRIPE_SECRET_KEY,OTHER --approve ${HASH}`,
    ].join("\n");
    expect(rollbackApproval(output)).toEqual({ to: "9a8b7c", hash: HASH });
  });

  it("finds no rollback in an output without the printed command", () => {
    expect(rollbackApproval(`Rollback hash: ${HASH}`)).toBeUndefined();
    expect(rollbackApproval(`opscrew promote --to prod --approve ${HASH}`)).toBeUndefined();
  });

  it("reads the run an output names last", () => {
    expect(
      runIdIn(
        "built by https://github.com/o/r/actions/runs/101\nRolled prod back: https://github.com/o/r/actions/runs/202\n",
      ),
    ).toBe(202);
    expect(runIdIn("no run here")).toBeUndefined();
  });

  it("reads rollback --list's table by its columns, newest first, with the marks", () => {
    const row = (version: typeof A, marks: string, message: string) => [
      version.digest.slice(0, 19),
      version.commit.slice(0, 7),
      "2026-11-01 10:00 UTC",
      marks,
      message,
    ];
    // As `opscrew rollback --list` prints its table.
    const table = textTable([
      ["Version", "Commit", "Built", "Mark", "Message"],
      row(C, "", "e2e: change C"),
      row(B, "previous", "e2e: change B"),
      row(A, "running", ""),
    ])
      .split("\n")
      .map((line) => `  ${line}`.trimEnd())
      .join("\n");
    const output = [
      "◆ Reading prod's versions in GitHub Container Registry",
      "",
      "Versions of prod, newest first:",
      "",
      table,
      "",
      "Deploys of prod are paused since 2026-11-01 10:30 UTC: pinned to …",
    ].join("\n");
    expect(listedVersions(output)).toEqual([
      {
        version: C.digest.slice(0, 19),
        commit: C.commit.slice(0, 7),
        marks: [],
        message: "e2e: change C",
      },
      {
        version: B.digest.slice(0, 19),
        commit: B.commit.slice(0, 7),
        marks: ["previous"],
        message: "e2e: change B",
      },
      {
        version: A.digest.slice(0, 19),
        commit: A.commit.slice(0, 7),
        marks: ["running"],
        message: "",
      },
    ]);
    const both = textTable([
      ["Version", "Commit", "Built", "Mark", "Message"],
      row(A, "running, previous", "x"),
    ]);
    expect(listedVersions(both)[0]?.marks).toEqual(["running", "previous"]);
    expect(listedVersions("No versions of prod were found to roll back to.")).toEqual([]);
  });

  it("reads status' Deploys lines", () => {
    const output = [
      "Deploys (read from the server and GitHub now):",
      `  Running: ${A.commit.slice(0, 7)} "e2e: examples" (${A.digest.slice(0, 19)}), since 2026-11-01 10:31 UTC`,
      `  Before it: ${B.commit.slice(0, 7)} (${B.digest.slice(0, 19)})`,
      `  Paused since 2026-11-01 10:30 UTC: \`opscrew rollback\` pinned it to ${A.commit.slice(0, 7)} (${A.digest.slice(0, 19)}). Run …`,
    ].join("\n");
    const deploys = statusDeploys(output);
    expect(deploys.running?.startsWith(A.commit.slice(0, 7))).toBe(true);
    expect(deploys.running).toContain(A.digest.slice(0, 19));
    expect(deploys.paused).toContain(`pinned it to ${A.commit.slice(0, 7)}`);
    expect(statusDeploys("  Deploys: on (each push to main deploys)")).toEqual({});
  });

  it("reads an environment's entry of the deploy pause variable", () => {
    const value = JSON.stringify({
      "shop/prod": {
        reason: "rollback",
        since: "2026-11-01T10:30:00Z",
        image: A.digest,
        commit: A.commit,
      },
      "shop/staging": { reason: "move", since: "2026-11-01T09:00:00Z" },
    });
    expect(pauseEntryOf(value, "shop/prod")).toMatchObject({
      reason: "rollback",
      commit: A.commit,
    });
    expect(pauseEntryOf(value, "other/prod")).toBeUndefined();
    expect(pauseEntryOf(undefined, "shop/prod")).toBeUndefined();
    expect(() => pauseEntryOf("not json", "shop/prod")).toThrow();
  });

  it("appends a last CMD that prints the marker and only sleeps", () => {
    const dockerfile = 'FROM node:22-alpine AS runtime\nCMD ["sh", "/app/start.sh"]';
    const changed = neverAnswering(dockerfile, "opscrew-e2e-never-answers-abc123");
    expect(changed.startsWith(`${dockerfile}\n`)).toBe(true);
    expect(changed.trimEnd().split("\n").at(-1)).toBe(
      'CMD ["sh", "-c", "echo opscrew-e2e-never-answers-abc123; exec sleep 86400"]',
    );
    expect(neverAnswering(`${dockerfile}\n`, "m")).toBe(
      changed.replace("opscrew-e2e-never-answers-abc123", "m"),
    );
    expect(() => neverAnswering(dockerfile, 'x"; rm -rf /')).toThrow(/not plain/);
  });

  it("skips without the GHCR read token, as without the Hetzner pass's variables", () => {
    const env = Object.fromEntries(ROLLBACK_VARIABLES.map((name) => [name, "set"]));
    expect(
      missingVariables({ ...env, [ROLLBACK_GATE]: "1" }, ROLLBACK_GATE, ROLLBACK_VARIABLES),
    ).toEqual([]);
    expect(
      missingVariables(
        { ...env, [ROLLBACK_GATE]: "1", OPSCREW_E2E_GHCR_READ_TOKEN: " " },
        ROLLBACK_GATE,
        ROLLBACK_VARIABLES,
      ),
    ).toEqual(["OPSCREW_E2E_GHCR_READ_TOKEN"]);
    expect(ROLLBACK_VARIABLES).toEqual(
      expect.arrayContaining(["OPSCREW_E2E_HCLOUD_TOKEN", "OPSCREW_E2E_DOMAIN"]),
    );
  });

  it("uses a release command that prints its marker", () => {
    expect(RELEASE_COMMAND).toBe(`echo ${RELEASE_MARKER}`);
  });
});

describe("shownRollback", () => {
  const cli = (result: CliRun) => {
    const calls: string[][] = [];
    return {
      calls,
      opscrew: async (...args: string[]) => {
        calls.push(args);
        return result;
      },
      tail: (text: string) => `[tail of ${text.length} characters]`,
    };
  };

  it("runs the rollback without --approve and returns what its printed command names", async () => {
    const fake = cli({ exitCode: 1, stdout: SHOWN, output: SHOWN });
    const shown = await shownRollback(fake, ["--env", "prod"]);
    expect(fake.calls).toEqual([["rollback", "--env", "prod"]]);
    expect(shown).toMatchObject({ to: A.digest, hash: HASH, output: SHOWN });
  });

  it("throws, with the scrubbed tail only, when it did not stop at the approval", async () => {
    const changed = cli({ exitCode: 0, stdout: SHOWN, output: SHOWN });
    await expect(shownRollback(changed)).rejects.toThrow(/exit 1\), but exited with 0/);
    await expect(shownRollback(changed)).rejects.not.toThrow(HASH);
    const none = cli({ exitCode: 1, stdout: "", output: "Nothing was changed." });
    await expect(shownRollback(none)).rejects.toThrow(/printed no command to approve/);
  });
});
