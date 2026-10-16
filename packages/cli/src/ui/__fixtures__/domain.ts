/**
 * A temp project for the `opscrew domain` command tests, wired to `@opscrew/agents/testing`'s
 * fakes: Cloudflare (accounts, registrar, extensions, zones), its zone records and scan, the public
 * DNS and Porkbun, Namecheap and GoDaddy accounts. Nothing here reaches the network. Tests only.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OtherRegistrarId } from "@opscrew/agents";
import {
  buyable,
  connectApi,
  FakeCloudflare,
  FakePublicDns,
  FakeRegistrar,
  FakeZoneRecords,
  TOKEN,
} from "@opscrew/agents/testing";
import type { RegistrarCapabilities } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { withServices } from "../../deps";
import { projectContext, ScriptedPrompts, type TempProject, tempProject } from "./harness";

export interface DomainTestProject {
  project: TempProject;
  /** Cloudflare; a purchase there succeeds at once. Every call of every fake goes to `cf.events`. */
  cf: FakeCloudflare;
  zones: FakeZoneRecords;
  dns: FakePublicDns;
  /** A Porkbun, Namecheap or GoDaddy account (created on first use), passed to every later run. */
  other(id: OtherRegistrarId, capabilities?: Partial<RegistrarCapabilities>): FakeRegistrar;
  /** A context for one run: scripted prompt answers, interactive or not. */
  context(options?: {
    interactive?: boolean;
    answers?: unknown[];
    token?: string | null;
  }): ReturnType<typeof projectContext> & { prompts: ScriptedPrompts };
  /** Writes OpsCrew's note about an earlier, unfinished purchase. */
  writePurchaseRecord(record: Record<string, unknown>): Promise<string>;
  /** `<projectHome>/domain-purchase.json`. */
  readonly recordFile: string;
}

/** An empty temp project, the domain fakes and contexts wired to them. */
export async function domainTestProject(): Promise<DomainTestProject> {
  const project = await tempProject();
  const cf = new FakeCloudflare();
  cf.checks.set("shopapp.com", buyable("shopapp.com"));
  cf.firstState = "succeeded";
  const zones = new FakeZoneRecords(cf.events, cf.zoneApi);
  const dns = new FakePublicDns(cf.events);
  const others = new Map<OtherRegistrarId, FakeRegistrar>();
  const paths = resolveProjectPaths(project.root, { env: project.env });
  const recordFile = path.join(paths.projectHomeDir, "domain-purchase.json");
  return {
    project,
    cf,
    zones,
    dns,
    recordFile,
    other(id, capabilities) {
      const fake = others.get(id) ?? new FakeRegistrar(id, cf.events, capabilities);
      others.set(id, fake);
      return fake;
    },
    context(options = {}) {
      const token = options.token === undefined ? TOKEN : options.token;
      const prompts = new ScriptedPrompts(options.answers ?? []);
      const ctx = projectContext(
        {
          ...project,
          env: { ...project.env, ...(token === null ? {} : { CLOUDFLARE_API_TOKEN: token }) },
        },
        { interactive: options.interactive ?? false, services: { prompts, fetch: dns.fetch } },
      );
      const registrars = Object.fromEntries(
        [...others].map(([id, fake]) => [id, connectApi(fake, cf.events)] as const),
      );
      withServices(ctx, {
        domain: {
          ...cf.services(),
          zones: zones.api(),
          ...(others.size === 0 ? {} : { registrars }),
          randomUUID: () => "00000000-0000-4000-8000-000000000001",
        },
      });
      return Object.assign(ctx, { prompts });
    },
    async writePurchaseRecord(record) {
      await mkdir(path.dirname(recordFile), { recursive: true });
      await writeFile(recordFile, JSON.stringify(record));
      return recordFile;
    },
  };
}
