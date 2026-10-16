import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { buyable, domainProject, domainTestPlan, TOKEN, visibleText } from "../testing";
import { buyDomain } from "./buy";
import { domainStatus, setDomainAutoRenew } from "./manage";

const DOMAIN = "shopapp.com";

/** A project whose plan records shopapp.com, bought through OpsCrew. */
async function boughtProject() {
  const project = await domainProject({ plan: domainTestPlan() });
  const first = await project.run();
  await buyDomain(first.deps, { domain: DOMAIN, services: first.services });
  project.cf.events.length = 0;
  return project;
}

describe("domainStatus", () => {
  it("says plainly when the project has no domain, without needing a token", async () => {
    const project = await domainProject({ plan: domainTestPlan() });
    const { deps, services } = await project.run({ token: null });

    const result = await domainStatus(deps, { services });

    expect(result.domain).toBeUndefined();
    expect(result.next.join("\n")).toContain("opscrew domain search");
    expect(project.cf.events).toEqual([]);
  });

  it("shows the registration, auto-renew and DNSSEC of the plan's domain", async () => {
    const project = await boughtProject();
    const { deps, services } = await project.run();

    const result = await domainStatus(deps, { services });

    expect(result.domain).toMatchObject({
      domain: DOMAIN,
      registrar: "cloudflare",
      expiresAt: "2027-10-11T12:00:05Z",
      autoRenew: true,
      locked: true,
      privacy: true,
    });
    expect(result.dnssec).toBe(true);
    expect(result.pendingPurchase).toBeUndefined();
    expect(result.next.join("\n")).toContain(
      "renews automatically up to 30 days before 2027-10-11",
    );
    expect(visibleText(deps)).not.toContain(TOKEN);
  });

  it("reports an unfinished purchase", async () => {
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
        registrar: "cloudflare",
      }),
    );

    const result = await domainStatus(deps, { services });

    expect(result.pendingPurchase).toEqual({
      domain: DOMAIN,
      requestedAt: "2026-10-11T11:59:00.000Z",
    });
    expect(result.next[0]).toContain("Run `opscrew domain buy shopapp.com` to finish it.");
  });

  it("records the registration of a domain bought before the plan existed, after a repo-write approval", async () => {
    // bought with no project files, then `opscrew design` wrote a plan serving app.shopapp.com
    const project = await domainProject();
    const first = await project.run();
    await buyDomain(first.deps, { domain: DOMAIN, services: first.services });
    const { deps, handler, services } = await project.run();
    const plan = domainTestPlan({ domain: `app.${DOMAIN}` });
    await writeArtifact("plan", deps.paths.files.plan, plan);
    expect(plan.dns.registration).toBeUndefined();

    const result = await domainStatus(deps, { services });

    expect(result.domain?.domain).toBe(DOMAIN);
    expect(handler.requests.map((r) => r.kind)).toEqual(["repo-write"]);
    expect(handler.requests[0]?.title).toBe(
      "Record the registration of shopapp.com in opscrew/plan.yaml",
    );
    expect(handler.requests[0]?.details).toContain("dns.zone becomes shopapp.com");
    expect(handler.requests[0]?.details).toContain("Nothing changes on Cloudflare.");
    const after = await readArtifact("plan", deps.paths.files.plan);
    expect(after.dns).toMatchObject({
      provider: "cloudflare",
      domain: `app.${DOMAIN}`,
      zone: DOMAIN,
      registration: {
        registrar: "cloudflare",
        registeredAt: "2026-10-11T12:00:05.000Z",
        expiresAt: "2027-10-11T12:00:05.000Z",
        autoRenew: true,
        privacy: true,
        dnssec: true,
      },
    });
    // nothing changed on Cloudflare and the next status run asks nothing
    expect(project.cf.registerCalls).toHaveLength(1);
    const again = await project.run();
    await domainStatus(again.deps, { services: again.services });
    expect(again.handler.requests).toEqual([]);
  });

  it("leaves the plan unchanged when recording the registration is refused, and says so", async () => {
    const project = await domainProject();
    const first = await project.run();
    await buyDomain(first.deps, { domain: DOMAIN, services: first.services });
    const { deps, services } = await project.run({ answer: () => false });
    const plan = domainTestPlan({ domain: DOMAIN });
    await writeArtifact("plan", deps.paths.files.plan, plan);

    const result = await domainStatus(deps, { services });

    expect(result.domain?.domain).toBe(DOMAIN);
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(plan);
    expect(result.next.join("\n")).toContain(
      "opscrew/plan.yaml does not record the registration of shopapp.com yet",
    );
  });

  it("says when the plan's domain is not registered with Cloudflare Registrar", async () => {
    const project = await domainProject({ plan: domainTestPlan({ domain: "app.example.com" }) });
    const { deps, services } = await project.run();

    const result = await domainStatus(deps, { services });

    expect(result.domain).toBeUndefined();
    expect(result.next.join("\n")).toContain("app.example.com is not registered with Cloudflare");
  });
});

describe("setDomainAutoRenew", () => {
  it("turns auto-renew off after an approval that shows the renewal date and price", async () => {
    const project = await boughtProject();
    const { deps, handler, services } = await project.run();

    const result = await setDomainAutoRenew(deps, { on: false, services });

    const [request] = handler.requests;
    expect(request).toMatchObject({
      kind: "domain-settings",
      title: "Turn auto-renew off for shopapp.com",
    });
    // future charges: the domain is typed (`--confirm` in scripts), `--yes` never grants it
    expect(request?.confirmPhrase).toBe(DOMAIN);
    expect(request?.details).toContain("Expires: 2027-10-11");
    expect(request?.details).toContain("Renewal price: $10.44 per year");
    // the approval comes before the change
    expect(project.cf.events.indexOf("approval domain-settings")).toBeLessThan(
      project.cf.events.indexOf(`setAutoRenew ${DOMAIN} off`),
    );
    expect(result.domain?.autoRenew).toBe(false);
    expect(result.next.join("\n")).toContain("Auto-renew is off");
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns.registration?.autoRenew).toBe(false);
    expect(deps.audit.entries.find((e) => e.action === "set auto-renew")).toMatchObject({
      target: DOMAIN,
      detail: "auto-renew off",
    });
  });

  it("turns auto-renew on, naming the charge before expiry", async () => {
    const project = await boughtProject();
    project.cf.domains.set(DOMAIN, {
      ...(project.cf.domains.get(DOMAIN) as NonNullable<ReturnType<typeof project.cf.domains.get>>),
      autoRenew: false,
    });
    project.cf.checks.set(DOMAIN, {
      domain: DOMAIN,
      registrable: false,
      renewal: buyable(DOMAIN, 9, 12).renewal,
    });
    const { deps, handler, services } = await project.run();

    await setDomainAutoRenew(deps, { on: true, services });

    expect(handler.requests[0]?.details).toContain(
      "up to 30 days before 2027-10-11, Cloudflare charges $12.00 per year",
    );
    expect(handler.requests[0]?.confirmPhrase).toBe(DOMAIN);
    expect(project.cf.autoRenewCalls).toEqual([{ domain: DOMAIN, on: true }]);
  });

  it("changes nothing when the change is refused or the domain is not typed exactly", async () => {
    const project = await boughtProject();
    const answers = [() => false, () => ({ approved: true, confirmation: "shopapp.co" })];
    for (const answer of answers) {
      const { deps, services } = await project.run({ answer });
      const before = await readArtifact("plan", deps.paths.files.plan);

      await expect(setDomainAutoRenew(deps, { on: false, services })).rejects.toMatchObject({
        code: "APPROVAL_REFUSED",
        message: expect.stringContaining("stays on"),
      });

      expect(project.cf.autoRenewCalls).toEqual([]);
      expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(before);
    }
  });

  it("asks nothing when auto-renew is already as requested", async () => {
    const project = await boughtProject();
    const { deps, handler, services } = await project.run();

    const result = await setDomainAutoRenew(deps, { on: true, services });

    expect(handler.requests).toEqual([]);
    expect(project.cf.autoRenewCalls).toEqual([]);
    expect(result.domain?.autoRenew).toBe(true);
  });

  it("stops when the project has no domain or Cloudflare does not hold it", async () => {
    const empty = await domainProject({ plan: domainTestPlan() });
    const run = await empty.run();
    await expect(
      setDomainAutoRenew(run.deps, { on: false, services: run.services }),
    ).rejects.toMatchObject({ code: "PHASE_PRECONDITION" });

    const elsewhere = await domainProject({ plan: domainTestPlan({ domain: "example.org" }) });
    const other = await elsewhere.run();
    await expect(
      setDomainAutoRenew(other.deps, { on: false, services: other.services }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("not registered with Cloudflare Registrar"),
    });
  });
});
