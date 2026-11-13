/**
 * The user's own additions to the app's site (FR-1443, contracts/edge-and-checks.md): one file in
 * the proxy's syntax, `opscrew/proxy/additions.caddy`, `.nginx` or `.openlitespeed`, which the
 * site includes. Before any change, OpsCrew's rules scan it, gixy-ng advises on nginx's when it is
 * installed, and the proxy's own checker validates the whole edge with it when Docker is there.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "@opscrew/contracts";
import {
  findExecutable,
  generateP256,
  OpsCrewError,
  readTextIfExists,
  selfSignedClientCertificate,
  toPosixRelative,
} from "@opscrew/core";
import {
  additionsPath,
  certbotHosts,
  EDGE_PROXIES,
  type EdgeProxy,
  edgeProxy,
  IMAGES,
  OPENLITESPEED_CHECK,
  OPENLITESPEED_INPUT,
  otherProxies,
  type RuntimeContext,
  renderEdgeCompose,
  renderEdgeSite,
  siteHosts,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { localDocker, localDockerProblem, runGixy, scanProxyAdditions } from "@opscrew/secops";
import { parse } from "yaml";
import type { PhaseDeps } from "../context";
import { planFile } from "../runners/words";
import type { ProvisionServices } from "./types";

/** How long the proxy's checker may take, once its pinned image is on this computer. */
const CHECK_TIMEOUT_MS = 5 * 60_000;
/** How long downloading the proxy's pinned image may take (OpenLiteSpeed's is about 1.1 GB). */
const PULL_TIMEOUT_MS = 30 * 60_000;

/** The last lines of a command's answer, its errors last. */
function lastLines(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-8).join("\n");
}

/**
 * Downloads the proxy's pinned image for its check, in a step of its own with its own limit, unless
 * this computer has it already, so a slow download is never taken for the proxy's refusal.
 * Throws `COMMAND_FAILED` with Docker's last lines when the download fails or runs out of time.
 */
async function downloadCheckImage(
  deps: Pick<PhaseDeps, "runner" | "redactor" | "reporter">,
  proxy: EdgeProxy,
  path: string,
): Promise<void> {
  const { label } = EDGE_PROXIES[proxy];
  const { ref } = IMAGES[proxy];
  const there = await deps.runner.run("docker", ["image", "inspect", ref], { timeoutMs: 30_000 });
  if (there.exitCode === 0 && !there.timedOut) return;
  deps.reporter.step(
    `Downloading ${label}'s image for the check (once${proxy === "openlitespeed" ? "; it is about 1.1 GB" : ""})`,
  );
  const result = await deps.runner.run("docker", ["pull", ref], { timeoutMs: PULL_TIMEOUT_MS });
  if (result.exitCode === 0 && !result.timedOut) return;
  throw new OpsCrewError(
    "COMMAND_FAILED",
    deps.redactor.redact(
      `Docker couldn't download ${label}'s image (${ref}) to check your additions in ${path}${result.timedOut ? " (the download did not finish in 30 minutes)" : ""}:\n${lastLines(result)}\nNothing was changed.`,
    ),
    { hint: "Check this computer's connection to the internet, then run the command again." },
  );
}

/**
 * The files of the edge's proxy that its Compose file holds (`configs.<name>.content`), by where the
 * check mounts them: the main configuration, and on OpenLiteSpeed also the catch-all and the error
 * page.
 */
function edgeConfigs(compose: string, proxy: EdgeProxy): Record<string, string> {
  const document = parse(compose) as { configs?: Record<string, { content?: unknown }> };
  const names: Record<string, string> =
    proxy === "caddy"
      ? { caddyfile: "/etc/caddy/Caddyfile" }
      : proxy === "nginx"
        ? { "nginx-conf": "/etc/nginx/nginx.conf" }
        : {
            "openlitespeed-conf": OPENLITESPEED_INPUT.conf,
            "openlitespeed-catchall": OPENLITESPEED_INPUT.catchAll,
            "openlitespeed-error": OPENLITESPEED_INPUT.errorPage,
          };
  return Object.fromEntries(
    Object.entries(names).map(([name, target]) => {
      const content = document.configs?.[name]?.content;
      if (typeof content !== "string") {
        throw new Error(`The rendered edge has no ${name} for its proxy.`);
      }
      // Compose writes a literal `$` as `$$`.
      return [target, content.replaceAll("$$", "$")];
    }),
  );
}

/** A throwaway self-signed certificate and key that stand in for a real pair in the check. */
function placeholder(commonName: string): { certificate: string; key: string } {
  const key = generateP256().privateKey;
  return { certificate: selfSignedClientCertificate({ key, commonName, days: 1 }), key };
}

/**
 * Lays the edge out in a temporary folder as the server has it (the main configuration, the
 * app's site, its additions, placeholder certificates) and runs the proxy's own checker in its
 * pinned image, without a network, once for each of the app's site files (OpenLiteSpeed's edge's own
 * check, with kamal-proxy's name, which `openlitespeed -t` looks up, on the container's loopback).
 * Throws `PHASE_PRECONDITION` with the checker's output when it refuses.
 */
async function runProxyChecker(
  deps: Pick<PhaseDeps, "runner" | "redactor">,
  plan: DeployPlan,
  ctx: RuntimeContext,
  additions: { path: string; text: string },
): Promise<void> {
  const proxy = edgeProxy(plan);
  const { label, site } = EDGE_PROXIES[proxy];
  const app = plan.app.name;
  const dir = await mkdtemp(join(tmpdir(), "opscrew-edge-check-"));
  try {
    const configs = Object.entries(
      edgeConfigs(renderEdgeCompose(plan, ctx.cloudflareRanges).content, proxy),
    ).map(([target, content], index) => ({ target, content, file: join(dir, `config-${index}`) }));
    for (const config of configs) await writeFile(config.file, config.content);
    await mkdir(join(dir, "sites"));
    await writeFile(join(dir, "sites", `${app}.additions`), additions.text);
    const tls = join(dir, "tls", app);
    await mkdir(tls, { recursive: true });
    const origin = placeholder(app);
    await writeFile(join(tls, "origin.pem"), origin.certificate);
    await writeFile(join(tls, "origin.key"), origin.key);
    await writeFile(join(tls, "pull.pem"), origin.certificate);
    // On this computer the site serves the leaf of OpsCrew's local CA instead.
    await writeFile(join(tls, "local.pem"), origin.certificate);
    await writeFile(join(tls, "local.key"), origin.key);
    const live = join(dir, "letsencrypt", "live", app);
    await mkdir(live, { recursive: true });
    if (certbotHosts(plan, ctx).length > 0) {
      const certbot = placeholder(app);
      await writeFile(join(live, "fullchain.pem"), certbot.certificate);
      await writeFile(join(live, "privkey.pem"), certbot.key);
    }
    const mount = (from: string, to: string) => ["-v", `${from}:${to}:ro`];
    const user =
      typeof process.getuid === "function" && typeof process.getgid === "function"
        ? ["--user", `${process.getuid()}:${process.getgid()}`]
        : [];
    const mains = configs.flatMap((config) => mount(config.file, config.target));
    const args =
      proxy === "caddy"
        ? [
            ...mains,
            ...mount(join(dir, "sites"), "/etc/caddy/sites"),
            ...mount(join(dir, "tls"), "/etc/caddy/tls"),
            IMAGES.caddy.ref,
            ...["caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
          ]
        : proxy === "nginx"
          ? [
              ...user,
              ...mains,
              ...mount(join(dir, "sites"), "/etc/nginx/sites"),
              ...mount(join(dir, "tls"), "/etc/nginx/tls"),
              ...mount(join(dir, "letsencrypt"), "/etc/letsencrypt"),
              ...["--entrypoint", "nginx", IMAGES.nginx.ref, "-t"],
            ]
          : [
              ...["--add-host", "kamal-proxy:127.0.0.1"],
              ...mains,
              ...mount(join(dir, "sites"), OPENLITESPEED_INPUT.sites),
              ...mount(join(dir, "tls"), OPENLITESPEED_INPUT.tls),
              ...mount(join(dir, "letsencrypt"), "/etc/letsencrypt"),
              ...["--entrypoint", "sh", IMAGES.openlitespeed.ref, "-c", OPENLITESPEED_CHECK],
            ];
    // The site before certbot's first certificate is checked too. OpenLiteSpeed's other site
    // files are the same for both.
    const files = renderEdgeSite(plan, ctx).map((file) => ({
      name: file.path.slice(file.path.lastIndexOf("/") + 1),
      content: file.content,
    }));
    const variant = (name: string) => name.endsWith(`.${site}`);
    for (const file of files.filter((f) => !variant(f.name))) {
      await writeFile(join(dir, "sites", file.name), file.content);
    }
    for (const file of files.filter((f) => variant(f.name))) {
      await writeFile(join(dir, "sites", `${app}.${site}`), file.content);
      const result = await deps.runner.run(
        "docker",
        ["run", "--rm", "--network", "none", ...args],
        { timeoutMs: CHECK_TIMEOUT_MS },
      );
      if (result.exitCode === 0 && !result.timedOut) continue;
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        deps.redactor.redact(
          `${label} refused this app's site with your additions in ${additions.path}${result.timedOut ? " (its check did not finish in time)" : ""}:\n${lastLines(result)}\nNothing was changed.`,
        ),
        { hint: `Fix ${additions.path} for the reason above, then run the command again.` },
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Said when the app has additions but runs in the user's Portainer, whose app stack's Caddy has
 * none yet: the file is not used there.
 */
export async function portainerAdditionsNote(
  deps: Pick<PhaseDeps, "paths" | "reporter">,
): Promise<void> {
  for (const proxy of Object.keys(EDGE_PROXIES)) {
    const file = join(deps.paths.files.shared.proxyDir, `additions.${proxy}`);
    if ((await readTextIfExists(file)) === undefined) continue;
    const additions = toPosixRelative(deps.paths.root, file);
    deps.reporter.warn(
      `OpsCrew does not use ${additions} in your Portainer: the app stack's Caddy has no additions yet, so the site stays as OpsCrew renders it.`,
    );
  }
}

/**
 * Checks the app's additions for the plan's proxy on a server before any change, and says whether there are
 * any (the render's `additions`). A file for another proxy is refused with how to convert it;
 * OpsCrew's rules refuse what is unsafe, each with its line; gixy-ng's findings on nginx are shown
 * as advice when it is installed (not those that do not apply to what OpsCrew wrote); and when Docker runs on this computer, the proxy's own checker
 * validates the whole edge with the additions (`ctx` as the deploy renders it). Any refusal stops
 * with `PHASE_PRECONDITION` and nothing changed.
 */
export async function checkAdditions(
  deps: Pick<PhaseDeps, "paths" | "runner" | "redactor" | "reporter">,
  plan: DeployPlan,
  ctx: RuntimeContext,
  services: Pick<ProvisionServices, "which">,
): Promise<boolean> {
  const root = deps.paths.root;
  const proxy = edgeProxy(plan);
  const path = additionsPath(plan, proxy);
  for (const otherProxy of otherProxies(proxy)) {
    const other = EDGE_PROXIES[otherProxy];
    const otherPath = additionsPath(plan, otherProxy);
    if ((await readTextIfExists(join(root, otherPath))) === undefined) continue;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${otherPath} holds additions for ${other.label}, but this app's proxy is ${EDGE_PROXIES[proxy].label} (target.edge), so OpsCrew would not use them. Nothing was changed.`,
      {
        hint: `Write the same rules in ${EDGE_PROXIES[proxy].label}'s syntax in ${path} and delete ${otherPath}, or set target.edge to "${otherProxy}" in ${planFile(plan)}; then run the command again.`,
      },
    );
  }
  const text = await readTextIfExists(join(root, path));
  if (text === undefined) return false;
  const refusals = scanProxyAdditions(text, {
    proxy,
    // On this computer the site serves its .localhost hostname.
    hostnames: ctx.localhost !== undefined ? [ctx.localhost.hostname] : siteHosts(plan),
    upstream: EDGE_PROXIES[proxy].upstream,
  });
  if (refusals.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      deps.redactor.redact(
        [
          `OpsCrew refuses your additions in ${path}. Nothing was changed.`,
          ...refusals.map((r) => `  line ${r.line} (${r.rule}): ${r.message}`),
        ].join("\n"),
      ),
      { hint: `Change ${path} as each line above says, then run the command again.` },
    );
  }
  if (proxy === "nginx") {
    const advice = await runGixy(join(root, path), deps.runner, {
      which: services.which ?? ((name: string) => findExecutable(name)),
    });
    // Advice that does not apply to the lines OpsCrew wrote (`noise`) is not shown.
    for (const result of advice.filter((r) => r.noise === undefined)) {
      deps.reporter.warn(deps.redactor.redact(`gixy-ng on ${path}: ${result.message}`));
    }
  }
  const { label } = EDGE_PROXIES[proxy];
  if ((await localDockerProblem(localDocker(deps.runner))) === undefined) {
    await downloadCheckImage(deps, proxy, path);
    deps.reporter.step(`Checking your additions with ${label} (Docker)`);
    await runProxyChecker(deps, plan, ctx, { path, text });
  } else {
    deps.reporter.info(
      `Docker is not running on this computer, so ${label}'s own check of your additions runs in the deploy, before anything reaches the server.`,
    );
  }
  return true;
}
