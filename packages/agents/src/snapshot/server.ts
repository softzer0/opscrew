/**
 * `opscrew snapshot --server [--stop] [--server-name <name>]` and `opscrew restore --server <id>`
 * (024 US4, FR-2405, plan.md 5., D5): the provider's snapshot of a whole server OpsCrew created at
 * Hetzner Cloud or DigitalOcean, and a rebuild of that server from one in place, keeping its id,
 * addresses and firewall. Both go through the connectors only, never `tofu apply`; the server
 * modules ignore the image, so the next provision plans no replacement. A restore is
 * destroy-grade (`allowDestroy` and the server's name typed) and ends with the app's health check
 * `opscrew verify` runs. Own servers, Portainer and this computer are refused, naming the data
 * snapshot instead.
 */
import type {
  AppServer,
  CheckResult,
  ComputeCatalog,
  Money,
  ProviderExtras,
  ServerSnapshotApi,
} from "@opscrew/contracts";
import { errorText, formatMoney, OpsCrewError, sha256Hex, taxLabel } from "@opscrew/core";
import { APP_SERVER, type CloudProvider, isCloudProvider } from "@opscrew/plan-schema";
import { defaultTcpConnect, formatUtc } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { destroyTexts } from "../destroy/texts";
import { NOTHING_CHANGED } from "../promote/shared";
import { providerProfile, vpsConnector } from "../providers";
import { missing } from "../provision/credentials";
import { MAINTENANCE_WINDOW_TITLE } from "../retarget/texts";
import { provisionedElsewhereHint, serverAddress } from "../shared";
import { cloudServerName } from "../shared/servers";
import { pollUntil } from "../shared/wait";
import { checkHealth, siteUrl, type VerifyCheckContext } from "../verify/checks";
import { defaultDnsResolver, defaultTlsConnect } from "../verify/net";
import { cloudProviders, type ProviderSnapshot, providerSnapshots, serverApi } from "./provider";
import { requireNoDeployOrMove, type SnapshotRun, snapshotRun, snapshotTarget } from "./run";
import { snapshotIdAt } from "./store";
import type { SnapshotEntry, SnapshotServices } from "./types";

/** How long the app may take to answer after a rebuild, and how often it is asked. */
const HEALTH_WAIT_MS = 5 * 60_000;
const HEALTH_INTERVAL_MS = 10_000;

/** What `opscrew snapshot --server` refuses with, after what. */
const NOTHING_TAKEN = "No snapshot was taken.";

/**
 * Collaborators of the whole-server commands: the snapshot commands' ones, a provider's price
 * catalogue, and the waits between the app's health checks after a restore. Each defaults to
 * the real one.
 */
export interface ServerSnapshotServices extends SnapshotServices {
  /** A provider's prices (default: its connector's catalogue, live with a token). */
  catalog?: (provider: CloudProvider) => ComputeCatalog;
  /** Waits between health checks (default: real time). */
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds for the health checks' wait (default `Date.now`). */
  now?: () => number;
}

export interface TakeServerSnapshotOptions {
  /** `--server-name <name>`: one of the app's extra servers (018) instead of the app's server. */
  serverName?: string;
  /** `--stop`: shut the server down for the snapshot and start it again, approved first. */
  stop?: boolean;
  services?: ServerSnapshotServices;
}

export interface RestoreServerOptions {
  services?: ServerSnapshotServices;
}

/** A whole server's snapshot at its provider. */
export interface ServerSnapshotResult {
  /** The provider's id of the snapshot. */
  id: string;
  /** Where it is, in words: `at Hetzner Cloud (server shop-staging)`. */
  where: string;
  server: NonNullable<SnapshotEntry["server"]>;
}

/** A snapshot `opscrew snapshot --server` took. */
export interface TakenServerSnapshot extends ServerSnapshotResult {
  /** Its billed size in GB, once the provider reports it. */
  sizeGb?: number;
  /** Its monthly price at the provider's rate (excluding VAT or tax), when both are known. */
  monthly?: Money;
}

/** A server `opscrew restore --server` rebuilt; it throws when the app does not answer after. */
export interface RestoredServer extends ServerSnapshotResult {
  /** False when this computer does not know the server's address, so the app was not checked. */
  checked: boolean;
}

/** `--server` refused where OpsCrew created no server, naming the data snapshot instead. */
function noProviderServer(run: SnapshotRun, which: string, command: string): OpsCrewError {
  const { plan, environment, flags } = run;
  const app = plan.target.provider;
  const place =
    app === "portainer"
      ? `${environment} runs in your Portainer`
      : app === "localhost"
        ? `${environment} runs on this computer`
        : `${which === APP_SERVER ? "The app's server" : `Server ${which}`} of ${environment} is your own server`;
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${place}, and \`${command}\` only works on a server OpsCrew created at Hetzner Cloud or DigitalOcean, whose provider snapshots and rebuilds it. ${NOTHING_CHANGED}`,
    {
      hint: `\`opscrew snapshot${flags}\` takes a snapshot of the app's data there, \`opscrew snapshot list${flags}\` shows them and \`opscrew restore <id>${flags}\` restores one.`,
    },
  );
}

/** `CREDENTIALS_MISSING` for `provider`'s token. */
function noToken(run: SnapshotRun, provider: CloudProvider): OpsCrewError {
  return missing(
    providerProfile(provider).displayName,
    vpsConnector(provider, run.deps).credentials,
  );
}

/** A server OpsCrew created, found at its provider. */
interface FoundServer {
  provider: CloudProvider;
  api: ServerSnapshotApi;
  server: AppServer;
  /** Its location and size in the plan. */
  target: { location: string; serverType: string };
}

/** The server `--server-name` names (default the app's) with its provider and API, found there. */
async function serverToSnapshot(run: SnapshotRun, which: string): Promise<FoundServer> {
  const { plan, environment, flags } = run;
  const extra = plan.servers?.find((server) => server.name === which);
  if (which !== APP_SERVER && extra === undefined) {
    const names = (plan.servers ?? []).map((server) => server.name);
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${environment} has no server ${which}. ${NOTHING_TAKEN}`,
      {
        hint:
          names.length === 0
            ? `Leave --server-name out: ${environment} has only the app's server.`
            : `Name one of ${names.join(", ")} with --server-name, or leave it out for the app's server.`,
      },
    );
  }
  const target = extra === undefined ? plan.target : extra.target;
  if (!isCloudProvider(target.provider) || !("serverType" in target)) {
    throw noProviderServer(run, which, "opscrew snapshot --server");
  }
  const provider = target.provider;
  const profile = providerProfile(provider);
  const api = serverApi(run, provider);
  if (api === undefined) throw noToken(run, provider);
  const name = which === APP_SERVER ? plan.app.name : cloudServerName(plan, which);
  const named = (await api.findAppServers(plan.app.name)).filter((s) => s.name === name);
  const [server] = named;
  if (server === undefined || named.length > 1) {
    const { console: where, noun } = destroyTexts(provider);
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      server === undefined
        ? `OpsCrew found no ${noun} ${name} of ${environment} at ${profile.displayName}. ${NOTHING_TAKEN}`
        : `Several ${noun}s at ${profile.displayName} are named ${name}, so OpsCrew cannot tell which one to snapshot. ${NOTHING_TAKEN}`,
      {
        hint: `Check the ${noun}s in ${where} (\`opscrew drift${flags}\` shows what changed outside OpsCrew), then try again.`,
      },
    );
  }
  return { provider, api, server, target };
}

/** `€0.011`: a rate with the digits it has, unlike {@link formatMoney}'s two. */
function rateText(rate: Money): string {
  return `${rate.currency === "EUR" ? "€" : "$"}${rate.amount}`;
}

/** `sizeGb` at `rate` a month. */
function priceOf(sizeGb: number, rate: Money): Money {
  return { amount: sizeGb * rate.amount, currency: rate.currency };
}

/** `€0.44`, or `under €0.01` for an amount two decimals would show as nothing. */
function priceText(price: Money): string {
  return price.amount < 0.005
    ? `under ${formatMoney({ ...price, amount: 0.01 })}`
    : formatMoney(price);
}

/** The provider's snapshot rate and the server's disk size, from its price catalogue. */
async function prices(
  deps: PhaseDeps,
  services: ServerSnapshotServices,
  { provider, target }: FoundServer,
): Promise<{ extras: ProviderExtras; diskGb?: number }> {
  const catalog = services.catalog?.(provider) ?? vpsConnector(provider, deps).catalog();
  const offer = (await catalog.listOffers(target.location)).find(
    (candidate) => candidate.id === target.serverType,
  );
  const extras = await catalog.extras(target.location);
  return { extras, ...(offer === undefined ? {} : { diskGb: offer.diskGb }) };
}

/** The summary's price line before the snapshot: at most the server's whole disk. */
function priceLine(provider: CloudProvider, extras: ProviderExtras, diskGb?: number): string {
  const { noun } = destroyTexts(provider);
  const rate = extras.snapshotPerGbMonth;
  if (rate === undefined) return `It is ${destroyTexts(provider).snapshotBilled}.`;
  const tax = taxLabel(rate.currency, extras.pricesIncludeVat);
  const published =
    extras.snapshotRateAsOf === undefined
      ? ""
      : ` (the published rate of ${extras.snapshotRateAsOf.slice(0, 10)})`;
  const per = `${rateText(rate)} per GB per month, ${tax}${published}`;
  return diskGb === undefined
    ? `It costs ${per}, for the size the provider bills once it is taken.`
    : `It costs up to ${priceText(priceOf(diskGb, rate))} a month: the ${noun}'s ${diskGb} GB disk at ${per}. The provider bills the snapshot's size, shown once it is taken.`;
}

/**
 * Takes the snapshot, shutting the server down first and starting it again after with `stop`.
 * The start is tried whatever happened before it; a failure says what state the server is in.
 */
async function snapshotWith(
  run: SnapshotRun,
  input: { provider: CloudProvider; api: ServerSnapshotApi; server: AppServer; stop: boolean },
): Promise<string> {
  const { deps, plan, environment } = run;
  const { provider, api, server, stop } = input;
  const { noun, console: where } = destroyTexts(provider);
  const stamp = snapshotIdAt(deps.clock.now());
  const request = {
    name: `opscrew-${plan.app.name}-${stamp}`,
    description: `OpsCrew snapshot of ${server.name} (${environment}), ${stamp}`,
    // Never `managed-by`, so that cleanups by that label keep the snapshot.
    labels: { "created-by": "opscrew", app: plan.app.name, env: environment, "taken-at": stamp },
  };
  const audit = (action: string, detail: string) =>
    deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action,
      target: `${provider} server ${server.id}`,
      ...(stop ? { decision: "approved" as const } : {}),
      detail: deps.redactor.redact(detail),
    });
  if (!stop) {
    deps.reporter.step(`Taking the snapshot of the ${noun} ${server.name} while it runs`);
    await audit("create snapshot", `snapshot ${request.name} of ${server.name}, live`);
    const { snapshotId } = await api.snapshotServer(server.id, request);
    await audit("snapshot ready", `snapshot ${snapshotId} of ${server.name}`);
    return snapshotId;
  }
  let snapshotId: string | undefined;
  let failure: unknown;
  let off = false;
  try {
    deps.reporter.step(`Shutting the ${noun} ${server.name} down (up to 5 minutes)`);
    await audit("shut down server", `${server.name}, for a snapshot`);
    await api.powerOff(server.id);
    off = true;
    deps.reporter.step(`Taking the snapshot of the ${noun} ${server.name}`);
    await audit("create snapshot", `snapshot ${request.name} of ${server.name}, shut down`);
    snapshotId = (await api.snapshotServer(server.id, request)).snapshotId;
    await audit("snapshot ready", `snapshot ${snapshotId} of ${server.name}`);
  } catch (error) {
    failure = error;
  }
  deps.reporter.step(`Starting the ${noun} ${server.name} again`);
  const started = await api.powerOn(server.id).then(
    () => undefined,
    (error: unknown) => error,
  );
  await audit("start server", `${server.name}: ${started === undefined ? "started" : "failed"}`);
  const startedText =
    started === undefined
      ? off
        ? `The ${noun} was started again.`
        : `OpsCrew asked the ${noun} to start again, in case its shutdown went on.`
      : `Starting the ${noun} again failed too (${errorText(started)}), so it may be off and the app offline: check it in ${where} and start it there.`;
  if (failure !== undefined) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      deps.redactor.redact(
        `OpsCrew could not take the snapshot of the ${noun} ${server.name}: ${errorText(failure)}. ${startedText}`,
      ),
      { hint: `Check its snapshots in ${where}, then try again.` },
    );
  }
  if (started !== undefined) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      deps.redactor.redact(
        `OpsCrew took the snapshot ${snapshotId} of the ${noun} ${server.name}, but could not start the ${noun} again: ${errorText(started)}. It is off, so the app is offline.`,
      ),
      { hint: `Start the ${noun} in ${where}, then run \`opscrew verify${run.flags}\`.` },
    );
  }
  return snapshotId as string;
}

/**
 * `opscrew snapshot --server` on the environment `deps` belong to: refused on own servers,
 * Portainer, this computer and while a deploy or a move runs; otherwise shows what it costs (at
 * most the server's disk at the provider's snapshot rate) and that attached volumes are not in it,
 * then takes the provider's snapshot of the app's server (or `--server-name`'s), while it runs
 * with a warning that it may not be consistent, or with `--stop` shut down after approving that
 * downtime and started again. The result has its billed size and monthly price, once known.
 * @throws OpsCrewError `PHASE_PRECONDITION` for each refusal, `INVALID_INPUT` for an unknown
 * `--server-name`, `CREDENTIALS_MISSING` without the provider's token, `APPROVAL_REFUSED` when the
 * downtime is not approved, `PROVIDER_ERROR` when the provider fails.
 */
export async function takeServerSnapshot(
  deps: PhaseDeps,
  options: TakeServerSnapshotOptions = {},
): Promise<TakenServerSnapshot> {
  const run = await snapshotRun(deps, options.services);
  const { environment, flags } = run;
  const which = options.serverName ?? APP_SERVER;
  const stop = options.stop === true;
  if (snapshotTarget(run) !== "servers") {
    throw noProviderServer(run, which, "opscrew snapshot --server");
  }
  const found = await serverToSnapshot(run, which);
  const { provider, api, server } = found;
  await requireNoDeployOrMove(run, "take a snapshot of a server");
  const profile = providerProfile(provider);
  const { noun, console: where } = destroyTexts(provider);
  const { extras, diskGb } = await prices(deps, options.services ?? {}, found);
  const lines = [
    `A snapshot of the whole ${noun} ${server.name} of ${environment} at ${profile.displayName}:`,
    stop
      ? `- The ${noun} is shut down for it and started again after: the app is offline meanwhile, usually a few minutes (up to 5 minutes to shut down cleanly, then as long as the snapshot takes).`
      : `- It is taken while the ${noun} runs. A live snapshot may not be consistent: data being written at that moment can be incomplete in it. \`opscrew snapshot --server --stop${flags}\` shuts the ${noun} down for it instead.`,
    `- ${priceLine(provider, extras, diskGb)}`,
    `- It holds the ${noun}'s own disk only: volumes attached to it at ${profile.displayName} are not included.`,
    `- It stays at ${profile.displayName} until you delete it (\`opscrew snapshot delete <id>${flags}\`).`,
  ];
  deps.reporter.info(lines.join("\n"));
  if (stop) {
    const approval = await deps.approvals.request({
      kind: "remote-exec",
      title: `${MAINTENANCE_WINDOW_TITLE} shut down the ${noun} ${server.name} of ${environment} for a snapshot`,
      details: lines.join("\n"),
    });
    if (!approval.approved) {
      throw new OpsCrewError("APPROVAL_REFUSED", `Nothing was stopped. ${NOTHING_TAKEN}`, {
        hint: `Run \`opscrew snapshot --server --stop${flags}\` again and approve it, or leave --stop out to take it while the ${noun} runs.`,
      });
    }
  }
  const id = await snapshotWith(run, { provider, api, server, stop });
  const sizeGb = (await api.listSnapshots(server.id)).find((s) => s.id === id)?.sizeGb;
  const rate = extras.snapshotPerGbMonth;
  const monthly = sizeGb === undefined || rate === undefined ? undefined : priceOf(sizeGb, rate);
  const billed =
    sizeGb === undefined
      ? `${profile.displayName} does not report its size yet; \`opscrew snapshot list${flags}\` shows it later`
      : monthly === undefined
        ? `${sizeGb} GB, ${destroyTexts(provider).snapshotBilled}`
        : `${sizeGb} GB, ${priceText(monthly)} a month ${taxLabel(monthly.currency, extras.pricesIncludeVat)}`;
  deps.reporter.success(
    `Took the snapshot ${id} of the ${noun} ${server.name} of ${environment} at ${profile.displayName} (${billed}). Delete it in ${where} or with \`opscrew snapshot delete ${id}${flags}\` when you no longer need it.`,
  );
  return {
    id,
    where: `at ${profile.displayName} (${noun} ${server.name})`,
    server: { provider, id: server.id, name: server.name },
    ...(sizeGb === undefined ? {} : { sizeGb }),
    ...(monthly === undefined ? {} : { monthly }),
  };
}

/** The restore's approval text: what is lost, what stays, and the protection's lift. */
function restoreLines(found: ProviderSnapshot): string[] {
  const { entry } = found;
  const server = entry.server as NonNullable<SnapshotEntry["server"]>;
  const profile = providerProfile(server.provider);
  const noun = profile.serverNoun;
  return [
    `The snapshot ${entry.id} of the ${noun} ${server.name}, taken ${formatUtc(entry.taken)}, ${entry.where}.`,
    `${profile.displayName} rebuilds the ${noun} from it in place: its disk is replaced by the snapshot's, so everything written on it since, the app's data, version and settings included, is lost for good. Its addresses and firewall stay.`,
    ...(profile.deleteProtection
      ? [
          `The ${noun}'s delete and rebuild protection is lifted for the rebuild and set again right after it, whether it succeeds or fails.`,
        ]
      : []),
    `Volumes attached to the ${noun} are not in the snapshot and are not changed.`,
    `The app is offline until the ${noun} has started from the snapshot; OpsCrew then checks that it answers.`,
    `Typing ${server.name} approves it.`,
  ];
}

/**
 * The app's health endpoint, as `opscrew verify` checks it, polled until it answers 200 or 5
 * minutes have passed; `undefined` when this computer does not know where the app is.
 */
async function appHealth(
  run: SnapshotRun,
  services: ServerSnapshotServices,
): Promise<CheckResult | undefined> {
  const { deps, plan, flags } = run;
  let url = siteUrl(plan);
  if (url === undefined) {
    const address = await serverAddress(deps, plan);
    if (address !== undefined) {
      deps.redactor.addName(address.ipv4, "server-address");
      if (address.ipv6 !== undefined) deps.redactor.addName(address.ipv6, "server-address");
    }
    url = siteUrl(plan, address);
  }
  if (url === undefined) return undefined;
  const ctx: VerifyCheckContext = {
    plan,
    resolver: defaultDnsResolver,
    fetch: deps.fetch,
    tlsConnect: defaultTlsConnect,
    tcpConnect: defaultTcpConnect,
    now: deps.clock.now(),
    deployRuns: async () => undefined,
    flag: flags,
  };
  let last: CheckResult | undefined;
  await pollUntil(
    async () => {
      last = await checkHealth(url, ctx);
      return last.status === "pass" ? true : undefined;
    },
    {
      timeoutMs: HEALTH_WAIT_MS,
      intervalMs: HEALTH_INTERVAL_MS,
      ...(services.sleep === undefined ? {} : { sleep: services.sleep }),
      ...(services.now === undefined ? {} : { now: services.now }),
    },
  );
  // pollUntil checks at least once.
  return last as CheckResult;
}

/**
 * `opscrew restore --server <id>` on the environment `deps` belong to: refused on own servers,
 * Portainer, this computer and while a deploy or a move runs; otherwise finds the whole-server
 * snapshot `id` among those OpsCrew took of the app's servers, asks the destroy-grade approval
 * (`allowDestroy`, the server's name typed, `--confirm <name>` in a script; its hash covers the
 * snapshot, the server and the text), rebuilds that server from it in place through its
 * connector, and checks that the app answers, as `opscrew verify` does.
 * @throws OpsCrewError `INVALID_INPUT` for an id that isn't a provider's, `PHASE_PRECONDITION`
 * for each refusal and an unknown id, `APPROVAL_REFUSED` when the name is not typed,
 * `PROVIDER_ERROR` when the rebuild fails, `COMMAND_FAILED` when the app does not answer after.
 */
export async function restoreServerSnapshot(
  deps: PhaseDeps,
  id: string,
  options: RestoreServerOptions = {},
): Promise<RestoredServer> {
  if (!/^\d+$/.test(id)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${id} is no whole-server snapshot's id: the providers' ids are numbers. ${NOTHING_CHANGED}`,
      { hint: "`opscrew snapshot list` shows each snapshot's id and kind." },
    );
  }
  const run = await snapshotRun(deps, options.services);
  const { environment, flags } = run;
  const providers = snapshotTarget(run) === "servers" ? cloudProviders(run) : [];
  if (providers.length === 0) throw noProviderServer(run, APP_SERVER, "opscrew restore --server");
  const tokenless = providers.find((provider) => serverApi(run, provider) === undefined);
  if (tokenless !== undefined) throw noToken(run, tokenless);
  await requireNoDeployOrMove(run, "restore a server from a snapshot");
  const found = (await providerSnapshots(run)).find((candidate) => candidate.entry.id === id);
  if (found === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${environment} has no whole-server snapshot ${id} that OpsCrew took. ${NOTHING_CHANGED}`,
      {
        hint: `\`opscrew snapshot list${flags}\` shows its snapshots; the whole-server ones are of kind server.`,
      },
    );
  }
  const server = found.entry.server as NonNullable<SnapshotEntry["server"]>;
  const profile = providerProfile(server.provider);
  const noun = profile.serverNoun;
  const lines = restoreLines(found);
  const hash = sha256Hex(
    JSON.stringify({
      provider: server.provider,
      server: server.id,
      name: server.name,
      snapshot: id,
      lines,
    }),
  );
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `Rebuild the ${noun} ${server.name} of ${environment} from the snapshot ${id}`,
    details: [...lines, `Restore hash: ${hash}`].join("\n"),
    planHash: hash,
    allowDestroy: true,
    confirmPhrase: server.name,
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The ${noun} ${server.name} was not rebuilt${approval.reason === undefined ? "" : `: ${approval.reason}`}. ${NOTHING_CHANGED}`,
      {
        hint: `Run \`opscrew restore --server ${id}${flags}\` again and type ${server.name} (in a script: --confirm ${server.name} --approve ${hash}).`,
      },
    );
  }
  const audit = (action: string, detail: string) =>
    deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action,
      target: `${server.provider} server ${server.id}`,
      decision: "approved",
      detail: deps.redactor.redact(detail),
    });
  deps.reporter.step(
    `Rebuilding the ${noun} ${server.name} from the snapshot ${id} (this can take several minutes)`,
  );
  await audit("rebuild server", `${server.name} from snapshot ${id} (${hash})`);
  try {
    await found.api.rebuild(server.id, id);
  } catch (error) {
    await audit("rebuild failed", `${server.name} from snapshot ${id}: ${errorText(error)}`);
    throw error;
  }
  await audit("server rebuilt", `${server.name} from snapshot ${id}`);
  const result = { id, where: found.entry.where, server };
  deps.reporter.step("Checking that the app answers (up to 5 minutes)");
  const health = await appHealth(run, options.services ?? {});
  if (health === undefined) {
    deps.reporter.warn(
      `Rebuilt the ${noun} ${server.name} from the snapshot ${id}, but OpsCrew does not know the server's address on this computer, so it did not check the app: ${provisionedElsewhereHint(`opscrew verify${flags}`)}.`,
    );
    return { ...result, checked: false };
  }
  if (health.status !== "pass") {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      deps.redactor.redact(
        `Rebuilt the ${noun} ${server.name} from the snapshot ${id}, but the app did not answer within 5 minutes: ${health.message}`,
      ),
      health.remediation === undefined ? {} : { hint: deps.redactor.redact(health.remediation) },
    );
  }
  deps.reporter.success(
    deps.redactor.redact(
      `Rebuilt the ${noun} ${server.name} of ${environment} from the snapshot ${id}, and the app answers: ${health.message}`,
    ),
  );
  return { ...result, checked: true };
}
