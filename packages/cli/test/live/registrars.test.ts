/**
 * Live domain purchases in the Porkbun and Namecheap sandboxes (FR-710): nothing real is bought.
 * Skipped unless the OPSCREW_E2E_* variables of a registrar are set; see docs/e2e.md. The Porkbun
 * pass refuses to run with keys that are not sandbox keys (`pk1_sb_`), and the Namecheap pass always
 * sets NAMECHEAP_SANDBOX=1. Registrar sandboxes get stand-in Cloudflare zones (the sandbox domains
 * do not exist), so a Cloudflare token is only used to resolve the account.
 */
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NamecheapClient } from "@opscrew/connector-namecheap";
import { PorkbunClient, PorkbunRegistrar } from "@opscrew/connector-porkbun";
import { NodeCommandRunner } from "@opscrew/core";
import { materializeFixture } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";

const E2E = {
  cloudflareToken: process.env.OPSCREW_E2E_CLOUDFLARE_REGISTRAR_TOKEN,
  account: process.env.OPSCREW_E2E_CLOUDFLARE_ACCOUNT_ID,
  porkbunKey: process.env.OPSCREW_E2E_PORKBUN_API_KEY,
  porkbunSecret: process.env.OPSCREW_E2E_PORKBUN_SECRET_KEY,
  namecheapUser: process.env.OPSCREW_E2E_NAMECHEAP_API_USER,
  namecheapKey: process.env.OPSCREW_E2E_NAMECHEAP_API_KEY,
  namecheapUserName: process.env.OPSCREW_E2E_NAMECHEAP_USERNAME,
  namecheapClientIp: process.env.OPSCREW_E2E_NAMECHEAP_CLIENT_IP,
};
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CLI = join(REPO_ROOT, "packages/cli/dist/opscrew.js");
const EXAMPLE = join(REPO_ROOT, "examples/nextjs-postgres");
/** The nameservers of the stand-in zones registrar sandboxes get (agents' SANDBOX_NAMESERVERS). */
const SANDBOX_NAMESERVERS = ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"];
const runner = new NodeCommandRunner();

interface Offer {
  domain: string;
  registrable: boolean;
  firstYear?: { amount: number; currency: string };
}

/** A planned project (analyze, interview, design on the example) and a CLI runner in it. */
async function plannedProject(registrarEnv: Record<string, string>) {
  expect(existsSync(CLI), "build the CLI first: pnpm --filter opscrew build").toBe(true);
  const work = await mkdtemp(join(tmpdir(), "opscrew-e2e-registrar-"));
  const repo = join(work, "repo");
  const env: Record<string, string | undefined> = {
    ...process.env,
    CI: "1",
    OPSCREW_HOME: join(work, "home"),
    CLOUDFLARE_API_TOKEN: E2E.cloudflareToken,
    ...registrarEnv,
  };
  for (const name of Object.keys(env)) if (name.startsWith("OPSCREW_E2E_")) delete env[name];
  for (const name of ["HCLOUD_TOKEN", "DIGITALOCEAN_TOKEN", "DIGITALOCEAN_ACCESS_TOKEN"]) {
    delete env[name];
  }
  await materializeFixture(EXAMPLE, repo);
  await runner.run("git", ["-C", repo, "init", "-q"], { env });
  const opscrew = async (...args: string[]) => {
    const result = await runner.run(process.execPath, [CLI, ...args], {
      cwd: repo,
      env,
      timeoutMs: 10 * 60_000,
    });
    return { ...result, output: `${result.stdout}\n${result.stderr}` };
  };
  expect((await opscrew("analyze", "--no-ai")).exitCode).toBe(0);
  await writeFile(
    join(work, "answers.json"),
    JSON.stringify({
      expectedMonthlyUsers: "<1k",
      budgetMonthly: 20,
      provider: "hetzner",
      region: "eu-central",
      uptime: "best-effort",
      dataCriticality: "important",
      dnsProvider: "none",
      keepExternalServices: [],
    }),
  );
  expect((await opscrew("interview", "--answers", join(work, "answers.json"))).exitCode).toBe(0);
  expect((await opscrew("design")).exitCode).toBe(0);
  return { repo, opscrew };
}

/** `domain search --registrar <id> --json` for `domain`, returning its row (if listed). */
async function searchRow(
  opscrew: Awaited<ReturnType<typeof plannedProject>>["opscrew"],
  registrar: string,
  domain: string,
): Promise<Offer | undefined> {
  const search = await opscrew("domain", "search", domain, "--registrar", registrar, "--json");
  expect(search.exitCode, search.output).toBe(0);
  const parsed = JSON.parse(search.stdout) as { results: Offer[] };
  return parsed.results.find((r) => r.domain === domain);
}

const porkbunReady = Boolean(
  E2E.cloudflareToken && E2E.account && E2E.porkbunKey && E2E.porkbunSecret,
);

describe.skipIf(!porkbunReady)("live registrar purchase (Porkbun sandbox)", () => {
  it("buys, points at Cloudflare, manages DNSSEC and connects a second domain without buying a real one", {
    timeout: 20 * 60_000,
  }, async () => {
    const apiKey = E2E.porkbunKey as string;
    const secretApiKey = E2E.porkbunSecret as string;
    // Never run against live keys: those would buy real domains.
    expect(apiKey.startsWith("pk1_sb_"), "OPSCREW_E2E_PORKBUN_API_KEY must be a sandbox key").toBe(
      true,
    );
    const client = new PorkbunClient({ apiKey, secretApiKey });
    expect(client.sandbox).toBe(true);
    // Fresh sandbox credit, so the purchases are covered.
    const reset = await fetch("https://api.porkbun.com/api/json/v3/sandbox/reset", {
      method: "POST",
      headers: { "X-API-Key": apiKey, "X-Secret-API-Key": secretApiKey },
    });
    expect(reset.ok, `sandbox reset: HTTP ${reset.status}`).toBe(true);

    const { repo, opscrew } = await plannedProject({
      PORKBUN_API_KEY: apiKey,
      PORKBUN_SECRET_API_KEY: secretApiKey,
    });
    const account = E2E.account as string;
    const domain = `opscrew-e2e-${Date.now().toString(36)}.com`;
    const row = await searchRow(opscrew, "porkbun", domain);
    expect(row?.registrable, `${domain} is available at Porkbun`).toBe(true);
    const maxPrice = row?.firstYear ? `${row.firstYear.amount}${row.firstYear.currency}` : "100USD";

    // Without --confirm a script must not buy.
    const refused = await opscrew("domain", "buy", domain, "--registrar", "porkbun");
    expect(refused.exitCode, refused.output).toBe(1);
    expect(refused.output).toContain("--confirm");

    const bought = await opscrew(
      "domain",
      "buy",
      domain,
      "--registrar",
      "porkbun",
      "--account",
      account,
      "--confirm",
      domain,
      "--max-price",
      maxPrice,
      "--yes",
    );
    expect(bought.exitCode, bought.output).toBe(0);
    expect(bought.output).toContain("sandbox");
    for (const secret of [apiKey, secretApiKey, E2E.cloudflareToken as string]) {
      expect(bought.output).not.toContain(secret);
    }

    // The domain is registered and points at the (stand-in) Cloudflare zone's nameservers.
    expect((await client.getDomain(domain))?.domain).toBe(domain);
    expect((await client.getNs(domain)).map((n) => n.toLowerCase()).sort()).toEqual(
      SANDBOX_NAMESERVERS,
    );
    const plan = await readArtifact("plan", join(repo, "opscrew/plan.yaml"));
    expect(plan.dns.domain).toBe(domain);
    expect(plan.dns.registration).toMatchObject({ registrar: "porkbun" });

    // Status and auto-renew go through Porkbun's API.
    const shown = await opscrew("domain", "status");
    expect(shown.exitCode, shown.output).toBe(0);
    expect(shown.output).toContain(domain);
    const off = await opscrew("domain", "auto-renew", "off", "--confirm", domain);
    expect(off.exitCode, off.output).toBe(0);

    // DS records and the record listing through the adapter (the sandbox has no real delegation).
    const registrar = new PorkbunRegistrar(client);
    const ds = { keyTag: 2371, algorithm: 13, digestType: 2, digest: "ab".repeat(32) };
    await registrar.addDsRecord(domain, ds);
    expect((await registrar.listDsRecords(domain)).map((d) => d.keyTag)).toContain(2371);
    await registrar.removeDsRecord(domain, 2371);
    expect((await registrar.listDsRecords(domain)).map((d) => d.keyTag)).not.toContain(2371);

    // A second sandbox domain on Porkbun's own nameservers, connected through `domain connect`.
    const owned = `opscrew-e2e-c${Date.now().toString(36)}.com`;
    const quote = await registrar.quote(owned, 1);
    const first = await registrar.register({
      domain: owned,
      years: 1,
      autoRenew: false,
      privacy: true,
      quote,
      idempotencyKey: `opscrew-e2e-${owned}`,
    });
    expect(first.state).toBe("succeeded");
    const connected = await opscrew(
      "domain",
      "connect",
      owned,
      "--registrar",
      "porkbun",
      "--account",
      account,
      "--confirm",
      owned,
      "--yes",
      "--json",
    );
    expect(connected.exitCode, connected.output).toBe(0);
    const result = JSON.parse(connected.stdout) as { outcome: string; nameservers: string[] };
    expect(result.outcome).toBe("connected");
    expect((await client.getNs(owned)).map((n) => n.toLowerCase()).sort()).toEqual(
      SANDBOX_NAMESERVERS,
    );
  });
});

const namecheapReady = Boolean(
  E2E.cloudflareToken && E2E.account && E2E.namecheapUser && E2E.namecheapKey,
);

describe.skipIf(!namecheapReady)("live registrar purchase (Namecheap sandbox)", () => {
  it("checks the account, buys with the default address and points the domain at Cloudflare", {
    timeout: 20 * 60_000,
  }, async () => {
    const namecheapEnv: Record<string, string> = {
      NAMECHEAP_SANDBOX: "1",
      NAMECHEAP_API_USER: E2E.namecheapUser as string,
      NAMECHEAP_API_KEY: E2E.namecheapKey as string,
      ...(E2E.namecheapUserName ? { NAMECHEAP_USERNAME: E2E.namecheapUserName } : {}),
      ...(E2E.namecheapClientIp ? { NAMECHEAP_CLIENT_IP: E2E.namecheapClientIp } : {}),
    };
    const { repo, opscrew } = await plannedProject(namecheapEnv);
    const client = new NamecheapClient({
      apiUser: namecheapEnv.NAMECHEAP_API_USER as string,
      apiKey: namecheapEnv.NAMECHEAP_API_KEY as string,
      sandbox: true,
      ...(E2E.namecheapUserName ? { userName: E2E.namecheapUserName } : {}),
      ...(E2E.namecheapClientIp
        ? { clientIp: E2E.namecheapClientIp }
        : {
            detectClientIp: async () => {
              const trace = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
              return /^ip=(.*)$/m.exec(trace)?.[1]?.trim() ?? "";
            },
          }),
    });
    // API access, whitelisting and the balance (users.getBalances).
    const balance = await client.getBalances();
    expect(balance).toBeDefined();

    const account = E2E.account as string;
    const domain = `opscrew-e2e-${Date.now().toString(36)}.com`;
    const row = await searchRow(opscrew, "namecheap", domain);
    expect(row?.registrable, `${domain} is available at Namecheap`).toBe(true);
    const maxPrice = row?.firstYear ? `${row.firstYear.amount}${row.firstYear.currency}` : "100USD";

    const bought = await opscrew(
      "domain",
      "buy",
      domain,
      "--registrar",
      "namecheap",
      "--account",
      account,
      "--confirm",
      domain,
      "--max-price",
      maxPrice,
      "--yes",
    );
    expect(bought.exitCode, bought.output).toBe(0);
    expect(bought.output).toContain("sandbox");
    expect(bought.output).not.toContain(E2E.namecheapKey as string);

    // Registered (domains.getList) and pointed at the stand-in zone (domains.dns.setCustom).
    expect((await client.listDomains(domain)).map((d) => d.domain)).toContain(domain);
    const dns = await client.getDnsList(domain);
    expect(dns.nameservers.map((n) => n.toLowerCase()).sort()).toEqual(SANDBOX_NAMESERVERS);
    const plan = await readArtifact("plan", join(repo, "opscrew/plan.yaml"));
    expect(plan.dns.registration).toMatchObject({ registrar: "namecheap" });

    // Auto-renew cannot change through Namecheap's API: OpsCrew says where, changes nothing.
    const renew = await opscrew("domain", "auto-renew", "off", "--confirm", domain);
    expect(renew.output).toContain("namecheap.com");
  });
});
