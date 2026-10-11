#!/usr/bin/env node
// Validates the OpsCrew Claude Code plugin and the repository marketplace file against the
// documented plugin format (code.claude.com/docs, plugins reference). Exit code 1 on any error.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(pluginDir, "..");
const errors = [];
const warnings = [];
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED_PLUGIN_PREFIXES = ["claude-", "anthropic-", "anthropics-", "cc-plugin-"];
const RESERVED_MARKETPLACES = [
  "claude-plugins-official",
  "claude-code-plugins",
  "inline",
  "builtin",
  "npm",
  "github",
];

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
if (manifest) {
  if (typeof manifest.name !== "string" || !KEBAB.test(manifest.name)) {
    errors.push("plugin.json: `name` must be kebab-case");
  } else if (RESERVED_PLUGIN_PREFIXES.some((p) => manifest.name.startsWith(p))) {
    errors.push(`plugin.json: name must not start with ${RESERVED_PLUGIN_PREFIXES.join(", ")}`);
  }
  for (const field of ["version", "description"]) {
    if (typeof manifest[field] !== "string" || manifest[field].length === 0)
      warnings.push(`plugin.json: missing ${field}`);
  }
  if (typeof manifest.author?.name !== "string") warnings.push("plugin.json: missing author.name");
  if (manifest.homepage !== undefined) {
    try {
      new URL(manifest.homepage);
    } catch {
      errors.push("plugin.json: homepage must be a valid URL");
    }
  }
}

// .mcp.json
const mcp = readJson(join(pluginDir, ".mcp.json"));
if (mcp) {
  const servers = mcp.mcpServers;
  if (typeof servers !== "object" || servers === null || Object.keys(servers).length === 0) {
    errors.push(".mcp.json: `mcpServers` must define at least one server");
  } else {
    for (const [name, server] of Object.entries(servers)) {
      if (typeof server.command !== "string" && typeof server.url !== "string") {
        errors.push(`.mcp.json: server ${name} needs a \`command\` (stdio) or \`url\``);
      }
    }
  }
}

// The MCP server version must match the plugin version (no floating `@latest`).
const pinned = JSON.stringify(mcp ?? {}).match(/opscrew@([^"\s]+)/);
if (manifest && pinned && pinned[1] !== manifest.version) {
  errors.push(
    `.mcp.json: runs opscrew@${pinned[1]}, but the plugin version is ${manifest.version}; pin the same version`,
  );
}

// skills/<name>/SKILL.md
const skillsDir = join(pluginDir, "skills");
const skills = existsSync(skillsDir)
  ? readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory())
  : [];
if (skills.length === 0) errors.push("skills/: no skills found");
for (const skill of skills) {
  const file = join(skillsDir, skill, "SKILL.md");
  if (!existsSync(file)) {
    errors.push(`skills/${skill}: missing SKILL.md`);
    continue;
  }
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) {
    errors.push(`skills/${skill}/SKILL.md: missing YAML frontmatter`);
    continue;
  }
  const fields = Object.fromEntries(
    match[1]
      .split("\n")
      .map((line) => /^([a-zA-Z-]+):\s*(.*)$/.exec(line))
      .filter(Boolean)
      .map((m) => [m[1], m[2].trim()]),
  );
  if (fields.name !== skill)
    errors.push(`skills/${skill}/SKILL.md: \`name\` must equal the directory name`);
  if (!fields.description) errors.push(`skills/${skill}/SKILL.md: missing \`description\``);
  else if (fields.description.length > 1536)
    errors.push(`skills/${skill}/SKILL.md: description over 1536 characters`);
  if (match[2].trim().length === 0) errors.push(`skills/${skill}/SKILL.md: empty body`);
  if (text.split("\n").length > 500) warnings.push(`skills/${skill}/SKILL.md: over 500 lines`);
}

// .claude-plugin/marketplace.json at the repository root
const marketplace = readJson(join(repoRoot, ".claude-plugin", "marketplace.json"));
if (marketplace) {
  if (
    typeof marketplace.name !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(marketplace.name)
  ) {
    errors.push("marketplace.json: invalid `name`");
  } else if (
    RESERVED_MARKETPLACES.includes(marketplace.name) ||
    /^(anthropic|claudeai)-/.test(marketplace.name)
  ) {
    errors.push(`marketplace.json: \`${marketplace.name}\` is a reserved marketplace name`);
  }
  if (typeof marketplace.owner?.name !== "string")
    errors.push("marketplace.json: missing owner.name");
  if (marketplace.description !== undefined) {
    errors.push("marketplace.json: `description` belongs under `metadata`, not at the root");
  }
  if (!marketplace.metadata?.description) {
    warnings.push("marketplace.json: missing metadata.description");
  }
  const entries = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  if (entries.length === 0)
    errors.push("marketplace.json: `plugins` must list at least one plugin");
  for (const entry of entries) {
    if (typeof entry.name !== "string" || entry.source === undefined) {
      errors.push("marketplace.json: every plugin needs `name` and `source`");
      continue;
    }
    if (typeof entry.source === "string") {
      if (!entry.source.startsWith("./") && entry.source !== ".") {
        errors.push(`marketplace.json: relative source for ${entry.name} must start with ./`);
      } else if (!existsSync(join(repoRoot, entry.source, ".claude-plugin", "plugin.json"))) {
        errors.push(`marketplace.json: source ${entry.source} has no .claude-plugin/plugin.json`);
      }
    }
    if (manifest && entry.source === "./plugin" && entry.name !== manifest.name) {
      errors.push(
        `marketplace.json: entry name ${entry.name} differs from plugin.json name ${manifest.name}`,
      );
    }
  }
}

for (const warning of warnings) console.warn(`warning: ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exit(1);
}
console.log(
  `OpsCrew plugin OK: ${skills.length} skills, ${Object.keys(mcp?.mcpServers ?? {}).length} MCP server(s).`,
);
