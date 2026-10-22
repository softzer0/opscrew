// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { TOOLS, toolDownloadUrl } from "../pins";
import { DEPLOY_SECRETS, renderWorkflow, TUNNEL_DEPLOY_SECRETS } from "./index";

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
};

const ctx = testContext();
const tunnelPlan = testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com" });
const tunnel = renderWorkflow(tunnelPlan, ctx).content;
const tunnelDoc = parse(tunnel);
const deploySteps: Step[] = tunnelDoc.jobs.deploy.steps;
const install = deploySteps.find((s) => s.name?.startsWith("Install cloudflared"));
const sshSteps = deploySteps.filter((s) => (s.run ?? "").includes("ssh_opts"));

describe("renderWorkflow for an own server in tunnel mode", () => {
  it("installs the pinned cloudflared and checks its SHA-256 before SSH is configured", () => {
    expect(install?.name).toBe(`Install cloudflared ${TOOLS.cloudflared.version}`);
    const names = deploySteps.map((s) => s.name ?? s.uses);
    expect(names.indexOf(install?.name)).toBeLessThan(
      names.indexOf("Configure SSH with the pinned host key"),
    );
    const run = install?.run ?? "";
    expect(run).toContain(
      "https://github.com/cloudflare/cloudflared/releases/download/2026.5.1/cloudflared-linux-amd64",
    );
    expect(run).toContain(toolDownloadUrl("cloudflared", "arm64"));
    expect(run).toContain(TOOLS.cloudflared.sha256.amd64);
    expect(run).toContain(TOOLS.cloudflared.sha256.arm64);
    expect(run).toMatch(/sha256sum -c -/);
    expect(run.indexOf("sha256sum -c")).toBeLessThan(run.indexOf("sudo install"));
  });

  it("vendors well-formed checksums", () => {
    for (const sum of Object.values(TOOLS.cloudflared.sha256))
      expect(sum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reaches SSH on the SSH hostname through cloudflared access ssh", () => {
    const configure = deploySteps.find((s) => s.name === "Configure SSH with the pinned host key");
    expect(configure?.run).toContain("echo 'Host ssh-shop.example.com'");
    expect(configure?.run).toContain(
      "echo '  ProxyCommand /usr/local/bin/cloudflared access ssh --hostname %h'",
    );
    expect(sshSteps.map((s) => s.name)).toEqual([
      "Upload runtime files and environment",
      "Start the new version",
      "Roll back to the previous version",
    ]);
    for (const step of sshSteps) {
      expect(step.env?.HOST).toBe("ssh-shop.example.com");
      expect(step.env?.TUNNEL_SERVICE_TOKEN_ID).toBe(
        `\${{ secrets.${TUNNEL_DEPLOY_SECRETS.serviceTokenId} }}`,
      );
      expect(step.env?.TUNNEL_SERVICE_TOKEN_SECRET).toBe(
        `\${{ secrets.${TUNNEL_DEPLOY_SECRETS.serviceTokenSecret} }}`,
      );
    }
    expect(tunnel).not.toContain(`secrets.${DEPLOY_SECRETS.host}`);
  });

  it("never prints the service token or puts it on a command line", () => {
    for (const step of deploySteps) {
      const run = step.run ?? "";
      expect(run).not.toMatch(/TUNNEL_SERVICE_TOKEN|service-token|\$\{\{/);
    }
    expect(tunnel.match(/TUNNEL_SERVICE_TOKEN_(?:ID|SECRET):/g)).toHaveLength(6);
  });

  it("checks health on the domain through Cloudflare", () => {
    const health = deploySteps.find((s) => s.id === "health");
    expect(health?.env?.URL).toBe("https://shop.example.com/api/health");
  });

  it("matches the snapshot", () => {
    expect(tunnel).toMatchSnapshot();
  });
});

describe("renderWorkflow for an own server in public mode", () => {
  it("is the workflow OpsCrew-created servers get", () => {
    const own = renderWorkflow(testPlan({ provider: "own", domain: "shop.example.com" }), ctx);
    const hetzner = renderWorkflow(testPlan({ domain: "shop.example.com" }), ctx);
    expect(own).toEqual(hetzner);
    expect(own.content).not.toMatch(/cloudflared|TUNNEL_/);
  });
});

describe("renderWorkflow build runner", () => {
  it("builds arm64 images on GitHub's arm64 runner and everything else on ubuntu-latest", () => {
    const runner = (plan: ReturnType<typeof testPlan>) =>
      parse(renderWorkflow(plan, ctx).content).jobs as Record<string, { "runs-on": string }>;
    const arm = runner(testPlan({ provider: "own", arch: "arm64" }));
    expect(arm.build?.["runs-on"]).toBe("ubuntu-24.04-arm");
    expect(arm.deploy?.["runs-on"]).toBe("ubuntu-latest");
    for (const plan of [
      testPlan({ provider: "own", arch: "amd64" }),
      testPlan(),
      testPlan({ provider: "digitalocean" }),
    ]) {
      expect(runner(plan).build?.["runs-on"]).toBe("ubuntu-latest");
    }
  });
});

function bashWorks(): boolean {
  try {
    const probe = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
    return probe.status === 0 && probe.stdout.trim() === "ok";
  } catch {
    return false;
  }
}

/*
 * Runs the generated install script in bash with a fake `uname`, `curl` (writes FAKE_BINARY),
 * `sudo` and `install` (copies into $WORK/bin), and the real `sha256sum`.
 */
describe.skipIf(!bashWorks())("cloudflared install script", { timeout: 60_000 }, () => {
  const FAKE_BINARY = "fake cloudflared binary";
  const fakeSum = createHash("sha256").update(FAKE_BINARY).digest("hex");
  const PRELUDE = [
    'uname() { echo "$FAKE_MACHINE"; }',
    'curl() { local out=""; while [[ $# -gt 0 ]]; do case "$1" in -o) out="$2"; shift 2 ;; https://*) echo "$1" >> "$WORK/urls"; shift ;; *) shift ;; esac; done; printf "%s" "$FAKE_BINARY" > "$out"; }',
    'sudo() { "$@"; }',
    'install() { mkdir -p "$WORK/bin"; cp "${@: -2:1}" "$WORK/bin/cloudflared"; }',
    "cloudflared() { echo 'cloudflared version 2026.5.1'; }",
  ].join("\n");

  function run(script: string, machine: string) {
    const work = mkdtempSync(join(tmpdir(), "opscrew-cloudflared-")).replaceAll("\\", "/");
    try {
      const result = spawnSync("bash", ["-c", `${PRELUDE}\n${script}`], {
        env: {
          ...process.env,
          WORK: work,
          RUNNER_TEMP: work,
          FAKE_MACHINE: machine,
          FAKE_BINARY,
        },
        encoding: "utf8",
      });
      const urls = existsSync(join(work, "urls")) ? readFileSync(join(work, "urls"), "utf8") : "";
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
        urls: urls.trim().split("\n"),
        installed: existsSync(join(work, "bin", "cloudflared")),
      };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  const script = install?.run ?? "";

  it("refuses a download whose checksum differs and installs nothing", () => {
    const result = run(script, "x86_64");
    expect(result.status).not.toBe(0);
    expect(result.urls).toEqual([toolDownloadUrl("cloudflared", "amd64")]);
    expect(result.installed).toBe(false);
  });

  it("installs the binary for the runner's architecture when the checksum matches", () => {
    for (const [machine, arch] of [
      ["x86_64", "amd64"],
      ["aarch64", "arm64"],
    ] as const) {
      const result = run(script.replace(TOOLS.cloudflared.sha256[arch], fakeSum), machine);
      expect(result.status, result.output).toBe(0);
      expect(result.urls).toEqual([toolDownloadUrl("cloudflared", arch)]);
      expect(result.installed).toBe(true);
    }
  });

  it("stops on a runner it has no build for", () => {
    const result = run(script, "riscv64");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("no cloudflared build for this runner (riscv64)");
    expect(result.installed).toBe(false);
  });
});

// Reads the release's asset digests from the GitHub API, so it only runs with OPSCREW_IT=1.
describe.skipIf(process.env.OPSCREW_IT !== "1")(
  "vendored cloudflared checksums (integration)",
  () => {
    it("match the digests GitHub lists for the release assets", async (test) => {
      let release: { assets: { name: string; digest?: string }[] };
      try {
        const response = await fetch(
          `https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${TOOLS.cloudflared.version}`,
          { headers: { accept: "application/vnd.github+json" } },
        );
        if (!response.ok) test.skip(`GitHub answered ${response.status}`);
        release = (await response.json()) as typeof release;
      } catch (error) {
        test.skip(`GitHub could not be reached: ${String(error)}`);
        return;
      }
      for (const arch of ["amd64", "arm64"] as const) {
        const asset = release.assets.find((a) => a.name === `cloudflared-linux-${arch}`);
        expect(asset?.digest).toBe(`sha256:${TOOLS.cloudflared.sha256[arch]}`);
      }
    });
  },
);
