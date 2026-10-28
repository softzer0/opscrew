import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  OpsCrewError,
  type ProjectPaths,
  type Redactor,
  readTextIfExists,
  writeFileAtomic,
} from "@opscrew/core";
import type { AddonKind } from "@opscrew/iac-templates";
import { z } from "zod";
import { readSecretFile, type SecretFile } from "../shared/secret-files";
import { generateEd25519KeyPair } from "../shared/ssh-keys";

/**
 * The login email of Beszel's dashboard in hub mode (`USER_EMAIL`): the one user OpsCrew creates,
 * never in the plan. A reserved name (`.invalid`), so no mail ever goes to someone else.
 */
export const BESZEL_EMAIL = "admin@opscrew.invalid";

const BeszelSecretsSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("hub"),
    /** The dashboard's password: letters, digits, `-` and `_`. */
    password: z.string().regex(/^[A-Za-z0-9_-]{24,128}$/),
    /** The agent's token: 48 lowercase hex digits. */
    token: z.string().regex(/^[0-9a-f]{48}$/),
    /** The hub's private Ed25519 key (OpenSSH, unencrypted). */
    hubKey: z.string().startsWith("-----BEGIN OPENSSH PRIVATE KEY-----"),
    /** Its public half, `ssh-ed25519 AAAA…` (not secret: it goes into the host plan). */
    hubPublicKey: z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/=]+$/),
  }),
  z.strictObject({
    mode: z.literal("agent"),
    /** The token the user's hub gave for this server. */
    token: z.string().regex(/^[A-Za-z0-9-]{16,128}$/),
  }),
]);

/** Beszel's secrets on this computer (`beszel_secrets.json`, 0600, in the recovery copy). */
export type BeszelSecrets = z.infer<typeof BeszelSecretsSchema>;

function damaged(file: string, what: string): OpsCrewError {
  return new OpsCrewError(
    "ARTIFACT_INVALID",
    `${what} OpsCrew keeps for this project (${file}) is damaged, so OpsCrew stopped instead of replacing it: the add-on on the server may still use it. Nothing was changed.`,
    {
      hint: "Put the file back from a backup (or `opscrew secrets restore`), or delete it and turn the add-on off and on again for new values.",
    },
  );
}

/** Registers every secret value with the redactor, so none is ever shown. */
function registered(redactor: Pick<Redactor, "addLiteral">, secrets: BeszelSecrets): BeszelSecrets {
  if (secrets.mode === "hub") {
    redactor.addLiteral(secrets.password, "beszel-password");
    redactor.addLiteral(secrets.hubKey, "beszel-hub-key");
  }
  redactor.addLiteral(secrets.token, "beszel-token");
  return secrets;
}

/** Beszel's secrets from this computer, or `undefined`; a damaged file stops (fail closed). */
export async function readBeszelSecrets(deps: {
  paths: Pick<ProjectPaths, "files">;
  redactor: Pick<Redactor, "addLiteral">;
}): Promise<BeszelSecrets | undefined> {
  const file = deps.paths.files.beszelSecrets;
  const text = await readTextIfExists(file);
  if (text === undefined) return undefined;
  let parsed: z.ZodSafeParseResult<BeszelSecrets>;
  try {
    parsed = BeszelSecretsSchema.safeParse(JSON.parse(text));
  } catch {
    throw damaged(file, "The Beszel secrets file");
  }
  if (!parsed.success) throw damaged(file, "The Beszel secrets file");
  return registered(deps.redactor, parsed.data);
}

/** Writes Beszel's secrets (0600, in a folder only the user can open). */
export async function writeBeszelSecrets(
  paths: Pick<ProjectPaths, "files">,
  secrets: BeszelSecrets,
): Promise<void> {
  const file = paths.files.beszelSecrets;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Hub mode's secrets: the ones on this computer, or, the first time (or after agent mode), new
 * ones, written at once: a 32-character password of letters, digits, `-` and `_`, a token of 48
 * lowercase hex digits and the hub's Ed25519 key. They are generated here because the hub's public
 * key is part of the host plan.
 */
export async function ensureBeszelHubSecrets(deps: {
  paths: Pick<ProjectPaths, "files">;
  redactor: Pick<Redactor, "addLiteral">;
}): Promise<Extract<BeszelSecrets, { mode: "hub" }>> {
  const existing = await readBeszelSecrets(deps);
  if (existing?.mode === "hub") return existing;
  const key = generateEd25519KeyPair("beszel-hub");
  const secrets = {
    mode: "hub" as const,
    password: randomBytes(24).toString("base64url"),
    token: randomBytes(24).toString("hex"),
    hubKey: key.privateKeyOpenSsh,
    hubPublicKey: key.publicKeyOpenSsh.split(" ").slice(0, 2).join(" "),
  };
  await writeBeszelSecrets(deps.paths, secrets);
  registered(deps.redactor, secrets);
  return secrets;
}

/** The Grafana Cloud token on this computer (`grafana_cloud_token`, 0600). */
export function grafanaTokenFile(paths: Pick<ProjectPaths, "files">): SecretFile {
  const file = paths.files.grafanaCloudToken;
  return {
    file,
    valid: (value) => /^[A-Za-z0-9+/=_.-]{16,}$/.test(value),
    damaged: {
      message: `The Grafana Cloud token OpsCrew keeps for this project (${file}) is damaged, so OpsCrew stopped. Nothing was changed.`,
      hint: "Delete the file and give the token again in OPSCREW_GRAFANA_CLOUD_TOKEN.",
    },
  };
}

/** The Grafana Cloud token from this computer, or `undefined` (registered with the redactor). */
export async function readGrafanaToken(deps: {
  paths: Pick<ProjectPaths, "files">;
  redactor: Pick<Redactor, "addLiteral">;
}): Promise<string | undefined> {
  const token = await readSecretFile(grafanaTokenFile(deps.paths));
  if (token !== undefined) deps.redactor.addLiteral(token, "grafana-cloud-token");
  return token;
}

/** Keeps the Grafana Cloud token on this computer (0600), as it is on the server. */
export async function writeGrafanaToken(
  paths: Pick<ProjectPaths, "files">,
  token: string,
): Promise<void> {
  const file = paths.files.grafanaCloudToken;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${token}\n`, { mode: 0o600 });
}

/** Removes the add-on's secrets from this computer (once it is off on the server). */
export async function removeAddonSecrets(
  paths: Pick<ProjectPaths, "files">,
  kind: AddonKind,
): Promise<void> {
  const file = kind === "beszel" ? paths.files.beszelSecrets : paths.files.grafanaCloudToken;
  await rm(file, { force: true });
}
