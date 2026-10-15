import type { ApprovalRequest, CommandRunner } from "@opscrew/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type ApprovalPrompts,
  InteractiveApprovalHandler,
  NonInteractiveApprovalHandler,
} from "./approval";

const HASH = "ab".repeat(32);
const OTHER = "cd".repeat(32);
const clock = { now: () => new Date("2026-10-11T09:00:00.000Z") };

const apply = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  kind: "iac-apply",
  title: "Create 4 resources on Hetzner Cloud",
  details: "+ hcloud_server.app",
  planHash: HASH,
  ...overrides,
});

describe("NonInteractiveApprovalHandler", () => {
  const handler = (approvePlanHash?: string) =>
    new NonInteractiveApprovalHandler({
      ...(approvePlanHash === undefined ? {} : { approvePlanHash }),
      approver: "--approve flag",
      clock,
    });

  it("approves an iac-apply whose plan hash matches --approve, case-insensitively", async () => {
    const decision = await handler(HASH.toUpperCase()).request(apply());
    expect(decision).toEqual({
      approved: true,
      approver: "--approve flag",
      decidedAt: "2026-10-11T09:00:00.000Z",
    });
  });

  it("refuses a different plan hash", async () => {
    const decision = await handler(OTHER).request(apply());
    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/does not match/);
    expect(decision.reason).toMatch(/--approve <hash>/);
  });

  it("refuses when no hash or an invalid hash was given", async () => {
    for (const value of [undefined, "", "not-a-hash"]) {
      const decision = await handler(value).request(apply());
      expect(decision.approved).toBe(false);
      expect(decision.reason).toMatch(/interactive terminal/);
      expect(decision.reason).toMatch(/--approve <hash>/);
    }
  });

  it("refuses an apply without a plan hash", async () => {
    const decision = await handler(HASH).request(apply({ planHash: undefined }));
    expect(decision.approved).toBe(false);
  });

  it("refuses destroys even when the hash matches", async () => {
    const decision = await handler(HASH).request(
      apply({ allowDestroy: true, confirmPhrase: "my-server" }),
    );
    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/interactive terminal/);
  });

  it("refuses every other kind of request", async () => {
    for (const kind of ["repo-write", "git-push", "pull-request", "github-secrets"] as const) {
      const decision = await handler(HASH).request({ kind, title: "Push", details: "" });
      expect(decision.approved).toBe(false);
      expect(decision.reason).toMatch(/interactive terminal/);
      expect(decision.reason).toMatch(/--approve <hash>/);
    }
  });
});

describe("NonInteractiveApprovalHandler with several --approve hashes (own servers)", () => {
  const THIRD = "ef".repeat(32);
  const handler = (hashes: string[], assumeYes = false) =>
    new NonInteractiveApprovalHandler({
      approvePlanHashes: hashes,
      ...(assumeYes ? { assumeYes: true } : {}),
      approver: "--approve flag",
      clock,
    });
  const hostApply = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    kind: "host-apply",
    title: "Apply the host plan to your server (5 changes)",
    details: `Host plan hash: ${OTHER}`,
    planHash: OTHER,
    ...overrides,
  });

  it("grants an infrastructure plan and a host plan when each hash is listed", async () => {
    const both = handler([HASH, OTHER.toUpperCase()]);
    expect((await both.request(apply())).approved).toBe(true);
    expect((await both.request(hostApply())).approved).toBe(true);
  });

  it("grants only the listed hashes", async () => {
    const onlyInfra = handler([HASH]);
    const refused = await onlyInfra.request(hostApply());
    expect(refused.approved).toBe(false);
    expect(refused.reason).toMatch(/does not match/);
    expect((await handler([OTHER]).request(apply())).approved).toBe(false);
    expect((await handler([THIRD]).request(hostApply())).approved).toBe(false);
  });

  it("refuses a host plan without a hash, or with an invalid --approve value", async () => {
    expect((await handler([OTHER]).request(hostApply({ planHash: undefined }))).approved).toBe(
      false,
    );
    const invalid = await handler([OTHER, "not-a-hash"]).request(hostApply());
    expect(invalid.approved).toBe(false);
    expect(invalid.reason).toMatch(/64-character/);
  });

  it("never grants a host plan through --yes", async () => {
    const yes = new NonInteractiveApprovalHandler({
      assumeYes: true,
      approver: "--yes flag",
      clock,
    });
    expect((await yes.request(hostApply())).approved).toBe(false);
    expect((await yes.request(apply())).approved).toBe(false);
    // --yes next to --approve still grants only the listed hash.
    expect((await handler([HASH], true).request(hostApply())).approved).toBe(false);
  });

  it("refuses a teardown host plan (typed app name) even when its hash is listed", async () => {
    const decision = await handler([OTHER]).request(
      hostApply({ allowDestroy: true, confirmPhrase: "shop" }),
    );
    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/typed confirmation/);
    const phraseOnly = await handler([OTHER]).request(hostApply({ confirmPhrase: "shop" }));
    expect(phraseOnly.approved).toBe(false);
  });
});

describe("NonInteractiveApprovalHandler with a stack plan (the user's Portainer)", () => {
  const STACK = "12".repeat(32);
  const handler = (hashes: string[], assumeYes = false) =>
    new NonInteractiveApprovalHandler({
      approvePlanHashes: hashes,
      ...(assumeYes ? { assumeYes: true } : {}),
      approver: assumeYes ? "--yes flag" : "--approve flag",
      clock,
    });
  const stackApply = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    kind: "stack-apply",
    title: "Apply the stack plan to your Portainer (3 changes)",
    details: `Stack plan hash: ${STACK}`,
    planHash: STACK,
    ...overrides,
  });

  it("grants a stack plan only when its hash is listed with --approve", async () => {
    expect((await handler([HASH, STACK.toUpperCase()]).request(stackApply())).approved).toBe(true);
    const unlisted = await handler([HASH]).request(stackApply());
    expect(unlisted.approved).toBe(false);
    expect(unlisted.reason).toMatch(/stack plan's hash does not match/);
    expect((await handler([STACK]).request(stackApply({ planHash: undefined }))).approved).toBe(
      false,
    );
  });

  it("never grants a stack plan through --yes, with or without other hashes", async () => {
    const yes = new NonInteractiveApprovalHandler({ assumeYes: true, approver: "--yes", clock });
    expect((await yes.request(stackApply())).approved).toBe(false);
    expect((await handler([HASH], true).request(stackApply())).approved).toBe(false);
  });

  it("refuses a stack teardown (typed app name) even when its hash is listed", async () => {
    const decision = await handler([STACK]).request(
      stackApply({ allowDestroy: true, confirmPhrase: "shop" }),
    );
    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/typed confirmation/);
  });
});

describe("NonInteractiveApprovalHandler with --yes", () => {
  const handler = new NonInteractiveApprovalHandler({
    assumeYes: true,
    approver: "--yes flag",
    clock,
  });

  it("approves writing files, storing secrets, pushing and opening a pull request", async () => {
    for (const kind of ["repo-write", "github-secrets", "git-push", "pull-request"] as const) {
      const decision = await handler.request({ kind, title: kind, details: "" });
      expect(decision, kind).toMatchObject({ approved: true, approver: "--yes flag" });
    }
  });

  it("never approves an infrastructure apply, a host plan, a changed host key or a tool call", async () => {
    expect((await handler.request(apply())).approved).toBe(false);
    expect((await handler.request(apply({ kind: "host-apply" }))).approved).toBe(false);
    for (const kind of ["remote-exec", "tool-call"] as const) {
      expect((await handler.request({ kind, title: kind, details: "" })).approved).toBe(false);
    }
  });

  it("never buys a domain or changes its settings", async () => {
    for (const kind of ["domain-purchase", "domain-settings"] as const) {
      const decision = await handler.request({
        kind,
        title: kind,
        details: "",
        ...(kind === "domain-purchase" ? { confirmPhrase: "shopapp.com" } : {}),
      });
      expect(decision.approved, kind).toBe(false);
      expect(decision.reason).toMatch(/interactive terminal/);
    }
  });

  it("never approves anything that needs a typed confirmation", async () => {
    const decision = await handler.request({
      kind: "repo-write",
      title: "Overwrite",
      details: "",
      confirmPhrase: "shop",
    });
    expect(decision.approved).toBe(false);
  });
});

describe("InteractiveApprovalHandler", () => {
  const gitRunner = (name: string, exitCode = 0): CommandRunner => ({
    run: vi.fn(async () => ({ exitCode, stdout: `${name}\n`, stderr: "" })),
  });

  const setup = (prompts: Partial<ApprovalPrompts>, runner = gitRunner("Ada Lovelace")) => {
    const out: string[] = [];
    const fullPrompts: ApprovalPrompts = {
      confirm: vi.fn(async () => true),
      text: vi.fn(async () => ""),
      isCancel: (value: unknown): value is symbol => typeof value === "symbol",
      ...prompts,
    };
    const handler = new InteractiveApprovalHandler({
      stdout: (text) => out.push(text),
      runner,
      prompts: fullPrompts,
      clock,
      osUserName: () => "os-user",
    });
    return { handler, out, prompts: fullPrompts };
  };

  it("prints the request summary and approves on confirm, naming the git user", async () => {
    const { handler, out, prompts } = setup({ confirm: vi.fn(async () => true) });
    const decision = await handler.request(
      apply({
        costDelta: { amount: 4.51, currency: "EUR" },
        policy: [
          {
            policyId: "fw",
            title: "SSH open to the world",
            severity: "high",
            passed: false,
            message: "Restrict port 22.",
            resource: "hcloud_firewall.app",
          },
          { policyId: "ok", title: "Backups on", severity: "low", passed: true, message: "" },
        ],
      }),
    );
    const printed = out.join("");
    expect(printed).toContain("Create 4 resources on Hetzner Cloud");
    expect(printed).toContain("+ hcloud_server.app");
    expect(printed).toContain("SSH open to the world");
    expect(printed).toContain("Restrict port 22.");
    expect(printed).not.toContain("Backups on");
    expect(printed).toContain("+€4.51");
    expect(prompts.confirm).toHaveBeenCalledOnce();
    expect(prompts.text).not.toHaveBeenCalled();
    expect(decision).toEqual({
      approved: true,
      approver: "Ada Lovelace",
      decidedAt: "2026-10-11T09:00:00.000Z",
    });
  });

  it("refuses when the user declines or cancels", async () => {
    const declined = await setup({ confirm: vi.fn(async () => false) }).handler.request(apply());
    expect(declined.approved).toBe(false);
    const cancelled = await setup({ confirm: vi.fn(async () => Symbol("cancel")) }).handler.request(
      apply(),
    );
    expect(cancelled.approved).toBe(false);
    expect(cancelled.reason).toMatch(/cancel/);
  });

  it("requires the exact confirmation phrase when one is set", async () => {
    const request = apply({ allowDestroy: true, confirmPhrase: "my-server" });
    const ok = setup({ text: vi.fn(async () => " my-server ") });
    const approved = await ok.handler.request(request);
    expect(ok.prompts.confirm).not.toHaveBeenCalled();
    expect(approved).toMatchObject({ approved: true, confirmation: "my-server" });

    const wrong = await setup({ text: vi.fn(async () => "yes") }).handler.request(request);
    expect(wrong).toMatchObject({ approved: false, confirmation: "yes" });
    expect(wrong.reason).toMatch(/did not match/);

    const cancelled = await setup({ text: vi.fn(async () => Symbol("cancel")) }).handler.request(
      request,
    );
    expect(cancelled.approved).toBe(false);
  });

  it("falls back to the OS user name when git has no user.name", async () => {
    const noName = await setup({}, gitRunner("", 1)).handler.request(apply());
    expect(noName.approver).toBe("os-user");
    const noGit: CommandRunner = {
      run: async () => {
        throw new Error("spawn git ENOENT");
      },
    };
    const missing = await setup({}, noGit).handler.request(apply());
    expect(missing.approver).toBe("os-user");
  });
});
