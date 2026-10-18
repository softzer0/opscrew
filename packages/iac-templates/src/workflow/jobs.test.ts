// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext } from "../__fixtures__/plans";
import { ACTIONS, TOOLS } from "../pins";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import { jobYaml, serverPlan, withBuild, withPlan } from "./__fixtures__/plans";
import { renderWorkflow } from "./index";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};
type Job = { needs: string | string[]; permissions: Record<string, string>; steps: Step[] };

const ctx = testContext();
const content = (plan: DeployPlan) => renderWorkflow(plan, ctx).content;
const jobs = (plan: DeployPlan): Record<string, Job> => parse(content(plan)).jobs;
const action = (key: keyof typeof ACTIONS) => ACTIONS[key].split(" #")[0];

const signed = withPlan(serverPlan(), { supplyChain: { sign: true } });
const tagged = withPlan(serverPlan(), { deployTags: { enabled: true } });
const released = withPlan(serverPlan(), { deployTags: { enabled: true, release: true } });

describe("signing", () => {
  it("is off by default", () => {
    expect(jobs(serverPlan()).sign).toBeUndefined();
    expect(content(serverPlan())).not.toContain("id-token");
  });

  it("signs the image digest with cosign keyless, in the only job that holds id-token: write", () => {
    const all = jobs(signed);
    const sign = all.sign as Job;
    expect(sign.needs).toBe("build");
    expect(sign.permissions).toEqual({ "id-token": "write", packages: "write" });
    for (const [id, job] of Object.entries(all)) {
      if (id !== "sign") expect(job.permissions["id-token"], id).toBeUndefined();
    }
    const install = sign.steps.find((s) => s.uses === action("cosignInstaller"));
    expect(install?.with).toEqual({ "cosign-release": TOOLS.cosign.version });
    const run = sign.steps.at(-1);
    expect(run?.env).toEqual({ IMAGE: "${{ needs.build.outputs.image }}" });
    expect(run?.run).toContain('cosign sign --yes "$IMAGE"');
    expect(run?.run).toContain("@sha256:[0-9a-f]{64}$");
    expect(jobYaml(content(signed), "sign")).toMatchSnapshot();
  });
});

describe("deploy tags", () => {
  it("are off by default", () => {
    expect(jobs(serverPlan()).tag).toBeUndefined();
  });

  it("tag the commit after a healthy deploy, in the only job that holds contents: write", () => {
    const all = jobs(tagged);
    const tag = all.tag as Job;
    expect(tag.needs).toEqual(["build", "deploy"]);
    expect(tag.permissions).toEqual({ contents: "write" });
    for (const [id, job] of Object.entries(all)) {
      if (id !== "tag") expect(job.permissions.contents, id).not.toBe("write");
    }
    expect(tag.steps).toHaveLength(1);
    expect(tag.steps[0]?.run).not.toContain("gh release");
    expect(jobYaml(content(tagged), "tag")).toMatchSnapshot();
  });

  it("create a release naming the digest with release", () => {
    expect(jobs(released).tag?.steps[0]?.run).toContain("gh release create");
    expect(jobYaml(content(released), "tag")).toMatchSnapshot();
  });

  function bashWorks(): boolean {
    try {
      return spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";
    } catch {
      return false;
    }
  }

  it.skipIf(!bashWorks())("name the tag deploy-<UTC yyyymmdd-hhmmss>", () => {
    const work = mkdtempSync(join(tmpdir(), "opscrew-tag-")).replaceAll("\\", "/");
    try {
      const IMAGE = `ghcr.io/acme/shop@sha256:${"b".repeat(64)}`;
      const fakes = [
        'gh() { printf "%s\\n" "$@" > "$WORK/gh"; }',
        'date() { [[ "$*" == "-u +%Y%m%d-%H%M%S" ]] && echo 20261018-154501; }',
      ].join("\n");
      const run = (plan: DeployPlan) => {
        const script = jobs(plan).tag?.steps[0]?.run ?? "";
        const result = spawnSync("bash", ["-c", `${fakes}\n${script}`], {
          env: {
            ...process.env,
            WORK: work,
            IMAGE,
            GITHUB_REPOSITORY: "acme/shop",
            GITHUB_SHA: "f".repeat(40),
            GITHUB_STEP_SUMMARY: `${work}/summary`,
          },
          encoding: "utf8",
        });
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        return readFileSync(join(work, "gh"), "utf8").trim().split("\n");
      };
      expect(run(tagged)).toEqual([
        "api",
        "repos/acme/shop/git/refs",
        "-f",
        "ref=refs/tags/deploy-20261018-154501",
        "-f",
        `sha=${"f".repeat(40)}`,
      ]);
      expect(run(released)).toEqual([
        "release",
        "create",
        "deploy-20261018-154501",
        "--repo",
        "acme/shop",
        "--target",
        "f".repeat(40),
        "--title",
        "deploy-20261018-154501",
        "--notes",
        `Deployed image: \`${IMAGE}\``,
      ]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("the jobs after the deploy", () => {
  it("lists only the jobs that are on", () => {
    expect(Object.keys(jobs(serverPlan()))).toEqual(["build", "deploy", "prune"]);
    const everything = withPlan(serverPlan(), {
      supplyChain: { sign: true },
      deployTags: { enabled: true },
    });
    expect(Object.keys(jobs(everything))).toEqual(["build", "deploy", "sign", "tag", "prune"]);
    const nothing = withPlan(serverPlan(), { imageRetention: { enabled: false } });
    expect(Object.keys(jobs(nothing))).toEqual(["build", "deploy"]);
  });

  it("matches the snapshot with every option off", () => {
    expect(
      content(withPlan(serverPlan(), { imageRetention: { enabled: false } })),
    ).toMatchSnapshot();
  });

  it("are the same for a Portainer target, which gets the same build", () => {
    const portainer = withBuild(
      withPlan(portainerTestPlan({ redeploy: "cloudflare" }), {
        supplyChain: { sign: true },
        deployTags: { enabled: true },
      }),
      "railpack",
      { language: "rust" },
    );
    const server = withBuild(
      withPlan(serverPlan(), { supplyChain: { sign: true }, deployTags: { enabled: true } }),
      "railpack",
      { language: "rust" },
    );
    const p = jobs(portainer);
    const s = jobs(server);
    expect(Object.keys(p)).toEqual(["build", "deploy", "sign", "tag", "prune"]);
    expect(p.build).toEqual(s.build);
    for (const id of ["sign", "tag", "prune"]) expect(p[id]).toEqual(s[id]);
    expect(parse(content(portainer)).jobs.deploy.outputs).toEqual({
      previous: "${{ steps.write.outputs.previous_image }}",
    });
  });
});
