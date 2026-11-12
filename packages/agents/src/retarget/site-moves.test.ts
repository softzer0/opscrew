import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exists, findExecutable, OpsCrewError, tfstateFile } from "@opscrew/core";
import { CLOUDFLARE_DEPLOY_SECRETS, siteEnvSecret } from "@opscrew/iac-templates";
import type { ServerlessProvider } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { pagesVerificationStateFile } from "../shared";
import {
  type ScriptedApprovalHandler,
  SITE_MOVE,
  type SiteMoveHarness,
  siteMoveHarness as setup,
} from "../testing";
import { abortRetarget } from "./abort";
import { finishRetarget } from "./finish";
import { runRetarget } from "./run";
import type { RetargetOptions } from "./types";

const {
  CF_TOKEN,
  DEPLOY_TOKEN,
  GITHUB_TOKEN,
  API_KEY,
  VERIFICATION,
  DOMAIN,
  PAGES_ADDRESS,
  SHELL,
  CUSTOM_DOMAIN,
  PAGES_RECORD,
  VERIFICATION_RECORD,
} = SITE_MOVE;

type Setup = SiteMoveHarness;

/** Every file under the project apart from git's objects and the user's own env file. */
async function projectText(root: string): Promise<string> {
  const texts: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "production.env") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else texts.push(await readFile(path, "utf8"));
    }
  };
  await walk(root);
  return texts.join("\n");
}

/** Every user-visible or persisted text of the runs so far, for the leak checks. */
async function everything(s: Setup): Promise<string> {
  return [
    ...s.runs.flatMap(({ deps, handler }) => [
      deps.reporter.text(),
      JSON.stringify(deps.audit.entries),
      JSON.stringify(handler.requests),
    ]),
    JSON.stringify(s.github.pulls),
    JSON.stringify(s.zone.calls),
    s.engine.appliedPlans.join("\n"),
    await projectText(s.root),
  ].join("\n");
}

/** The kinds of the approvals a run asked for, in order. */
const kinds = (handler: ScriptedApprovalHandler) => handler.requests.map((r) => r.kind);

/** `runRetarget` with the setup's services. */
async function move(s: Setup, options: Omit<RetargetOptions, "services"> = {}, interactive = true) {
  const { deps, handler } = await s.run({ interactive });
  const result = await runRetarget(deps, { ...options, services: s.services });
  return { deps, handler, result };
}

/** The move to `to` started and its deploy setup merged: the next run deploys and switches. */
async function merged(s: Setup, to: ServerlessProvider): Promise<void> {
  await move(s, to === "github-pages" ? { to, pagesVerification: VERIFICATION } : { to });
  await s.merge();
  if (to === "cloudflare-workers") s.github.deploy = s.workerDeploys;
}

/** The error `work` stopped with. */
async function failure(work: Promise<unknown>): Promise<OpsCrewError> {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** `--finish` or `--abort` in a run of its own, the app's name typed. */
async function end(
  s: Setup,
  command: "finish" | "abort",
  o: { interactive?: boolean; approvePlanHash?: string } = {},
) {
  const { deps, handler } = await s.run({ interactive: o.interactive ?? true });
  const options = {
    services: s.services,
    confirm: async () => true,
    ...(o.approvePlanHash !== undefined ? { approvePlanHash: o.approvePlanHash } : {}),
  };
  const result = await (command === "finish"
    ? finishRetarget(deps, options)
    : abortRetarget(deps, options));
  return { deps, handler, result };
}

const HASH = /^[0-9a-f]{64}$/;

/** The Worker's deploy secrets, which only its deploys read. */
const WORKER_SECRETS = Object.values(CLOUDFLARE_DEPLOY_SECRETS);

describe.skipIf(!findExecutable("git"))(
  "a site's move between site hosts",
  { timeout: 300_000 },
  () => {
    it("moves from GitHub Pages to Cloudflare's hosting and back, each change approved by its hash", async () => {
      const s = await setup("github-pages");

      // 1. To Cloudflare's hosting: the Worker without custom domains, its secrets, the pull request.
      const first = await move(s, { to: "cloudflare-workers" });
      expect(first.result).toMatchObject({ step: "started", done: false });
      expect(first.result.next[0]).toContain("Merge https://github.com/acme/shop/pull/7");
      expect(kinds(first.handler)).toEqual([
        "iac-apply",
        "github-secrets",
        "git-push",
        "pull-request",
      ]);
      expect(first.handler.requests[0]).toMatchObject({
        planHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(first.handler.requests[0]?.allowDestroy).toBeUndefined();
      expect(s.engine.appliedPlans).toEqual([SHELL.map((a) => `create ${a}`).join(", ")]);
      const summary = first.deps.reporter.text();
      expect(summary).toContain("Moving example-app from GitHub Pages to Cloudflare hosting:");
      expect(summary).toContain("No maintenance window: a site has no data to copy.");
      expect(summary).toContain("The site is unreachable for the seconds between the two.");
      expect(s.github.secrets.get("OPSCREW_CLOUDFLARE_API_TOKEN")).toBe(DEPLOY_TOKEN);
      expect(s.github.secrets.get("OPSCREW_ENV_API_KEY")).toBe(API_KEY);
      const started = await s.readPlan();
      expect(started.target.provider).toBe("cloudflare-workers");
      expect(started.dns.proxied).toBe(true);
      expect(started.retarget).toMatchObject({
        step: "started",
        from: { target: { provider: "github-pages" } },
      });
      // GitHub Pages still serves the domain: its site and record are untouched.
      expect(s.pages.state.site).toMatchObject({ cname: DOMAIN });

      // 2. Merged: the deploy run, the Worker checked through Cloudflare's API, then the switch.
      await s.merge();
      s.github.deploy = s.workerDeploys;
      const second = await move(s);
      expect(second.result).toMatchObject({ step: "switched", done: true });
      expect(s.github.dispatches).toEqual([{ workflowFile: "opscrew-deploy.yml", ref: "main" }]);
      expect(kinds(second.handler)).toEqual(["iac-apply", "cloudflare-apply"]);
      const switchPlan = second.handler.requests[0];
      expect(switchPlan).toMatchObject({ allowDestroy: true, confirmPhrase: "example-app" });
      expect(s.engine.appliedPlans.at(-1)).toBe(`create ${CUSTOM_DOMAIN}, delete ${PAGES_RECORD}`);
      expect(s.checked).toEqual([`https://${DOMAIN}/`]);
      expect(second.result.next[0]).toContain("opscrew retarget --finish");

      // 3. Finish: the GitHub Pages site goes after the typed name; its verification record stays.
      const finished = await s.run();
      const confirmed: string[] = [];
      const end = await finishRetarget(finished.deps, {
        services: s.services,
        confirm: async (preview) => {
          confirmed.push(preview.name);
          return true;
        },
      });
      expect(end).toMatchObject({ step: "finished", done: true });
      expect(confirmed).toEqual(["example-app"]);
      expect(kinds(finished.handler)).toEqual(["pages-apply", "git-push", "pull-request"]);
      expect(finished.handler.requests[0]).toMatchObject({
        allowDestroy: true,
        confirmPhrase: "example-app",
      });
      expect(s.pages.state.site).toBeUndefined();
      expect(end.next.join("\n")).toContain(
        "_github-pages-challenge-example-org.docs.example.com stays",
      );
      const onWorkers = await s.readPlan();
      expect(onWorkers.retarget).toBeUndefined();
      expect(onWorkers.target).toMatchObject({
        provider: "cloudflare-workers",
        worker: "example-app",
      });
      expect(
        await exists(join(s.root, "opscrew/infra/modules/cloudflare-dns/github-pages/main.tf")),
      ).toBe(false);
      expect(await readFile(join(s.root, "opscrew/infra/prod/main.tf"), "utf8")).not.toContain(
        "move",
      );

      // 4. And back to GitHub Pages: the site turned on without a custom domain, then the pull request.
      await s.merge();
      const back = await move(s, { to: "github-pages", pagesVerification: VERIFICATION });
      expect(back.result).toMatchObject({ step: "started", done: false });
      expect(kinds(back.handler)).toEqual([
        "pages-apply",
        "github-secrets",
        "git-push",
        "pull-request",
      ]);
      expect(s.pages.state.site).toEqual({ buildType: "workflow", httpsEnforced: false });
      // The verification record stayed, so its plan changes nothing.
      expect(s.engine.states.get(pagesVerificationStateFile(s.paths))).toEqual(
        new Set([VERIFICATION_RECORD]),
      );

      await s.merge();
      s.github.deploy = () => undefined;
      const switched = await move(s);
      expect(switched.result).toMatchObject({ step: "switched", done: true });
      // The Pages plan sets the domain first, then one plan moves the hostname.
      expect(kinds(switched.handler)).toEqual(["pages-apply", "iac-apply"]);
      expect(switched.handler.requests[1]).toMatchObject({
        allowDestroy: true,
        confirmPhrase: "example-app",
      });
      expect(s.engine.appliedPlans.at(-1)).toBe(`create ${PAGES_RECORD}, delete ${CUSTOM_DOMAIN}`);
      expect(s.pages.state.site).toMatchObject({ cname: DOMAIN });
      expect(s.checked.slice(-2)).toEqual([PAGES_ADDRESS, `http://${DOMAIN}/`]);
      expect(switched.result.next.join("\n")).toContain("run `opscrew provision`");

      // 5. Finish: OpsCrew's rules for the Worker's hostnames, then the Worker, after the typed name.
      const last = await s.run();
      const done = await finishRetarget(last.deps, {
        services: s.services,
        confirm: async () => true,
      });
      expect(done).toMatchObject({ step: "finished", done: true });
      expect(kinds(last.handler)).toEqual([
        "cloudflare-apply",
        "iac-apply",
        "git-push",
        "pull-request",
      ]);
      for (const request of last.handler.requests.slice(0, 2)) {
        expect(request).toMatchObject({ allowDestroy: true, confirmPhrase: "example-app" });
      }
      expect(s.engine.appliedPlans.at(-1)).toBe(SHELL.map((a) => `delete ${a}`).join(", "));
      const onPages = await s.readPlan();
      expect(onPages.retarget).toBeUndefined();
      expect(onPages.target.provider).toBe("github-pages");
      expect(onPages.dns.proxied).toBe(false);
      expect(onPages.security.wafCustomRules).toBe(false);
      expect(await exists(join(s.root, "opscrew/cloudflare/wrangler.jsonc"))).toBe(false);
      // The Worker's deploy secrets are still there for the user to delete, as the output says.
      expect(done.next.join("\n")).toContain("OPSCREW_CLOUDFLARE_API_TOKEN");
      for (const name of WORKER_SECRETS) expect(s.github.secrets.has(name)).toBe(true);

      // Nothing secret anywhere: output, audit, approvals, pull requests, Cloudflare calls, files.
      const text = await everything(s);
      for (const secret of [CF_TOKEN, DEPLOY_TOKEN, GITHUB_TOKEN, API_KEY]) {
        expect(text).not.toContain(secret);
      }
    }, 480_000); // Two moves, there and back: past 180 s while other test runs share the machine.

    it("aborts a move to GitHub Pages before the switch: the Pages site goes, the Worker keeps the domain", async () => {
      const s = await setup("cloudflare-workers");
      // The Worker's provision stored its deploy secrets and the site's value from this computer.
      const stored = [...WORKER_SECRETS, siteEnvSecret("API_KEY")];
      for (const name of stored) s.github.secrets.set(name, "stored");
      await mkdir(dirname(s.paths.files.deploySecrets), { recursive: true });
      await writeFile(
        s.paths.files.deploySecrets,
        `${JSON.stringify({ host: "cloudflare-workers", repo: "example-org/example-app", names: stored })}\n`,
      );
      const first = await move(s, { to: "github-pages", pagesVerification: VERIFICATION });
      expect(first.result).toMatchObject({ step: "started", done: false });
      expect(s.pages.state.site).toEqual({ buildType: "workflow", httpsEnforced: false });
      // The site's values for the Pages build are stored; the Worker's deploy secrets stay.
      expect(kinds(first.handler)).toContain("github-secrets");
      for (const name of WORKER_SECRETS) expect(s.github.secrets.has(name)).toBe(true);

      const aborted = await s.run();
      const result = await abortRetarget(aborted.deps, {
        services: s.services,
        confirm: async () => true,
      });
      expect(result).toMatchObject({ step: "aborted", done: true });
      expect(kinds(aborted.handler)[0]).toBe("pages-apply");
      expect(aborted.handler.requests[0]).toMatchObject({
        allowDestroy: true,
        confirmPhrase: "example-app",
      });
      expect(s.pages.state.site).toBeUndefined();
      // The Worker and its custom domain were never touched.
      expect(s.engine.states.get(tfstateFile(s.paths))).toEqual(new Set([...SHELL, CUSTOM_DOMAIN]));
      const plan = await s.readPlan();
      expect(plan.retarget).toBeUndefined();
      expect(plan.target.provider).toBe("cloudflare-workers");
      expect(plan.dns.proxied).toBe(true);
      expect(result.next.join("\n")).toContain("stays, so docs.example.com stays verified");
      // The Worker deploys again with its own deploy secrets.
      for (const name of WORKER_SECRETS) expect(s.github.secrets.has(name)).toBe(true);
    });

    it("refuses to abort once the hostnames moved, and to finish before they did", async () => {
      const s = await setup("github-pages");
      await move(s, { to: "cloudflare-workers" });
      const early = await s.run();
      await expect(
        finishRetarget(early.deps, { services: s.services, confirm: async () => true }),
      ).rejects.toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringContaining("do not go to Cloudflare hosting yet"),
      });
      await s.merge();
      s.github.deploy = s.workerDeploys;
      expect((await move(s)).result.step).toBe("switched");
      const late = await s.run();
      await expect(abortRetarget(late.deps, { services: s.services })).rejects.toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringContaining("can no longer be aborted"),
      });
    });

    it("aborts before the switch from GitHub Pages: the Worker's shell is deleted and the deploy setup goes back", async () => {
      const s = await setup("github-pages");
      await move(s, { to: "cloudflare-workers" });
      await s.merge();
      s.github.deploy = s.workerDeploys;
      // The switch plan is refused, so the move stays deployed.
      const second = await s.run({ answer: (kind) => kind !== "iac-apply" });
      await expect(runRetarget(second.deps, { services: s.services })).rejects.toMatchObject({
        code: "APPROVAL_REFUSED",
      });
      expect((await s.readPlan()).retarget?.step).toBe("deployed");

      const aborted = await s.run();
      const result = await abortRetarget(aborted.deps, {
        services: s.services,
        confirm: async () => true,
      });
      expect(result).toMatchObject({ step: "aborted", done: true });
      expect(aborted.handler.requests[0]).toMatchObject({
        kind: "iac-apply",
        allowDestroy: true,
        confirmPhrase: "example-app",
      });
      expect(s.engine.appliedPlans.at(-1)).toBe(SHELL.map((a) => `delete ${a}`).join(", "));
      expect(s.engine.states.get(tfstateFile(s.paths))).toEqual(new Set([PAGES_RECORD]));
      const plan = await s.readPlan();
      expect(plan.retarget).toBeUndefined();
      expect(plan.target.provider).toBe("github-pages");
      expect(plan.dns.proxied).toBe(false);
      // The Worker's settings leave the repository again, in the pull request that restores Pages.
      expect(await exists(join(s.root, "opscrew/cloudflare/wrangler.jsonc"))).toBe(false);
      expect(result.next[0]).toContain("Merge https://github.com/acme/shop/pull/7");
    });

    it("stops a script at each plan with its hash, and applies exactly that plan with --approve", async () => {
      const s = await setup("github-pages");
      const first = await move(s, { to: "cloudflare-workers" }, false);
      expect(first.result).toMatchObject({ step: "started", done: false });
      const hash = first.result.pendingPlanHash;
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(first.result.next[0]).toContain(`opscrew retarget --approve ${hash}`);
      expect(s.engine.appliedPlans).toEqual([]);

      const second = await move(s, { approvePlanHash: hash as string }, false);
      expect(s.engine.appliedPlans).toEqual([SHELL.map((a) => `create ${a}`).join(", ")]);
      expect(second.handler.requests[0]).toMatchObject({ kind: "iac-apply", planHash: hash });
      expect(second.result.pendingPlanHash).toBeUndefined();
    });
  },
);

describe.skipIf(!findExecutable("git"))(
  "a site's move when something goes wrong",
  { timeout: 300_000 },
  () => {
    it.each([
      ["github-pages", "cloudflare-workers", "GitHub Pages"],
      ["cloudflare-workers", "github-pages", "Cloudflare hosting"],
    ] as const)(
      "aborts after a switch that failed part-way: the hostname answers on %s again",
      async (from, to, host) => {
        const s = await setup(from);
        await merged(s, to);
        // The switch's apply deletes the old binding, then fails before it creates the new one.
        s.engine.failPartway = true;
        const error = await failure(move(s));
        expect(error.code).toBe("ENGINE_FAILED");
        expect((await s.readPlan()).retarget?.step).toBe("deployed");
        const held = s.engine.states.get(tfstateFile(s.paths)) ?? new Set<string>();
        expect(held.has(CUSTOM_DOMAIN) || held.has(PAGES_RECORD)).toBe(false);

        const aborted = await end(s, "abort");
        expect(aborted.result).toMatchObject({ step: "aborted", done: true });
        expect(s.engine.states.get(tfstateFile(s.paths))).toEqual(
          new Set(from === "github-pages" ? [PAGES_RECORD] : [...SHELL, CUSTOM_DOMAIN]),
        );
        expect(s.checked.at(-1)).toBe(`https://${DOMAIN}/`);
        expect(aborted.deps.reporter.text()).toContain(
          `The move is aborted; example-app stays on ${host}.`,
        );
        const plan = await s.readPlan();
        expect(plan.retarget).toBeUndefined();
        expect(plan.target.provider).toBe(from);
      },
    );

    it("aborts after the Pages plan set the custom domain, removing it with the site", async () => {
      const s = await setup("cloudflare-workers");
      await merged(s, "github-pages");
      const refused = await s.run({ answer: (kind) => kind !== "iac-apply" });
      await expect(runRetarget(refused.deps, { services: s.services })).rejects.toMatchObject({
        code: "APPROVAL_REFUSED",
      });
      expect(s.pages.state.site).toMatchObject({ cname: DOMAIN });
      expect((await s.readPlan()).retarget?.step).toBe("deployed");

      const aborted = await end(s, "abort");
      expect(aborted.result).toMatchObject({ step: "aborted", done: true });
      // Nothing to put back on the Worker; the Pages plan takes the domain away with the site.
      expect(kinds(aborted.handler)).toEqual(["pages-apply", "git-push", "pull-request"]);
      expect(s.pages.state.site).toBeUndefined();
      expect(s.engine.states.get(tfstateFile(s.paths))).toEqual(new Set([...SHELL, CUSTOM_DOMAIN]));
    });

    it("stops when the deploy workflow fails, while GitHub Pages keeps serving the site", async () => {
      const s = await setup("github-pages");
      await merged(s, "cloudflare-workers");
      s.github.conclusion = "failure";
      const error = await failure(move(s));
      expect(error).toMatchObject({ code: "COMMAND_FAILED" });
      expect(error.message).toContain("The deploy workflow did not succeed (failure)");
      expect(error.message).toContain("GitHub Pages still serves the site.");
      expect((await s.readPlan()).retarget?.step).toBe("started");
    });

    it("stops when the Worker does not run the build of the deploy workflow's run", async () => {
      const s = await setup("github-pages");
      await merged(s, "cloudflare-workers");
      s.github.deploy = () => undefined;
      const error = await failure(move(s));
      expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
      expect(error.message).toContain(
        "The Worker example-app does not run the build of the deploy workflow's run 42.",
      );
      expect((await s.readPlan()).retarget?.step).toBe("started");
    });

    it("stops when GitHub Pages does not answer on github.io after the deploy", async () => {
      const s = await setup("cloudflare-workers");
      await merged(s, "github-pages");
      s.up.pages = false;
      const error = await failure(move(s));
      expect(error.message).toContain(
        "GitHub Pages does not answer at https://example-org.github.io/example-app/ after the deploy. Cloudflare hosting still serves the site.",
      );
      expect((await s.readPlan()).retarget?.step).toBe("started");
    });

    it("says when the domain does not answer after the switch, and checks again on the next run", async () => {
      const s = await setup("github-pages");
      await merged(s, "cloudflare-workers");
      s.up.domain = false;
      const error = await failure(move(s));
      expect(error.message).toContain("The site does not answer at https://docs.example.com/ yet");
      expect((await s.readPlan()).retarget?.step).toBe("switched");
      s.up.domain = true;
      expect((await move(s)).result).toMatchObject({ step: "switched", done: true });
    });

    it("finishes a move to the Worker only once OpsCrew's rules cover its hostnames, each hash in turn", async () => {
      const s = await setup("github-pages");
      await merged(s, "cloudflare-workers");
      const refused = await s.run({ answer: (kind) => kind !== "cloudflare-apply" });
      await expect(runRetarget(refused.deps, { services: s.services })).rejects.toMatchObject({
        code: "APPROVAL_REFUSED",
      });
      expect((await s.readPlan()).retarget?.step).toBe("switched");

      // A script: the zone's plan first, while the GitHub Pages site stays.
      const rules = await end(s, "finish", { interactive: false });
      expect(rules.result).toMatchObject({ step: "switched", done: false });
      expect(rules.result.pendingPlanHash).toMatch(HASH);
      expect(kinds(rules.handler)).toEqual([]);
      expect(s.pages.state.site).toMatchObject({ cname: DOMAIN });

      const site = await end(s, "finish", {
        interactive: false,
        approvePlanHash: rules.result.pendingPlanHash as string,
      });
      expect(kinds(site.handler)).toEqual(["cloudflare-apply"]);
      expect(site.handler.requests[0]?.planHash).toBe(rules.result.pendingPlanHash);
      expect(site.result.pendingPlanHash).toMatch(HASH);
      expect(site.result.next[0]).toContain("--confirm example-app");
      expect(s.pages.state.site).toMatchObject({ cname: DOMAIN });

      const done = await end(s, "finish", {
        interactive: false,
        approvePlanHash: site.result.pendingPlanHash as string,
      });
      expect(done.result).toMatchObject({ step: "finished", done: true });
      expect(kinds(done.handler)).toEqual(["pages-apply", "git-push", "pull-request"]);
      expect(done.handler.requests[0]).toMatchObject({
        planHash: site.result.pendingPlanHash,
        allowDestroy: true,
      });
      expect(s.pages.state.site).toBeUndefined();
    });

    it("switches a script to GitHub Pages and finishes it, each Pages and infrastructure hash in turn", async () => {
      const s = await setup("cloudflare-workers");
      await merged(s, "github-pages");
      const deployed = await move(s, {}, false);
      expect(deployed.result).toMatchObject({ step: "deployed", done: false });
      const pagesHash = deployed.result.pendingPlanHash as string;
      expect(pagesHash).toMatch(HASH);
      expect(s.pages.state.site?.cname).toBeUndefined();

      const domain = await move(s, { approvePlanHash: pagesHash }, false);
      expect(kinds(domain.handler)).toEqual(["pages-apply"]);
      expect(s.pages.state.site).toMatchObject({ cname: DOMAIN });
      expect(domain.result).toMatchObject({ step: "deployed", done: false });
      expect(domain.result.next[0]).toContain("--confirm example-app");

      const switched = await move(
        s,
        { approvePlanHash: domain.result.pendingPlanHash as string },
        false,
      );
      expect(kinds(switched.handler)).toEqual(["iac-apply"]);
      expect(switched.handler.requests[0]).toMatchObject({
        planHash: domain.result.pendingPlanHash,
        allowDestroy: true,
        confirmPhrase: "example-app",
      });
      expect(switched.result).toMatchObject({ step: "switched", done: true });

      const removal = await end(s, "finish", { interactive: false });
      expect(removal.result.pendingPlanHash).toMatch(HASH);
      expect(kinds(removal.handler)).toEqual([]);
      const finished = await end(s, "finish", {
        interactive: false,
        approvePlanHash: removal.result.pendingPlanHash as string,
      });
      expect(finished.result).toMatchObject({ step: "finished", done: true });
      expect(kinds(finished.handler)).toEqual(["iac-apply", "git-push", "pull-request"]);
      expect(s.engine.states.get(tfstateFile(s.paths))).toEqual(new Set([PAGES_RECORD]));
    });

    it("aborts a script's move to the Worker by the plan's hash", async () => {
      const s = await setup("github-pages");
      await merged(s, "cloudflare-workers");
      const refused = await s.run({ answer: (kind) => kind !== "iac-apply" });
      await expect(runRetarget(refused.deps, { services: s.services })).rejects.toMatchObject({
        code: "APPROVAL_REFUSED",
      });
      const pending = await end(s, "abort", { interactive: false });
      expect(pending.result.pendingPlanHash).toMatch(HASH);
      expect(pending.result.next[0]).toContain("--confirm example-app");
      expect(s.engine.states.get(tfstateFile(s.paths))).toEqual(new Set([...SHELL, PAGES_RECORD]));

      const aborted = await end(s, "abort", {
        interactive: false,
        approvePlanHash: pending.result.pendingPlanHash as string,
      });
      expect(aborted.result).toMatchObject({ step: "aborted", done: true });
      expect(aborted.handler.requests[0]).toMatchObject({
        kind: "iac-apply",
        planHash: pending.result.pendingPlanHash,
        allowDestroy: true,
      });
      expect(s.engine.states.get(tfstateFile(s.paths))).toEqual(new Set([PAGES_RECORD]));
    });

    it("refuses a move to GitHub Pages while the repository has a Pages site already", async () => {
      const s = await setup("cloudflare-workers", { pagesSite: true });
      const error = await failure(move(s, { to: "github-pages", pagesVerification: VERIFICATION }));
      expect(error).toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringContaining("GitHub Pages is already on for example-org/example-app"),
      });
      expect(s.runs.at(-1)?.handler.requests).toEqual([]);
      expect((await s.readPlan()).retarget).toBeUndefined();
      expect(s.pages.state.site).toEqual({ buildType: "legacy", httpsEnforced: false });
    });
  },
);
