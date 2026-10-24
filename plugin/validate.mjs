#!/usr/bin/env node
// Checks the OpsCrew Claude Code plugin and the repository marketplace file: the required fields
// of the documented plugin format, a name and a description for every skill, and the MCP server
// pinned to the plugin's version (FR-111). Exit code 1 on any error.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(pluginDir, "..");
const errors = [];

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${file}: ${error.message}`);
    return undefined;
  }
}

// plugin.json
const manifest = readJson(join(pluginDir, ".claude-plugin", "plugin.json"));
if (
  manifest &&
  (typeof manifest.name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name))
) {
  errors.push("plugin.json: `name` must be kebab-case");
}

// .mcp.json
const mcp = readJson(join(pluginDir, ".mcp.json"));
const servers = mcp?.mcpServers;
if (mcp && (typeof servers !== "object" || servers === null || Object.keys(servers).length === 0)) {
  errors.push(".mcp.json: `mcpServers` must define at least one server");
}
for (const [name, server] of Object.entries(servers ?? {})) {
  if (typeof server.command !== "string" && typeof server.url !== "string") {
    errors.push(`.mcp.json: server ${name} needs a \`command\` (stdio) or \`url\``);
  }
}

// The MCP server runs the OpsCrew CLI that Claude Code installs from the plugin's lockfile when it
// installs the plugin, at the plugin's version (FR-111: no floating `@latest`). Claude Code installs
// only exact registry versions, and only when package.json and the lockfile list the same packages.
// biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's variable, not a template.
const launcher = "${CLAUDE_PLUGIN_ROOT}/node_modules/opscrew/dist/opscrew.js";
if (mcp && !JSON.stringify(mcp).includes(launcher)) {
  errors.push(`.mcp.json: must run ${launcher}, the CLI installed from the plugin's lockfile`);
}
const pkg = readJson(join(pluginDir, "package.json"));
const lock = readJson(join(pluginDir, "package-lock.json"));
const version = manifest?.version;
if (pkg && JSON.stringify(pkg.dependencies) !== JSON.stringify({ opscrew: version })) {
  errors.push(`package.json: must depend on exactly opscrew ${version}, the plugin's version`);
}
if (lock) {
  const fix = "run `npm install --package-lock-only --ignore-scripts` in plugin/";
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) {
    errors.push(`package-lock.json: lockfileVersion must be 2 or 3; ${fix}`);
  }
  if (JSON.stringify(lock.packages?.[""]?.dependencies) !== JSON.stringify(pkg?.dependencies)) {
    errors.push(`package-lock.json: lists other dependencies than package.json; ${fix}`);
  }
  if (lock.packages?.["node_modules/opscrew"]?.version !== version) {
    errors.push(`package-lock.json: must lock opscrew ${version}; ${fix}`);
  }
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "") continue;
    if (!entry.resolved?.startsWith("https://registry.npmjs.org/") || !entry.integrity) {
      errors.push(
        `package-lock.json: ${path} must come from registry.npmjs.org with its integrity`,
      );
    }
  }
}

// skills/<name>/SKILL.md, among them the three FR-111 names
const skillsDir = join(pluginDir, "skills");
const skills = existsSync(skillsDir)
  ? readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory())
  : [];
for (const required of ["opscrew-deploy", "opscrew-scan", "opscrew-adapt"]) {
  if (!skills.includes(required)) errors.push(`skills/${required}: missing (FR-111)`);
}
for (const skill of skills) {
  const file = join(skillsDir, skill, "SKILL.md");
  if (!existsSync(file)) {
    errors.push(`skills/${skill}: missing SKILL.md`);
    continue;
  }
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(
    readFileSync(file, "utf8").replace(/\r\n/g, "\n"),
  );
  if (!frontmatter) {
    errors.push(`skills/${skill}/SKILL.md: missing YAML frontmatter`);
    continue;
  }
  const field = (key) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(frontmatter[1])?.[1].trim();
  if (field("name") !== skill) {
    errors.push(`skills/${skill}/SKILL.md: \`name\` must equal the directory name`);
  }
  if (!field("description")) errors.push(`skills/${skill}/SKILL.md: missing \`description\``);
}

// .claude-plugin/marketplace.json at the repository root
const marketplace = readJson(join(repoRoot, ".claude-plugin", "marketplace.json"));
if (marketplace) {
  if (typeof marketplace.name !== "string" || marketplace.name === "") {
    errors.push("marketplace.json: missing `name`");
  }
  if (typeof marketplace.owner?.name !== "string") {
    errors.push("marketplace.json: missing owner.name");
  }
  const entries = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  if (entries.length === 0)
    errors.push("marketplace.json: `plugins` must list at least one plugin");
  for (const entry of entries) {
    if (typeof entry.name !== "string" || entry.source === undefined) {
      errors.push("marketplace.json: every plugin needs `name` and `source`");
    } else if (typeof entry.source === "string" && !entry.source.startsWith("./")) {
      errors.push(`marketplace.json: relative source for ${entry.name} must start with ./`);
    } else if (
      typeof entry.source === "string" &&
      !existsSync(join(repoRoot, entry.source, ".claude-plugin", "plugin.json"))
    ) {
      errors.push(`marketplace.json: source ${entry.source} has no .claude-plugin/plugin.json`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exit(1);
}
console.log(
  `OpsCrew plugin OK: ${skills.length} skills, ${Object.keys(servers ?? {}).length} MCP server(s).`,
);
