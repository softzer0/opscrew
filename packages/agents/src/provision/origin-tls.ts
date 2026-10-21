/**
 * The app's origin TLS (feature 014, contracts/cloudflare-tls.md, ADR 0017): the hostnames
 * Cloudflare's proxy serves get a Cloudflare origin certificate, and the origin requires a client
 * certificate of the app's own, which Cloudflare presents through per-hostname Authenticated
 * Origin Pulls. The keys are made on this computer (core's P-256 keys, certificate request and
 * self-signed client certificate) and kept with the generated values; Cloudflare's side goes
 * through the shared Cloudflare plan; the server gets the files with the deploy.
 */
import { posix } from "node:path";
import type { SharedDesired, SharedPlan, SharedRecord } from "@opscrew/connector-cloudflare";
import { type PortainerFacts, valueFingerprint } from "@opscrew/connector-portainer";
import type { Clock, PhaseName, RemoteExec } from "@opscrew/contracts";
import {
  buildCsr,
  exists,
  fingerprintSha256,
  generateP256,
  isUserFacingError,
  listText,
  OpsCrewError,
  selfSignedClientCertificate,
  writeFileAtomic,
} from "@opscrew/core";
import {
  EDGE_DIR,
  EDGE_PROXIES,
  type EdgeProxy,
  edgeProxy,
  ORIGIN_PULL_PEM,
  PORTAINER_STACK_VARIABLES,
  type RenderedFile,
  siteHosts,
  tunnelMode,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { parse } from "yaml";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import {
  type PortainerConnection,
  readServerAddresses,
  readValidJson,
  recordedStack,
  SshRemoteExec,
} from "../shared";
import { readOwnServerRecord } from "../shared/own-server";
import type { CloudflareSetup, GitHubSetup } from "./credentials";
import { generatedValuesFile } from "./secrets";
import { readCloudflareRecord, type SharedCloudflareInput } from "./shared-cloudflare";
import type { ProvisionServices } from "./types";

/** The client certificate's lifetime: 15 years, as the origin certificate's (research R3). */
const CLIENT_CERTIFICATE_DAYS = 5475;

/** The origin TLS values in `generated_values.json` (key `originTls`); never logged or committed. */
const OriginTlsValuesSchema = z.strictObject({
  /** The origin certificate's private key (PKCS#8 PEM). */
  ORIGIN_TLS_KEY: z.string().min(1).optional(),
  /** The origin certificate Cloudflare issued (PEM). */
  ORIGIN_TLS_CERT: z.string().min(1).optional(),
  /** The client certificate's private key (PKCS#8 PEM), sent to Cloudflare once in its upload. */
  ORIGIN_PULL_KEY: z.string().min(1).optional(),
  /** The client certificate (PEM, public): `pull.pem`, the origin's trust pool. */
  ORIGIN_PULL_CERT: z.string().min(1).optional(),
  /**
   * The key and certificate request of an origin certificate a Cloudflare plan creates, kept until
   * the plan is applied, so a plan shown with `--plan-only` keeps its hash for `--approve`.
   */
  ORIGIN_TLS_REQUEST: z
    .strictObject({
      key: z.string().min(1),
      csr: z.string().min(1),
      hostnames: z.array(z.string()),
    })
    .optional(),
});

/** What {@link readOriginTlsValues} keeps; every field is optional. */
export type OriginTlsValues = z.infer<typeof OriginTlsValuesSchema>;

/** The key and certificate request of a new origin certificate. */
export type CertificateRequest = NonNullable<OriginTlsValues["ORIGIN_TLS_REQUEST"]>;

/** What the origin serves now, read from the server or the stack (`SharedDesired.tls.served`). */
export type ServedOrigin = NonNullable<NonNullable<SharedDesired["tls"]>["served"]>;

/** The generated values file, as provision's other values keep it: `originTls` among them. */
const GeneratedFileSchema = z.looseObject({ originTls: z.unknown().optional() });

/** The generated values file as an object; `{}` when it is missing or not a JSON object. */
async function generatedObject(deps: Pick<PhaseDeps, "paths">): Promise<Record<string, unknown>> {
  return (await readValidJson(generatedValuesFile(deps), GeneratedFileSchema)) ?? {};
}

/**
 * The app's origin TLS values from `generated_values.json` (none when missing or damaged), with
 * every private key registered with the redactor.
 */
export async function readOriginTlsValues(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
): Promise<OriginTlsValues> {
  const parsed = OriginTlsValuesSchema.safeParse((await generatedObject(deps)).originTls);
  const values = parsed.success ? parsed.data : {};
  for (const key of [
    values.ORIGIN_TLS_KEY,
    values.ORIGIN_PULL_KEY,
    values.ORIGIN_TLS_REQUEST?.key,
  ]) {
    if (key !== undefined) deps.redactor.addLiteral(key, "origin-tls");
  }
  return values;
}

/** Writes the app's origin TLS values into `generated_values.json` (0600), keeping the rest. */
async function writeOriginTlsValues(
  deps: Pick<PhaseDeps, "paths">,
  values: OriginTlsValues,
): Promise<void> {
  const { originTls: _old, ...rest } = await generatedObject(deps);
  const next = Object.keys(values).length > 0 ? { ...rest, originTls: values } : rest;
  await writeFileAtomic(generatedValuesFile(deps), `${JSON.stringify(next)}\n`);
}

/**
 * The app's hostnames that get origin TLS: those Cloudflare's proxy serves when OpsCrew's proxy is
 * their public origin (a server, or OpsCrew's Caddy in a Portainer stack in web mode `caddy`).
 * None behind a Cloudflare Tunnel (no public origin, FR-1409), for a DNS-only domain, or behind the
 * user's own proxy.
 */
export function originTlsHostnames(plan: DeployPlan): string[] {
  if (plan.dns.provider !== "cloudflare" || !plan.dns.proxied || tunnelMode(plan)) return [];
  if (plan.target.provider === "portainer" && plan.target.web.mode !== "caddy") return [];
  return [...siteHosts(plan)].sort();
}

function sortedUnique(items: readonly string[]): string[] {
  return [...new Set(items)].sort();
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** A new P-256 key, registered with the redactor at once. */
function newKey(deps: Pick<PhaseDeps, "redactor">): string {
  const key = generateP256().privateKey;
  deps.redactor.addLiteral(key, "origin-tls");
  return key;
}

/**
 * The origin TLS part of this run's Cloudflare plan ({@link planOriginTls}): what is asked of
 * Cloudflare, the keys and request the apply sends, and the hostnames that left the proxy.
 */
export interface OriginTlsStep {
  desired: NonNullable<SharedDesired["tls"]>;
  /** The client certificate and its key, for `upload-client-certificate`. */
  keys?: { clientCertificate: string; clientKey: string };
  /** The key and request for `create-origin-certificate`, when a new certificate is wanted. */
  request?: CertificateRequest;
  /** Hostnames the app no longer proxies that stay in `desired.tls.proxied` until the server shows it. */
  leaving: string[];
  /**
   * A hostname leaving the proxy is still the app's, DNS only from now on: its DNS record stays
   * proxied for this run, while the deploy gives the origin a public certificate (R3).
   */
  holdsProxy: boolean;
  /** The origin TLS values this step read or made. */
  values: OriginTlsValues;
}

/**
 * Plans the app's origin TLS (contracts/cloudflare-tls.md): its proxied hostnames
 * ({@link originTlsHostnames}), plus the hostnames its record's client certificate is on that the
 * app now serves DNS only while the server still requires it for them (`served`; all of them
 * while the server cannot be read), so a hostname leaving the proxy takes two runs. The client certificate is made once (15 years) and
 * kept at once; a fresh key and certificate request go with every plan (the planner creates a
 * certificate only when its rule wants one), except that a request a plan already created is kept
 * while the hostnames are the same. `undefined` when the app has no origin TLS and wants none.
 */
export async function planOriginTls(
  deps: Pick<PhaseDeps, "paths" | "redactor" | "clock">,
  input: {
    plan: DeployPlan;
    record: SharedRecord | undefined;
    served: ServedOrigin | undefined;
  },
): Promise<OriginTlsStep | undefined> {
  const { plan, record, served } = input;
  const wanted = originTlsHostnames(plan);
  const client = record?.tls?.client;
  const sites = siteHosts(plan);
  // A hostname the app no longer serves at all goes at once: the planner turns it off once the
  // server shows it no longer requires it, and its DNS record goes with the infrastructure.
  const leaving = sortedUnique([...(client?.enabled ?? []), ...(client?.retiring ?? [])]).filter(
    (h) =>
      !wanted.includes(h) &&
      sites.includes(h) &&
      (served === undefined || served.requiring.includes(h)),
  );
  const proxied = sortedUnique([...wanted, ...leaving]);
  if (proxied.length === 0 && record?.tls?.origin === undefined && client === undefined) {
    return undefined;
  }
  let values = await readOriginTlsValues(deps);
  let keys: OriginTlsStep["keys"];
  let request: CertificateRequest | undefined;
  if (proxied.length > 0) {
    let clientKey = values.ORIGIN_PULL_KEY;
    let clientCertificate = values.ORIGIN_PULL_CERT;
    if (clientKey === undefined || clientCertificate === undefined) {
      clientKey = newKey(deps);
      clientCertificate = selfSignedClientCertificate({
        key: clientKey,
        commonName: `opscrew-${plan.app.name}`,
        days: CLIENT_CERTIFICATE_DAYS,
        now: deps.clock.now(),
      });
      values = { ...values, ORIGIN_PULL_KEY: clientKey, ORIGIN_PULL_CERT: clientCertificate };
      await writeOriginTlsValues(deps, values);
    }
    keys = { clientCertificate, clientKey };
    const kept = values.ORIGIN_TLS_REQUEST;
    if (kept !== undefined && sameList(kept.hostnames, proxied)) {
      request = kept;
    } else {
      const key = newKey(deps);
      request = { key, csr: buildCsr({ key, hostnames: proxied }), hostnames: proxied };
    }
  }
  return {
    desired: {
      proxied,
      retiring: [],
      ...(served !== undefined ? { served } : {}),
      ...(request !== undefined && keys !== undefined
        ? {
            origin: { csr: request.csr },
            client: { sha256: fingerprintSha256(keys.clientCertificate) },
          }
        : {}),
    },
    ...(keys !== undefined ? { keys } : {}),
    ...(request !== undefined ? { request } : {}),
    leaving,
    holdsProxy: plan.target.provider !== "portainer" && !plan.dns.proxied && leaving.length > 0,
    values,
  };
}

/**
 * Keeps the step's certificate request while its plan creates an origin certificate (so the plan
 * keeps its hash until it is applied), and drops a kept request no plan needs any more.
 */
export async function keepCertificateRequest(
  deps: Pick<PhaseDeps, "paths">,
  step: OriginTlsStep,
  plan: Pick<SharedPlan, "changes">,
): Promise<void> {
  const creates = plan.changes.some((change) => change.kind === "create-origin-certificate");
  const { ORIGIN_TLS_REQUEST: kept, ...rest } = step.values;
  if (creates && step.request !== undefined && kept !== step.request) {
    step.values = { ...rest, ORIGIN_TLS_REQUEST: step.request };
    await writeOriginTlsValues(deps, step.values);
  } else if (!creates && kept !== undefined) {
    step.values = rest;
    await writeOriginTlsValues(deps, rest);
  }
}

/**
 * Keeps the origin certificate a Cloudflare apply created with the key of its request
 * (`ORIGIN_TLS_KEY`, `ORIGIN_TLS_CERT`); the request is done.
 */
export async function keepOriginCertificate(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  request: CertificateRequest,
  certificate: string,
): Promise<void> {
  const { ORIGIN_TLS_REQUEST: _done, ...rest } = await readOriginTlsValues(deps);
  await writeOriginTlsValues(deps, {
    ...rest,
    ORIGIN_TLS_KEY: request.key,
    ORIGIN_TLS_CERT: certificate,
  });
}

/**
 * The hostnames the origin serves with the app's origin certificate and requires the client
 * certificate for (the render's `originTls`): the plan's proxied hostnames that the record's
 * origin certificate covers and its client certificate is on, when this computer holds both
 * certificates and their keys. `undefined` without any (no origin TLS yet, a token without the
 * certificate permissions, a plan not applied): the site stays as today.
 */
export function originTlsFor(
  plan: DeployPlan,
  record: SharedRecord | undefined,
  values: OriginTlsValues,
): { hostnames: string[] } | undefined {
  const origin = record?.tls?.origin;
  const client = record?.tls?.client;
  const { ORIGIN_TLS_CERT: cert, ORIGIN_PULL_CERT: pull } = values;
  if (origin === undefined || client === undefined) return undefined;
  if (values.ORIGIN_TLS_KEY === undefined || values.ORIGIN_PULL_KEY === undefined) return undefined;
  if (cert === undefined || fingerprintSha256(cert) !== origin.sha256) return undefined;
  if (pull === undefined || fingerprintSha256(pull) !== client.sha256) return undefined;
  const hostnames = originTlsHostnames(plan).filter(
    (h) => origin.hostnames.includes(h) && client.enabled.includes(h),
  );
  return hostnames.length > 0 ? { hostnames } : undefined;
}

/** The deploy secret `OPSCREW_ORIGIN_TLS` on a server: the certificate's PEM, then the key's. */
export function originTlsSecret(values: OriginTlsValues): string {
  return `${values.ORIGIN_TLS_CERT ?? ""}${values.ORIGIN_TLS_KEY ?? ""}`;
}

/**
 * The stack variable `OPSCREW_ORIGIN_TLS` in a Portainer stack: the certificate, its key and
 * `pull.pem` as one PEM text in base64 (Portainer writes a stack's variables one line each).
 */
export function portainerOriginTls(values: OriginTlsValues): string {
  const pem = `${originTlsSecret(values)}${values.ORIGIN_PULL_CERT ?? ""}`;
  return Buffer.from(pem, "utf8").toString("base64");
}

/** `opscrew/runtime/edge/tls/pull.pem`: the client certificate, the origin's trust pool (public). */
export function pullPemFile(values: OriginTlsValues): RenderedFile {
  return { path: ORIGIN_PULL_PEM, content: values.ORIGIN_PULL_CERT ?? "", kind: "runtime" };
}

/**
 * True when the plan replaces an origin certificate for the same hostnames (a renewal, or one
 * Cloudflare no longer lists): only the deploy secret changes, so a deploy must bring it.
 */
export function renewsOriginCertificate(plan: Pick<SharedPlan, "changes" | "previous">): boolean {
  const before = plan.previous?.tls?.origin;
  return plan.changes.some(
    (change) =>
      change.kind === "create-origin-certificate" &&
      before !== undefined &&
      sameList(before.hostnames, change.hostnames),
  );
}

/**
 * The hostnames a site file requires the client certificate for: Caddy's site blocks with
 * `client_auth`, nginx's `server` blocks with `ssl_verify_client on`.
 */
export function requiringHostnames(site: string): string[] {
  const out = new Set<string>();
  let hosts: string[] = [];
  for (const line of site.split(/\r?\n/)) {
    const block = /^([^\s#{}][^{]*?)\s*\{\s*$/.exec(line);
    if (block?.[1] !== undefined) {
      hosts =
        block[1] === "server"
          ? []
          : block[1]
              .split(/[\s,]+/)
              .filter((h) => h !== "")
              .map((h) => h.replace(/^https?:\/\//, ""));
    }
    const name = /^\s*server_name\s+([^;]+);/.exec(line);
    if (name?.[1] !== undefined) hosts = name[1].trim().split(/\s+/);
    if (/^\s*(?:client_auth\s*\{|ssl_verify_client\s+on\s*;)/.test(line)) {
      for (const host of hosts) out.add(host);
    }
  }
  return [...out].sort();
}

/** What a server's edge runs for the app, read over SSH ({@link readServerEdge}). */
export interface ServerEdge {
  /** The edge's proxy; `undefined` when the server has no edge yet. */
  proxy: EdgeProxy | undefined;
  served: ServedOrigin;
}

const EDGE_READ_MARK = "opscrew-edge-read 1";

/** The read-only command that prints the edge's proxy, the app's origin certificate and site. */
export function edgeReadCommand(app: string): string {
  const sites = Object.values(EDGE_PROXIES).map((p) => `${EDGE_DIR}/sites/${app}.${p.site}`);
  return [
    `echo '${EDGE_READ_MARK}'`,
    `if [ -f ${EDGE_DIR}/compose.yaml ]; then echo "proxy=$(sed -n 's/^x-opscrew-edge-proxy: *//p' ${EDGE_DIR}/compose.yaml | head -n 1)"; else echo proxy=none; fi`,
    "echo '--origin--'",
    `cat ${EDGE_DIR}/tls/${app}/origin.pem 2>/dev/null || true`,
    "echo '--site--'",
    `cat ${sites.join(" ")} 2>/dev/null || true`,
    "echo '--end--'",
  ].join("; ");
}

/** The edge {@link edgeReadCommand} printed; `undefined` for any other output (nothing was read). */
export function parseServerEdge(stdout: string): ServerEdge | undefined {
  const text = stdout.replaceAll("\r\n", "\n");
  const start = text.indexOf(`${EDGE_READ_MARK}\n`);
  const origin = text.indexOf("--origin--\n");
  const site = text.indexOf("--site--\n");
  const end = text.lastIndexOf("--end--");
  if (start === -1 || origin < start || site < origin || end < site) return undefined;
  const stamp = /^proxy=(.*)$/m.exec(text.slice(start, origin))?.[1]?.trim();
  if (stamp === undefined) return undefined;
  // An edge from before the proxy choice has no stamp: it runs Caddy.
  const proxy = stamp === "none" ? undefined : stamp === "" ? "caddy" : stamp;
  if (proxy !== undefined && proxy !== "caddy" && proxy !== "nginx") return undefined;
  const pem = text.slice(origin + "--origin--\n".length, site);
  let originSha256: string | undefined;
  if (pem.includes("-----BEGIN CERTIFICATE-----")) {
    try {
      originSha256 = fingerprintSha256(pem);
    } catch {
      originSha256 = undefined;
    }
  }
  return {
    proxy,
    served: {
      ...(originSha256 !== undefined ? { originSha256 } : {}),
      requiring: requiringHostnames(text.slice(site + "--site--\n".length, end)),
    },
  };
}

/**
 * Where the deploy logs in to the app's server: the recorded address of a server OpsCrew created,
 * or the recorded login of the user's own server in public mode (behind a tunnel the server has no
 * public origin, so nothing is read). `undefined` when this computer knows none or has no deploy
 * key.
 */
async function deployLogin(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
): Promise<{ host: string; port: number } | undefined> {
  if (!(await exists(deps.paths.files.deployKey))) return undefined;
  if (plan.target.provider === "own") {
    if (plan.target.access !== "public") return undefined;
    const login = await readOwnServerRecord(deps.paths).catch(() => undefined);
    return login === undefined ? undefined : { host: login.host, port: login.port };
  }
  const address = await readServerAddresses(deps.paths).then(
    (record) => record.deployment,
    () => undefined,
  );
  return address === undefined ? undefined : { host: address.ipv4, port: 22 };
}

/**
 * What the app's server runs, read over SSH as `deploy` (read-only, audited without the address):
 * the edge's proxy, and the origin certificate and client-certificate requirement of the app's
 * site. `undefined` when it cannot be read (no deployment yet, the server unreachable): the
 * clean-up that waits for the server then waits, and the run goes on.
 */
export async function readServerEdge(
  deps: Pick<PhaseDeps, "paths" | "runner" | "audit">,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "remote">,
): Promise<ServerEdge | undefined> {
  const login = await deployLogin(deps, plan);
  if (login === undefined) return undefined;
  const remote =
    services.remote?.(login.host) ??
    new SshRemoteExec({
      host: login.host,
      port: login.port,
      keyFile: deps.paths.files.deployKey,
      knownHostsFile: deps.paths.files.knownHosts,
      runner: deps.runner,
    });
  return readEdgeOver(deps, remote, plan.app.name);
}

/**
 * What the server's edge runs for `app`, read with {@link edgeReadCommand} over `remote`
 * (read-only, audited without the address); `undefined` when it could not be read.
 */
export async function readEdgeOver(
  deps: Pick<PhaseDeps, "audit">,
  remote: RemoteExec,
  app: string,
): Promise<ServerEdge | undefined> {
  let edge: ServerEdge | undefined;
  try {
    const result = await remote.run(edgeReadCommand(app), { timeoutMs: 30_000 });
    edge = result.exitCode === 0 ? parseServerEdge(result.stdout) : undefined;
  } catch {
    edge = undefined;
  }
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "read the edge's proxy and the app's origin TLS (read-only)",
    target: "server",
    decision: "allow",
    detail: edge === undefined ? "not read" : "read",
  });
  return edge;
}

/**
 * What a Portainer stack serves: the hostnames its Caddy requires the client certificate for (its
 * stack file in Portainer), and the record's origin certificate when the stack holds the app's
 * values for it (`fingerprint` is the keyed fingerprint of {@link portainerOriginTls} under the
 * stack variable's name, and `held` the stack's) and its Caddy uses them.
 */
export function stackServed(
  file: string | undefined,
  record: SharedRecord | undefined,
  match: { held: string | undefined; fingerprint: string | undefined },
): ServedOrigin {
  let caddyfile = "";
  try {
    const document = parse(file ?? "") as { configs?: { caddyfile?: { content?: unknown } } };
    const content = document?.configs?.caddyfile?.content;
    if (typeof content === "string") caddyfile = content.replaceAll("$$", "$");
  } catch {
    caddyfile = "";
  }
  const requiring = requiringHostnames(caddyfile);
  const sha256 = record?.tls?.origin?.sha256;
  const serves =
    requiring.length > 0 &&
    sha256 !== undefined &&
    match.held !== undefined &&
    match.held === match.fingerprint;
  return { ...(serves ? { originSha256: sha256 } : {}), requiring };
}

/** Days before its expiry a certificate OpsCrew manages is warned about (FR-1406). */
const WARN_DAYS = 30;

/**
 * Provision's warnings about TLS: CAA records of the user's at the app's domain where OpsCrew
 * publishes its own (FR-1431: reported, never replaced), and the app's client certificate within
 * 30 days of its expiry, which OpsCrew never replaces by itself (with the steps to do it).
 */
export function tlsWarnings(
  plan: DeployPlan,
  cloudflare: Pick<CloudflareSetup, "foreignCaa"> | undefined,
  shared: Pick<SharedPlan, "record"> | undefined,
  clock: Clock,
): string[] {
  const warnings: string[] = [];
  const caa = cloudflare?.foreignCaa ?? [];
  const { dns } = plan;
  const publishes =
    plan.target.provider !== "portainer" &&
    !dns.proxied &&
    dns.zone !== undefined &&
    dns.domain !== dns.zone;
  if (caa.length > 0 && publishes) {
    warnings.push(
      `Cloudflare has CAA records at ${dns.domain} that OpsCrew did not create (${caa.map((r) => r.content).join("; ")}). OpsCrew leaves them as they are and adds its own for the authorities your server's proxy uses; together they decide which authorities may issue certificates there, so check that they still name the one the proxy uses.`,
    );
  }
  const expiring = clientCertificateWarning(shared?.record, clock);
  if (expiring !== undefined) warnings.push(expiring);
  return warnings;
}

/**
 * The warning about the app's client certificate for Cloudflare's origin pulls within 30 days of
 * its expiry (FR-1406), with the steps to replace it, since OpsCrew never replaces it by itself;
 * `undefined` otherwise. Provision says it, and `status` and `secure` can too.
 */
export function clientCertificateWarning(
  record: Pick<SharedRecord, "tls"> | undefined,
  clock: Clock,
): string | undefined {
  const client = record?.tls?.client;
  if (client === undefined) return undefined;
  if (Date.parse(client.expiresAt) - clock.now().getTime() >= WARN_DAYS * 86_400_000) {
    return undefined;
  }
  return `This app's client certificate for Cloudflare's origin pulls expires on ${client.expiresAt.slice(0, 10)}, and OpsCrew does not replace it by itself: the server must trust the new one before Cloudflare sends it. To replace it: add a new client certificate after the old one in ${ORIGIN_PULL_PEM} and deploy; upload the new one and turn it on for each hostname with Cloudflare's API (POST /zones/<zone id>/origin_tls_client_auth/hostnames/certificates, then PUT /zones/<zone id>/origin_tls_client_auth/hostnames); remove the old one from ${ORIGIN_PULL_PEM} and deploy; delete the old one at Cloudflare; then put the new certificate's id, expiry and SHA-256 in the client entry of .opscrew/cloudflare.json, and its key in generated_values.json.`;
}

/**
 * Starts the deploy workflow on the plan's branch, so the server gets the renewed origin
 * certificate the deploy secret now holds (the Cloudflare plan's approval named this deploy). A
 * refused start is a warning: the old certificate is still valid for a while.
 */
export async function deployRenewedCertificate(
  deps: Pick<PhaseDeps, "audit" | "reporter" | "redactor">,
  github: Pick<GitHubSetup, "api" | "owner" | "repo">,
  plan: Pick<DeployPlan, "cicd">,
  phase: PhaseName,
): Promise<void> {
  const workflow = posix.basename(plan.cicd.workflowPath);
  const { branch } = plan.cicd;
  const { owner, repo } = github;
  try {
    await github.api.dispatchWorkflow(owner, repo, workflow, branch);
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    deps.reporter.warn(
      deps.redactor.redact(
        `OpsCrew could not start the deploy workflow (${error.message}), so the server still serves the previous origin certificate. Run ${workflow} on ${branch} in GitHub Actions to bring it the new one.`,
      ),
    );
    return;
  }
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "dispatch workflow",
    phase,
    target: `${owner}/${repo}`,
    decision: "approved",
    detail: `${workflow} on ${branch}: the renewed origin certificate`,
  });
  deps.reporter.success(
    `Started the deploy workflow (${workflow} on ${branch}), which brings the renewed origin certificate to the server.`,
  );
}

/**
 * What the Cloudflare apply needs for the step: the client certificate and its key, the waits'
 * sleep, and keeping a created origin certificate with its request's key.
 */
export function originTlsApply(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  step: OriginTlsStep | undefined,
  services: Pick<ProvisionServices, "sleep">,
): Pick<SharedCloudflareInput, "keys" | "sleep" | "keepOriginCertificate"> {
  const request = step?.request;
  return {
    ...(step?.keys !== undefined ? { keys: step.keys } : {}),
    ...(services.sleep !== undefined ? { sleep: services.sleep } : {}),
    ...(request !== undefined
      ? {
          keepOriginCertificate: (certificate: string) =>
            keepOriginCertificate(deps, request, certificate),
        }
      : {}),
  };
}

/**
 * The origin TLS of the app's stack in the user's Portainer ({@link planOriginTls}), against what
 * the stack serves now ({@link stackServed}): its file as Portainer holds it, and whether its
 * values hold this computer's certificate (their keyed fingerprints, `valueKey`).
 */
export async function stackOriginTls(
  deps: Pick<PhaseDeps, "paths" | "redactor" | "clock">,
  input: {
    plan: DeployPlan;
    cloudflare: Pick<CloudflareSetup, "zoneId">;
    connection: Pick<PortainerConnection, "created">;
    facts: Pick<PortainerFacts, "stacks">;
    valueKey: Uint8Array;
  },
): Promise<OriginTlsStep | undefined> {
  const record = await readCloudflareRecord(deps.paths).then((r) =>
    r?.zoneId === input.cloudflare.zoneId ? r : undefined,
  );
  const values = await readOriginTlsValues(deps);
  const stack = recordedStack(input.connection, input.facts, "app");
  const name = PORTAINER_STACK_VARIABLES.originTls;
  const complete =
    values.ORIGIN_TLS_CERT !== undefined &&
    values.ORIGIN_TLS_KEY !== undefined &&
    values.ORIGIN_PULL_CERT !== undefined;
  const served = stackServed(stack?.file, record, {
    held: stack?.envFingerprints?.[name],
    fingerprint: complete
      ? valueFingerprint(input.valueKey, name, portainerOriginTls(values))
      : undefined,
  });
  return planOriginTls(deps, { plan: input.plan, record, served });
}

/**
 * What the Cloudflare plan's text says about the app's origin TLS beyond its changes: a renewed
 * certificate's deploy (`deploy`, the workflow the run starts once the deploy secret holds it; none
 * where the run itself brings it, as in a Portainer stack), the hostnames leaving the proxy, and a
 * clean-up that waits because what the origin serves could not be read.
 */
export function originTlsNotes(
  step: OriginTlsStep,
  deploy: { workflow: string; branch: string } | undefined,
): (plan: SharedPlan) => string[] {
  return (plan) => {
    const notes: string[] = [];
    if (deploy !== undefined && renewsOriginCertificate(plan)) {
      notes.push(
        `  The new origin certificate reaches the server with a deploy: once the deploy secret holds it, OpsCrew starts the deploy workflow (${deploy.workflow} on ${deploy.branch}).`,
      );
    }
    if (step.leaving.length > 0) {
      notes.push(
        `  ${listText(step.leaving)} left Cloudflare's proxy: the deploy after this run stops requiring Cloudflare's client certificate for ${step.leaving.length === 1 ? "it" : "them"}, and the next run turns it off at Cloudflare${step.holdsProxy ? " and switches the DNS records to DNS only" : ""}.`,
      );
    }
    const waiting =
      (plan.record.tls?.origin?.superseded.length ?? 0) > 0 || step.leaving.length > 0;
    if (step.desired.served === undefined && waiting) {
      notes.push(
        "  OpsCrew could not read what your server serves now, so the origin certificates it replaced and the client certificate's hostnames that left the proxy stay as they are until a run that can read it.",
      );
    }
    return notes;
  };
}

/**
 * The switch of the server's proxy this run's deploy makes, in words (with its interruption), when
 * the server's edge (`edge`, as read; `undefined` when it could not be read) runs another proxy
 * than `target.edge`; `undefined` when it runs the plan's, or none yet. With other OpsCrew apps on
 * the server it stops before any change: they share the proxy, and each app's deploy writes only
 * its own site (research R5); so does a proxy that could not be read there (it fails closed).
 */
export function edgeSwitch(
  plan: DeployPlan,
  edge: ServerEdge | undefined,
  others: readonly string[],
): string | undefined {
  if (edge === undefined && others.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew could not read which proxy your server runs, which every OpsCrew app on it shares (also ${listText([...others])}), so it cannot tell whether ${plan.app.name} may use ${EDGE_PROXIES[edgeProxy(plan)].label}. Nothing was changed.`,
      {
        hint: "Check that OpsCrew's login to your server works (the login from `opscrew interview`) and that /srv/edge/compose.yaml is readable there, then run the command again.",
      },
    );
  }
  const running = edge?.proxy;
  const wanted = edgeProxy(plan);
  if (running === undefined || running === wanted) return undefined;
  const from = EDGE_PROXIES[running].label;
  const to = EDGE_PROXIES[wanted].label;
  if (others.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Your server's proxy is ${from}, which every OpsCrew app on it shares (also ${listText([...others])}), so OpsCrew cannot switch it to ${to} for ${plan.app.name}. Nothing was changed.`,
      {
        hint: `Set target.edge back to "${running}" in opscrew/plan.yaml (or run \`opscrew design\` again), then run the command again. OpsCrew switches a server's proxy only while it holds one OpsCrew app.`,
      },
    );
  }
  return `The deploy after this run switches the server's proxy from ${from} to ${to}: the site is interrupted for a few seconds for hostnames behind Cloudflare's proxy, and for under a minute for DNS-only ones while ${to === "nginx" ? "certbot gets their first certificates" : "Caddy gets their certificates"}. kamal-proxy and the app keep running, and ${from}'s volumes stay, so switching back is quick.`;
}
