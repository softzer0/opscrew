import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import type { ConnectDomainOptions, ConnectDomainResult } from "./types";

/**
 * Moves a domain the user already owns onto Cloudflare DNS: copies its records into a new zone,
 * then switches the nameservers at the registrar (T708).
 */
export async function connectDomain(
  _deps: PhaseDeps,
  _options: ConnectDomainOptions,
): Promise<ConnectDomainResult> {
  throw new OpsCrewError("INTERNAL", "Connecting a domain is not implemented yet.", {
    hint: "Update OpsCrew; `opscrew domain connect` arrives with feature 007.",
  });
}
