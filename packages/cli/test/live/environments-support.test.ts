/**
 * Offline checks of the pure helpers of feature 015's live tests: address ranges against GitHub's
 * Actions ranges, a firewall's SSH sources, the runners' secrets, the promotion to approve and a
 * GitHub environment's rules. No network.
 */
import { randomBytes } from "node:crypto";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  cidrsOverlap,
  destroyWithinBudget,
  environmentRules,
  overlapping,
  promotionApproval,
  runnerCredentialSecrets,
  runnerTokenShapes,
  sshSources,
} from "./environments-support";

/** A string shaped like a runner registration token, made at run time. */
const tokenShaped = () => `A${randomBytes(14).toString("hex").toUpperCase()}`;

describe("cidrsOverlap", () => {
  it("finds an address inside a range and ranges that share addresses", () => {
    expect(cidrsOverlap("192.0.2.7/32", "192.0.2.0/24")).toBe(true);
    expect(cidrsOverlap("192.0.2.0/24", "192.0.2.128/25")).toBe(true);
    expect(cidrsOverlap("192.0.2.7", "192.0.2.0/24")).toBe(true);
    expect(cidrsOverlap("0.0.0.0/0", "198.51.100.0/24")).toBe(true);
    expect(cidrsOverlap("2001:db8::1/128", "2001:db8::/32")).toBe(true);
    expect(cidrsOverlap("::/0", "2001:db8:abcd::/48")).toBe(true);
  });

  it("keeps apart ranges that share no address, and the two families", () => {
    expect(cidrsOverlap("192.0.2.7/32", "198.51.100.0/24")).toBe(false);
    expect(cidrsOverlap("192.0.2.0/25", "192.0.2.128/25")).toBe(false);
    expect(cidrsOverlap("2001:db8::1/128", "2001:db9::/32")).toBe(false);
    expect(cidrsOverlap("192.0.2.7/32", "::/0")).toBe(false);
  });

  it("refuses what is not an address range", () => {
    expect(() => cidrsOverlap("192.0.2.300/32", "192.0.2.0/24")).toThrow(/not an IPv4/);
    expect(() => cidrsOverlap("2001:db8::1::2/128", "::/0")).toThrow(/not an IPv6/);
    expect(() => cidrsOverlap("192.0.2.0/33", "192.0.2.0/24")).toThrow(/prefix/);
  });

  it("lists the sources inside GitHub's ranges", () => {
    const actions = ["198.51.100.0/24", "2001:db8:1::/48"];
    expect(overlapping(["192.0.2.7/32", "0.0.0.0/0", "2001:db8:1:2::/64"], actions)).toEqual([
      "0.0.0.0/0",
      "2001:db8:1:2::/64",
    ]);
    expect(overlapping(["192.0.2.7/32"], actions)).toEqual([]);
  });
});

describe("sshSources", () => {
  it("takes the inbound TCP rules that reach port 22", () => {
    expect(
      sshSources([
        { direction: "in", protocol: "tcp", port: "22", source_ips: ["192.0.2.7/32"] },
        { direction: "in", protocol: "tcp", port: "80", source_ips: ["0.0.0.0/0"] },
        { direction: "in", protocol: "tcp", port: "20-30", source_ips: ["192.0.2.8/32"] },
        { direction: "in", protocol: "udp", port: "22", source_ips: ["0.0.0.0/0"] },
        { direction: "in", protocol: "icmp", port: null, source_ips: ["0.0.0.0/0"] },
        { direction: "out", protocol: "tcp", port: "22" },
        { direction: "in", protocol: "tcp", port: "22", source_ips: ["192.0.2.7/32"] },
      ]),
    ).toEqual(["192.0.2.7/32", "192.0.2.8/32"]);
  });
});

describe("destroyWithinBudget", () => {
  it("deletes through the API after a destroy that hangs past the budget, skipping the rest", async () => {
    const calls: string[] = [];
    const logged: string[] = [];
    await destroyWithinBudget(
      {
        pending: ["staging", "prod"],
        destroy: (environment) => {
          calls.push(`destroy ${environment}`);
          return new Promise<void>(() => undefined);
        },
        budgetMs: 50,
        log: (message) => logged.push(message),
      },
      async () => {
        calls.push("API deletion");
      },
    );
    expect(calls).toEqual(["destroy staging", "API deletion"]);
    expect(logged).toEqual([
      expect.stringContaining("still running when the cleanup's budget ended"),
      expect.stringContaining("no time left to destroy prod"),
    ]);
  });

  it("deletes through the API after a failed destroy, and gives each destroy the time left", async () => {
    const calls: string[] = [];
    await destroyWithinBudget(
      {
        pending: ["staging", "prod"],
        destroy: async (environment, timeLeft) => {
          expect(timeLeft()).toBeGreaterThan(0);
          calls.push(`destroy ${environment}`);
          if (environment === "staging") throw new Error("exited with 2\nthe output");
        },
        budgetMs: 60_000,
        log: (message) => calls.push(message),
      },
      async () => {
        calls.push("API deletion");
      },
    );
    expect(calls).toEqual([
      "destroy staging",
      "opscrew destroy of staging failed (Error: exited with 2); the API deletes what is left",
      "destroy prod",
      "API deletion",
    ]);
  });
});

describe("the runners' secrets", () => {
  it("counts strings shaped like a registration token, standing alone", () => {
    const token = tokenShaped();
    expect(token).toHaveLength(29);
    expect(runnerTokenShapes(`token: ${token}\nagain ${token}.`)).toBe(2);
    expect(runnerTokenShapes(`x${token}`)).toBe(0);
    expect(runnerTokenShapes(`${token}9`)).toBe(0);
    expect(runnerTokenShapes(token.toLowerCase())).toBe(0);
    expect(runnerTokenShapes("ACTIONS_RUNNER_INPUT_TOKEN and OPSCREW_STAGING_SSH_KEY")).toBe(0);
  });

  it("takes the RSA key's private parameters, never its public ones", () => {
    const value = (seed: string) => fakeSecret("aws-secret-access-key", seed);
    const secrets = runnerCredentialSecrets({
      d: value("d"),
      dp: value("dp"),
      dq: value("dq"),
      exponent: "AQAB",
      inverseQ: value("iq"),
      modulus: value("m"),
      p: value("p"),
      q: value("q"),
    });
    expect(secrets).toEqual(["d", "dp", "dq", "iq", "p", "q"].map(value));
    expect(runnerCredentialSecrets(null)).toEqual([]);
    expect(runnerCredentialSecrets({ d: "short" })).toEqual([]);
  });
});

describe("promotionApproval", () => {
  it("reads the digest and the hash from the printed command", () => {
    const digest = `sha256:${"ab".repeat(32)}`;
    const hash = "cd".repeat(32);
    const older = "ef".repeat(32);
    const output = [
      `Image: ghcr.io/owner/app@${digest}`,
      `Promotion hash: ${hash}`,
      `To deploy it later without prompts, run: opscrew promote --to prod --digest ${digest} --approve ${older}`,
      `  run: opscrew promote --to prod --digest ${digest} --approve ${hash}`,
    ].join("\n");
    expect(promotionApproval(output)).toEqual({ digest, hash });
    expect(promotionApproval("No plan hash was approved.")).toBeUndefined();
  });
});

describe("environmentRules", () => {
  it("reads the reviewers, the wait timer and the branch policy", () => {
    expect(
      environmentRules({
        name: "staging",
        protection_rules: [
          { type: "required_reviewers", reviewers: [{ type: "User" }] },
          { type: "wait_timer", wait_timer: 1 },
          { type: "branch_policy" },
        ],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      }),
    ).toEqual({
      reviewers: 1,
      waitTimer: 1,
      branchPolicy: { protectedBranches: false, customBranchPolicies: true },
    });
  });

  it("reads an environment without rules (a Free private repository's)", () => {
    expect(environmentRules({ name: "staging", deployment_branch_policy: null })).toEqual({
      reviewers: 0,
      waitTimer: 0,
      branchPolicy: null,
    });
  });
});
