import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { connectProject, SEEDED_CONTACT, TOKEN, visibleText } from "../testing";
import { requireCloudflareToken } from "./common";
import { findDomainRegistrar } from "./registrar-lookup";
import { resolveDomainServices } from "./services";

const DOMAIN = "example.com";

async function caught(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** A run with the registrar fakes wired in; `setUp` configures them first. */
async function lookup(setUp: (cp: Awaited<ReturnType<typeof connectProject>>) => void) {
  const cp = await connectProject();
  setUp(cp);
  const run = await cp.run();
  // as a command does first: the token is registered with the redactor
  requireCloudflareToken(run.deps);
  const services = resolveDomainServices(run.deps, run.services);
  const find = () => findDomainRegistrar(run.deps, services, DOMAIN, "acc-1");
  return { cp, deps: run.deps, find };
}

function noLeak(deps: Parameters<typeof visibleText>[0], error?: unknown): void {
  const text = visibleText(deps, error);
  expect(text).not.toContain(TOKEN);
  for (const value of Object.values(SEEDED_CONTACT)) expect(text).not.toContain(value);
}

describe("findDomainRegistrar", () => {
  it("finds the one configured registrar account that holds the domain", async () => {
    const { cp, deps, find } = await lookup((cp) => {
      cp.other("porkbun");
      cp.other("namecheap").own(DOMAIN);
    });

    const found = await find();

    expect(found).toMatchObject({ kind: "api", registrarId: "namecheap" });
    expect(found.kind === "api" && found.registrar.id).toBe("namecheap");
    expect(cp.project.cf.events).toEqual([
      `porkbun ownsDomain ${DOMAIN}`,
      `namecheap ownsDomain ${DOMAIN}`,
    ]);
    noLeak(deps);
  });

  it("finds Cloudflare Registrar in the account given when no other registrar holds it", async () => {
    const { cp, deps, find } = await lookup((cp) => {
      cp.other("godaddy");
      cp.project.cf.own(DOMAIN);
    });

    expect(await find()).toEqual({ kind: "cloudflare" });
    expect(cp.project.cf.events).toEqual([`godaddy ownsDomain ${DOMAIN}`, `getDomain ${DOMAIN}`]);
    noLeak(deps);
  });

  it("says another registrar, without an error, when no account it can ask holds the domain", async () => {
    const withRegistrar = await lookup((cp) => cp.other("porkbun"));
    expect(await withRegistrar.find()).toEqual({ kind: "other" });

    // no registrar configured: only Cloudflare Registrar is asked
    const alone = await lookup(() => {});
    expect(await alone.find()).toEqual({ kind: "other" });
    expect(alone.cp.project.cf.events).toEqual([`getDomain ${DOMAIN}`]);
  });

  it("stops before any change when a registrar account can't be checked and Cloudflare doesn't hold it", async () => {
    const { deps, find } = await lookup((cp) => {
      cp.other("porkbun");
      cp.ownsErrors.set("porkbun", new Error(`porkbun said no for ${TOKEN}`));
    });

    const error = await caught(find());

    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain(`OpsCrew could not tell where ${DOMAIN} is registered`);
    expect(error.message).toContain("Porkbun could not be checked");
    expect(error.message).toMatch(/Nothing was changed\.$/);
    noLeak(deps, error);
  });

  it("does not stop for an account it can't check when Cloudflare Registrar holds the domain", async () => {
    const { find } = await lookup((cp) => {
      cp.other("porkbun");
      cp.ownsErrors.set("porkbun", new Error("timeout"));
      cp.project.cf.own(DOMAIN);
    });

    expect(await find()).toEqual({ kind: "cloudflare" });
  });

  it("stops when two registrar accounts both hold the domain", async () => {
    const { find } = await lookup((cp) => {
      cp.other("porkbun").own(DOMAIN);
      cp.other("godaddy").own(DOMAIN);
    });

    const error = await caught(find());

    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain(
      "more than one of your registrar accounts (Porkbun and GoDaddy)",
    );
    expect(error.message).toMatch(/Nothing was changed\.$/);
  });
});
