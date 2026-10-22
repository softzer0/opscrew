// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployPlan } from "@opscrew/plan-schema";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { ACTIONS, IMAGES, TOOLS, toolDownloadUrl } from "../pins";
import {
  inEnvironment,
  jobYaml,
  localhostPlan,
  serverPlan,
  withBuild,
  withPlan,
} from "./__fixtures__/plans";
import {
  DEPLOY_SECRETS,
  deploySecretName,
  deploySecretNamesFor,
  renderWorkflow,
  TUNNEL_DEPLOY_SECRETS,
} from "./index";

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
};
type Job = {
  "runs-on": string | string[];
  defaults?: { run: { shell: string } };
  permissions: Record<string, string>;
  steps: Step[];
};

const ctx = { ...testContext(), localhost: { hostname: "shop.localhost" } };
const content = (plan: DeployPlan) => renderWorkflow(plan, ctx).content;
const jobs = (plan: DeployPlan) => (parse(content(plan)) as { jobs: Record<string, Job> }).jobs;
const jobOf = (plan: DeployPlan, id: string) => {
  const found = jobs(plan)[id];
  if (found === undefined) throw new Error(`no job ${id}`);
  return found;
};
const stepOf = (job: Job, name: string) => {
  const found = job.steps.find((s) => s.id === name || s.name === name);
  if (found === undefined) throw new Error(`no step ${name}`);
  return found;
};
const action = (key: keyof typeof ACTIONS) => ACTIONS[key].split(" #")[0];

const MACHINE = { name: "build-box", arch: "amd64" } as const;
const LABEL = ["self-hosted", "opscrew-shop-staging"];
const SSH_SETUP = "Configure SSH with the pinned host key";
const UPLOAD = "Upload runtime files and environment";
const ROLLBACK = "Roll back to the previous version";

/** `plan` as the staging environment with prefixed secrets, on GitHub's machines or `runner`. */
function staging(
  plan: DeployPlan,
  o: { runner?: "github" | "host" | "server"; build?: "github" | "runner" } = {},
): DeployPlan {
  const runner = o.runner ?? "github";
  return inEnvironment(plan, {
    name: "staging",
    runner,
    ...(runner === "host" ? { runnerHost: MACHINE } : {}),
    ...(o.build === undefined ? {} : { build: o.build }),
    secrets: "prefixed",
  });
}

const tunnelPlan = () =>
  testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com" });

describe("the deploy job on a runner machine", () => {
  const machine = staging(serverPlan(), { runner: "host" });
  const github = staging(serverPlan());

  it("runs on the environment's label and deploys over SSH with a GitHub-hosted job's steps", () => {
    const deploy = jobOf(machine, "deploy");
    const hosted = jobOf(github, "deploy");
    expect(deploy["runs-on"]).toEqual(LABEL);
    expect(deploy.defaults).toEqual({ run: { shell: "bash" } });
    // The runner keeps its workspace: the job's token stays out of its git settings.
    expect(deploy.steps[0]).toEqual({
      uses: action("checkout"),
      with: { "persist-credentials": false },
    });
    expect(deploy.steps.slice(1).map((s) => s.name)).toEqual(
      hosted.steps.slice(1).map((s) => s.name),
    );
    expect(deploy.steps.map((s) => s.name)).toContain(SSH_SETUP);
    for (const name of [SSH_SETUP, UPLOAD, "start", ROLLBACK]) {
      expect(stepOf(deploy, name).env, name).toEqual(stepOf(hosted, name).env);
    }
    expect(stepOf(deploy, "start").env?.HOST).toBe("${{ secrets.OPSCREW_STAGING_HOST }}");
    // The server's scripts are the same, piped over the same SSH.
    for (const name of ["start", ROLLBACK]) {
      const remote = (run = "") => run.slice(run.indexOf("<<'REMOTE'"), run.lastIndexOf("REMOTE"));
      expect(remote(stepOf(deploy, name).run), name).toBe(remote(stepOf(hosted, name).run));
    }
    expect(stepOf(deploy, "start").run).toContain(
      'ssh "${ssh_opts[@]}" "deploy@${HOST}" sh -s -- "$IMAGE" <<\'REMOTE\'',
    );
    expect(content(machine)).toContain("deploys it to your server\n# over SSH.");
    expect(jobYaml(content(machine), "deploy")).toMatchSnapshot();
  });

  it("keeps the SSH key and known hosts in the job's temp folder, never the machine's home", () => {
    for (const plan of [machine, staging(tunnelPlan(), { runner: "host" })]) {
      const yaml = jobYaml(content(plan), "deploy");
      expect(yaml).not.toContain("~/.ssh");
      // The runner machine's user has no sudo.
      expect(yaml).not.toMatch(/\bsudo\b/);
      // The job's own ssh config too, so the machine user's own cannot change the connection.
      expect(yaml).toContain(
        'ssh_opts=(-i "$RUNNER_TEMP/opscrew-ssh/opscrew" -o UserKnownHostsFile="$RUNNER_TEMP/opscrew-ssh/known_hosts" -F "$RUNNER_TEMP/opscrew-ssh/config" ',
      );
    }
    expect(stepOf(jobOf(machine, "deploy"), SSH_SETUP).run).toContain(
      ': > "$RUNNER_TEMP/opscrew-ssh/config"',
    );
  });

  it("creates the edge's network first, so two environments deploying at once both pass", () => {
    const check = "Validate the edge's configuration with Caddy";
    expect(stepOf(jobOf(machine, "deploy"), check).run).toContain(
      "docker network create opscrew-edge > /dev/null 2>&1 || docker network inspect opscrew-edge > /dev/null",
    );
    expect(stepOf(jobOf(github, "deploy"), check).run).toContain(
      "docker network inspect opscrew-edge > /dev/null 2>&1 || docker network create opscrew-edge > /dev/null",
    );
  });

  it("checks the app at the server's address without a domain, not on the machine itself", () => {
    const health = stepOf(jobOf(staging(testPlan(), { runner: "host" }), "deploy"), "health");
    expect(health.env?.URL).toBe("http://${{ secrets.OPSCREW_STAGING_HOST }}/api/health");
  });

  it("reaches a tunnel's SSH hostname with cloudflared from the job's temp folder", () => {
    const deploy = jobOf(staging(tunnelPlan(), { runner: "host" }), "deploy");
    const install = stepOf(deploy, `Install cloudflared ${TOOLS.cloudflared.version}`).run ?? "";
    expect(install).toContain('chmod 0755 "$RUNNER_TEMP/cloudflared"');
    const setup = stepOf(deploy, SSH_SETUP).run ?? "";
    expect(setup).toContain(
      'echo "  ProxyCommand $RUNNER_TEMP/cloudflared access ssh --hostname %h"',
    );
    expect(setup).toContain('} > "$RUNNER_TEMP/opscrew-ssh/config"');
    expect(stepOf(deploy, UPLOAD).run).toContain('-F "$RUNNER_TEMP/opscrew-ssh/config"');
    expect(stepOf(deploy, "start").env).toEqual(
      stepOf(jobOf(staging(tunnelPlan()), "deploy"), "start").env,
    );
  });
});

function bashWorks(): boolean {
  try {
    return spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";
  } catch {
    return false;
  }
}

const work = mkdtempSync(join(tmpdir(), "opscrew-runner-machine-")).replaceAll("\\", "/");
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!bashWorks())("the SSH steps on a runner machine", { timeout: 60_000 }, () => {
  it("write the connection files into the job's temp folder and use only those", () => {
    const deploy = jobOf(staging(tunnelPlan(), { runner: "host" }), "deploy");
    const home = `${work}/home`;
    const temp = `${work}/temp`;
    mkdirSync(home, { recursive: true });
    mkdirSync(temp, { recursive: true });
    const env = { ...process.env, HOME: home, RUNNER_TEMP: temp };
    // Git for Windows' install cannot set a folder's mode on every drive; the paths are the point.
    const install = 'install() { mkdir -p "${@: -1}"; }';
    const setup = spawnSync("bash", ["-c", `${install}\n${stepOf(deploy, SSH_SETUP).run ?? ""}`], {
      env: { ...env, SSH_KEY: "key-for-the-test", KNOWN_HOSTS: "known-for-the-test" },
      encoding: "utf8",
    });
    expect(setup.status, `${setup.stdout}${setup.stderr}`).toBe(0);
    expect(existsSync(`${home}/.ssh`)).toBe(false);
    expect(readFileSync(`${temp}/opscrew-ssh/opscrew`, "utf8")).toBe("key-for-the-test\n");
    expect(readFileSync(`${temp}/opscrew-ssh/known_hosts`, "utf8")).toBe("known-for-the-test\n");
    expect(readFileSync(`${temp}/opscrew-ssh/config`, "utf8")).toBe(
      `Host ssh-shop-staging.example.com\n  ProxyCommand ${temp}/cloudflared access ssh --hostname %h\n`,
    );

    // The upload's ssh and scp get the job's own key, known hosts and config.
    const fakes = [
      `ssh() { printf 'ssh %s\\n' "$*" >> "${work}/calls"; cat > /dev/null; }`,
      `scp() { printf 'scp %s\\n' "$*" >> "${work}/calls"; }`,
    ].join("\n");
    const upload = spawnSync("bash", ["-c", `${fakes}\n${stepOf(deploy, UPLOAD).run ?? ""}`], {
      env: {
        ...env,
        HOST: "ssh-shop-staging.example.com",
        OPSCREW_APP_ENV: "",
        OPSCREW_SERVICE_DB_ENV: "",
      },
      encoding: "utf8",
    });
    expect(upload.status, `${upload.stdout}${upload.stderr}`).toBe(0);
    const calls = readFileSync(`${work}/calls`, "utf8").trim().split("\n");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain(
        `-i ${temp}/opscrew-ssh/opscrew -o UserKnownHostsFile=${temp}/opscrew-ssh/known_hosts -F ${temp}/opscrew-ssh/config -o IdentitiesOnly=yes`,
      );
    }
  });

  it("write an empty ssh config in public mode", () => {
    const deploy = jobOf(staging(serverPlan(), { runner: "host" }), "deploy");
    const temp = `${work}/public-temp`;
    mkdirSync(temp, { recursive: true });
    const install = 'install() { mkdir -p "${@: -1}"; }';
    const setup = spawnSync("bash", ["-c", `${install}\n${stepOf(deploy, SSH_SETUP).run ?? ""}`], {
      env: { ...process.env, RUNNER_TEMP: temp, SSH_KEY: "key", KNOWN_HOSTS: "known" },
      encoding: "utf8",
    });
    expect(setup.status, `${setup.stdout}${setup.stderr}`).toBe(0);
    expect(readFileSync(`${temp}/opscrew-ssh/config`, "utf8")).toBe("");
  });
});

describe.skipIf(!bashWorks())("the build's own Docker settings", { timeout: 60_000 }, () => {
  it("never write the user's Docker settings, and keep their daemon and CLI plugins", () => {
    const plan = inEnvironment(localhostPlan(), {
      name: "dev",
      runner: "local",
      build: "runner",
      secrets: "prefixed",
    });
    const step = jobOf(plan, "build").steps[0]?.run ?? "";
    const home = `${work}/docker-home`;
    const temp = `${work}/docker-temp`;
    mkdirSync(`${home}/.docker/cli-plugins`, { recursive: true });
    mkdirSync(temp, { recursive: true });
    writeFileSync(`${home}/.docker/config.json`, '{"credsStore":"desktop"}\n');
    writeFileSync(`${home}/.docker/cli-plugins/docker-buildx`, "buildx\n");
    writeFileSync(`${work}/github-env`, "");
    const fakes = `docker() { [[ "$*" == "context inspect --format {{.Endpoints.docker.Host}}" ]] && echo unix:///desktop.sock; }`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      RUNNER_TEMP: temp,
      GITHUB_ENV: `${work}/github-env`,
    };
    delete env.DOCKER_CONFIG;
    const result = spawnSync("bash", ["-c", `${fakes}\n${step}`], { env, encoding: "utf8" });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(readFileSync(`${work}/github-env`, "utf8")).toBe(
      `DOCKER_HOST=unix:///desktop.sock\nDOCKER_CONFIG=${temp}/docker\n`,
    );
    // The login goes to the job's file, never to the user's settings or credential store.
    expect(readFileSync(`${temp}/docker/config.json`, "utf8")).toBe('{"auths":{"ghcr.io":{}}}\n');
    expect(readFileSync(`${home}/.docker/config.json`, "utf8")).toBe('{"credsStore":"desktop"}\n');
    expect(readFileSync(`${temp}/docker/cli-plugins/docker-buildx`, "utf8")).toBe("buildx\n");
    // The local deploy's login goes to the app's Docker settings file too, never the store.
    expect(stepOf(jobOf(plan, "deploy"), "start").run).toMatch(
      /printf '\{"auths":\{"ghcr\.io":\{\}\}\}\\n' > "\$dir"\/\.docker\/config\.json\nfi\n.*DOCKER_CONFIG="\$dir"\/\.docker docker login/,
    );
    // Every later step, the login action's and the scan's logout included, uses the job's own.
    expect(jobYaml(content(plan), "build")).not.toMatch(
      /~\/\.docker|DOCKER_CONFIG=(?!\$RUNNER_TEMP)/,
    );
  });
});

describe("deploySecretNamesFor on a runner machine", () => {
  const connection = [DEPLOY_SECRETS.host, DEPLOY_SECRETS.sshKey, DEPLOY_SECRETS.knownHosts];

  it("lists the connection secrets, as for a GitHub-hosted job", () => {
    expect(deploySecretNamesFor(staging(serverPlan(), { runner: "host" }))).toEqual(
      deploySecretNamesFor(staging(serverPlan())),
    );
    expect(deploySecretNamesFor(staging(serverPlan(), { runner: "host" }))).toEqual(
      expect.arrayContaining(connection),
    );
    const tunnel = staging(tunnelPlan(), { runner: "host" });
    expect(deploySecretNamesFor(tunnel)).toEqual(
      expect.arrayContaining([...connection, ...Object.values(TUNNEL_DEPLOY_SECRETS)]),
    );
    // The server's runner deploys on its own machine and needs none.
    expect(deploySecretNamesFor(staging(serverPlan(), { runner: "server" }))).not.toContain(
      DEPLOY_SECRETS.host,
    );
  });

  it("covers every secret the rendered workflow reads", () => {
    const plans = [
      staging(serverPlan(), { runner: "host" }),
      staging(tunnelPlan(), { runner: "host", build: "runner" }),
    ];
    for (const plan of plans) {
      const listed = new Set(deploySecretNamesFor(plan).map((n) => deploySecretName(plan, n)));
      for (const [, name] of content(plan).matchAll(/secrets\.([A-Z_]+)/g)) {
        if (name !== "GITHUB_TOKEN") expect(listed.has(name ?? ""), name).toBe(true);
      }
    }
  });
});

describe("the build job on the environment's runner (build: runner)", () => {
  const machine = staging(serverPlan(), { runner: "host", build: "runner" });
  const local = inEnvironment(localhostPlan(), {
    name: "dev",
    runner: "local",
    build: "runner",
    secrets: "prefixed",
  });
  const DOCKER_CONFIG = "Keep this job's Docker login and builder to itself";

  it("runs on the environment's label with the steps GitHub's machines run", () => {
    const localOnGithub = inEnvironment(localhostPlan(), {
      name: "dev",
      runner: "local",
      secrets: "prefixed",
    });
    for (const [plan, label, onGithub] of [
      [machine, LABEL, staging(serverPlan())],
      [local, ["self-hosted", "opscrew-shop-dev"], localOnGithub],
    ] as const) {
      const build = jobOf(plan, "build");
      expect(build["runs-on"]).toEqual(label);
      // Every run: step with bash, Git for Windows' on a Windows computer.
      expect(build.defaults).toEqual({ run: { shell: "bash" } });
      const hosted = jobOf(onGithub, "build");
      expect(build.permissions).toEqual(hosted.permissions);
      // The runner keeps its workspace: the job's token stays out of its git settings.
      expect(build.steps[1]).toEqual({
        uses: action("checkout"),
        with: { "persist-credentials": false },
      });
      // The same steps, but the image's name in lower case without bash 4 (below) and the scan's
      // socket path kept from Git Bash.
      const same = (steps: Step[]) =>
        steps
          .filter((s) => s.name !== DOCKER_CONFIG && s.uses !== action("checkout"))
          .map((s) =>
            s.id === "image" ? {} : { ...s, run: s.run?.replace("MSYS_NO_PATHCONV=1 ", "") },
          );
      expect(same(build.steps)).toEqual(same(hosted.steps));
      expect(hosted.steps[0]).toEqual({ uses: action("checkout") });
    }
    expect(jobYaml(content(machine), "build")).toMatchSnapshot();
  });

  it("keeps Buildx pinned, the mode=max provenance, the SBOM and the commit tag", () => {
    const build = jobOf(machine, "build");
    expect(stepOf(build, "Set up Docker Buildx").uses).toBe(action("setupBuildx"));
    const push = stepOf(build, "push");
    expect(push.uses).toBe(action("buildPush"));
    expect(push.with).toMatchObject({
      provenance: "mode=max",
      sbom: true,
      tags: "${{ steps.image.outputs.image }}",
    });
  });

  it("leaves the signing, label and retention jobs on GitHub's machines", () => {
    const plan = withPlan(machine, {
      supplyChain: { sign: true },
      deployTags: { enabled: true },
    });
    const all = jobs(plan);
    expect(all.sign?.permissions).toEqual({ "id-token": "write", packages: "write" });
    for (const id of ["sign", "label", "prune", "tag"]) {
      if (all[id] !== undefined) expect(all[id]?.["runs-on"], id).toBe("ubuntu-latest");
    }
    expect(all.sign).toBeDefined();
  });

  it("keeps each job's Docker login to itself, on a runner machine and the local runner", () => {
    for (const plan of [machine, local]) {
      const first = jobOf(plan, "build").steps[0];
      expect(first?.name).toBe(DOCKER_CONFIG);
      expect(first?.run).toContain('echo "DOCKER_CONFIG=$RUNNER_TEMP/docker"');
    }
    expect(jobOf(staging(serverPlan()), "build").steps.map((s) => s.name)).not.toContain(
      DOCKER_CONFIG,
    );
  });

  it("never takes the local deploy lock", () => {
    expect(jobYaml(content(local), "build")).not.toContain("OPSCREW_LOCAL_LOCK");
    expect(jobYaml(content(local), "deploy")).toContain("OPSCREW_LOCAL_LOCK");
  });

  it("runs under macOS's bash 3.2: no bash 4 syntax in the jobs on a self-hosted runner", () => {
    for (const base of [machine, local]) {
      const plans = [base, withBuild(base, "buildpacks"), withBuild(base, "railpack")];
      for (const plan of plans) {
        for (const id of ["build", "deploy"]) {
          expect(jobYaml(content(plan), id), id).not.toMatch(
            /\$\{\w+(,,|\^\^)\}|mapfile|readarray/,
          );
        }
        // macOS has no sha256sum, and bash 3.2 refuses an empty "${array[@]}" under set -u.
        const build = jobYaml(content(plan), "build");
        expect(build).not.toMatch(/\| sha256sum|(?<!\+)"\$\{(settings|values|args)\[@\]\}"/);
      }
    }
  });

  it.skipIf(!bashWorks())(
    "names the image in lower case without bash 4",
    { timeout: 60_000 },
    () => {
      const script = stepOf(jobOf(local, "build"), "image").run ?? "";
      const output = `${work}/image-output`;
      const result = spawnSync("bash", ["-c", script], {
        env: {
          ...process.env,
          GITHUB_REPOSITORY: "Acme/Shop",
          GITHUB_SHA: "abc",
          GITHUB_OUTPUT: output,
        },
        encoding: "utf8",
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(
        "name=ghcr.io/acme/shop\nimage=ghcr.io/acme/shop:abc\n",
      );
    },
  );

  it("installs pack and Railpack into the job's temp folder, without sudo", () => {
    for (const [builder, name] of [
      ["buildpacks", "pack"],
      ["railpack", "Railpack"],
    ] as const) {
      const tool = builder === "buildpacks" ? "pack" : "railpack";
      const build = jobOf(withBuild(machine, builder), "build");
      const install = build.steps.find((s) => s.name?.startsWith(`Install ${name}`))?.run ?? "";
      expect(install).not.toMatch(/\bsudo\b/);
      expect(install).toContain('mkdir -p "$RUNNER_TEMP/bin"');
      expect(install).toContain(`"$RUNNER_TEMP/bin/${tool}"`);
      expect(install).toContain('echo "$RUNNER_TEMP/bin" >> "$GITHUB_PATH"');
      // GitHub's machines install it as before.
      const hosted = jobOf(withBuild(staging(serverPlan()), builder), "build");
      expect(hosted.steps.find((s) => s.name?.startsWith(`Install ${name}`))?.run).toContain(
        `sudo install -m 0755`,
      );
    }
  });

  it("runs pack and Railpack off Linux in the pinned Linux image through Docker", () => {
    for (const [builder, name, tool] of [
      ["buildpacks", "pack", "pack"],
      ["railpack", "Railpack", "railpack"],
    ] as const) {
      const step = `Install ${name} ${TOOLS[tool].version}`;
      const install = stepOf(jobOf(withBuild(local, builder), "build"), step);
      expect(install.run).toContain('if [[ "$RUNNER_OS" == Linux ]]; then');
      expect(install.run).toContain(
        `MSYS_NO_PATHCONV=1 exec docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$mount:$work" -w "$(pwd)" -e DOCKER_CONFIG="$temp/docker"`,
      );
      expect(install.run).toContain(IMAGES.linuxTools.ref);
      // The registry login stays in the job's Docker settings: the step holds no token.
      expect(install.env).toBeUndefined();
      // A runner machine is Linux: it installs the tool as it is.
      const onMachine = stepOf(jobOf(withBuild(machine, builder), "build"), step).run ?? "";
      expect(onMachine).not.toMatch(/RUNNER_OS|docker run|WRAPPER/);
    }
    // The scan's socket path reaches Docker as it is under Git Bash too.
    expect(jobYaml(content(local), "build")).toContain(
      "MSYS_NO_PATHCONV=1 docker run --rm -v /var/run/docker.sock:/var/run/docker.sock",
    );
    expect(jobYaml(content(staging(serverPlan())), "build")).not.toContain("MSYS_NO_PATHCONV");
  });

  it("builds for the target's architecture on an arm64 runner machine", () => {
    const arm = withBuild(
      inEnvironment(testPlan({ provider: "own", arch: "arm64", domain: "shop.example.com" }), {
        name: "staging",
        runner: "host",
        runnerHost: { name: "pi", arch: "arm64" },
        build: "runner",
        secrets: "prefixed",
      }),
      "buildpacks",
    );
    const build = jobOf(arm, "build");
    expect(build["runs-on"]).toEqual(LABEL);
    expect(build.steps.find((s) => s.name?.startsWith("Install pack"))?.run).toContain(
      toolDownloadUrl("pack", "arm64"),
    );
  });

  it("renders build: github as GitHub's machines, as before", () => {
    const explicit = staging(serverPlan(), { runner: "host", build: "github" });
    expect(jobYaml(content(explicit), "build")).toBe(
      jobYaml(content(staging(serverPlan())), "build"),
    );
    expect(jobOf(explicit, "build")["runs-on"]).toBe("ubuntu-latest");
  });
});

describe.skipIf(!bashWorks())("pack off Linux, through Docker", { timeout: 60_000 }, () => {
  const plan = withBuild(
    inEnvironment(localhostPlan(), {
      name: "dev",
      runner: "local",
      build: "runner",
      secrets: "prefixed",
    }),
    "buildpacks",
  );
  const install = stepOf(jobOf(plan, "build"), `Install pack ${TOOLS.pack.version}`).run ?? "";
  const sh = (script: string, cwd?: string, env: Record<string, string> = {}) =>
    spawnSync("bash", ["-c", script], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  const hasCygpath = sh("command -v cygpath").status === 0;
  const cygpath = (flag: string, path: string) => sh(`cygpath ${flag} '${path}'`).stdout.trim();

  /**
   * Installs pack as the step does on `os` (curl, the checksum and install faked), then runs it
   * from the checkout with `args` and a fake docker; returns the folders and docker's arguments.
   */
  function installAndRun(os: "macOS" | "Windows", args: (temp: string) => string[]) {
    const root = `${work}/${os}`;
    const temp = `${root}/_work/_temp`;
    const checkout = `${root}/_work/shop/shop`;
    for (const dir of [temp, checkout, `${root}/src`, `${root}/fakebin`]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(`${root}/src/pack`, "#!/bin/sh\n");
    expect(sh("tar -czf ../pack.tar.gz pack", `${root}/src`).status).toBe(0);
    writeFileSync(
      `${root}/fakebin/docker`,
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$DOCKER_ARGS"\n',
    );
    const runnerTemp = os === "Windows" ? cygpath("-w", temp) : temp;
    const env = { RUNNER_OS: os, RUNNER_TEMP: runnerTemp };
    const fakes = [
      `curl() { cp '${root}/pack.tar.gz' "$5"; }`,
      "sha256sum() { cat > /dev/null; }",
      'install() { cp "${@: -2:1}" "${@: -1}"; }',
    ].join("\n");
    const installed = sh(`${fakes}\n${install}`, checkout, { ...env, GITHUB_PATH: `${root}/path` });
    expect(installed.status, `${installed.stdout}${installed.stderr}`).toBe(0);
    const quoted = args(runnerTemp)
      .map((arg) => `'${arg}'`)
      .join(" ");
    const fakeDocker = `PATH="$(cd '${root}/fakebin' && pwd):$PATH"; chmod +x '${root}/fakebin/docker'`;
    const ran = sh(`${fakeDocker}\nbash '${temp}/bin/pack' ${quoted}`, checkout, {
      ...env,
      DOCKER_ARGS: `${root}/docker-args`,
    });
    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
    return {
      root,
      temp,
      cwd: sh("pwd", checkout).stdout.trim(),
      docker: readFileSync(`${root}/docker-args`, "utf8").trim().split("\n"),
    };
  }

  it("mounts the runner's work folder at the same path, with the job's Docker settings", () => {
    const { root, temp, cwd, docker } = installAndRun("macOS", (t) => [
      "build",
      "app",
      "--report-output-dir",
      `${t}/pack-report`,
    ]);
    const workDir = `${root}/_work`;
    expect(docker).toEqual([
      "run",
      "--rm",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-v",
      `${workDir}:${workDir}`,
      "-w",
      cwd,
      "-e",
      `DOCKER_CONFIG=${temp}/docker`,
      IMAGES.linuxTools.ref,
      `${temp}/opscrew-linux/pack`,
      "build",
      "app",
      "--report-output-dir",
      `${temp}/pack-report`,
    ]);
    expect(readFileSync(`${root}/path`, "utf8")).toBe(`${temp}/bin\n`);
  });

  it.skipIf(!hasCygpath)(
    "mounts Docker Desktop's C:/… form on Windows and turns Windows paths into it",
    () => {
      const { root, temp, docker } = installAndRun("Windows", (t) => [
        "build",
        "app",
        "--report-output-dir",
        `${t}\\pack-report`,
      ]);
      const posixTemp = cygpath("-u", temp);
      const posixWork = cygpath("-u", `${root}/_work`);
      expect(docker.slice(4, 6)).toEqual(["-v", `${cygpath("-m", `${root}/_work`)}:${posixWork}`]);
      expect(docker).toContain(`DOCKER_CONFIG=${posixTemp}/docker`);
      expect(docker.slice(-6)).toEqual([
        IMAGES.linuxTools.ref,
        `${posixTemp}/opscrew-linux/pack`,
        "build",
        "app",
        "--report-output-dir",
        `${posixTemp}/pack-report`,
      ]);
    },
  );
});
