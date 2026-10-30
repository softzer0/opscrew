import { sha256Hex } from "@opscrew/core";
import {
  UFW_NETWORK_COMMENT,
  UFW_NETWORK_LOCAL_COMMENT,
  UFW_NETWORK_SSH_COMMENT,
} from "./constants";
import { DOCKER_POOLS, type NetworkStepParams, networkConfig, networkDropIn } from "./network";
import {
  NETWORK_FILTER_UNIT_TEXT,
  type NetworkFilterParams,
  networkFilterDropIn,
  networkFilterScript,
} from "./network-filter";

/**
 * SHA-256 of the files the `network` step writes for these parameters: the interface's
 * configuration (no key in it) and Docker's drop-in for the host's OpsCrew interfaces (this one
 * and `otherInterfaces`), as inspection reports them (`HostFacts.network`).
 */
export function networkFileHashes(params: NetworkStepParams): { config: string; dropIn: string } {
  return {
    config: sha256Hex(networkConfig(params)),
    dropIn: sha256Hex(networkDropIn([params.interface, ...params.otherInterfaces])),
  };
}

/**
 * The ufw rules the `network` step adds for these parameters, as inspection reads them
 * (`HostFacts.firewall.ufwRules`): WireGuard's UDP port, SSH on the interface, and the host's
 * Docker networks to each local port on the private address.
 */
export function networkUfwRules(params: NetworkStepParams): { rule: string; comment: string }[] {
  const ip = params.address.slice(0, params.address.indexOf("/"));
  return [
    { rule: `allow ${params.port}/udp`, comment: UFW_NETWORK_COMMENT },
    {
      rule: `allow in on ${params.interface} to any port ${params.sshPort} proto tcp`,
      comment: UFW_NETWORK_SSH_COMMENT,
    },
    ...DOCKER_POOLS.flatMap((pool) =>
      [...new Set(params.localPorts)].map((port) => ({
        rule: `allow from ${pool} to ${ip} port ${port} proto tcp`,
        comment: UFW_NETWORK_LOCAL_COMMENT,
      })),
    ),
  ];
}

/**
 * SHA-256 of the files the `network-filter` step writes for these parameters: the interface's
 * filter script, the templated unit and Docker's drop-in for the interface's filter.
 */
export function networkFilterFileHashes(params: NetworkFilterParams): {
  script: string;
  unit: string;
  dropIn: string;
} {
  return {
    script: sha256Hex(networkFilterScript(params)),
    unit: sha256Hex(NETWORK_FILTER_UNIT_TEXT),
    dropIn: sha256Hex(networkFilterDropIn(params.interface)),
  };
}
