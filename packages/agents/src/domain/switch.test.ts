import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { domainProject, ZONE_DS, ZONE_NAMESERVERS } from "../testing";
import { registrarLinks } from "./registrars";
import { SANDBOX_NAMESERVERS, SANDBOX_ZONES } from "./services";
import {
  dsRecordText,
  ensureZone,
  pointToZone,
  publishDs,
  type SwitchContext,
  switchToCloudflare,
} from "./switch";

const DOMAIN = "shopapp.com";
const ZONE = `zone-${DOMAIN}`;
const PUBLISH = { publishDs: true };

async function setup(
  id: "porkbun" | "namecheap" | "godaddy" = "porkbun",
  capabilities: { nameservers?: boolean } = {},
) {
  const project = await domainProject();
  const fake = project.other(id, capabilities);
  fake.own(DOMAIN);
  const { deps } = await project.run();
  const ctx: SwitchContext = {
    deps,
    account: { id: "acc-1", name: "Shop" },
    zones: project.cf.zoneApi,
    domain: DOMAIN,
    registrarId: id,
    registrar: fake.api(),
  };
  return { project, fake, deps, ctx };
}

describe("switchToCloudflare", () => {
  it("creates the zone, then points the nameservers, then publishes DS, then asks for activation", async () => {
    const { project, fake, ctx } = await setup();

    const result = await switchToCloudflare(ctx, PUBLISH);

    expect(project.cf.events).toEqual([
      `createZone acc-1 ${DOMAIN}`,
      `porkbun getNameservers ${DOMAIN}`,
      `porkbun setNameservers ${DOMAIN} ${ZONE_NAMESERVERS.join(",")}`,
      `dnssecEnabled ${ZONE}`,
      `enableDnssec ${ZONE}`,
      `dsRecord ${ZONE}`,
      `porkbun listDsRecords ${DOMAIN}`,
      `porkbun addDsRecord ${DOMAIN} 2371`,
      `activationCheck ${ZONE}`,
    ]);
    expect(result).toMatchObject({
      zone: { id: ZONE },
      nameservers: { outcome: "set", nameservers: ZONE_NAMESERVERS },
      ds: { outcome: "added", ds: { keyTag: 2371 } },
      activation: { requested: true },
      dnssec: true,
    });
    expect(fake.nameservers.get(DOMAIN)).toEqual(ZONE_NAMESERVERS);
  });

  it("is idempotent: a second run changes nothing at the registrar", async () => {
    const { project, fake, ctx } = await setup();
    await switchToCloudflare(ctx, PUBLISH);
    project.cf.events.length = 0;

    const again = await switchToCloudflare(ctx, PUBLISH);

    expect(again.nameservers.outcome).toBe("already");
    expect(again.ds.outcome).toBe("already");
    expect(again.dnssec).toBe(true);
    expect(fake.count("setNameservers")).toBe(1);
    expect(fake.count("addDsRecord")).toBe(1);
    expect(project.cf.count("enableDnssec")).toBe(1);
  });

  it("returns the DS values where the API cannot publish them (the caller shows them once); DNSSEC is then not claimed", async () => {
    const { fake, deps, ctx } = await setup("godaddy");

    const result = await switchToCloudflare(ctx, PUBLISH);

    expect(result.ds).toMatchObject({ outcome: "manual", ds: { keyTag: 2371 } });
    expect(result.ds.outcome === "manual" && dsRecordText(result.ds.ds ?? ZONE_DS)).toBe(
      "key tag 2371, algorithm 13, digest type 2, digest ABCDEF0123",
    );
    expect(result.dnssec).toBe(false);
    expect(fake.count("addDsRecord")).toBe(0);
    expect(deps.reporter.text()).not.toContain("key tag 2371");
    expect(deps.reporter.text()).not.toContain(registrarLinks("godaddy").domains);
  });

  it("leaves DNSSEC for later when asked to (a domain that may be live, zone not active)", async () => {
    const { project, fake, ctx } = await setup();

    const result = await switchToCloudflare(ctx, { publishDs: false });

    expect(result.ds).toEqual({ outcome: "later" });
    expect(result.dnssec).toBe(false);
    expect(fake.count("addDsRecord")).toBe(0);
    expect(project.cf.count("enableDnssec")).toBe(0);
    expect(fake.nameservers.get(DOMAIN)).toEqual(ZONE_NAMESERVERS);
  });

  it("prints the nameservers and the dashboard link where the API cannot set them", async () => {
    const { fake, deps, ctx } = await setup("namecheap", { nameservers: false });
    const zone = await ensureZone(ctx);

    const result = await pointToZone(ctx, zone);

    expect(result).toEqual({ outcome: "manual", nameservers: [...ZONE_NAMESERVERS] });
    expect(fake.count("setNameservers")).toBe(0);
    expect(fake.count("getNameservers")).toBe(0);
    expect(deps.reporter.text()).toContain(`${ZONE_NAMESERVERS[0]} and ${ZONE_NAMESERVERS[1]}`);
    expect(deps.reporter.text()).toContain(registrarLinks("namecheap").domains);
  });

  it("says when Cloudflare has no DS record yet, without failing", async () => {
    const { deps, ctx } = await setup();
    const pending = { ...ctx, zones: { ...ctx.zones, dsRecord: async () => undefined } };
    const zone = await ensureZone(pending);

    const result = await publishDs(pending, zone);

    expect(result.outcome).toBe("pending");
    expect(deps.reporter.text()).toContain("has not produced the DS record");
  });

  it("does not fail when the activation check is refused or errors", async () => {
    const { project, deps, ctx } = await setup();
    project.cf.activation = { requested: false, reason: "too soon" };
    const first = await switchToCloudflare(ctx, PUBLISH);
    expect(first.activation.requested).toBe(false);

    project.cf.failures.activationCheck = () =>
      new OpsCrewError("PROVIDER_ERROR", "Cloudflare is busy.");
    project.cf.zones.set(DOMAIN, {
      ...(project.cf.zones.get(DOMAIN) ?? { id: ZONE, name: DOMAIN }),
      status: "pending",
    });
    const second = await switchToCloudflare(ctx, PUBLISH);
    expect(second.activation.requested).toBe(false);
    expect(deps.reporter.text()).toContain("checks the nameservers on its own");
  });

  it("with stand-in zones (registrar sandbox) sets the stand-in nameservers and says DNSSEC and the activation check were skipped", async () => {
    const { project, deps, fake, ctx } = await setup();

    const result = await switchToCloudflare({ ...ctx, zones: SANDBOX_ZONES }, PUBLISH);

    expect(result.nameservers.outcome).toBe("set");
    expect(fake.nameservers.get(DOMAIN)).toEqual(SANDBOX_NAMESERVERS);
    expect(result.ds.outcome).toBe("skipped");
    expect(result.activation.skipped).toBe(true);
    expect(result.dnssec).toBe(false);
    const actions = deps.audit.entries.map((e) => e.action);
    expect(actions).not.toContain("enable DNSSEC");
    expect(actions).not.toContain("zone activation check");
    expect(fake.count("addDsRecord")).toBe(0);
    expect(project.cf.events).toEqual([
      `porkbun getNameservers ${DOMAIN}`,
      `porkbun setNameservers ${DOMAIN} ${SANDBOX_NAMESERVERS.join(",")}`,
    ]);
  });

  it("stops plainly when the zone has no nameservers", async () => {
    const { ctx } = await setup();

    const error = await pointToZone(ctx, { id: ZONE, name: DOMAIN }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toContain("nameservers");
  });
});
