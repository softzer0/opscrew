import { isIP } from "node:net";
import { type DeployPlan, isHostingTarget } from "@opscrew/plan-schema";
import { zoneTfvars, zoneVariables } from "../infra/cloudflare";
import {
  besideInfraDir,
  CLOUDFLARE_PROVIDER,
  CLOUDFLARE_PROVIDER_BLOCK,
  moduleBlock,
  output,
  rootHeader,
  variablesTf,
  versionsTf,
} from "../infra/hcl";
import { MODULE_FILES } from "../infra/modules";
import { wrongTarget } from "../providers";
import type { RenderContext, RenderedFile } from "../types";

/** The vendored module the root uses: `cloudflare-dns` itself, without its GitHub Pages mode. */
const DNS_MODULE = "cloudflare-dns";

/**
 * The root module of an app on a hosting account whose domain is on Cloudflare (027 plan 2), under
 * `plan.infra.dir`, with the vendored `cloudflare-dns` module beside it: the `cloudflare-dns`
 * module's hosting mode, one A record from the hostname to the account's `address`, DNS only (the
 * account serves the hostname with its own certificate, which the panel issues once the name points
 * at it), with no AAAA, `www.` or CAA record. The address is the account's public one, which the
 * record publishes anyway. Deterministic; contains no secrets.
 * @throws OpsCrewError `PHASE_PRECONDITION` for another target; Error without a zone id or an IPv4
 * address.
 */
export function renderHostingDns(
  plan: DeployPlan,
  ctx: RenderContext,
  address: string,
): RenderedFile[] {
  if (!isHostingTarget(plan.target)) {
    throw wrongTarget("This step only applies to an app on a hosting account.");
  }
  if (!ctx.cloudflare?.zoneId) {
    throw new Error("A Cloudflare zone id is required to render DNS for this plan.");
  }
  if (isIP(address) !== 4) throw new Error(`${address} isn't an IPv4 address.`);
  const dir = plan.infra.dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const modules = besideInfraDir(plan, "modules");
  const main = [
    rootHeader(plan),
    "",
    ...CLOUDFLARE_PROVIDER_BLOCK,
    ...moduleBlock({
      comment: [
        "# The app on a hosting account: its hostname's A record to the account's address, DNS only.",
        "# The account serves the hostname with its own certificate, which the panel issues once the",
        "# name points at it; Cloudflare's proxy would stand in its way.",
      ],
      name: "dns",
      source: DNS_MODULE,
      args: [
        ["zone_id", "var.cloudflare_zone_id"],
        ["domain", "var.domain"],
        ["ipv4", "var.account_ipv4"],
        ["ipv6_record", "false"],
        ["proxied", "false"],
      ],
    }),
  ].join("\n");
  const variables = variablesTf(plan, [
    ...zoneVariables("domain"),
    {
      name: "account_ipv4",
      type: "string",
      description: "The hosting account's public IPv4 address, which its sites answer on.",
    },
  ]);
  const outputs = [rootHeader(plan), "", ...output("url", "module.dns.url")].join("\n");
  const tfvars = {
    ...zoneTfvars(plan, ctx, "domain"),
    account_ipv4: address,
  };
  const vendored = Object.entries(MODULE_FILES)
    .filter(([path]) => path.slice(0, path.lastIndexOf("/")) === DNS_MODULE)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([path, content]): RenderedFile => ({ path: `${modules}/${path}`, content, kind: "infra" }),
    );
  return [
    { path: `${dir}/versions.tf`, content: versionsTf(plan, [CLOUDFLARE_PROVIDER]), kind: "infra" },
    { path: `${dir}/main.tf`, content: main, kind: "infra" },
    { path: `${dir}/variables.tf`, content: variables, kind: "infra" },
    { path: `${dir}/outputs.tf`, content: outputs, kind: "infra" },
    {
      path: `${dir}/terraform.tfvars.json`,
      content: `${JSON.stringify(tfvars, null, 2)}\n`,
      kind: "infra",
    },
    ...vendored,
  ];
}
