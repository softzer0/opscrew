import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan } from "../localhost/__fixtures__/computer";
import { ownPlan, portainerPlan, testPlan } from "../testing";
import { sitePlan } from "../testing/serverless";
import { checkDesignText, checkMinutes, readCheckRepository } from "./design";

/** `base` with the check on (or `enabled`). */
function withCheck(base: DeployPlan, enabled = true): DeployPlan {
  return DeployPlanSchema.parse({ ...base, observability: { check: { enabled } } });
}

const cloud = withCheck(testPlan({ domain: "shop.example.com" }));

describe("checkMinutes", () => {
  it("counts one whole minute a run over a 31-day month", () => {
    expect(checkMinutes(60)).toBe(744);
    expect(checkMinutes(15)).toBe(2_976);
    expect(checkMinutes(5)).toBe(8_928);
  });
});

describe("checkDesignText", () => {
  it("is free every 15 minutes in a public repository", () => {
    const { lines, warnings } = checkDesignText(cloud, undefined, {
      public: true,
      hasIssues: true,
    });
    expect(lines).toEqual([
      "Scheduled check: every 15 minutes in GitHub Actions, one run for every app and environment of the repository. It checks each hostname's health path and certificate, and the server's free disk, and opens a GitHub issue when one fails.",
      "Its Actions minutes are free: the repository is public.",
    ]);
    expect(warnings).toEqual([]);
  });

  it("runs every 60 minutes in a private repository on GitHub Free: 744 of 2,000", () => {
    const { lines, warnings } = checkDesignText(cloud, undefined, {
      public: false,
      includedMinutes: 2_000,
    });
    expect(lines[0]).toContain("every 60 minutes");
    expect(lines[1]).toBe(
      "It uses about 744 ubuntu-slim minutes a month (each run counts as a whole minute), about 248 of the 2,000 included minutes of your GitHub plan: a slim minute uses a third of an included one.",
    );
    expect(warnings).toEqual([]);
  });

  it("counts GitHub Pro's 3,000 and warns about no interval there", () => {
    const { lines, warnings } = checkDesignText(
      cloud,
      { enabled: true, intervalMinutes: 15 },
      { public: false, includedMinutes: 3_000 },
    );
    expect(lines[1]).toBe(
      "It uses about 2,976 ubuntu-slim minutes a month (each run counts as a whole minute), about 992 of the 3,000 included minutes of your GitHub plan: a slim minute uses a third of an included one.",
    );
    expect(warnings).toEqual([]);
  });

  it("counts GitHub Free's 2,000 when the plan is unknown, and warns about a set interval past 750", () => {
    const { lines, warnings } = checkDesignText(
      cloud,
      { enabled: true, intervalMinutes: 30 },
      { public: false },
    );
    expect(lines[1]).toBe(
      "It uses about 1,488 ubuntu-slim minutes a month (each run counts as a whole minute), about 496 of the 2,000 included minutes of GitHub Free (OpsCrew could not read your plan): a slim minute uses a third of an included one.",
    );
    expect(warnings).toEqual([
      expect.stringMatching(
        /^observability\.check\.intervalMinutes is 30, so the check uses about 1,488 ubuntu-slim minutes a month \(about 496 of the 2,000 included minutes of GitHub Free\), more than the 750/,
      ),
    ]);
  });

  it("counts an unknown repository as private", () => {
    const { lines, warnings } = checkDesignText(cloud, undefined, {});
    expect(lines[0]).toContain("every 60 minutes");
    expect(lines[1]).toContain(
      "OpsCrew could not tell whether the repository is public, so it counts it as private.",
    );
    // The default interval stays within 750 minutes.
    expect(warnings).toEqual([]);
  });

  it("says when the repository's issues are off", () => {
    const { warnings } = checkDesignText(cloud, undefined, { public: true, hasIssues: false });
    expect(warnings).toEqual([expect.stringContaining("The repository's issues are off")]);
  });

  it("names the targets without a disk check", () => {
    for (const [base, reason] of [
      [portainerPlan(), "OpsCrew reaches your Portainer only through its API"],
      [sitePlan(), "Cloudflare's hosting has no server of the app's"],
      [sitePlan({ provider: "github-pages" }), "GitHub Pages has no server of the app's"],
      [
        ownPlan({ access: "tunnel" }),
        "the check's SSH can't pass the tunnel's Cloudflare Access login",
      ],
    ] as const) {
      const { lines } = checkDesignText(withCheck(base), undefined, { public: true });
      expect(lines[0]).not.toContain("disk");
      expect(lines[2]).toMatch(/^The check reads no disk here: /);
      expect(lines[2]).toContain(reason);
    }
    // An own server in public mode reads its disk.
    const { lines } = checkDesignText(withCheck(ownPlan()), undefined, { public: true });
    expect(lines[0]).toContain("the server's free disk");
    expect(lines).toHaveLength(2);
  });

  it("says that localhost gets no check, and when the check is off", () => {
    expect(checkDesignText(localPlan(), undefined, {}).lines).toEqual([
      "Scheduled check: none. GitHub can't reach your computer, so the check that opens an issue when the app is down doesn't apply here.",
    ]);
    expect(checkDesignText(withCheck(testPlan(), false), undefined, {}).lines).toEqual([
      "Scheduled check: off for this environment (set observability.check.enabled to true to turn it on).",
    ]);
  });
});

describe("readCheckRepository", () => {
  const deps = {} as Parameters<typeof readCheckRepository>[0];
  const answers = (repo: { private: boolean; hasIssues?: boolean }, minutes?: number) => ({
    calls: [] as string[],
    async getRepo(owner: string, name: string) {
      this.calls.push(`repo ${owner}/${name}`);
      return { defaultBranch: "main", canPush: true, ...repo };
    },
    async includedMinutes(owner: string) {
      this.calls.push(`minutes ${owner}`);
      return minutes;
    },
  });

  it("reads the plan's minutes only for a private repository", async () => {
    const pro = answers({ private: true, hasIssues: false }, 3_000);
    await expect(readCheckRepository(deps, { owner: "acme", repo: "shop" }, pro)).resolves.toEqual({
      public: false,
      hasIssues: false,
      includedMinutes: 3_000,
    });
    const open = answers({ private: false });
    await expect(readCheckRepository(deps, { owner: "acme", repo: "shop" }, open)).resolves.toEqual(
      { public: true },
    );
    expect(open.calls).toEqual(["repo acme/shop"]);
  });

  it("knows nothing without a remote, a token or an answer", async () => {
    await expect(readCheckRepository(deps, {}, answers({ private: true }))).resolves.toEqual({});
    await expect(readCheckRepository(deps, { owner: "acme", repo: "shop" }, null)).resolves.toEqual(
      {},
    );
    const failing = {
      getRepo: async () => {
        throw new Error("offline");
      },
      includedMinutes: async () => undefined,
    };
    await expect(
      readCheckRepository(deps, { owner: "acme", repo: "shop" }, failing),
    ).resolves.toEqual({});
  });
});
