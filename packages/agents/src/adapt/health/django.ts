/**
 * Django: a tiny view and a `path(...)` entry first in the root URLconf's `urlpatterns` (the
 * module `ROOT_URLCONF` names in the settings).
 */
import { appCodeFiles, appFolder, readSource, under } from "./common";
import {
  blockBefore,
  type PyStatement,
  pyBinds,
  pyImportName,
  pyImports,
  pyReference,
  scanPy,
} from "./py";
import { applyInsertions, escapeRegExp, type Insertion, listing, prependElement } from "./text";
import { type HealthEdit, type HealthRouteInput, manual, OK_BODY } from "./types";

const ROOT_URLCONF = /^ROOT_URLCONF[ \t]*=[ \t]*(["'])([\w.]+)\1/m;

/** The root URLconf file, or why OpsCrew cannot tell which one it is. */
async function rootUrlconf(
  input: HealthRouteInput,
  files: readonly string[],
): Promise<{ file: string; settings: string[] } | { reason: string }> {
  const settingsFirst = [
    ...files.filter((file) => /settings/.test(file)),
    ...files.filter((file) => !/settings/.test(file)),
  ];
  const modules = new Map<string, string>();
  const settings: string[] = [];
  for (const file of settingsFirst) {
    const text = await readSource(input.repo, file);
    if (text === undefined || !text.includes("ROOT_URLCONF")) continue;
    const module = ROOT_URLCONF.exec(text)?.[2];
    if (module === undefined) continue;
    modules.set(module, file);
    settings.push(text);
  }
  if (modules.size === 0) {
    return { reason: "OpsCrew found no ROOT_URLCONF in the Django settings" };
  }
  if (modules.size > 1) {
    const named = [...modules].map(([module, file]) => `${module} in ${file}`);
    return {
      reason: `the Django settings name different root URLconfs (${listing(named)}), so OpsCrew cannot tell which one serves the app`,
    };
  }
  const module = [...modules.keys()][0] as string;
  const relative = module.split(".").join("/");
  const dir = appFolder(input.facts);
  const bases = new Set<string>();
  for (const file of files) {
    if (file === under(dir, "manage.py") || file.endsWith("/manage.py")) {
      bases.add(file.slice(0, -"manage.py".length).replace(/\/$/, "") || ".");
    }
  }
  bases.add(dir);
  bases.add(under(dir, "src"));
  const all = new Set(await input.repo.files());
  for (const base of bases) {
    for (const candidate of [`${relative}.py`, `${relative}/__init__.py`]) {
      const file = base === "." ? candidate : `${base}/${candidate}`;
      if (all.has(file)) return { file, settings };
    }
  }
  return { reason: `OpsCrew could not find the file of ROOT_URLCONF "${module}"` };
}

/** The Django health route: a view and the first `urlpatterns` entry in the root URLconf. */
export async function djangoHealthRoute(input: HealthRouteInput): Promise<HealthEdit> {
  const files = await appCodeFiles(input.repo, input.facts, /\.py$/);
  const root = await rootUrlconf(input, files);
  if ("reason" in root) return manual(`${root.reason}.`);
  const { file } = root;
  const text = await readSource(input.repo, file);
  if (text === undefined) return manual(`OpsCrew could not read ${file}.`);
  const src = scanPy(text);
  const route = input.healthPath.replace(/^\//, "");
  const bare = route.replace(/\/$/, "");
  const existing = new RegExp(
    `\\b(?:re_)?path\\(\\s*r?["']\\^?(${escapeRegExp(bare)}/?)\\$?["']`,
  ).exec(text);
  if (existing?.[1] !== undefined && src.code[existing.index] !== " ") {
    if (existing[1] === route) {
      return {
        action: "none",
        reason: `${file} already routes ${input.healthPath}; OpsCrew left it as it is.`,
      };
    }
    return manual(
      `${file} already routes /${existing[1]}, but the plan checks ${input.healthPath}: set app.healthPath to /${existing[1]} in \`opscrew/plan.yaml\` (or run \`opscrew design\` again).`,
    );
  }
  const assignments = src.statements.filter(
    (s) => s.indent === "" && /^urlpatterns[ \t]*(?::[^=\n]*)?=(?!=)/.test(s.code),
  );
  if (assignments.length !== 1) {
    return manual(
      assignments.length === 0
        ? `${file} has no urlpatterns list OpsCrew can add to.`
        : `${file} assigns urlpatterns ${assignments.length} times, so OpsCrew cannot tell which list Django uses.`,
    );
  }
  const statement = assignments[0] as PyStatement;
  const value = /=(?!=)[ \t]*/.exec(statement.code);
  const open = value === null ? -1 : statement.start + value.index + value[0].length;
  if (src.code[open] !== "[") {
    return manual(`urlpatterns in ${file} is not a plain list, so OpsCrew did not edit it.`);
  }
  const imports = pyImports(src);
  const q = src.quote;
  const insertions: Insertion[] = [];
  const response = pyImportName(src, imports, "django.http", "JsonResponse", "DjangoJsonResponse");
  if (response.insertion) insertions.push(response.insertion);
  let pathName = pyReference(imports, "django.urls.path");
  if (pathName === undefined) {
    const added = pyImportName(src, imports, "django.urls", "path", "django_path");
    pathName = added.local;
    if (added.insertion) insertions.push(added.insertion);
  }
  const view = pyBinds(src, "health") ? "opscrew_health" : "health";
  const lines: string[] = [];
  // Django 5.1's LoginRequiredMiddleware would send the health check to the login page.
  if (root.settings.some((settings) => /LoginRequiredMiddleware/.test(settings))) {
    const decorator = pyImportName(
      src,
      imports,
      "django.contrib.auth.decorators",
      "login_not_required",
      "django_login_not_required",
    );
    if (decorator.insertion) insertions.push(decorator.insertion);
    lines.push(`@${decorator.local}`);
  }
  lines.push(
    `def ${view}(request):`,
    `${src.unit}return ${response.local}({${q}status${q}: ${q}ok${q}})`,
  );
  insertions.push(blockBefore(src, statement, lines));
  const entry = prependElement(text, src.code, open, `${pathName}(${q}${route}${q}, ${view})`);
  if (entry === undefined) return manual(`urlpatterns in ${file} is not closed.`);
  insertions.push(entry);
  const checks: string[] = [];
  if (root.settings.some((settings) => /^\s*SECURE_SSL_REDIRECT\s*=/m.test(settings))) {
    checks.push(
      `Check that SECURE_SSL_REDIRECT does not redirect ${input.healthPath}: the deploy health check calls the container over plain HTTP (add it to SECURE_REDIRECT_EXEMPT if it does).`,
    );
  }
  return {
    action: "write",
    framework: "Django",
    files: [{ path: file, content: applyInsertions(text, insertions), created: false }],
    path: file,
    note: `Added GET ${input.healthPath} to ${file} by OpsCrew, first in urlpatterns: a small view answers ${OK_BODY} for the deploy health check.`,
    checks,
  };
}
