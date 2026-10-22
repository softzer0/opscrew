import { runDns } from "@opscrew/agents";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { addEnvOption } from "../ui/environment";
import {
  addHostKeyOption,
  addPlanApproveOptions,
  type InfraFlags,
  runInfraCommand,
  YES_DESCRIPTION,
} from "./provision";

interface DnsFlags extends InfraFlags {
  domain?: string;
}

/**
 * `opscrew dns`: sets (or changes) the plan's Cloudflare domain and runs the same plan → policies
 * → approval bound to the plan hash → apply path as `provision` (FR-214). Exit codes: 0 done,
 * 1 refused or a policy failed, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("dns")
    .description("Point your domain at the new servers through Cloudflare")
    .option(
      "--domain <fqdn>",
      "Hostname the app should use, for example app.example.com (default: the plan's domain)",
    );
  addPlanApproveOptions(command);
  addEnvOption(command);
  addHostKeyOption(command)
    .option("--yes", YES_DESCRIPTION)
    .action(({ domain, ...flags }: DnsFlags) => {
      const fqdn = domain?.trim();
      return runInfraCommand(ctx, "dns", flags, (deps, options) =>
        runDns(deps, { ...options, ...(fqdn ? { domain: fqdn } : {}) }),
      );
    });
}
