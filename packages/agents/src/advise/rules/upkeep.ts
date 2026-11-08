/**
 * Advise's upkeep and security rules (spec US7): Dependabot's alerts and pull requests, the
 * servers' security updates, a required reboot and `secure`'s failing host checks, and the GitHub
 * and Cloudflare tokens' expiry, and the credentials older than `credentials.maxAgeDays`. They
 * apply to every target.
 */
import { CLOUDFLARE_TOKEN_PAGE } from "@opscrew/connector-cloudflare";
import { type CheckResult, SEVERITIES } from "@opscrew/contracts";
import { listText, plural } from "@opscrew/core";
import { credentialMaxAgeDaysOf } from "@opscrew/plan-schema";
import { couldNotRun } from "@opscrew/secops";
import type { CredentialDate } from "../../rotate/inventory";
import { type Proposal, type Readings, THRESHOLDS } from "../types";
import { PLAN, withoutStop } from "./shared";

/** The upkeep and security proposals: Dependabot, security updates, host checks, tokens, ages. */
export function upkeepRules(readings: Readings): Proposal[] {
  return [
    ...dependabotProposals(readings),
    ...Object.entries(readings.upkeep.hostChecks).flatMap(([server, results]) =>
      hostProposals(readings, server, results),
    ),
    ...tokenProposals(readings),
    ...ageProposals(readings),
  ];
}

/** The open alerts by severity with Dependabot's pull requests, or the alerts off. */
function dependabotProposals({ upkeep }: Readings): Proposal[] {
  const { dependabot, pulls } = upkeep;
  // Unread (no permission, GitHub unreachable): listed under notRead, nothing to propose.
  if (dependabot === undefined) return [];
  if (dependabot.state === "off") {
    return [
      {
        id: "security.env.dependabot-off",
        category: "security",
        // A security gap: known vulnerabilities go unseen.
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
    ];
  }
  const { alerts } = dependabot;
  if (alerts.length === 0) return [];
  const groups = SEVERITIES.map((severity) => {
    const found = alerts.filter((a) => a.severity === severity);
    return { severity, count: found.length, packages: [...new Set(found.map((a) => a.package))] };
  }).filter((group) => group.count > 0);
  return [
    {
      id: "security.env.dependabot-alerts",
      category: "security",
      urgency: "soon",
      title: `Fix ${plural(alerts.length, "Dependabot alert")}: ${listText(groups.map((g) => `${g.count} ${g.severity}`))}`,
      reasons: [
        ...groups.map((group) => ({
          text: `${group.count} ${group.severity} ${group.count === 1 ? "alert" : "alerts"}, in ${listText(group.packages.sort())}`,
          basis: { kind: "account" as const },
        })),
        // Dependabot's pull requests, which may or may not update the alerts' packages.
        ...pulls.map((pull) => ({
          text: `Dependabot has a pull request open, #${pull.number} "${pull.title}": ${pull.url}`,
          basis: { kind: "account" as const },
        })),
      ],
      apply: {
        kind: "manual",
        text: `Read the alerts in the repository's Security tab, Dependabot, and update the packages${
          pulls.length === 0
            ? ""
            : `; Dependabot's open ${pulls.length === 1 ? "pull request" : "pull requests"} ${listText(pulls.map((p) => `#${p.number}`))} may do some of it`
        }`,
      },
    },
  ];
}

/**
 * A server's required reboot, pending security updates and failing host checks. A check's message
 * and `target` (the server's address) never reach a proposal: only its id, title, severity and the
 * updates' count do.
 */
function hostProposals(readings: Readings, server: string, results: CheckResult[]): Proposal[] {
  const basis = { kind: "one-reading" as const, at: readings.at };
  const found = (id: string) =>
    results.find((r) => r.id === id && r.status === "warn" && !couldNotRun(r));
  const proposals: Proposal[] = [];
  const reboot = found("reboot-required");
  if (reboot !== undefined) {
    proposals.push({
      id: `security.${server}.reboot`,
      category: "security",
      urgency: "now",
      server,
      title: `Reboot server ${server} to finish its security updates`,
      reasons: [
        {
          text: "Security updates were installed that need a reboot. The app's containers start again on their own",
          basis,
        },
      ],
      apply: {
        kind: "manual",
        text: `Reboot server ${server} during a quiet moment: from the provider's console, or \`sudo reboot\` from your own login on it`,
      },
    });
  }
  const updates = found("security-updates");
  const count = updates?.message.match(/^(\d+) security update/)?.[1];
  if (updates !== undefined && count !== undefined && Number(count) > 0) {
    const automatic = !results.some((r) => r.id === "unattended-upgrades" && r.status === "fail");
    proposals.push({
      id: `security.${server}.updates`,
      category: "security",
      urgency: "soon",
      server,
      title: `Let server ${server} install its ${plural(Number(count), "security update")}`,
      reasons: [
        {
          text: `${plural(Number(count), "security update")} ${count === "1" ? "is" : "are"} waiting`,
          basis,
        },
      ],
      apply: {
        kind: "manual",
        text: automatic
          ? "Nothing to run: unattended-upgrades installs them each night"
          : "Turn automatic updates back on, as root on the server: `systemctl enable --now unattended-upgrades`",
      },
    });
  }
  // The disk is the size rules' (the updates and the reboot are warnings, never failing here).
  const failing = results
    .filter((r) => r.status === "fail" && r.id !== "disk-usage")
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  if (failing.length > 0) {
    proposals.push({
      id: `security.${server}.host-checks`,
      category: "security",
      urgency: "soon",
      server,
      title: `Fix ${plural(failing.length, "failing host check")} on server ${server}`,
      reasons: failing.map((r) => ({
        text: `The check "${r.title}" failed`,
        figure: r.severity,
        basis,
      })),
      apply: { kind: "command", command: `opscrew secure${readings.flags}` },
    });
  }
  return proposals;
}

const DAY_MS = 86_400_000;

/** Each token's name, its variable and where a new one is made. */
const TOKENS = {
  github: {
    name: "GitHub",
    variable: "GITHUB_TOKEN",
    page: "https://github.com/settings/personal-access-tokens/new",
  },
  cloudflare: {
    name: "Cloudflare",
    variable: "CLOUDFLARE_API_TOKEN",
    page: CLOUDFLARE_TOKEN_PAGE,
  },
} as const;

/** A GitHub or Cloudflare token expiring within `tokenDays` (`now` within `tokenDaysNow`). */
function tokenProposals(readings: Readings): Proposal[] {
  return readings.upkeep.tokens.flatMap(({ service, expiresAt }): Proposal[] => {
    const left = (Date.parse(expiresAt) - Date.parse(readings.at)) / DAY_MS;
    if (left > THRESHOLDS.tokenDays) return [];
    const token = TOKENS[service];
    const date = expiresAt.slice(0, 10);
    const days = Math.floor(left);
    const uses = `The ${token.name} token OpsCrew uses (${token.variable})`;
    return [
      {
        id: `upkeep.env.${service}-token`,
        category: "upkeep",
        urgency: left <= THRESHOLDS.tokenDaysNow ? "now" : "soon",
        title:
          left < 0
            ? `Replace the ${token.name} token, which expired on ${date}`
            : `Replace the ${token.name} token before it expires on ${date}`,
        reasons: [
          left < 0
            ? { text: `${uses} expired on ${date}`, basis: { kind: "account" } }
            : {
                text: `${uses} expires on ${date}`,
                figure: days === 0 ? "today" : `in ${plural(days, "day")}`,
                basis: { kind: "account" },
              },
        ],
        apply: {
          kind: "manual",
          text: `Create a new token with the same permissions at ${token.page} and put it in ${token.variable}`,
        },
      },
    ];
  });
}

/** How a credential's date reads in a title (`made`) and in its reason (`was made on`). */
const DATE_WORDS: Record<CredentialDate["source"], { title: string; reason: string }> = {
  rotated: { title: "last rotated", reason: "was last rotated on" },
  made: { title: "made", reason: "was made on" },
  "first-deploy": { title: "made", reason: "was made at the first deploy, on" },
  "first-seen": { title: "first seen", reason: "was first seen on this computer on" },
};

/**
 * Each credential dated more than `credentials.maxAgeDays` ago (spec US7, research R9), with the
 * command that rotates it. One without a date or with nothing to rotate is skipped, and so is a
 * user's token whose expiry was read: its expiry warning is {@link tokenProposals}'.
 */
function ageProposals(readings: Readings): Proposal[] {
  const maxDays = credentialMaxAgeDaysOf(readings.plan);
  const expiring = new Set<string>(readings.upkeep.tokens.map((t) => t.service));
  return (readings.upkeep.credentials ?? []).flatMap((credential): Proposal[] => {
    const { name, kind, rotation, date } = credential;
    if (date === undefined || rotation.mode === "none") return [];
    if (kind === "user-token" && expiring.has(name)) return [];
    const age = (Date.parse(readings.at) - Date.parse(date.at)) / DAY_MS;
    if (age <= maxDays) return [];
    const words = DATE_WORDS[date.source];
    const token = kind === "user-token";
    const ago = `more than ${maxDays} days ago`;
    return [
      {
        id: `upkeep.env.rotate-${name}`,
        category: "upkeep",
        urgency: "soon",
        title: token
          ? `Replace the ${name} token, ${words.title} ${ago}`
          : `Rotate ${name}, ${words.title} ${ago}`,
        reasons: [
          {
            text: `${token ? `The ${name} token` : name} ${words.reason} ${date.at.slice(0, 10)}, ${ago}`,
            figure: `${plural(Math.floor(age), "day")} old`,
            basis: PLAN,
          },
          { text: withoutStop(credential.changes), basis: PLAN },
        ],
        apply: { kind: "command", command: `opscrew rotate ${name}${readings.flags}` },
      },
    ];
  });
}
