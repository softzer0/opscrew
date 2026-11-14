import { type DeployPlan, isCloudProvider, isHostingTarget } from "@opscrew/plan-schema";
import { usesCloudflare } from "../predicates";
import { beszelHostname, portainerHostname, sshHostname } from "../tunnel";
import type { RenderContext } from "../types";
import { managesPortainerRecords, portainerWebhookHostname } from "./portainer";

/**
 * The module calls of OpsCrew's roots that hold only Cloudflare resources: the app's records, its
 * tunnel and Access, Portainer webhook's tunnel and the Worker.
 */
export const CLOUDFLARE_MODULE_NAMES = [
  "dns",
  "tunnel",
  "access",
  "portainer_tunnel",
  "worker",
] as const;

/**
 * Whose a Cloudflare resource is: the zone's (it moves with the zone, and Cloudflare deletes it with
 * a moved zone) or the account's (a moved zone leaves it behind).
 */
export type CloudflareAddressScope = "zone" | "account";

/** The resource types that belong to a zone; every other Cloudflare resource is the account's. */
const ZONE_TYPES: ReadonlySet<string> = new Set([
  "cloudflare_dns_record",
  "cloudflare_certificate_pack",
]);

/**
 * `[module.<name>[<key>].][data.]<type>.<name>[<key>]`: the module call and the resource type. A
 * key may hold dots (`["www.example.com"]`), so it is matched to the end.
 */
const ADDRESS =
  /^(?:module\.([A-Za-z_][\w-]*)(?:\[[^\]]*\])?\.)?(?:data\.)?([A-Za-z_][\w-]*)\.[A-Za-z_][\w-]*(?:\[.*\])?$/;

/**
 * Whether the resource at `address` (as the engines' state lists it) is Cloudflare's, and then whose:
 * `zone` for `cloudflare_dns_record` and `cloudflare_certificate_pack`, `account` for every other
 * resource under one of {@link CLOUDFLARE_MODULE_NAMES} (`module.worker.terraform_data.worker`
 * too) and every other top-level `cloudflare_*` resource. `undefined` for everything else: servers,
 * networks, firewalls, keys, `random_*` and `terraform_data` outside those modules.
 * @throws Error when `address` is not a resource address.
 */
export function cloudflareAddressScope(address: string): CloudflareAddressScope | undefined {
  const match = ADDRESS.exec(address);
  const type = match?.[2];
  if (match === null || type === undefined) {
    throw new Error(`"${address}" isn't a resource address.`);
  }
  const module = match[1];
  const cloudflare =
    module === undefined
      ? type.startsWith("cloudflare_")
      : (CLOUDFLARE_MODULE_NAMES as readonly string[]).includes(module);
  if (!cloudflare) return undefined;
  return ZONE_TYPES.has(type) ? "zone" : "account";
}

/** The Cloudflare ids a root may have, by variable: where the render context holds each. */
const ACCOUNT_IDS = {
  cloudflare_zone_id: { key: "zoneId", label: "zone id" },
  cloudflare_account_id: { key: "accountId", label: "account id" },
  one_time_pin_identity_provider_id: {
    key: "oneTimePinIdentityProviderId",
    label: "id of the account's one-time PIN login method",
  },
} as const;

/**
 * The Cloudflare ids among the root's variables, with `ctx`'s values: `cloudflare_zone_id`,
 * `cloudflare_account_id` and `one_time_pin_identity_provider_id`, those the root has. `tfvars` is
 * the root's `terraform.tfvars.json`, where every root writes them. Rendered for another account,
 * a root's files differ only in these values, so planning the committed root with them as `-var`s
 * plans it in that account, and patching them in its `terraform.tfvars.json` moves it there.
 * @throws Error when `ctx` lacks an id the root has.
 */
export function accountVariables(
  tfvars: Readonly<Record<string, unknown>>,
  ctx: Pick<RenderContext, "cloudflare">,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ACCOUNT_IDS)
      .filter(([name]) => name in tfvars)
      .map(([name, { key, label }]) => {
        const id = ctx.cloudflare?.[key];
        if (!id) throw new Error(`This configuration needs the Cloudflare ${label}.`);
        return [name, id];
      }),
  );
}

/**
 * Every DNS name the plan's roots give an OpsCrew record or a Worker custom domain, with the app in
 * `zone` (in place of `dns.zone`), sorted: the app's domain and `www.` (except where OpsCrew
 * creates no record for them: a Portainer target behind the user's own proxy or Caddy without
 * `records`), a tunnel's SSH, Portainer and Beszel hostnames, Portainer webhook's hostname, a
 * hosting account's domain (no `www.`). GitHub's domain verification record, named after the
 * repository's owner, is not among them. None without a Cloudflare domain.
 */
export function opscrewRecordNames(plan: DeployPlan, zone: string): string[] {
  if (!usesCloudflare(plan)) return [];
  const inZone: DeployPlan = { ...plan, dns: { ...plan.dns, zone } };
  const { target, dns } = inZone;
  const domain = dns.domain as string;
  const app = [domain, ...(dns.www ? [`www.${domain}`] : [])];
  const names: (string | undefined)[] = [];
  if (target.provider === "portainer") {
    if (target.web.mode === "tunnel" || managesPortainerRecords(target)) names.push(...app);
    names.push(portainerWebhookHostname(inZone));
  } else if (isHostingTarget(target)) {
    names.push(domain);
  } else {
    names.push(...app);
    if (isCloudProvider(target.provider) || target.provider === "own") {
      names.push(sshHostname(inZone), portainerHostname(inZone), beszelHostname(inZone));
    }
  }
  return [...new Set(names.filter((name) => name !== undefined))].sort();
}

/** A Worker custom domain's address in the site's root, and its hostname. */
export interface WorkerCustomDomain {
  address: string;
  hostname: string;
}

/**
 * The Worker's custom domains in the root of a site on Cloudflare's hosting:
 * `module.worker.cloudflare_workers_custom_domain.domain[0]` for the domain and `.www[0]` for
 * `www.` when on. None for another target.
 */
export function workerCustomDomainAddresses(plan: DeployPlan): WorkerCustomDomain[] {
  const domain = plan.dns.domain;
  if (plan.target.provider !== "cloudflare-workers" || domain === undefined) return [];
  const address = (name: string) => `module.worker.cloudflare_workers_custom_domain.${name}[0]`;
  return [
    { address: address("domain"), hostname: domain },
    ...(plan.dns.www ? [{ address: address("www"), hostname: `www.${domain}` }] : []),
  ];
}
