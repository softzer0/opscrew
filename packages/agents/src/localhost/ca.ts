/**
 * OpsCrew's local certificate authority (data-model.md "Local certificate authority"): one per
 * computer in `<OpsCrew home>/local-ca/`, its P-256 key at 0600 (never copied, printed or
 * committed; it can be made again), its certificate valid for 10 years. Each localhost hostname
 * gets a leaf certificate for 1 year (never over 825 days, which Apple's platforms refuse), renewed
 * by provision with fewer than 30 days left.
 */
import { createPrivateKey, type KeyObject, X509Certificate } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  generateP256,
  localCaCertificate,
  type ProjectPaths,
  readTextIfExists,
  sha256Hex,
  signedLeafCertificate,
  writeFileAtomic,
} from "@opscrew/core";
import { localhostTlsUpload } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import { readValidJson } from "../shared";
import { localRoots } from "./services";

/** The local CA certificate's lifetime. */
const CA_DAYS = 3650;
/** A leaf certificate's lifetime: 1 year, well under the 825 days Apple's platforms accept. */
const LEAF_DAYS = 365;
/** Provision issues a new leaf when the one in place has fewer days left than this. */
export const LEAF_RENEW_DAYS = 30;

/** Where the local CA lives: `<OpsCrew home>/local-ca/`. */
export function caFiles(paths: Pick<ProjectPaths, "homeDir">) {
  const dir = join(paths.homeDir, "local-ca");
  return {
    dir,
    key: join(dir, "ca.key"),
    certificate: join(dir, "ca.pem"),
    trust: join(dir, "trust.json"),
  };
}

/** The local CA: its key (in memory only) and its certificate (PEM, public). */
export interface LocalCa {
  key: KeyObject;
  certificate: string;
}

/** The local CA when this computer has one, else `undefined`. */
export async function readLocalCa(
  paths: Pick<ProjectPaths, "homeDir">,
): Promise<LocalCa | undefined> {
  const files = caFiles(paths);
  const [key, certificate] = await Promise.all([
    readTextIfExists(files.key),
    readTextIfExists(files.certificate),
  ]);
  if (key === undefined || certificate === undefined) return undefined;
  return { key: createPrivateKey(key), certificate };
}

/**
 * The local CA, made on first use: a P-256 key written at 0600 in a 0700 folder, and its
 * certificate `OpsCrew local CA (<computer>)` (CA:TRUE, keyCertSign), valid for 10 years.
 */
export async function ensureLocalCa(
  paths: Pick<ProjectPaths, "homeDir">,
  o: { computerName: string; now: Date },
): Promise<LocalCa> {
  const existing = await readLocalCa(paths);
  if (existing !== undefined) return existing;
  const files = caFiles(paths);
  await mkdir(files.dir, { recursive: true, mode: 0o700 });
  await chmod(files.dir, 0o700);
  const pair = generateP256();
  const key = createPrivateKey(pair.privateKey);
  const certificate = localCaCertificate(key, {
    commonName: caName(o.computerName),
    days: CA_DAYS,
    now: o.now,
  });
  await writeFileAtomic(files.key, pair.privateKey, { mode: 0o600 });
  await writeFileAtomic(files.certificate, certificate, { mode: 0o644 });
  return { key, certificate };
}

/** The local CA's common name: `OpsCrew local CA (<computer>)`, its name in trust stores too. */
export function caName(computerName: string): string {
  const computer = computerName.replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 40) || "this computer";
  return `OpsCrew local CA (${computer})`;
}

/** RFC 5280's upper bound on a common name, which a leaf's first name becomes. */
const MAX_COMMON_NAME = 64;

/**
 * The common name of `hostname`'s leaf certificate when the hostname is longer than one holds (a
 * long `<env>.<app>.localhost`): a short name made from its SHA-256. The SAN names the hostname
 * alone, for TLS.
 */
function leafCommonName(hostname: string): string | undefined {
  return hostname.length <= MAX_COMMON_NAME
    ? undefined
    : `${sha256Hex(hostname).slice(0, 16)}.localhost`;
}

/** A new leaf certificate for `hostname` signed by the local CA, and its key (PEM, never logged). */
export function issueLeaf(
  ca: LocalCa,
  hostname: string,
  now: Date,
): { certificate: string; key: string } {
  const pair = generateP256();
  const commonName = leafCommonName(hostname);
  const certificate = signedLeafCertificate({
    caKey: ca.key,
    caCertificate: ca.certificate,
    key: createPrivateKey(pair.privateKey),
    hostnames: [hostname],
    ...(commonName !== undefined ? { commonName } : {}),
    days: LEAF_DAYS,
    now,
  });
  return { certificate, key: pair.privateKey };
}

/** The app's leaf certificate in the edge's TLS folder, where the start script keeps it. */
export function leafFile(
  paths: Pick<ProjectPaths, "homeDir">,
  plan: Pick<DeployPlan, "app">,
): string {
  const upload = localhostTlsUpload(plan.app.name).certificate;
  return join(localRoots(paths).edge, upload.slice(0, -".new".length));
}

/** What provision does with the app's leaf certificate, and why. */
export interface LeafState {
  action: "create" | "change" | "keep";
  /** Why it changes, or until when the one in place is valid. */
  detail: string;
  /** The leaf in place's expiry (ISO), when there is one. */
  expires?: string;
}

/**
 * Whether the app's leaf certificate in the edge's TLS folder serves `hostname`: `create` when
 * there is none (or no local CA yet), `change` when it names another hostname, was not signed by
 * this computer's CA or has fewer than {@link LEAF_RENEW_DAYS} days left, else `keep`.
 */
export async function leafState(
  paths: Pick<ProjectPaths, "homeDir">,
  plan: Pick<DeployPlan, "app">,
  hostname: string,
  now: Date,
): Promise<LeafState> {
  const [text, ca] = await Promise.all([
    readTextIfExists(leafFile(paths, plan)),
    readTextIfExists(caFiles(paths).certificate),
  ]);
  if (text === undefined || ca === undefined) {
    return { action: "create", detail: `a new certificate for ${hostname}, valid for 1 year` };
  }
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(text);
  } catch {
    return { action: "change", detail: "the certificate in place cannot be read" };
  }
  const expires = new Date(leaf.validTo).toISOString();
  if (leaf.subjectAltName !== `DNS:${hostname}`) {
    return {
      action: "change",
      detail: `the certificate in place names ${leaf.subjectAltName}`,
      expires,
    };
  }
  const issuer = new X509Certificate(ca);
  if (!leaf.checkIssued(issuer) || !leaf.verify(issuer.publicKey)) {
    return {
      action: "change",
      detail: "the certificate in place is not from this computer's local CA",
      expires,
    };
  }
  const days = Math.floor((Date.parse(expires) - now.getTime()) / 86_400_000);
  if (days < LEAF_RENEW_DAYS) {
    return {
      action: "change",
      detail: `the certificate in place expires on ${expires.slice(0, 10)}`,
      expires,
    };
  }
  return { action: "keep", detail: `valid until ${expires.slice(0, 10)}`, expires };
}

const TrustSchema = z.strictObject({ trusted: z.literal(true), at: z.string() });

/** True when `opscrew localhost trust` recorded this computer's trust in the local CA. */
export async function caTrusted(paths: Pick<ProjectPaths, "homeDir">): Promise<boolean> {
  return (await readValidJson(caFiles(paths).trust, TrustSchema)) !== undefined;
}
