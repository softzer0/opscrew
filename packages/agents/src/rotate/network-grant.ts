/**
 * `opscrew rotate grant:<device>/<service>` (025 plan.md 7., US5, FR-2508): a new password for a
 * device's own login (018's grants), shown once. A PostgreSQL, MySQL, MariaDB or MongoDB login
 * changes through the service's `grant` host plan (ADR 0011, approved by its hash): the old
 * password stops at once. A Valkey, Redis or Dragonfly login lives in the service's settings, so it
 * rotates as the services do on their servers (`rotateDeviceLogin`, `rotate.sh`): the new password
 * beside the old until the app's switch, then the old one dropped. A password reaches a server only
 * on standard input, and stays on this computer with the generated values; it is never logged or
 * audited.
 */
import { GrantParamsSchema } from "@opscrew/connector-ssh-host";
import { listText, OpsCrewError } from "@opscrew/core";
import { serviceSpec } from "@opscrew/iac-templates";
import { type DeployPlan, type PlanService, serverOfService } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { requireNoCloudflareMove } from "../provision/guard";
import { type RefreshRecoveryResult, refreshRecoveryCopy } from "../secrets/copy";
import { randomPassword, readValidJson, withApprovals, writePlanIfChanged } from "../shared";
import {
  GeneratedValuesSchema,
  generatedValuesFile,
  recordGeneratedEntries,
} from "../shared/app-secrets";
import {
  applyGrantPlan,
  connection,
  declared,
  memberAddress,
  passwordKey,
  type VpnConnection,
  type VpnGrantResult,
} from "../vpn/grants";
import { networkServer, requireServers, type VpnServices } from "../vpn/servers";
import { assertValuesCurrent, recordRotation } from "./record";
import { type RotateServicesOptions, rotateDeviceLogin } from "./server";

/** What {@link rotateGrant} reaches besides this computer. */
export interface GrantRotationOptions {
  /** The host plan's services, for a login a `grant` host plan changes. */
  services?: VpnServices;
  /** The servers' rotation's (GitHub, `--undo`), for a Valkey's, Redis's or Dragonfly's login. */
  servers: RotateServicesOptions;
}

/** A finished rotation of a device's login, or its undo. */
export interface GrantRotation {
  device: string;
  service: string;
  access: VpnGrantResult["access"];
  /** The service's private address on the app's network, and its port. */
  address: string;
  port: number;
  /** How the device signs in now: it holds the password, shown once; absent after an undo. */
  connection?: VpnConnection;
  /** The hash the change was approved by: the `grant` host plan's, or the rotation's on the servers. */
  hash: string;
  /** The recovery copy, refreshed with the new password: its files for the caller's pull request. */
  copy: RefreshRecoveryResult;
}

/**
 * The service `serviceName` of `plan` and `device`'s access to it.
 * @throws OpsCrewError `INVALID_INPUT` when the device has no login to it.
 */
function grantedService(
  plan: DeployPlan,
  device: string,
  serviceName: string,
  flags: string,
): { service: PlanService; access: VpnGrantResult["access"] } {
  const grants = plan.network?.grants ?? [];
  const grant = grants.find((g) => g.device === device && g.service === serviceName);
  if (grant === undefined) {
    const others = grants.filter((g) => g.device === device).map((g) => g.service);
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Device ${device} has no login to ${serviceName}, so there is none to rotate. Nothing was changed.`,
      {
        hint:
          others.length > 0
            ? `It has logins to ${listText(others)}; \`opscrew rotate${flags}\` lists what can be rotated.`
            : `\`opscrew rotate${flags}\` lists what can be rotated.`,
      },
    );
  }
  // The plan's rules guarantee the grant names an enabled service of a grantable kind.
  const service = plan.services.find((s) => s.name === grant.service) as PlanService;
  return { service, access: grant.access };
}

/**
 * The new password of a login a `grant` host plan changes: made (32 letters and digits),
 * registered with the redactor, set on the service's server by its host plan (shown and approved
 * by its own hash; the old one stops at once), then kept with the generated values. A plan that is
 * not approved changes nothing: the old password stays.
 */
async function newPasswordByHostPlan(
  deps: PhaseDeps,
  plan: DeployPlan,
  login: { device: string; service: PlanService; access: VpnGrantResult["access"] },
  input: { command: string; services: VpnServices },
): Promise<{ password: string; hash: string }> {
  const { device, service, access } = login;
  const key = passwordKey(device, service.name);
  const old = (await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema))?.grants?.[
    key
  ];
  if (old !== undefined) deps.redactor.addLiteral(old, "grant-password");
  const password = randomPassword(32);
  deps.redactor.addLiteral(password, "grant-password");
  const server = serverOfService(plan, service.name);
  const target = await networkServer(deps, plan, server, input.services);
  const params = GrantParamsSchema.parse({
    service: service.name,
    kind: service.kind,
    login: device,
    access,
    remove: false,
  });
  const outcome = await applyGrantPlan(deps, target, plan, params, input.command, {
    password,
    rewrite: true,
    title: `Give device ${device}'s login to ${service.name} a new password on server ${server}`,
  });
  await recordGeneratedEntries(deps, "grants", { [key]: password });
  await writePlanIfChanged(deps, withApprovals(plan, [outcome]));
  await recordRotation(deps, [`grant:${key}`]);
  deps.reporter.success(
    `Device ${device}'s login to ${service.name} (${serviceSpec(service.kind).title}) has a new password, and the old one no longer works.`,
  );
  return { password, hash: outcome.hash };
}

/**
 * Rotates the password of `device`'s own login to the service `serviceName` of `plan`
 * (`deps.paths`' environment), refused before any change when the device has no such login,
 * without servers, and by the two-computer guard. A PostgreSQL, MySQL, MariaDB or MongoDB login
 * gets its new password through its `grant` host plan ({@link newPasswordByHostPlan}; nothing to
 * undo: `options.servers.undo` is refused); a Valkey, Redis or Dragonfly login through
 * `rotateDeviceLogin`, which `options.servers.undo` undoes. Either way the recovery copy is
 * refreshed, and the result holds the connection details with the new password, which the caller prints once.
 * @throws OpsCrewError for the refusals, `APPROVAL_REFUSED`, and the change's error.
 */
export async function rotateGrant(
  deps: PhaseDeps,
  plan: DeployPlan,
  device: string,
  serviceName: string,
  options: GrantRotationOptions,
): Promise<GrantRotation> {
  requireNoCloudflareMove(plan);
  const { root, environment, app } = deps.paths;
  const flags = await commandFlags(root, environment, app);
  const command = `opscrew rotate grant:${device}/${serviceName}${flags}`;
  const { service, access } = grantedService(plan, device, serviceName, flags);
  requireServers(plan);
  let password: string | undefined;
  let hash: string;
  let copy: RefreshRecoveryResult;
  if (declared(service)) {
    ({ password, hash, copy } = await rotateDeviceLogin(
      deps,
      plan,
      { device, service },
      options.servers,
    ));
  } else {
    if (options.servers.undo === true) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `Device ${device}'s login to ${serviceName} changes in one step, so there is nothing to undo. Nothing was changed.`,
        { hint: `Run \`${command}\` for a new password.` },
      );
    }
    await assertValuesCurrent(deps);
    ({ password, hash } = await newPasswordByHostPlan(
      deps,
      plan,
      { device, service, access },
      { command, services: options.services ?? {} },
    ));
    copy = await refreshRecoveryCopy(deps, plan);
  }
  const server = serverOfService(plan, service.name);
  const address = memberAddress(plan, server);
  const { port } = serviceSpec(service.kind);
  if (password !== undefined) {
    deps.reporter.info(
      `The connection details are shown only now. The password stays on this computer, with OpsCrew's generated values (${generatedValuesFile(deps)}).`,
    );
  }
  return {
    device,
    service: service.name,
    access,
    address,
    port,
    ...(password === undefined
      ? {}
      : { connection: connection(service, device, password, address, port) }),
    hash,
    copy,
  };
}
