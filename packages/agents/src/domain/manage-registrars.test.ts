import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { buyable, domainProject, domainTestPlan, usd } from "../testing";
import { buyDomain } from "./buy";
import { domainStatus, setDomainAutoRenew } from "./manage";
import { registrarLinks } from "./registrars";

const DOMAIN = "shopapp.com";

/** A project whose plan records shopapp.com, bought through OpsCrew at the registrar. */
async function boughtAt(id: "porkbun" | "namecheap" | "godaddy") {
  const project = await domainProject({ plan: domainTestPlan() });
  const fake = project.other(id);
  fake.checks.set(DOMAIN, buyable(DOMAIN, 11.08, 12.5));
  fake.accountAutoRenew = true;
  const first = await project.run();
  await buyDomain(first.deps, { domain: DOMAIN, registrar: id, services: first.services });
  project.cf.events.length = 0;
  return { project, fake };
}

describe("domainStatus at another registrar", () => {
  it("shows the registrar's data for the plan's registrar, without a Cloudflare account", async () => {
    const { project } = await boughtAt("porkbun");
    const { deps, services } = await project.run({ token: null });

    const result = await domainStatus(deps, { services });

    expect(result.domain).toMatchObject({
      domain: DOMAIN,
      registrar: "porkbun",
      expiresAt: "2027-10-11T12:00:05Z",
      autoRenew: true,
    });
    expect(result.dnssec).toBe(true);
    expect(project.cf.events).not.toContain("accounts");
    expect(project.cf.events).toContain(`porkbun getDomain ${DOMAIN}`);
    expect(result.next.join("\n")).toContain("`opscrew domain auto-renew off`");
  });

  it("says where to change settings the registrar's API cannot change", async () => {
    const { project } = await boughtAt("namecheap");
    const { deps, services } = await project.run();

    const result = await domainStatus(deps, { services });

    expect(result.domain?.registrar).toBe("namecheap");
    const next = result.next.join("\n");
    expect(next).toContain(registrarLinks("namecheap").domains);
    expect(next).toContain("Namecheap's API cannot change it");
    // DNSSEC was not published through the API: the DS record to add is named
    expect(result.dnssec).toBe(false);
    expect(next).toContain("key tag 2371");
    expect(next).not.toContain("opscrew domain connect");
  });

  it("points to connect (never buy) for the DS record at a registrar with a DNSSEC API", async () => {
    const plan = domainTestPlan({ domain: DOMAIN });
    const project = await domainProject({
      plan: {
        ...plan,
        dns: {
          ...plan.dns,
          zone: DOMAIN,
          registration: { registrar: "porkbun", autoRenew: true, privacy: true, dnssec: false },
        },
      },
    });
    project.other("porkbun").own(DOMAIN);
    const { deps, services } = await project.run();

    const result = await domainStatus(deps, { services });

    const next = result.next.join("\n");
    expect(next).toContain(
      "Once Cloudflare shows its zone as active, run `opscrew domain connect shopapp.com` to add the zone's DS record at Porkbun",
    );
    expect(next).not.toContain("opscrew domain buy");
  });

  it("names the registrar in an unfinished purchase", async () => {
    const project = await domainProject();
    const { deps, services } = await project.run();
    const file = join(deps.paths.projectHomeDir, "domain-purchase.json");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        domain: DOMAIN,
        accountId: "acc-1",
        requestedAt: "2026-10-11T11:59:00.000Z",
        registrar: "godaddy",
        total: usd(11.99),
      }),
    );

    const result = await domainStatus(deps, { services });

    expect(result.next[0]).toContain(
      "Run `opscrew domain buy shopapp.com --registrar godaddy` to finish it.",
    );
  });

  it("says when the registrar's account does not hold the domain", async () => {
    const project = await domainProject({ plan: domainTestPlan({ domain: "app.example.com" }) });
    project.other("porkbun");
    const { deps, services } = await project.run();

    const result = await domainStatus(deps, { registrar: "porkbun", services });

    expect(result.domain).toBeUndefined();
    expect(result.next.join("\n")).toContain("not registered in this Porkbun account");
  });
});

describe("setDomainAutoRenew at another registrar", () => {
  it("changes auto-renew through the API where the registrar allows it, after the typed approval", async () => {
    const { project, fake } = await boughtAt("porkbun");
    const { deps, handler, services } = await project.run();

    const result = await setDomainAutoRenew(deps, { on: false, services });

    const [request] = handler.requests;
    expect(request).toMatchObject({
      kind: "domain-settings",
      title: "Turn auto-renew off for shopapp.com",
      confirmPhrase: DOMAIN,
    });
    expect(request?.details).toContain("in the Porkbun dashboard");
    expect(request?.details).not.toContain("Cloudflare");
    expect(project.cf.events.indexOf("approval domain-settings")).toBeLessThan(
      project.cf.events.indexOf(`porkbun setAutoRenew ${DOMAIN} off`),
    );
    expect(fake.autoRenewCalls).toEqual([{ domain: DOMAIN, on: false }]);
    expect(result.domain?.autoRenew).toBe(false);
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns.registration).toMatchObject({ registrar: "porkbun", autoRenew: false });
    expect(deps.audit.entries.find((e) => e.action === "set auto-renew")?.detail).toContain(
      "Porkbun",
    );
  });

  it("changes nothing at Porkbun when the change is refused", async () => {
    const { project, fake } = await boughtAt("porkbun");
    const { deps, services } = await project.run({ answer: () => false });

    await expect(setDomainAutoRenew(deps, { on: false, services })).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
    });
    expect(fake.autoRenewCalls).toEqual([]);
  });

  it("stops with the dashboard link where the API cannot change it: no approval, nothing changed", async () => {
    for (const id of ["namecheap", "godaddy"] as const) {
      const { project, fake } = await boughtAt(id);
      const { deps, handler, services } = await project.run();
      const before = await readArtifact("plan", deps.paths.files.plan);

      const error = await setDomainAutoRenew(deps, { on: false, services }).then(
        () => ({ code: "none", message: "", hint: "" }),
        (e: unknown) => e as { code: string; message: string; hint?: string },
      );

      expect(error.code, id).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("cannot change auto-renew");
      expect(error.hint).toContain(registrarLinks(id).domains);
      expect(handler.requests).toEqual([]);
      expect(fake.count("setAutoRenew")).toBe(0);
      expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(before);
    }
  });
});
