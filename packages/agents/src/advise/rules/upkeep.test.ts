import type { DependabotAlert, DependabotPull } from "@opscrew/connector-github";
import type { CheckResult } from "@opscrew/contracts";
import { HOST_CHECKS } from "@opscrew/secops";
import { describe, expect, it } from "vitest";
import { testPlan } from "../../testing";
import { pagesTestPlan } from "../../testing/pages";
import { sitePlan } from "../../testing/serverless";
import { type Readings, THRESHOLDS } from "../types";
import {
  AT,
  afterAt,
  hostCheck,
  readingsOf,
  SERVER_ADDRESS,
  validated,
} from "./__fixtures__/rule-readings";
import { upkeepRules } from "./upkeep";

const rules = validated(upkeepRules);

const REPO = "https://github.com/example/example-app";

function alert(severity: DependabotAlert["severity"], pkg: string, n: number): DependabotAlert {
  return { severity, package: pkg, url: `${REPO}/security/dependabot/${n}` };
}

function pull(number: number, title: string): DependabotPull {
  return { number, title, createdAt: "2026-11-01T08:00:00Z", url: `${REPO}/pull/${number}` };
}

function upkeep(o: Partial<Readings["upkeep"]>): Readings {
  return readingsOf(testPlan(), { upkeep: { pulls: [], tokens: [], hostChecks: {}, ...o } });
}

describe("upkeepRules: Dependabot", () => {
  it("reports the open alerts by severity, with Dependabot's open pull requests", () => {
    const readings = upkeep({
      dependabot: {
        state: "on",
        alerts: [
          alert("medium", "ws", 4),
          alert("critical", "lodash", 1),
          alert("high", "express", 2),
          alert("high", "lodash", 3),
        ],
      },
      pulls: [pull(12, "Bump lodash from 4.17.20 to 4.17.21"), pull(14, "Bump ws from 8.0 to 8.1")],
    });
    expect(rules(readings)).toEqual([
      {
        id: "security.env.dependabot-alerts",
        category: "security",
        urgency: "soon",
        title: "Fix 4 Dependabot alerts: 1 critical, 2 high and 1 medium",
        reasons: [
          { text: "1 critical alert, in lodash", basis: { kind: "account" } },
          { text: "2 high alerts, in express and lodash", basis: { kind: "account" } },
          { text: "1 medium alert, in ws", basis: { kind: "account" } },
          {
            text: `Dependabot has a pull request open, #12 "Bump lodash from 4.17.20 to 4.17.21": ${REPO}/pull/12`,
            basis: { kind: "account" },
          },
          {
            text: `Dependabot has a pull request open, #14 "Bump ws from 8.0 to 8.1": ${REPO}/pull/14`,
            basis: { kind: "account" },
          },
        ],
        apply: {
          kind: "manual",
          text: "Read the alerts in the repository's Security tab, Dependabot, and update the packages; Dependabot's open pull requests #12 and #14 may do some of it",
        },
      },
    ]);
  });

  it("points to the alerts on GitHub when no pull request fixes them", () => {
    const [proposal] = rules(
      upkeep({ dependabot: { state: "on", alerts: [alert("low", "debug", 9)] } }),
    );
    expect(proposal?.title).toBe("Fix 1 Dependabot alert: 1 low");
    expect(proposal?.apply).toEqual({
      kind: "manual",
      text: "Read the alerts in the repository's Security tab, Dependabot, and update the packages",
    });
  });

  it("proposes turning the alerts on when they are off", () => {
    expect(rules(upkeep({ dependabot: { state: "off" }, pulls: [pull(3, "Bump a")] }))).toEqual([
      {
        id: "security.env.dependabot-off",
        category: "security",
        urgency: "soon",
        title: "Turn on Dependabot alerts for the repository",
        reasons: [
          {
            text: "Dependabot alerts are off for the repository (GitHub's default for a private one), so nobody is told when a package the app uses has a known vulnerability",
            basis: { kind: "account" },
          },
        ],
        apply: {
          kind: "manual",
          text: "Turn on Dependabot alerts in the repository's Settings, Code security",
        },
      },
    ]);
  });

  it("proposes nothing without alerts, or when they couldn't be read", () => {
    expect(rules(upkeep({ dependabot: { state: "on", alerts: [] } }))).toEqual([]);
    expect(rules(upkeep({ pulls: [pull(3, "Bump a")] }))).toEqual([]);
  });
});

describe("upkeepRules: the servers' updates and host checks", () => {
  const pass = (id: string) => hostCheck({ id, status: "pass", severity: "low", message: "Fine." });
  /** `secure`'s own check's result for `stdout`, on the server's address (its `target`). */
  const evaluated = (id: string, stdout: string): CheckResult => {
    const result = HOST_CHECKS.find((c) => c.id === id)?.evaluate({
      exitCode: 0,
      stdout,
      stderr: "",
    });
    if (result === undefined) throw new Error(`secure has no host check ${id}`);
    return { ...result, target: SERVER_ADDRESS };
  };
  const updates = (count: number) => evaluated("security-updates", `${count}\n`);
  const reboot = evaluated("reboot-required", "yes\n");

  it("reports a required reboot (now) and pending security updates (soon)", () => {
    const readings = upkeep({ hostChecks: { app: [updates(3), reboot, pass("ufw")] } });
    expect(rules(readings)).toEqual([
      {
        id: "security.app.reboot",
        category: "security",
        urgency: "now",
        server: "app",
        title: "Reboot server app to finish its security updates",
        reasons: [
          {
            text: "Security updates were installed that need a reboot. The app's containers start again on their own",
            basis: { kind: "one-reading", at: AT },
          },
        ],
        apply: {
          kind: "manual",
          text: "Reboot server app during a quiet moment: from the provider's console, or `sudo reboot` from your own login on it",
        },
      },
      {
        id: "security.app.updates",
        category: "security",
        urgency: "soon",
        server: "app",
        title: "Let server app install its 3 security updates",
        reasons: [
          { text: "3 security updates are waiting", basis: { kind: "one-reading", at: AT } },
        ],
        apply: {
          kind: "manual",
          text: "Nothing to run: unattended-upgrades installs them each night",
        },
      },
    ]);
  });

  it("says how to turn automatic updates back on when they are off", () => {
    const off = hostCheck({
      id: "unattended-upgrades",
      status: "fail",
      severity: "medium",
      message: "unattended-upgrades is disabled.",
    });
    const proposals = rules(upkeep({ hostChecks: { app: [updates(1), off] } }));
    const proposal = proposals.find((p) => p.id === "security.app.updates");
    expect(proposal?.reasons[0]?.text).toBe("1 security update is waiting");
    expect(proposal?.apply).toEqual({
      kind: "manual",
      text: "Turn automatic updates back on, as root on the server: `systemctl enable --now unattended-upgrades`",
    });
  });

  it("lists the failing host checks most severe first, without the disk or the updates twice", () => {
    const fail = (id: string, severity: "critical" | "high" | "medium", title: string) =>
      hostCheck({ id, title, status: "fail", severity, message: `Failed on ${SERVER_ADDRESS}.` });
    const readings = upkeep({
      hostChecks: {
        app: [
          fail("ufw", "medium", "Host firewall (ufw) is enabled"),
          fail("docker-socket-not-exposed", "critical", "Docker API is not exposed over TCP"),
          fail("ssh-hardening", "high", "SSH allows keys only, no root login"),
          fail("disk-usage", "high", "Disk has free space"),
          updates(0),
          hostCheck({
            id: "listening-ports",
            status: "warn",
            severity: "high",
            message: `Could not run the check: ${SERVER_ADDRESS} did not answer`,
          }),
          pass("fail2ban"),
        ],
      },
    });
    const basis = { kind: "one-reading", at: AT };
    expect(rules({ ...readings, flags: " --env staging" })).toEqual([
      {
        id: "security.app.host-checks",
        category: "security",
        urgency: "soon",
        server: "app",
        title: "Fix 3 failing host checks on server app",
        reasons: [
          {
            text: 'The check "Docker API is not exposed over TCP" failed',
            figure: "critical",
            basis,
          },
          {
            text: 'The check "SSH allows keys only, no root login" failed',
            figure: "high",
            basis,
          },
          { text: 'The check "Host firewall (ufw) is enabled" failed', figure: "medium", basis },
        ],
        apply: { kind: "command", command: "opscrew secure --env staging" },
      },
    ]);
  });

  it("reports nothing for a reboot or updates check that couldn't run", () => {
    const failed = (id: string) =>
      hostCheck({
        id,
        status: "warn",
        severity: "low",
        message: `Could not run the check: ${SERVER_ADDRESS} timed out`,
      });
    const readings = upkeep({
      hostChecks: { app: [failed("reboot-required"), failed("security-updates")] },
    });
    expect(rules(readings)).toEqual([]);
  });

  it("never shows the server's address, from a check's message or its target", () => {
    const failing = hostCheck({
      id: "ufw",
      status: "fail",
      severity: "medium",
      message: `ufw is disabled on ${SERVER_ADDRESS}.`,
    });
    // secure's own results, with the address added to their messages too.
    const named = (result: CheckResult) => ({
      ...result,
      message: `${result.message} (${SERVER_ADDRESS})`,
    });
    const proposals = rules(
      upkeep({ hostChecks: { app: [named(updates(2)), named(reboot), failing] } }),
    );
    expect(proposals.map((p) => p.id)).toEqual([
      "security.app.reboot",
      "security.app.updates",
      "security.app.host-checks",
    ]);
    expect(JSON.stringify(proposals)).not.toContain(SERVER_ADDRESS);
  });
});

describe("upkeepRules: tokens", () => {
  it(`reports a token within ${THRESHOLDS.tokenDays} days (soon) and within ${THRESHOLDS.tokenDaysNow} (now)`, () => {
    const readings = upkeep({
      tokens: [
        { service: "github", expiresAt: afterAt(THRESHOLDS.tokenDays) },
        { service: "cloudflare", expiresAt: afterAt(THRESHOLDS.tokenDaysNow) },
      ],
    });
    expect(rules(readings)).toEqual([
      {
        id: "upkeep.env.github-token",
        category: "upkeep",
        urgency: "soon",
        title: "Replace the GitHub token before it expires on 2026-12-05",
        reasons: [
          {
            text: "The GitHub token OpsCrew uses (GITHUB_TOKEN) expires on 2026-12-05",
            figure: "in 30 days",
            basis: { kind: "account" },
          },
        ],
        apply: {
          kind: "manual",
          text: "Create a new token with the same permissions at https://github.com/settings/personal-access-tokens/new and put it in GITHUB_TOKEN",
        },
      },
      {
        id: "upkeep.env.cloudflare-token",
        category: "upkeep",
        urgency: "now",
        title: "Replace the Cloudflare token before it expires on 2026-11-12",
        reasons: [
          {
            text: "The Cloudflare token OpsCrew uses (CLOUDFLARE_API_TOKEN) expires on 2026-11-12",
            figure: "in 7 days",
            basis: { kind: "account" },
          },
        ],
        apply: {
          kind: "manual",
          text: "Create a new token with the same permissions at https://dash.cloudflare.com/profile/api-tokens and put it in CLOUDFLARE_API_TOKEN",
        },
      },
    ]);
  });

  it("goes from now to soon just past 7 days, and says nothing just past 30", () => {
    const after = (days: number) =>
      rules(upkeep({ tokens: [{ service: "github", expiresAt: afterAt(days, 1) }] }));
    expect(after(THRESHOLDS.tokenDaysNow)[0]?.urgency).toBe("soon");
    expect(after(THRESHOLDS.tokenDays)).toEqual([]);
  });

  it("says today when less than a day is left", () => {
    const [proposal] = rules(
      upkeep({ tokens: [{ service: "github", expiresAt: afterAt(0, 3_600_000) }] }),
    );
    expect(proposal?.reasons[0]).toMatchObject({
      text: "The GitHub token OpsCrew uses (GITHUB_TOKEN) expires on 2026-11-05",
      figure: "today",
    });
  });

  it("says when a token has already expired", () => {
    const [proposal] = rules(
      upkeep({ tokens: [{ service: "cloudflare", expiresAt: afterAt(-2) }] }),
    );
    expect(proposal?.urgency).toBe("now");
    expect(proposal?.reasons[0]?.text).toBe(
      "The Cloudflare token OpsCrew uses (CLOUDFLARE_API_TOKEN) expired on 2026-11-03",
    );
  });
});

describe("upkeepRules: targets", () => {
  it("gives Cloudflare's hosting and GitHub Pages the upkeep proposals", () => {
    for (const plan of [sitePlan(), pagesTestPlan()]) {
      const readings = readingsOf(plan, {
        upkeep: {
          dependabot: { state: "off" },
          pulls: [],
          tokens: [{ service: "github", expiresAt: afterAt(3) }],
          hostChecks: {},
        },
      });
      expect(rules(readings).map((p) => p.id)).toEqual([
        "security.env.dependabot-off",
        "upkeep.env.github-token",
      ]);
    }
  });
});
