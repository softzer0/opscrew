import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import type { DeployPlan } from "@opscrew/plan-schema";
import { previewRecipeDir, previewTemplatePlan, renderPreviewRecipe } from "../index";
import { envFor, IMAGE_NAME, REPOSITORY } from "./plans";

/*
 * A fake preview server for opscrew-preview under sh: the recipe in $WORK/srv/apps/<app>, the
 * shared edge in $WORK/srv/edge, and the shims of `shims/` first on the PATH:
 * - docker: logs every call in $WORK/state/docker.log; keeps containers in $WORK/state/containers
 *   (`<id> <project> <service> <image> <status> <name>`), the projects' networks and volumes, and
 *   the registry login in $DOCKER_CONFIG/config.json; `compose exec … kamal-proxy kamal-proxy`
 *   runs the kamal-proxy shim. Faults: LOGIN_FAIL, PULL_FAIL, EDGE_UP_FAIL, UP_FAIL (the app's
 *   services), RELEASE_FAIL, SEED_FAIL, RM_FAIL (`docker rm`).
 * - kamal-proxy: routes in $WORK/state/routes/<service> (`<target> <host>`); a deploy to a
 *   container whose image is in UNHEALTHY fails its health check.
 * - flock: logs `flock <args>`; fails for the descriptor in FLOCK_BUSY; while it locks the recipe
 *   (descriptor 8) it creates the preview folder FLOCK_MAKES, as another up would have meanwhile;
 *   the first time it locks a preview (descriptor 7) it removes the preview folder FLOCK_TAKES, as
 *   another removal would have meanwhile.
 * With GONE_CALLER the script's stdout is a pipe whose reader has gone.
 * - sleep: returns at once (the start script waits 30 seconds for the workers).
 * With `real`, docker is Docker itself but for the registry login (`docker-real`), with only the
 * flock shim beside it.
 */

/** A shim of the fixtures folder `shims/`. */
function shim(name: string): string {
  return readFileSync(new URL(`./shims/${name}.sh`, import.meta.url), "utf8");
}

/** The fake server's programs, by name, and their shim. */
const FAKES = { docker: "docker", "kamal-proxy": "kamal-proxy", flock: "flock", sleep: "sleep" };

/** True when `sh` runs here (Git for Windows' on Windows). */
export function shWorks(): boolean {
  try {
    return spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";
  } catch {
    return false;
  }
}

/** The registry token a pull request's job sends on stdin. */
export const TOKEN = fakeSecret("github-token", "preview-registry");

/** The user's preview values (`values.env`). */
export const VALUES = {
  STRIPE_KEY: fakeSecret("stripe-live-key", "preview-values"),
  MAIL_PASSWORD: fakeSecret("generic-password", "preview-values"),
};

/** An image of the recipe's name, by digest: `a` to `f` for 64 times that hex digit. */
export function image(digit: string): string {
  return `${IMAGE_NAME}@sha256:${digit.repeat(64)}`;
}

/** A commit: 40 times the hex digit. */
export function commit(digit: string): string {
  return digit.repeat(40);
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** A fake preview server in a new temporary folder, with `plan`'s recipe installed. */
export class PreviewServer {
  readonly work: string;
  readonly app: string;

  constructor(
    readonly plan: DeployPlan,
    o: { real?: boolean } = {},
  ) {
    this.work = mkdtempSync(join(tmpdir(), "opscrew-preview-")).replaceAll("\\", "/");
    this.app = plan.app.name;
    const dir = previewRecipeDir(plan);
    for (const file of renderPreviewRecipe(plan, {
      repository: REPOSITORY,
      imageName: IMAGE_NAME,
      env: envFor(previewTemplatePlan(plan)),
    })) {
      this.write(`${this.recipe}/${file.path.slice(dir.length + 1)}`, file.content, file.mode);
    }
    this.write(
      `${this.recipe}/values.env`,
      Object.entries(VALUES)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n"),
      0o600,
    );
    for (const folder of ["srv/edge", "srv/data", "state/routes"]) {
      mkdirSync(`${this.work}/${folder}`, { recursive: true });
    }
    for (const file of ["containers", "networks", "volumes"]) {
      writeFileSync(`${this.work}/state/${file}`, "");
    }
    const shims = o.real ? { docker: "docker-real", flock: "flock" } : FAKES;
    for (const [name, file] of Object.entries(shims)) {
      this.write(`${this.work}/bin/${name}`, shim(file), 0o755);
    }
    this.write(`${this.work}/run.sh`, shim("run"));
  }

  /** The recipe's folder, `/srv/apps/<app>`. */
  get recipe(): string {
    return `${this.work}/srv/apps/${this.app}`;
  }

  /** Preview `n`'s folder, `/srv/apps/<app>-pr-<n>`. */
  preview(n: number | string): string {
    return `${this.work}/srv/apps/${this.app}-pr-${n}`;
  }

  write(path: string, content: string, mode?: number): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (mode !== undefined) chmodSync(path, mode);
  }

  /** A file's content, or undefined when it doesn't exist. */
  read(path: string): string | undefined {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  /** A state file of the shims (`docker.log`, `containers`, `routes/<service>` …), "" when absent. */
  state(name: string): string {
    return this.read(`${this.work}/state/${name}`) ?? "";
  }

  /**
   * Runs opscrew-preview (the recipe's, or `script`): through the preview key with `key` (its
   * SSH_ORIGINAL_COMMAND), else with `args`; `stdin` is the registry token for up; `env` sets the
   * shims' faults.
   */
  run(
    o: {
      key?: string;
      args?: readonly string[];
      stdin?: string;
      env?: Record<string, string>;
      script?: string;
    } = {},
  ): RunResult {
    const { SSH_ORIGINAL_COMMAND: _, ...env } = process.env;
    const result = spawnSync("sh", [`${this.work}/run.sh`, ...(o.args ?? [])], {
      env: {
        ...env,
        WORK: this.work,
        RECIPE_SCRIPT: o.script ?? `${this.recipe}/bin/opscrew-preview`,
        ...(o.key === undefined ? {} : { SSH_ORIGINAL_COMMAND: o.key }),
        ...o.env,
      },
      input: o.stdin ?? "",
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  /** `up <n> <image> <commit>` through the preview key, with the token on stdin. */
  up(
    n: number,
    o: { image?: string; commit?: string; env?: Record<string, string> } = {},
  ): RunResult {
    return this.run({
      key: `up ${n} ${o.image ?? image("a")} ${o.commit ?? commit("1")}`,
      stdin: TOKEN,
      ...(o.env === undefined ? {} : { env: o.env }),
    });
  }

  /** Every file under the server's folder, by path, with its content. */
  tree(): Record<string, string> {
    const files: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = `${dir}/${entry}`;
        if (statSync(path).isDirectory()) {
          files[`${path}/`] = "";
          walk(path);
        } else {
          files[path] = readFileSync(path, "utf8");
        }
      }
    };
    walk(this.work);
    return files;
  }

  /** A preview's `.preview` file as fields. */
  previewFields(n: number): Record<string, string> {
    return Object.fromEntries(
      (this.read(`${this.preview(n)}/.preview`) ?? "")
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
  }

  /** The lines of previews.log. */
  log(): string[] {
    return (this.read(`${this.recipe}/previews.log`) ?? "").split("\n").filter(Boolean);
  }

  remove(): void {
    rmSync(this.work, { recursive: true, force: true });
  }
}
