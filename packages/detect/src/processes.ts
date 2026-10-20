/**
 * The app's processes besides the web one: workers from the Procfile and from job libraries, cron
 * jobs from `vercel.json`, and a note for schedulers that run inside the app's own process.
 */
import { isRecord, listText } from "@opscrew/core";
import type { ProjectFacts } from "@opscrew/plan-schema";
import { type Dependency, type DependencyEcosystem, parseJson, type ReadText } from "./manifests";
import { basenameRel, isWithin, joinRel, relativeTo, sortStrings } from "./paths";
import { byDepth, inFolder } from "./release/context";
import { isAppCodeFile, pythonModule, type SourceSignals } from "./sources";

type Worker = NonNullable<ProjectFacts["workers"]>[number];
type CronJob = NonNullable<ProjectFacts["cronJobs"]>[number];

/** What worker detection reads about the app. */
export interface ProcessContext {
  /** Repo-relative folder of the app; commands run there. */
  appDir: string;
  /** The files in scope (repo-relative). */
  files: readonly string[];
  read: ReadText;
  signals: ReadonlyMap<string, SourceSignals>;
  /** Django settings files and their text. */
  settingsTexts: ReadonlyMap<string, string>;
  /** Runtime dependencies of the app's units. */
  dependencies: readonly Dependency[];
  /** Names of the app's frameworks (`laravel`, `django`). */
  frameworks: ReadonlySet<string>;
  procfile: string | undefined;
  /** The variable the app reads Redis's URL from, when one is found. */
  redisVariable: string | undefined;
}

/** A library's worker, and the Procfile commands that run the same process. */
interface LibraryWorker {
  worker: Worker;
  /** Absent for a library with no command of its own (BullMQ, asynq, river). */
  sameProcess?: RegExp;
}

/** Commands that run Celery beat: `celery … beat`, or a worker with `-B` or `--beat`. */
const CELERY_BEAT = /\bcelery\b.*(?:\bbeat\b|\s-B\b)/;
/** Procfile commands of schedulers that must run once. */
const SCHEDULER_COMMAND = new RegExp(
  `${CELERY_BEAT.source}|\\bschedule:(?:work|run)\\b|\\bbin\\/jobs\\b|\\bsolid_queue:start\\b|\\bclockwork\\b`,
);
/** Procfile types that are schedulers by convention (Heroku's `clock`). */
const SCHEDULER_TYPE = /^(?:clock|scheduler|beat)$/;

/**
 * The app's workers, sorted by name: every Procfile type but `web` and `release` with its command,
 * and the job libraries' workers with their conventional command (absent when none is known).
 * A Procfile command wins over a library's for the same process; a library with no command of its
 * own is left to a Procfile type no library claims. Schedulers that must run once are `single`.
 */
export async function detectWorkers(ctx: ProcessContext): Promise<Worker[]> {
  const fromProcfile: Worker[] = [...(ctx.procfile ?? "").matchAll(/^([\w-]+):[ \t]*(.*\S)/gm)]
    .filter((match) => match[1] !== "web" && match[1] !== "release")
    .map((match) => {
      const [, name = "", command = ""] = match;
      return {
        name,
        command: inFolder(ctx.appDir, command),
        source: "procfile",
        single: SCHEDULER_COMMAND.test(command) || SCHEDULER_TYPE.test(name),
        evidence: [`procfile:${name}`],
      };
    });
  const runs = (pattern: RegExp | undefined) =>
    fromProcfile.filter((p) => pattern?.test(p.command ?? "") === true);
  const library = await libraryWorkers(ctx);
  const claimed = new Set(library.flatMap(({ sameProcess }) => runs(sameProcess)));
  const unclaimed = claimed.size < fromProcfile.length;
  const kept = library
    .filter(
      ({ worker, sameProcess }) =>
        !fromProcfile.some((p) => p.name === worker.name) &&
        (sameProcess === undefined ? !unclaimed : runs(sameProcess).length === 0),
    )
    .map(({ worker }) => worker);
  return [...fromProcfile, ...kept].sort((a, b) => (a.name < b.name ? -1 : 1));
}

async function libraryWorkers(ctx: ProcessContext): Promise<LibraryWorker[]> {
  const has = (ecosystem: DependencyEcosystem, name: string) =>
    ctx.dependencies.some((dep) => dep.ecosystem === ecosystem && dep.name === name);
  const run = (command: string) => inFolder(ctx.appDir, command);
  const worker = (
    name: string,
    command: string | undefined,
    evidence: string[],
    single = false,
  ): Worker => ({
    name,
    ...(command === undefined ? {} : { command: run(command) }),
    source: "library",
    single,
    evidence: sortStrings(evidence),
  });
  const found: LibraryWorker[] = [];

  // Python app code, shallowest first: Celery and Huey objects, Dramatiq actors, beat schedules.
  const python = ctx.files
    .filter((f) => f.endsWith(".py") && isWithin(ctx.appDir, f))
    .filter((f) => isAppCodeFile(relativeTo(ctx.appDir, f)))
    .sort(byDepth);
  const appObject = (framework: "celery" | "huey", separator: string) => {
    for (const file of python) {
      const object = ctx.signals.get(file)?.appObjects.find((o) => o.framework === framework);
      if (object)
        return `${pythonModule(relativeTo(ctx.appDir, file))}${separator}${object.variable}`;
    }
    return undefined;
  };
  const marked = (marker: "celery-beat" | "dramatiq-actor") =>
    python.filter((file) => ctx.signals.get(file)?.markers.includes(marker));

  if (has("pypi", "celery")) {
    const app = appObject("celery", ":");
    found.push({
      // Celery starts one process per CPU unless told: two fit a worker's default 256 MB.
      worker: worker(
        "celery-worker",
        app && `celery -A ${app} worker --loglevel=info --concurrency 2`,
        ["dependency:celery"],
      ),
      sameProcess: /\bcelery\b.*\bworker\b/,
    });
    const djangoBeat = has("pypi", "django-celery-beat");
    if (djangoBeat || marked("celery-beat").length > 0) {
      // The default scheduler keeps each task's last run in a file, by default in the working
      // folder, which the app's image does not let the app write; /tmp can be written. The file
      // is gone after a restart and beat rebuilds the schedule: each task's next run then counts
      // from the restart, so a run due while beat was down is not made up.
      const scheduler = djangoBeat
        ? " --scheduler django_celery_beat.schedulers:DatabaseScheduler"
        : " --schedule /tmp/celerybeat-schedule";
      found.push({
        worker: worker(
          "celery-beat",
          app && `celery -A ${app} beat --loglevel=info${scheduler}`,
          ["dependency:celery", djangoBeat ? "dependency:django-celery-beat" : "code:celery-beat"],
          true,
        ),
        sameProcess: CELERY_BEAT,
      });
    }
  }
  // RQ connects to localhost unless given the URL; django-rq reads it from the settings.
  const djangoRq = has("pypi", "django-rq");
  if (djangoRq || has("pypi", "rq")) {
    found.push({
      worker: worker(
        "rq-worker",
        djangoRq
          ? "python manage.py rqworker"
          : `rq worker --url "$${ctx.redisVariable ?? "REDIS_URL"}"`,
        [djangoRq ? "dependency:django-rq" : "dependency:rq"],
      ),
      sameProcess: /\brq\s+worker\b|\brqworker\b/,
    });
  }
  const djangoDramatiq = has("pypi", "django-dramatiq");
  if (djangoDramatiq || has("pypi", "dramatiq")) {
    const modules = marked("dramatiq-actor").map((f) => pythonModule(relativeTo(ctx.appDir, f)));
    found.push({
      worker: worker(
        "dramatiq",
        djangoDramatiq
          ? "python manage.py rundramatiq"
          : modules.length > 0
            ? `dramatiq ${sortStrings(modules).join(" ")}`
            : undefined,
        [djangoDramatiq ? "dependency:django-dramatiq" : "dependency:dramatiq"],
      ),
      sameProcess: /\b(?:run)?dramatiq\b/,
    });
  }
  if (has("pypi", "huey")) {
    const django = [...ctx.settingsTexts.values()].some((text) =>
      text.includes("huey.contrib.djhuey"),
    );
    const app = appObject("huey", ".");
    found.push({
      worker: worker("huey", django ? "python manage.py run_huey" : app && `huey_consumer ${app}`, [
        "dependency:huey",
      ]),
      sameProcess: /\b(?:huey_consumer|run_huey)\b/,
    });
  }
  if (has("gem", "sidekiq")) {
    const cron = ["sidekiq-cron", "sidekiq-scheduler"].filter((name) => has("gem", name));
    found.push({
      worker: worker(
        "sidekiq",
        "bundle exec sidekiq",
        ["dependency:sidekiq", ...cron.map((name) => `dependency:${name}`)],
        cron.length > 0,
      ),
      sameProcess: /\bsidekiq\b/,
    });
  }
  if (has("gem", "good_job")) {
    found.push({
      worker: worker("good-job", "bundle exec good_job start", ["dependency:good_job"]),
      sameProcess: /\bgood_job\b/,
    });
  }
  if (has("gem", "solid_queue")) {
    const binJobs = ctx.files.includes(joinRel(ctx.appDir, "bin/jobs"));
    found.push({
      worker: worker(
        "solid-queue",
        binJobs ? "bin/jobs" : "bundle exec rake solid_queue:start",
        ["dependency:solid_queue"],
        true,
      ),
      sameProcess: /\bbin\/jobs\b|\bsolid_queue:start\b/,
    });
  }
  if (has("gem", "resque")) {
    found.push({
      worker: worker("resque", "bundle exec rake resque:work QUEUE=*", ["dependency:resque"]),
      sameProcess: /\bresque:work\b|\bresque-pool\b/,
    });
  }
  if (has("npm", "bullmq"))
    found.push({ worker: worker("bullmq", undefined, ["dependency:bullmq"]) });
  if (has("go", "github.com/hibiken/asynq")) {
    found.push({ worker: worker("asynq", undefined, ["dependency:github.com/hibiken/asynq"]) });
  }
  if (has("go", "github.com/riverqueue/river")) {
    found.push({ worker: worker("river", undefined, ["dependency:github.com/riverqueue/river"]) });
  }
  if (ctx.frameworks.has("laravel")) {
    const jobsDir = joinRel(ctx.appDir, "app/Jobs");
    const horizon = has("composer", "laravel/horizon");
    if (horizon) {
      found.push({
        worker: worker("horizon", "php artisan horizon", ["dependency:laravel/horizon"]),
        sameProcess: /\bhorizon\b|\bqueue:(?:work|listen)\b/,
      });
    } else if (ctx.files.some((f) => isWithin(jobsDir, f) && f.endsWith(".php"))) {
      found.push({
        worker: worker("queue-worker", "php artisan queue:work", ["file:app/Jobs"]),
        sameProcess: /\bqueue:(?:work|listen)\b|\bhorizon\b/,
      });
    }
    // Without comments: Laravel 10's Kernel.php ships `// $schedule->command('inspire')…`.
    const code = async (path: string) =>
      ((await ctx.read(joinRel(ctx.appDir, path))) ?? "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(?:\/\/|#).*$/gm, "");
    const consoleRoutes = await code("routes/console.php");
    const kernel = await code("app/Console/Kernel.php");
    const schedule = /\bSchedule::/.test(consoleRoutes)
      ? "file:routes/console.php"
      : /\$schedule->/.test(kernel)
        ? "file:app/Console/Kernel.php"
        : undefined;
    if (schedule) {
      found.push({
        worker: worker("scheduler", "php artisan schedule:work", [schedule], true),
        sameProcess: /\bschedule:(?:work|run)\b/,
      });
    }
  }
  return found;
}

/** Schedulers that run inside the app's own process, by runtime dependency, with their names. */
const IN_PROCESS_SCHEDULERS: Partial<Record<DependencyEcosystem, Record<string, string>>> = {
  npm: { "node-cron": "node-cron", cron: "cron" },
  pypi: { apscheduler: "APScheduler" },
  maven: {
    "org.quartz-scheduler:quartz": "Quartz",
    "org.springframework.boot:spring-boot-starter-quartz": "Quartz",
  },
  nuget: {
    hangfire: "Hangfire",
    "hangfire.core": "Hangfire",
    "hangfire.aspnetcore": "Hangfire",
    quartz: "Quartz",
    "quartz.extensions.hosting": "Quartz",
    "quartz.aspnetcore": "Quartz",
  },
};

/**
 * The note for schedulers that run inside the app's own process (node-cron, APScheduler,
 * Spring's `@Scheduled` with `@EnableScheduling`, Hangfire, Quartz): OpsCrew adds no process for
 * them, and each copy of the app runs them. Undefined when there are none.
 */
export async function inProcessSchedulerNote(ctx: ProcessContext): Promise<string | undefined> {
  const names = new Set<string>();
  for (const dep of ctx.dependencies) {
    const name = dep.ecosystem === "nuget" ? dep.name.toLowerCase() : dep.name;
    const label = IN_PROCESS_SCHEDULERS[dep.ecosystem]?.[name];
    if (label) names.add(label);
  }
  if (ctx.dependencies.some((dep) => dep.ecosystem === "maven")) {
    for (const file of ctx.files.filter((f) => /\.(?:java|kt)$/.test(basenameRel(f)))) {
      if (/@EnableScheduling\b/.test((await ctx.read(file)) ?? "")) {
        names.add("Spring's @Scheduled");
        break;
      }
    }
  }
  if (names.size === 0) return undefined;
  return `The app runs scheduled jobs inside its own process (${listText(sortStrings(names))}), so OpsCrew adds no separate process for them. Keep one copy of the app running, or make sure each job runs only once when several copies run.`;
}

/** The `crons` of a `vercel.json` (`{ path, schedule }`), in file order; malformed ones skipped. */
export function vercelCronJobs(text: string | undefined): CronJob[] {
  const data = parseJson(text);
  if (!isRecord(data) || !Array.isArray(data.crons)) return [];
  return data.crons.flatMap((cron): CronJob[] => {
    if (!isRecord(cron) || typeof cron.path !== "string" || typeof cron.schedule !== "string") {
      return [];
    }
    const schedule = cron.schedule.trim();
    if (!/^\/\S*$/.test(cron.path) || schedule === "") return [];
    return [{ schedule, route: cron.path, source: "vercel.json" }];
  });
}
