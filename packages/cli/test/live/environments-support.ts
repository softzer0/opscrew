/**
 * Pure helpers of feature 015's live tests (`environments.test.ts`, `runners.test.ts`; docs/e2e.md
 * "Environments and promotion" to "A runner machine"): their variables, whether a firewall's SSH
 * sources reach into GitHub's Actions address ranges, strings shaped like a runner's registration
 * token, the cleanup's order, the private parts of a runner's credentials, the promotion an
 * `opscrew promote` run asks to approve, and a GitHub environment's rules. No network, no
 * processes; unit-tested in `environments-support.test.ts`.
 */

/** The variables of the Hetzner environment and runner tests besides their gate. */
export const ENVIRONMENT_E2E_VARIABLES = [
  "OPSCREW_E2E_HCLOUD_TOKEN",
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_DOMAIN",
] as const;

/** The variables of the environment rules test on the public repository besides its gate. */
export const RULES_E2E_VARIABLES = [
  "OPSCREW_E2E_HCLOUD_TOKEN",
  "OPSCREW_E2E_GITHUB_REPO_C",
  "OPSCREW_E2E_GITHUB_TOKEN",
] as const;

// ---------------------------------------------------------------------------------------------
// Address ranges.

interface Cidr {
  family: 4 | 6;
  network: bigint;
  prefix: number;
}

function ipv4Bits(text: string): bigint {
  const parts = text.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    throw new Error(`${text} is not an IPv4 address.`);
  }
  return parts.reduce((bits, part) => (bits << 8n) | BigInt(part), 0n);
}

function ipv6Bits(text: string): bigint {
  const halves = text.split("::");
  if (halves.length > 2) throw new Error(`${text} is not an IPv6 address.`);
  const groups = (half: string | undefined) =>
    half === undefined || half === "" ? [] : half.split(":");
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    throw new Error(`${text} is not an IPv6 address.`);
  }
  const all = [...head, ...Array<string>(halves.length === 1 ? 0 : missing).fill("0"), ...tail];
  return all.reduce((bits, group) => {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) throw new Error(`${text} is not an IPv6 address.`);
    return (bits << 16n) | BigInt(`0x${group}`);
  }, 0n);
}

/** `<address>/<prefix>` (or a bare address, a single host) as numbers. */
function parseCidr(text: string): Cidr {
  const [address = "", length] = text.trim().split("/");
  const family = address.includes(":") ? 6 : 4;
  const width = family === 4 ? 32 : 128;
  const prefix = length === undefined ? width : Number(length);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) {
    throw new Error(`${text} has no valid prefix length.`);
  }
  return { family, network: family === 4 ? ipv4Bits(address) : ipv6Bits(address), prefix };
}

/** Whether the address ranges `a` and `b` share an address (both IPv4 or both IPv6). */
export function cidrsOverlap(a: string, b: string): boolean {
  const x = parseCidr(a);
  const y = parseCidr(b);
  if (x.family !== y.family) return false;
  const width = BigInt(x.family === 4 ? 32 : 128);
  const host = width - BigInt(Math.min(x.prefix, y.prefix));
  const mask = ((1n << width) - 1n) ^ ((1n << host) - 1n);
  return (x.network & mask) === (y.network & mask);
}

/** The `sources` that share an address with any of `ranges` (GitHub's Actions ranges). */
export function overlapping(sources: readonly string[], ranges: readonly string[]): string[] {
  return sources.filter((source) => ranges.some((range) => cidrsOverlap(source, range)));
}

/** An inbound or outbound rule of a Hetzner Cloud firewall as its API lists it. */
export interface ListedFirewallRule {
  direction: string;
  protocol: string;
  /** A port (`22`), a range (`1024-65535`), or none (every port, or ICMP). */
  port?: string | null;
  source_ips?: string[];
}

/** Whether `port` (a Hetzner rule's port or range, none for every port) includes `wanted`. */
function portIncludes(port: string | null | undefined, wanted: number): boolean {
  if (port === undefined || port === null || port === "") return true;
  const [from = "", to = from] = port.split("-");
  return Number(from) <= wanted && wanted <= Number(to);
}

/** Every source address range that the inbound TCP rules let reach SSH (port 22). */
export function sshSources(rules: readonly ListedFirewallRule[]): string[] {
  return [
    ...new Set(
      rules
        .filter(
          (rule) =>
            rule.direction === "in" && rule.protocol === "tcp" && portIncludes(rule.port, 22),
        )
        .flatMap((rule) => rule.source_ips ?? []),
    ),
  ];
}

// ---------------------------------------------------------------------------------------------
// The cleanup's order.

/**
 * The cleanup's order: `destroy` for each of `pending` (newest first) within `budgetMs` in all,
 * each given the time left for its CLI runs, a failure or a destroy still running when the budget
 * ends only logged; then `afterwards` (the API deletions), always, whatever the destroys did.
 */
export async function destroyWithinBudget(
  options: {
    pending: readonly string[];
    destroy: (environment: string, timeLeft: () => number) => Promise<void>;
    budgetMs: number;
    log: (message: string) => void;
  },
  afterwards: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + options.budgetMs;
  const timeLeft = () => deadline - Date.now();
  try {
    for (const environment of options.pending) {
      if (timeLeft() <= 0) {
        options.log(`no time left to destroy ${environment} with opscrew; the API deletes it`);
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("it was still running when the cleanup's budget ended")),
          timeLeft(),
        );
      });
      try {
        await Promise.race([options.destroy(environment, timeLeft), late]);
      } catch (error) {
        options.log(
          `opscrew destroy of ${environment} failed (${String(error).split("\n")[0]}); the API deletes what is left`,
        );
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await afterwards();
  }
}

// ---------------------------------------------------------------------------------------------
// The runners' secrets.

/**
 * A GitHub Actions runner registration or remove token: 29 upper-case letters and digits starting
 * with `A` (the spike's tokens, research.md "Spike results"), standing alone.
 */
const RUNNER_TOKEN_SHAPE = /(?<![A-Za-z0-9])A[A-Z0-9]{28}(?![A-Za-z0-9])/g;

/**
 * How many strings in `text` are shaped like a runner's registration token. OpsCrew never shows
 * the token, and the test never sees it, so the leak search looks for its shape.
 */
export function runnerTokenShapes(text: string): number {
  return [...text.matchAll(RUNNER_TOKEN_SHAPE)].length;
}

/** The private parameters of a runner's RSA key in its `.credentials_rsaparams` file. */
const RSA_PRIVATE_PARTS = ["d", "dp", "dq", "inverseq", "p", "q"];

/**
 * The secret values of a registered runner's `.credentials_rsaparams` (its RSA key's private
 * parameters, base64), for the leak search; never the public modulus or exponent.
 */
export function runnerCredentialSecrets(json: unknown): string[] {
  if (json === null || typeof json !== "object") return [];
  return Object.entries(json).flatMap(([key, value]) =>
    RSA_PRIVATE_PARTS.includes(key.toLowerCase()) && typeof value === "string" && value.length >= 16
      ? [value]
      : [],
  );
}

// ---------------------------------------------------------------------------------------------
// Promotion and GitHub environments.

/**
 * The promotion an `opscrew promote` run showed and asked to approve, from the command it printed
 * for it (`opscrew promote --to <env> --digest sha256:… --approve <hash>`); the last one when it
 * printed several, `undefined` when none.
 */
export function promotionApproval(output: string): { digest: string; hash: string } | undefined {
  const matches = [
    ...output.matchAll(
      /opscrew promote --to \S+ --digest (sha256:[0-9a-f]{64}) --approve ([0-9a-f]{64})\b/g,
    ),
  ];
  const last = matches.at(-1);
  return last?.[1] === undefined || last[2] === undefined
    ? undefined
    : { digest: last[1], hash: last[2] };
}

/** What GitHub enforces in one of its environments. */
export interface EnvironmentRules {
  /** How many required reviewers it lists. */
  reviewers: number;
  /** Minutes each deploy waits; 0 without a wait timer. */
  waitTimer: number;
  /** Which branches may deploy to it; `null`: every branch. */
  branchPolicy: { protectedBranches: boolean; customBranchPolicies: boolean } | null;
}

/** The rules in GitHub's answer for one environment (`GET /repos/{r}/environments/{name}`). */
export function environmentRules(json: unknown): EnvironmentRules {
  const view = json as
    | {
        protection_rules?: { type?: string; reviewers?: unknown[]; wait_timer?: number }[];
        deployment_branch_policy?: {
          protected_branches?: boolean;
          custom_branch_policies?: boolean;
        } | null;
      }
    | undefined;
  const rules = view?.protection_rules ?? [];
  const policy = view?.deployment_branch_policy;
  return {
    reviewers: rules
      .filter((rule) => rule.type === "required_reviewers")
      .reduce((count, rule) => count + (rule.reviewers?.length ?? 0), 0),
    waitTimer: rules.find((rule) => rule.type === "wait_timer")?.wait_timer ?? 0,
    branchPolicy:
      policy === undefined || policy === null
        ? null
        : {
            protectedBranches: policy.protected_branches === true,
            customBranchPolicies: policy.custom_branch_policies === true,
          },
  };
}

// ---------------------------------------------------------------------------------------------
// Cloudflare's brief 52x answers while an origin pull setting rolls out.

/** How far from a rollout a 52x answer may be sent and still be Cloudflare's brief one. */
export const ORIGIN_PULL_BLIP_MS = 3_000;

/**
 * Why a failed request is Cloudflare's brief 52x answer while a per-hostname Authenticated Origin
 * Pulls setting rolls out, which the founder accepted (docs/guide/origin-protection.md, "Known
 * limits", 2026-10-23): an HTTP 520 to 527 sent within {@link ORIGIN_PULL_BLIP_MS} of a rollout in
 * `deploys` (epoch milliseconds, from the account's audit log). `undefined` for anything else.
 */
export function originPullBlip(
  failure: { at: string; what: string },
  deploys: readonly number[],
): string | undefined {
  if (!/^HTTP 52[0-7]$/.test(failure.what)) return undefined;
  const sent = Date.parse(failure.at);
  const near = deploys.find((at) => Math.abs(sent - at) <= ORIGIN_PULL_BLIP_MS);
  if (near === undefined) return undefined;
  const offset = sent - near;
  return `${failure.what}, ${Math.abs(offset)} ms ${offset >= 0 ? "after" : "before"} Cloudflare rolled out an origin pull setting (${new Date(near).toISOString()})`;
}
