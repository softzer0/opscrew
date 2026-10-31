import {
  type PhaseDeps,
  type VpnGrantResult,
  vpnAdd,
  vpnGrant,
  vpnList,
  vpnRemove,
  vpnRevoke,
} from "@opscrew/agents";
import type { Command } from "commander";
import { renderUnicodeCompact } from "uqr";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { collect } from "../ui/deploy";
import { type AppEnvFlags, addEnvOption, chooseEnvironment } from "../ui/environment";
import { checkApproveFlags } from "./provision";

/** Help text of `--approve <hash>` on the `vpn` commands. */
const APPROVE_DESCRIPTION =
  "Apply exactly the host plan with this hash (printed when a run stopped at it); give it once per server";

/** The flags every `vpn` command takes. */
interface VpnFlags extends AppEnvFlags {
  /** Every `--approve <hash>`: one per server's host plan. */
  approve?: string[];
}

/** Adds `--app`, `--env` and the repeatable `--approve <hash>` to `command`. */
function addVpnOptions(command: Command): Command {
  return addEnvOption(command).option("--approve <hash>", APPROVE_DESCRIPTION, collect);
}

/**
 * The phase deps of a `vpn` command (`command`, as the user runs it again) for the app and
 * environment it acts on, granting exactly the `--approve` hashes in a script.
 */
async function vpnDeps(ctx: CliContext, flags: VpnFlags, command: string): Promise<PhaseDeps> {
  const hashes = checkApproveFlags(command, { approve: flags.approve ?? [] }, `opscrew ${command}`);
  const { app, name } = await chooseEnvironment(ctx, flags, command);
  return createPhaseDeps(ctx, {
    ai: false,
    app,
    environment: name,
    approveHashes: hashes,
  });
}

/** The device's configuration as a QR code for the WireGuard app on a phone. */
function printQr(ctx: CliContext, config: string): void {
  ctx.stdout(
    [
      "",
      renderUnicodeCompact(config, { border: 2 }),
      "",
      "Scan it in the WireGuard app (Add a tunnel, then Scan from QR code). It holds the device's private key: clear the terminal once it is scanned.",
      "",
    ].join("\n"),
  );
}

/**
 * The connection details of a grant, shown once: the client's line (it asks for the password),
 * then the password and the URL with it, written unredacted and never logged.
 */
function printConnection(ctx: CliContext, result: VpnGrantResult): void {
  const { device, service, access, connection } = result;
  ctx.stdout(
    `\nDevice ${device}'s ${access} login to ${service}, shown only now (with the device's WireGuard tunnel on):\n  ${connection.client}\n`,
  );
  ctx.showOnce(
    `  Password: ${connection.password}\n  URL for DBeaver and other graphical clients: ${connection.url}\n`,
  );
}

interface AddFlags extends VpnFlags {
  thisComputer?: boolean;
  qr?: boolean;
  again?: boolean;
}

interface GrantFlags extends VpnFlags {
  full?: boolean;
  yesFullAccess?: boolean;
}

/**
 * `opscrew vpn add|remove|list|grant|revoke` (feature 018, FR-1813, FR-1817): the user's devices on
 * the app's private network, and a device's own login to a database or cache. Every change to a
 * server is a host plan shown and approved by its hash (in a script `--approve <hash>`, one per
 * server). A device's private key is made on this computer and written only to its configuration
 * file (and, with `--qr`, drawn as a QR code); a grant's password is printed once.
 */
export function register(program: Command, ctx: CliContext): void {
  const vpn = program
    .command("vpn")
    .description(
      "Your devices on the app's private network (WireGuard), and a device's own login to a database or cache",
    );

  addVpnOptions(
    vpn
      .command("add <name>")
      .description(
        "Add a device (a laptop, a phone): make its key here, add it to the servers and write its WireGuard configuration",
      )
      .option(
        "--this-computer",
        "This computer is the device: OpsCrew connects to the servers through its tunnel once public SSH is closed",
      )
      .option("--qr", "Also show the configuration as a QR code for the WireGuard app on a phone")
      .option(
        "--again",
        "A new key and configuration for a device already on the network (for example after a server was added)",
      ),
  ).action(async (name: string, flags: AddFlags) => {
    const deps = await vpnDeps(ctx, flags, `vpn add ${name}`);
    const result = await vpnAdd(deps, name, {
      ...(flags.thisComputer === true ? { thisComputer: true } : {}),
      ...(flags.qr === true ? { qr: true } : {}),
      ...(flags.again === true ? { again: true } : {}),
      services: servicesOf(ctx).vpn ?? {},
    });
    if (result.qr !== undefined) printQr(ctx, result.qr);
  });

  addVpnOptions(
    vpn
      .command("remove <name>")
      .description("Take a device off every server of the app, so its tunnel no longer connects"),
  ).action(async (name: string, flags: VpnFlags) => {
    const deps = await vpnDeps(ctx, flags, `vpn remove ${name}`);
    await vpnRemove(deps, name, { services: servicesOf(ctx).vpn ?? {} });
  });

  addEnvOption(
    vpn
      .command("list")
      .description(
        "List the devices with their addresses and when each last connected to each server (changes nothing)",
      ),
  ).action(async (flags: AppEnvFlags) => {
    const { app, name } = await chooseEnvironment(ctx, flags, "vpn list");
    const deps = createPhaseDeps(ctx, { ai: false, app, environment: name });
    await vpnList(deps, { services: servicesOf(ctx).vpn ?? {} });
  });

  addVpnOptions(
    vpn
      .command("grant <device> <service>")
      .description(
        "Give a device its own login to a database or cache (Postgres, MySQL, MariaDB, MongoDB, Valkey, Redis, Dragonfly), read-only unless --full; prints the connection details once",
      )
      .option(
        "--full",
        "Read and write access to all of the app's data instead of read-only (asks to confirm)",
      )
      .option(
        "--yes-full-access",
        "With --full in a script: confirm full access without a question",
      ),
  ).action(async (device: string, service: string, flags: GrantFlags) => {
    const deps = await vpnDeps(ctx, flags, `vpn grant ${device} ${service}`);
    const prompts = promptsOf(ctx);
    const result = await vpnGrant(deps, device, service, {
      ...(flags.full === true ? { full: true } : {}),
      ...(flags.yesFullAccess === true ? { yesFullAccess: true } : {}),
      confirmFull: async (question) => {
        const answer = await prompts.confirm({ message: question, initialValue: false });
        return !prompts.isCancel(answer) && answer === true;
      },
      services: servicesOf(ctx).vpn ?? {},
    });
    printConnection(ctx, result);
  });

  addVpnOptions(
    vpn
      .command("revoke <device> <service>")
      .description("Remove a device's login to a database or cache, and its access to the port"),
  ).action(async (device: string, service: string, flags: VpnFlags) => {
    const deps = await vpnDeps(ctx, flags, `vpn revoke ${device} ${service}`);
    await vpnRevoke(deps, device, service, { services: servicesOf(ctx).vpn ?? {} });
  });
}
