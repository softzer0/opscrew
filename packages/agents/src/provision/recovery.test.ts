import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import { findExecutable, type OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { refreshRecoveryCopy, restoreRecoveryCopy } from "../secrets";
import { FAKE_SOPS, FakeSops } from "../secrets/__fixtures__/fake-sops";
import { planAndCopyFiles } from "../secrets/__fixtures__/world";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  fakeCloudflare,
  fakeSharedCloudflare,
  opscrewRecord,
  planJsonFor,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  SERVER_IPV6,
  testPlan,
  writeFakeState,
} from "../testing";
import { DEPLOY_SETUP_BRANCH } from "./publish";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

const STRIPE = fakeSecret("stripe-live-key");

/** A clock that `later()` moves on an hour, so a stamped time always differs. */
function steppedClock() {
  let now = Date.parse("2026-10-21T08:00:00.000Z");
  return {
    clock: { now: () => new Date(now) },
    later: () => {
      now += 3_600_000;
    },
  };
}

/** Phase deps for the project at `root`, with OpsCrew's folder inside it and sops the fake. */
async function depsFor(
  root: string,
  shared: { sops: FakeSops; clock: { now: () => Date }; handler: ScriptedApprovalHandler },
) {
  await writeFile(join(root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
  return createTestPhaseDeps({
    root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(root, ".home-opscrew"),
      HCLOUD_TOKEN: fakeSecret("hcloud-token"),
      OPSCREW_APP_ENV_FILE: "production.env",
      OPSCREW_SOPS_BIN: FAKE_SOPS,
    },
    runner: shared.sops.runner(projectRunner()),
    approvalHandler: shared.handler,
    clock: shared.clock,
  });
}

async function project() {
  const created = await createProject(testPlan({ domain: "shop.example.com" }));
  const handler = new ScriptedApprovalHandler(() => true);
  const sops = new FakeSops();
  const { clock, later } = steppedClock();
  const deps = await depsFor(created.root, { sops, clock, handler });
  const engine = new FakeEngine({
    planJson: planJsonFor({ proxied: true }),
    outputs: {
      server_ipv4: SERVER_IPV4,
      server_ipv6: SERVER_IPV6,
      server_id: "4711",
      server_name: "shop",
      url: "https://shop.example.com",
    },
  });
  const zone = new FakeZone();
  const github = new FakeGitHub();
  const cloudflare = fakeCloudflare();
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    cloudflare,
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(zone),
  };
  return {
    ...created,
    deps,
    handler,
    services,
    engine,
    zone,
    sops,
    clock,
    later,
    github,
    cloudflare,
  };
}

type Project = Awaited<ReturnType<typeof project>>;

/**
 * The first provision, which makes the first recovery copy, and its pull request merged on GitHub
 * (its branch deleted there) and pulled into this clone's main; the next infrastructure plan has
 * nothing to change. Returns the age key file's text.
 */
async function provisionedAndMerged(s: Project): Promise<string> {
  const keyOut = join(await mkdtemp(join(tmpdir(), "opscrew-recovery-keys-")), "age-key.txt");
  await writeFakeState(s.deps.paths);
  const first = await runProvision(s.deps, {
    services: s.services,
    recovery: { keyOut: async () => keyOut },
  });
  expect(first.branch).toBe(DEPLOY_SETUP_BRANCH);
  expect(await s.git(s.root, "show", "--name-only", "--format=", "HEAD")).toContain(
    "opscrew/secrets.sops.json",
  );
  const merged = await s.git(s.root, "rev-parse", DEPLOY_SETUP_BRANCH);
  await s.git(s.bare, "update-ref", "refs/heads/main", merged);
  await s.git(s.bare, "update-ref", "-d", `refs/heads/${DEPLOY_SETUP_BRANCH}`);
  await s.git(s.root, "checkout", "-q", "main");
  await s.git(s.root, "merge", "-q", "--ff-only", DEPLOY_SETUP_BRANCH);
  // What the first apply created in the zone.
  s.cloudflare.state.records.push(
    opscrewRecord("shop.example.com", "A", SERVER_IPV4),
    opscrewRecord("shop.example.com", "AAAA", SERVER_IPV6),
  );
  s.engine.scenario.changes = [];
  return readFile(keyOut, "utf8");
}

/** The branches of the clone at `root` and of GitHub (the bare remote). */
async function branches(s: Pick<Project, "git" | "bare">, root: string) {
  return [await s.git(root, "branch", "--list"), await s.git(s.bare, "branch", "--list")];
}

/**
 * A provision with nothing to change, an hour later: no apply, no file changed, nothing committed,
 * pushed or opened, and the clone stays on main.
 */
async function expectNothingPublished(s: Project, deps: Project["deps"], root: string) {
  const before = await planAndCopyFiles(deps);
  const listed = await branches(s, root);
  const pulls = s.github.pulls.length;
  const applies = s.engine.applied.length;
  s.handler.requests.length = 0;
  s.later();
  const said = deps.reporter.text().length;

  const result = await runProvision(deps, { services: s.services });

  expect(s.engine.applied).toHaveLength(applies);
  expect(await planAndCopyFiles(deps)).toEqual(before);
  expect(await refreshRecoveryCopy(deps, testPlan())).toEqual({ changed: false });
  expect(s.github.pulls).toHaveLength(pulls);
  expect(await branches(s, root)).toEqual(listed);
  expect(await s.git(root, "branch", "--show-current")).toBe("main");
  expect(await s.git(root, "status", "--porcelain", "--", "opscrew", ".github")).toBe("");
  const asked = s.handler.requests.map((r) => r.kind);
  expect(asked).not.toContain("git-push");
  expect(asked).not.toContain("pull-request");
  expect(result).not.toHaveProperty("prUrl");
  expect(deps.reporter.text().slice(said)).toContain(
    "The deployment files did not change, so OpsCrew committed nothing and opened no pull request.",
  );
  // The secrets were stored again; a changed value reaches the app only with its next deploy.
  expect(deps.reporter.text().slice(said)).toContain(
    "OpsCrew stored the deploy secrets in GitHub Actions again. If you changed a value, the running app gets it on its next deploy: run opscrew-deploy.yml on main in GitHub Actions, or push a commit.",
  );
  expect(deps.reporter.text().slice(said)).not.toContain("deploys the app.");
}

describe.skipIf(!findExecutable("git"))("opscrew provision: the recovery copy", () => {
  it("stops before any plan or change when another computer updated the repository's copy", async () => {
    const s = await project();
    await mkdir(join(s.root, "opscrew"), { recursive: true });
    await writeFile(join(s.root, "opscrew/secrets.sops.json"), '{"files":{},"sops":{}}\n');
    const error = (await runProvision(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("SECRETS_COPY_CHANGED_ELSEWHERE");
    expect(error.hint).toContain("opscrew secrets restore");
    expect(s.handler.requests).toEqual([]);
    expect(s.engine.calls).toEqual([]);
    expect(s.zone.calls).toEqual([]);
  });

  it("asks the first key's file through the run's recovery options when the first copy is made", async () => {
    const s = await project();
    const asked: string[] = [];
    await runProvision(s.deps, {
      services: s.services,
      recovery: {
        recipient: async () => {
          asked.push("recipient");
          return undefined;
        },
        keyOut: async () => {
          asked.push("keyOut");
          return undefined;
        },
      },
    });
    expect(asked).toEqual(["recipient", "keyOut"]);
  });

  it("a second provision with nothing to change publishes nothing", async () => {
    const s = await project();
    await provisionedAndMerged(s);
    await expectNothingPublished(s, s.deps, s.root);
  });

  it("on a fresh computer, a provision right after the restore publishes nothing either", async () => {
    const s = await project();
    const key = await provisionedAndMerged(s);
    // Another computer: a new clone of GitHub's main, and OpsCrew's files only from the copy.
    const root = await mkdtemp(join(tmpdir(), "opscrew-provision-clone-"));
    await s.git(root, "clone", "-q", s.bare, ".");
    await s.git(root, "config", "user.name", "OpsCrew Test");
    await s.git(root, "config", "user.email", "test@example.invalid");
    await s.git(root, "config", "commit.gpgsign", "false");
    await s.git(root, "remote", "set-url", "origin", "https://github.com/acme/shop.git");
    await s.git(root, "remote", "set-url", "--push", "origin", s.bare);
    const deps = await depsFor(root, s);
    const restored = await restoreRecoveryCopy(deps, { identity: key });
    expect(restored.restored).toEqual(
      expect.arrayContaining([
        "home/deploy_secrets.json",
        "home/generated_values.json",
        "state/cloudflare.json",
        "state/server.json",
        "state/tfstate/prod.tfstate",
      ]),
    );

    await expectNothingPublished(s, deps, root);
  });
});
