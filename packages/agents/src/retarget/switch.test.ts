// T2321: the AAAA record in a move when one side has no IPv6 address. The records follow the live
// side, so a switch (and an abort's restore) between sides of different address families creates
// or deletes the AAAA record, and nothing else beyond updating the records in place.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResourceChange } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { updateServerAddresses } from "../shared";
import { OLD_IDS, OLD_IPV4 } from "../testing";
import { caught } from "./__fixtures__/assert";
import { NEW_IPV4, type PairHarness, pairHarness } from "./__fixtures__/pairs";
import { abortRetarget } from "./abort";
import { planBounded } from "./plans";
import { moveOf } from "./session";
import { dnsOnlyLead, dnsSwitchChange, sideAaaa, switchStep } from "./switch";

const MAIN_TF = "opscrew/infra/prod/main.tf";
const A = "module.dns.cloudflare_dns_record.a";
const AAAA = "module.dns.cloudflare_dns_record.aaaa[0]";

const change = (address: string, action: ResourceChange["action"]): ResourceChange => ({
  address,
  type: address.split(".").at(-2) ?? "",
  name: address.split(".").at(-1) ?? "",
  provider: "registry.opentofu.org/cloudflare/cloudflare",
  action,
});

describe("dnsSwitchChange", () => {
  const allows = (from: boolean, to: boolean, c: ResourceChange) => dnsSwitchChange(from, to)(c);

  it("allows the records' in-place updates whatever the address families", () => {
    for (const [from, to] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      expect(allows(from, to, change(A, "update"))).toBe(true);
      expect(allows(from, to, change(AAAA, "update"))).toBe(true);
      expect(allows(from, to, change("module.dns.cloudflare_dns_record.www[0]", "update"))).toBe(
        true,
      );
    }
  });

  it("deletes the AAAA record only when the side DNS goes to has no IPv6", () => {
    expect(allows(true, false, change(AAAA, "delete"))).toBe(true);
    expect(allows(true, true, change(AAAA, "delete"))).toBe(false);
    expect(allows(false, true, change(AAAA, "delete"))).toBe(false);
    expect(allows(false, false, change(AAAA, "delete"))).toBe(false);
  });

  it("creates the AAAA record only when the side DNS goes to has IPv6 and the other had none", () => {
    expect(allows(false, true, change(AAAA, "create"))).toBe(true);
    expect(allows(true, true, change(AAAA, "create"))).toBe(false);
    expect(allows(true, false, change(AAAA, "create"))).toBe(false);
    expect(allows(false, false, change(AAAA, "create"))).toBe(false);
  });

  it("refuses anything else, also during a change of family", () => {
    for (const [from, to] of [
      [true, false],
      [false, true],
    ] as const) {
      for (const refused of [
        change(A, "delete"),
        change(A, "create"),
        change(AAAA, "replace"),
        change("module.dns.cloudflare_dns_record.www[0]", "create"),
        change("module.dns.cloudflare_dns_record.www[0]", "delete"),
        change('module.dns.cloudflare_dns_record.caa["letsencrypt.org"]', "delete"),
        change("module.server.hcloud_server.this", "delete"),
        change("cloudflare_dns_record.aaaa[0]", from ? "delete" : "create"),
      ]) {
        expect(allows(from, to, refused), `${refused.action} ${refused.address}`).toBe(false);
      }
    }
  });

  it("names what it refused in the switch's stop", () => {
    const check = planBounded({
      lead: dnsOnlyLead("DNS switch"),
      change: dnsSwitchChange(true, false),
      hint: "",
    });
    expect(() =>
      check({ changes: [change(A, "update"), change(AAAA, "delete")], moves: [] }),
    ).not.toThrow();
    expect(() =>
      check({ changes: [change(A, "update"), change(AAAA, "create")], moves: [] }),
    ).toThrow(/would do more than update the DNS records in place[\s\S]*create .*aaaa\[0\]/);
  });
});

/** The new side, or the old one, has an IPv4 address only, here and in OpsCrew's local state. */
async function ipv4Only(h: PairHarness, which: "old" | "new"): Promise<void> {
  const key = which === "old" ? "from" : "next";
  const address = { ipv4: which === "old" ? OLD_IPV4 : NEW_IPV4 };
  h.session.servers = { ...h.session.servers, [key]: address };
  await updateServerAddresses(h.paths, (current) => ({
    ...current,
    retarget: { ...current.retarget, [key]: address },
  }));
}

type Effect = Parameters<NonNullable<PairHarness["engine"]["tamper"]>>[0];

/**
 * Makes the fake engine keep the app's AAAA record as the real engines do (the fake updates A and
 * AAAA together): it exists while the rendered DNS module's `ipv6_record` holds for the address
 * variables the engine is given, so a plan creates, deletes or updates it. Returns its state.
 */
function trackAaaa(h: PairHarness, present: boolean): { present: boolean } {
  const state = { present };
  const after = new Map<Effect, boolean>();
  h.engine.tamper = (effect) => {
    const main = readFileSync(join(h.root, MAIN_TF), "utf8");
    const dns = /^module "dns" \{$[\s\S]*?^\}$/m.exec(main)?.[0] ?? "";
    const record = /^ {2}ipv6_record += (.+)$/m.exec(dns)?.[1];
    const variable = record === undefined ? undefined : /^var\.(\w+) != null$/.exec(record)?.[1];
    const wanted =
      record === undefined ||
      (variable !== undefined && h.session.env[`TF_VAR_${variable}`] !== undefined);
    effect.changes = effect.changes.filter((c) => c.name !== "aaaa");
    const action = wanted
      ? state.present
        ? effect.dnsTo !== undefined && "update"
        : "create"
      : state.present && "delete";
    if (dns !== "" && action) effect.changes.push(change(AAAA, action));
    after.set(effect, wanted);
  };
  const apply = h.engine.apply.bind(h.engine);
  h.engine.apply = async (dir, planFile, approval) => {
    const result = await apply(dir, planFile, approval);
    const effect = h.engine.plans.find((p) => p.hash === approval.approvedPlanHash)?.effect;
    const wanted = effect === undefined ? undefined : after.get(effect);
    if (result.ok && wanted !== undefined) state.present = wanted;
    return result;
  };
  return state;
}

/** What the applies did to the AAAA record, in order. */
const aaaaApplies = (h: PairHarness) =>
  h.events.flatMap((e) =>
    e.type !== "apply"
      ? []
      : [
          ...e.creates.filter((a) => a === AAAA).map(() => "create"),
          ...e.deletes.filter((a) => a === AAAA).map(() => "delete"),
          ...e.updates.filter((a) => a === AAAA).map(() => "update"),
        ],
  );

describe("sideAaaa", () => {
  it("follows each side's address family as the layouts render it", async () => {
    const h = await pairHarness("hetzner", "own", { step: "migrated" });
    expect([sideAaaa(h.session, "old"), sideAaaa(h.session, "new")]).toEqual([true, true]);
    await ipv4Only(h, "new");
    expect([sideAaaa(h.session, "old"), sideAaaa(h.session, "new")]).toEqual([true, false]);
    // A cloud server always has IPv6, whatever OpsCrew recorded of it.
    h.session.servers = { ...h.session.servers, from: { ipv4: OLD_IPV4 } };
    expect(sideAaaa(h.session, "old")).toBe(true);
  });
});

describe.skipIf(!findExecutable("git"))(
  "a move between a cloud server (IPv4 and IPv6) and the user's own server (IPv4 only)",
  () => {
    /** Approves every typed deletion of the abort. */
    const abort = (h: PairHarness) =>
      abortRetarget(h.deps, { services: h.services, confirm: async () => true });

    it("switches to the own server: the A record is updated and the AAAA record deleted", async () => {
      const h = await pairHarness("hetzner", "own", { step: "migrated" });
      await ipv4Only(h, "new");
      const aaaa = trackAaaa(h, true);
      expect(await switchStep(h.session, {})).toBeUndefined();
      expect(moveOf(h.session).step).toBe("switched");
      expect(aaaaApplies(h)).toEqual(["delete"]);
      expect(aaaa.present).toBe(false);
      expect(h.engine.dnsServer()?.ipv4).toBe(NEW_IPV4);
      const approval = h.handler.requests.find((r) => r.kind === "iac-apply");
      expect(approval?.details).toContain("The AAAA record of shop.example.com is deleted");
    });

    it("switches back to the cloud server: the AAAA record is created", async () => {
      const h = await pairHarness("own", "hetzner", { step: "migrated" });
      await ipv4Only(h, "old");
      const aaaa = trackAaaa(h, false);
      expect(await switchStep(h.session, {})).toBeUndefined();
      expect(moveOf(h.session).step).toBe("switched");
      expect(aaaaApplies(h)).toEqual(["create"]);
      expect(aaaa.present).toBe(true);
      expect(h.engine.dnsServer()?.ipv4).toBe(NEW_IPV4);
    });

    it("still refuses a switch that would delete the AAAA record when the new side has IPv6", async () => {
      const h = await pairHarness("hetzner", "own", { step: "migrated" });
      trackAaaa(h, true);
      const tamper = h.engine.tamper;
      h.engine.tamper = (effect) => {
        tamper?.(effect);
        if (effect.dnsTo !== undefined) {
          effect.changes = effect.changes.filter((c) => c.address !== AAAA);
          effect.changes.push(change(AAAA, "delete"));
        }
      };
      const error = await caught(switchStep(h.session, {}));
      expect(error.message).toContain(dnsOnlyLead("DNS switch"));
      expect(error.message).toContain(`delete ${AAAA}`);
      expect(moveOf(h.session).step).toBe("migrated");
    });

    // The own server is the IPv4-only side; `present`: the AAAA record before the move.
    for (const [from, to, ipv4OnlySide, present] of [
      ["hetzner", "own", "new", true],
      ["own", "hetzner", "old", false],
    ] as const) {
      it(`${from} to ${to}: an abort before the switch leaves the AAAA record as it is`, async () => {
        const h = await pairHarness(from, to, { step: "deployed" });
        await ipv4Only(h, ipv4OnlySide);
        const aaaa = trackAaaa(h, present);
        expect(await abort(h)).toMatchObject({ step: "aborted", done: true });
        expect(aaaaApplies(h)).toEqual([]);
        expect(aaaa.present).toBe(present);
        expect((await readArtifact("plan", h.paths.files.plan)).target.provider).toBe(from);
      });

      it(`${from} to ${to}: an abort after a switch that failed half-way restores the AAAA record`, async () => {
        const h = await pairHarness(from, to, { step: "migrated" });
        await ipv4Only(h, ipv4OnlySide);
        const aaaa = trackAaaa(h, present);
        // The apply changed the records, then failed.
        h.engine.failApply = (effect) => {
          if (effect.dnsTo === undefined) return undefined;
          h.engine.state.dns = effect.dnsTo;
          aaaa.present = !present;
          return "Error: Cloudflare API timeout";
        };
        const error = await caught(switchStep(h.session, {}));
        expect(error.message).toContain("The switch failed");
        expect(moveOf(h.session).step).toBe("deployed");
        h.engine.failApply = undefined;

        expect(await abort(h)).toMatchObject({ step: "aborted", done: true });
        // The failed switch changed the AAAA record; the restore puts it back as it was.
        const [switched, restored] = present ? ["delete", "create"] : ["create", "delete"];
        expect(aaaaApplies(h)).toEqual([switched, restored]);
        expect(aaaa.present).toBe(present);
        expect(h.engine.state.dns).toBe(from === "hetzner" ? OLD_IDS.hetzner : OLD_IPV4);
      });
    }
  },
);
