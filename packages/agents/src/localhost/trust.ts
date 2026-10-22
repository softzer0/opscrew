/**
 * `opscrew localhost trust|untrust` (contracts/localhost.md "localTrust"): adds OpsCrew's local CA
 * to this computer's trust store, or takes it out again, with the OS's own command, shown first and
 * run only after the user agrees. In scripts the command is only printed.
 */
import { X509Certificate } from "node:crypto";
import { rm } from "node:fs/promises";
import { posix } from "node:path";
import { OpsCrewError, writeFileAtomic } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { caFiles, caName, ensureLocalCa, readLocalCa } from "./ca";
import { computer, type LocalhostServices } from "./services";

/** One program and its arguments, run without a shell. */
interface TrustCommand {
  command: string;
  args: string[];
}

/** The NSS nickname of the local CA in the user's browser database on Linux. */
const NSS_NICKNAME = "OpsCrew local CA";

/** Where the system's store on Linux (Debian and Ubuntu) takes extra CA certificates. */
const SYSTEM_CA_FILE = "/usr/local/share/ca-certificates/opscrew-local-ca.crt";

/** `command` as the user would type it: arguments with spaces or commas quoted. */
function commandText(commands: readonly TrustCommand[]): string {
  const word = (arg: string) => (/^[\w./\\:=@+-]+$/.test(arg) ? arg : `"${arg}"`);
  return commands.map((c) => [c.command, ...c.args].map(word).join(" ")).join(" && ");
}

/**
 * The OS's commands that trust (or untrust) the CA certificate `certificate` (its file `file`):
 * macOS's login keychain, Windows' current-user Root store, Linux's NSS database (the browsers').
 * macOS's and Linux's paths are joined with POSIX rules, whichever computer renders them.
 */
function trustCommands(
  action: "trust" | "untrust",
  o: { platform: NodeJS.Platform; homedir: string; file: string; certificate: string },
): TrustCommand[] {
  const cert = new X509Certificate(o.certificate);
  if (o.platform === "darwin") {
    const keychain = posix.join(o.homedir, "Library", "Keychains", "login.keychain-db");
    return action === "trust"
      ? [
          {
            command: "security",
            args: ["add-trusted-cert", "-r", "trustRoot", "-k", keychain, o.file],
          },
        ]
      : [
          {
            command: "security",
            args: ["delete-certificate", "-Z", cert.fingerprint.replaceAll(":", ""), keychain],
          },
        ];
  }
  if (o.platform === "win32") {
    return action === "trust"
      ? [{ command: "certutil", args: ["-user", "-addstore", "Root", o.file] }]
      : [{ command: "certutil", args: ["-user", "-delstore", "Root", cert.serialNumber] }];
  }
  const db = `sql:${posix.join(o.homedir, ".pki", "nssdb")}`;
  return action === "trust"
    ? [
        {
          command: "certutil",
          args: ["-d", db, "-A", "-t", "C,,", "-n", NSS_NICKNAME, "-i", o.file],
        },
      ]
    : [{ command: "certutil", args: ["-d", db, "-D", "-n", NSS_NICKNAME] }];
}

/** On Linux: the system store's commands (they need the user's password, so the user runs them). */
function systemStoreNote(action: "trust" | "untrust", file: string): string {
  return action === "trust"
    ? `For programs that use the system's certificates instead of the browser's (curl, for example), also run: sudo cp ${file} ${SYSTEM_CA_FILE} && sudo update-ca-certificates`
    : `If you also added it to the system's certificates, run: sudo rm -f ${SYSTEM_CA_FILE} && sudo update-ca-certificates --fresh`;
}

/**
 * Trusts OpsCrew's local CA on this computer, or takes the trust back (`untrust`): shows the exact
 * command and what it changes, then, in a terminal, runs it once the user agrees (a `remote-exec`
 * approval) and records the trust in `<OpsCrew home>/local-ca/trust.json`; in scripts it only
 * prints the command (`done: false`). Trusting makes the CA on first use. Never shows the CA's key.
 * @throws OpsCrewError `PHASE_PRECONDITION` to untrust without a local CA, `COMMAND_FAILED` when
 * the OS's command fails.
 */
export async function localTrust(
  deps: PhaseDeps,
  options: { action: "trust" | "untrust"; services?: LocalhostServices },
): Promise<{ command: string; done: boolean }> {
  const { action } = options;
  const local = computer(deps, options.services);
  const files = caFiles(deps.paths);
  const ca =
    action === "trust"
      ? await ensureLocalCa(deps.paths, { computerName: local.computerName, now: deps.clock.now() })
      : await readLocalCa(deps.paths);
  if (ca === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "This computer has no OpsCrew local CA, so there is nothing to untrust.",
      { hint: "Nothing to do: `opscrew localhost trust` makes it when you want one." },
    );
  }
  const commands = trustCommands(action, {
    platform: local.platform,
    homedir: local.homedir,
    file: files.certificate,
    certificate: ca.certificate,
  });
  const command = commandText(commands);
  const name = caName(local.computerName);
  const what =
    action === "trust"
      ? `This adds ${name} to your user's trusted certificates, so browsers show the local stack's https://<app>.localhost addresses without a warning. Your system may ask for your password or to confirm.`
      : `This removes ${name} from your user's trusted certificates; the local stack still works, with a browser warning.`;
  const undo = action === "trust" ? " `opscrew localhost untrust` undoes it." : "";
  const linux = local.platform === "linux" ? [systemStoreNote(action, files.certificate)] : [];
  deps.reporter.info([`${what}${undo}`, `Command: ${command}`, ...linux].join("\n"));
  if (!deps.interactive) {
    deps.reporter.info(
      "Run the command above yourself, or run this one in a terminal to be asked.",
    );
    return { command, done: false };
  }
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title:
      action === "trust"
        ? "Trust OpsCrew's local CA on this computer"
        : "Stop trusting OpsCrew's local CA on this computer",
    details: `${what}\nCommand: ${command}`,
  });
  if (!approval.approved) {
    deps.reporter.info("Nothing was changed.");
    return { command, done: false };
  }
  for (const step of commands) {
    const result = await deps.runner.run(step.command, step.args, { timeoutMs: 120_000 });
    if (result.exitCode !== 0) {
      throw new OpsCrewError(
        "COMMAND_FAILED",
        deps.redactor.redact(
          `${step.command} did not ${action} the local CA (exit code ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
        ),
        { hint: `Check the message above, then run \`opscrew localhost ${action}\` again.` },
      );
    }
  }
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: `localhost ${action}`,
    target: "this computer",
    decision: "approved",
  });
  if (action === "trust") {
    await writeFileAtomic(
      files.trust,
      `${JSON.stringify({ trusted: true, at: deps.clock.now().toISOString() })}\n`,
    );
  } else {
    await rm(files.trust, { force: true });
  }
  deps.reporter.success(
    action === "trust"
      ? `This computer trusts ${name}.${undo}`
      : `This computer no longer trusts ${name}.`,
  );
  return { command, done: true };
}
