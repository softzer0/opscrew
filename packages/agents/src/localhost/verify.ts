/**
 * `opscrew verify` for the localhost target (FR-1508): the same questions as on a server, asked
 * through 127.0.0.1 with the app's hostname as the Host header and the TLS server name, trusting
 * only OpsCrew's local CA: the health route over HTTPS, the certificate, the HTTP redirect, files
 * that must not be served, the ports on 127.0.0.1 only, and the components running.
 */
import type { CheckResult } from "@opscrew/contracts";
import { readTextIfExists, toPosixRelative } from "@opscrew/core";
import { EDGE_PROJECT } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { environmentFlag } from "../environments/choice";
import { checkResult, summarizeChecks, writePlanIfChanged, writeRenderedFiles } from "../shared";
import type { VerifyResult } from "../verify/run";
import { caFiles, caTrusted, LEAF_RENEW_DAYS } from "./ca";
import { projectObjects } from "./docker";
import { type LocalRequest, type LocalResponse, nodeLocalRequest } from "./https";
import { renderLocalRunbook } from "./runbook";
import { computer, type LocalhostServices } from "./services";
import { localAddress, localTarget, servedSite } from "./site";
import { localComponentStatus } from "./status";

/** A request that gives back why it failed instead of throwing. */
async function ask(
  request: LocalRequest,
  input: Parameters<LocalRequest>[0],
): Promise<LocalResponse | { error: string }> {
  try {
    return await request(input);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Checks the app on this computer, writes its runbook, and when nothing fails records
 * `deployment.firstDeployAt` (once). Not trusting the local CA is a warning that says how to.
 */
export async function verifyLocalhost(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: LocalhostServices = {},
): Promise<VerifyResult> {
  const { paths, reporter } = deps;
  const target = localTarget(plan);
  // The hostname the last deploy serves, which a later localhost environment may change.
  const site = await servedSite(paths, plan);
  const address = localAddress(site, target);
  const request = computer(deps, services).request ?? nodeLocalRequest;
  const ca = await readTextIfExists(caFiles(paths).certificate);
  const https = (path: string) =>
    ask(request, {
      scheme: "https",
      port: target.ports.https,
      hostname: site.hostname,
      path,
      ...(ca !== undefined ? { ca } : {}),
      timeoutMs: 10_000,
    });
  const health = plan.app.healthPath;
  const checks: CheckResult[] = [];

  const answer = await https(health);
  checks.push(
    "status" in answer && answer.status === 200
      ? checkResult(
          "local-health",
          "The app answers its health route over HTTPS",
          "high",
          "pass",
          `GET ${address}${health} answered 200 through 127.0.0.1.`,
        )
      : checkResult(
          "local-health",
          "The app answers its health route over HTTPS",
          "high",
          "fail",
          "status" in answer
            ? `GET ${address}${health} answered ${answer.status}.`
            : `GET ${address}${health} did not answer: ${answer.error}.`,
          {
            remediation:
              "Run `opscrew status` to see which containers run, and `opscrew provision` to deploy again.",
          },
        ),
  );
  const certificate = "status" in answer ? answer.certificate : undefined;
  if (certificate === undefined) {
    checks.push(
      checkResult(
        "local-certificate",
        "The site's certificate is OpsCrew's local CA's",
        "high",
        "fail",
        "No certificate from OpsCrew's local CA was served.",
        {
          remediation: "Run `opscrew provision`: it issues the app's certificate.",
        },
      ),
    );
  } else {
    const days = Math.floor(
      (Date.parse(certificate.validTo) - deps.clock.now().getTime()) / 86_400_000,
    );
    const names = certificate.subjectAltName.split(",").map((name) => name.trim());
    checks.push(
      !names.includes(`DNS:${site.hostname}`)
        ? checkResult(
            "local-certificate",
            "The site's certificate is OpsCrew's local CA's",
            "high",
            "fail",
            `The certificate names ${certificate.subjectAltName}, not ${site.hostname}.`,
            {
              remediation: "Run `opscrew provision`: it issues the app's certificate again.",
            },
          )
        : checkResult(
            "local-certificate",
            "The site's certificate is OpsCrew's local CA's",
            "medium",
            days < LEAF_RENEW_DAYS ? "warn" : "pass",
            `Issued by OpsCrew's local CA for ${site.hostname}, valid for ${days} more days.`,
            days < LEAF_RENEW_DAYS
              ? { remediation: "Run `opscrew provision`: it renews the certificate." }
              : {},
          ),
    );
  }

  const redirect = await ask(request, {
    scheme: "http",
    port: target.ports.http,
    hostname: site.hostname,
    path: "/",
    timeoutMs: 10_000,
  });
  const redirects =
    "status" in redirect &&
    [301, 302, 307, 308].includes(redirect.status) &&
    (redirect.location ?? "").startsWith(`https://${site.hostname}`);
  checks.push(
    checkResult(
      "local-redirect",
      "Plain HTTP redirects to HTTPS",
      "low",
      redirects ? "pass" : "warn",
      redirects
        ? `http://${site.hostname}:${target.ports.http}/ redirects to ${("location" in redirect && redirect.location) || "HTTPS"}.`
        : `http://${site.hostname}:${target.ports.http}/ did not redirect to HTTPS.`,
    ),
  );

  const served: string[] = [];
  for (const path of ["/.env", "/.git/config"]) {
    const result = await https(path);
    if ("status" in result && result.status === 200) served.push(path);
  }
  checks.push(
    served.length === 0
      ? checkResult(
          "local-secret-files",
          "Secret files are not served",
          "high",
          "pass",
          "/.env and /.git/config are not served.",
        )
      : checkResult(
          "local-secret-files",
          "Secret files are not served",
          "high",
          "fail",
          `${served.join(" and ")} answered 200.`,
          {
            remediation:
              "Keep these files out of the image (.dockerignore), then run `opscrew provision` again.",
          },
        ),
  );

  const edge = await projectObjects(deps, EDGE_PROJECT);
  const open = edge.containers.flatMap((container) =>
    container.ports
      .split(",")
      .map((port) => port.trim())
      .filter((port) => port.includes("->") && !port.startsWith("127.0.0.1:")),
  );
  checks.push(
    open.length === 0 && edge.containers.length > 0
      ? checkResult(
          "local-loopback",
          "The edge listens on 127.0.0.1 only",
          "high",
          "pass",
          "Only this computer reaches the site.",
        )
      : checkResult(
          "local-loopback",
          "The edge listens on 127.0.0.1 only",
          "high",
          "fail",
          edge.containers.length === 0
            ? "OpsCrew's edge is not running on this computer."
            : `The edge also listens on ${open.join(", ")}.`,
          { remediation: "Run `opscrew provision`: it starts the edge on 127.0.0.1 again." },
        ),
  );

  const status = await localComponentStatus(deps, plan);
  const down = status.components
    .filter((component) => component.running === 0)
    .map((c) => c.service);
  checks.push(
    down.length === 0
      ? checkResult(
          "local-components",
          "Every component runs",
          "high",
          "pass",
          `${status.components.length} components run.`,
        )
      : checkResult(
          "local-components",
          "Every component runs",
          "high",
          "fail",
          `Not running: ${down.join(", ")}.`,
          {
            remediation: "Run `opscrew status`, then `opscrew provision` to start them again.",
          },
        ),
  );

  checks.push(
    (await caTrusted(paths))
      ? checkResult(
          "local-trust",
          "This computer trusts OpsCrew's local CA",
          "low",
          "pass",
          "Browsers show the site without a warning.",
        )
      : checkResult(
          "local-trust",
          "This computer trusts OpsCrew's local CA",
          "low",
          "warn",
          "Browsers warn about the site's certificate until this computer trusts OpsCrew's local CA.",
          {
            remediation:
              "Run `opscrew localhost trust` (it shows the command first; `opscrew localhost untrust` undoes it).",
          },
        ),
  );

  const runbookPath = toPosixRelative(paths.root, paths.files.runbook);
  await writeRenderedFiles(paths.root, [renderLocalRunbook(plan, { address, file: runbookPath })]);
  const passed = checks.every((check) => check.status !== "fail");
  let current = plan;
  if (passed && plan.deployment.firstDeployAt === undefined) {
    current = {
      ...plan,
      deployment: { ...plan.deployment, firstDeployAt: deps.clock.now().toISOString() },
    };
    await writePlanIfChanged(deps, current);
  }
  const summary = summarizeChecks(checks);
  if (passed) {
    reporter.success(
      `${address} is live and healthy on this computer (${summary}). Runbook: ${runbookPath}`,
    );
  } else {
    // ` --env <name>` beside other environments (`--env prod` included).
    const flag = await environmentFlag(paths.root, paths.environment);
    reporter.error(
      `Verification found problems (${summary}). Fix them and run \`opscrew verify${flag}\` again.`,
    );
    reporter.info(`Runbook: ${runbookPath}`);
  }
  await deps.state.markPhase("verify", passed ? "ok" : "failed", summary);
  return { checks, passed, url: address, runbookPath, plan: current };
}
