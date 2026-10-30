/**
 * Public SSH on a server of the private network (the `public-ssh` step, ADR 0022): once deploys
 * reach the servers from inside the network and the user's computer is a device, SSH can answer
 * on the network's interface only. Closing removes ufw's public rules for the SSH port that
 * OpsCrew added (comment `opscrew-ssh`; on a server OpsCrew created also cloud-init's uncommented
 * one) and keeps the rule on the interface; opening puts them back from the allowed sources. The
 * change runs under the dead-man switch the `ufw` step uses, so a lost connection undoes it.
 */
import { z } from "zod";
import { NetworkInterfaceSchema } from "./network";
import { canonicalSshSource } from "./parse";

/** Every IPv4 address, and every IPv6 address: together they are "from anywhere". */
const ANY_IPV4 = "0.0.0.0/0";
const ANY_IPV6 = "::/0";

/** A source as the plan's `security.sshAllowedCidrs` holds it, in canonical form. */
const SourceSchema = z
  .string()
  .refine((text) => text === ANY_IPV4 || text === ANY_IPV6 || canonicalSshSource(text) === text, {
    message: "must be an IPv4 or IPv6 address or network such as 203.0.113.0/24",
  });

/**
 * The `public-ssh` step's parameters (contracts/split-placement.md "ssh-host"): open or close
 * public SSH, the network's interface (whose SSH rule stays), the sources that may reach SSH when
 * it is open (`security.sshAllowedCidrs`), the port SSH answers on, and whether OpsCrew created
 * the server (then cloud-init's uncommented rule for the port is OpsCrew's too).
 */
export const PublicSshParamsSchema = z
  .strictObject({
    open: z.boolean(),
    interface: NetworkInterfaceSchema,
    allowedCidrs: z.array(SourceSchema),
    sshPort: z.int().min(1).max(65535),
    cloudServer: z.boolean(),
  })
  .refine((params) => !params.open || params.allowedCidrs.length > 0, {
    path: ["allowedCidrs"],
    message: "must name at least one source to open public SSH to",
  });
export type PublicSshParams = z.infer<typeof PublicSshParamsSchema>;

/** The step's parameters as a host plan keeps them: the sources space-separated and sorted. */
export function publicSshFields(
  params: PublicSshParams,
): Record<string, string | number | boolean> {
  return {
    open: params.open,
    interface: params.interface,
    allowedCidrs: [...new Set(params.allowedCidrs)].sort().join(" "),
    sshPort: params.sshPort,
    cloudServer: params.cloudServer,
  };
}

/** A host plan's `public-ssh` parameters ({@link publicSshFields}) read back and checked. */
export const PublicSshFieldsSchema = z
  .strictObject({
    open: z.boolean(),
    interface: z.string(),
    allowedCidrs: z.string().transform((text) => text.split(" ").filter((item) => item !== "")),
    sshPort: z.number(),
    cloudServer: z.boolean(),
  })
  .pipe(PublicSshParamsSchema);

/**
 * The ufw rules public SSH needs, as `ufw allow` takes them: `<port>/tcp` from anywhere (IPv4 and
 * IPv6), otherwise one rule per source. None when it closes.
 */
export function publicSshRules(params: PublicSshParams): string[] {
  if (!params.open) return [];
  const sources = [...new Set(params.allowedCidrs)].sort();
  if (sources.includes(ANY_IPV4) && sources.includes(ANY_IPV6)) {
    return [`${params.sshPort}/tcp`];
  }
  return sources.map((source) => `from ${source} to any port ${params.sshPort} proto tcp`);
}

/** The rule on the interface that keeps SSH reachable on the private network. */
export function networkSshRule(params: Pick<PublicSshParams, "interface" | "sshPort">): string {
  return `in on ${params.interface} to any port ${params.sshPort} proto tcp`;
}
