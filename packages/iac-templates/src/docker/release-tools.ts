/**
 * The Node.js migration tools a release command runs, and the build-stage helper that finds their
 * npm packages, so the image keeps them.
 */

/** Migration tools run as `npx <bin>` or from a package script: their name and npm packages. */
export const NODE_TOOL_BINS: Readonly<Record<string, { name: string; packages: string[] }>> = {
  prisma: { name: "Prisma", packages: ["prisma"] },
  keystone: { name: "KeystoneJS", packages: [] },
  "drizzle-kit": { name: "Drizzle", packages: ["drizzle-kit"] },
  "typeorm-ts-node-commonjs": { name: "TypeORM", packages: ["typeorm", "ts-node"] },
  "typeorm-ts-node-esm": { name: "TypeORM", packages: ["typeorm", "ts-node"] },
  typeorm: { name: "TypeORM", packages: ["typeorm"] },
  sequelize: { name: "Sequelize", packages: ["sequelize-cli"] },
  "sequelize-cli": { name: "Sequelize", packages: ["sequelize-cli"] },
  knex: { name: "Knex", packages: ["knex"] },
  "mikro-orm": { name: "MikroORM", packages: ["@mikro-orm/cli"] },
  kysely: { name: "Kysely", packages: ["kysely-ctl"] },
  "node-pg-migrate": { name: "node-pg-migrate", packages: ["node-pg-migrate"] },
  "db-migrate": { name: "db-migrate", packages: ["db-migrate"] },
  payload: { name: "Payload", packages: ["payload"] },
  medusa: { name: "Medusa", packages: ["@medusajs/cli"] },
};

/** The bin a command runs with `npx` (`npx prisma@6 migrate deploy` → `prisma`). */
export function npxBin(command: string): string | undefined {
  return /^npx ([\w.-]+)/.exec(command)?.[1];
}

/**
 * The package script a command runs (`npm run db:migrate`, `pnpm migrate`, `yarn run migrate`), or
 * undefined for other commands.
 */
export function packageScriptOf(command: string): string | undefined {
  const run = /^(?:npm|pnpm|yarn|bun)\s.*?\brun\s+([\w:.-]+)/.exec(command)?.[1];
  if (run !== undefined) return run;
  const bare = /^(?:pnpm|yarn) ([\w:][\w:.-]*)/.exec(command)?.[1];
  return bare === undefined || ["exec", "dlx", "workspace", "install"].includes(bare)
    ? undefined
    : bare;
}

/**
 * Kept with any release tool when the app has them: knex, node-pg-migrate, MikroORM and TypeORM
 * load TypeScript configs and migrations through them.
 */
export const TYPESCRIPT_RUNNERS = ["ts-node", "tsx", "typescript"] as const;

/** Where the build stage keeps the helper. */
export const RELEASE_TOOLS_HELPER = "/tmp/opscrew-release-tools.cjs";

/**
 * The helper, run from the repository root:
 * `node <helper> <move|versions> <app folder> <package script or -> [package...]`. It adds the
 * packages of the tools the package script runs, and with any tool the {@link TYPESCRIPT_RUNNERS}
 * the app has. `move` moves the packages from `devDependencies` to `dependencies` in the app's and
 * the root `package.json`; `versions` prints `<package>@<installed version>` for each. Either
 * fails when a tool's package is not listed (move) or not installed (versions).
 */
const HELPER = [
  "// OpsCrew: the npm packages the release command's migration tool needs.",
  'const fs = require("fs");',
  `const BINS = ${JSON.stringify(
    Object.fromEntries(
      Object.entries(NODE_TOOL_BINS)
        .filter(([, tool]) => tool.packages.length > 0)
        .map(([bin, tool]) => [bin, tool.packages]),
    ),
  )};`,
  "const [mode, dir, script, ...packages] = process.argv.slice(2);",
  'const manifests = [...new Set([dir + "/package.json", "package.json"])].filter((f) => fs.existsSync(f));',
  'const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));',
  'if (script !== "-") {',
  "  const text = manifests.map((f) => read(f).scripts?.[script]).find((s) => s !== undefined);",
  '  if (text === undefined) throw new Error("No package.json in " + dir + " has a script " + script);',
  "  for (const command of text.split(/&&|\\|\\||;/)) {",
  "    const words = command.trim().split(/\\s+/).filter((w) => !/^[A-Za-z_]\\w*=/.test(w));",
  '    const bin = (words[0] === "npx" ? words[1] : words[0]) ?? "";',
  '    packages.push(...(BINS[bin.replace(/@.*$/, "")] ?? []));',
  "  }",
  "}",
  "const wanted = [...new Set(packages)];",
  "// TypeScript runners a tool needs for a TypeScript config or migrations: kept with it when there.",
  `const TS = ${JSON.stringify(TYPESCRIPT_RUNNERS)}.filter((t) => wanted.length > 0 && !wanted.includes(t));`,
  'const installed = (name) => [dir + "/node_modules/" + name + "/package.json", "node_modules/" + name + "/package.json"].find((f) => fs.existsSync(f));',
  'if (mode === "move") {',
  "  for (const name of wanted) {",
  "    const listed = manifests.some((f) => { const p = read(f); return p.dependencies?.[name] !== undefined || p.devDependencies?.[name] !== undefined; });",
  '    if (!listed) throw new Error("The release command needs " + name + ", which package.json does not list: add it.");',
  "  }",
  "  for (const file of manifests) {",
  "    const p = read(file);",
  "    const dev = p.devDependencies ?? {};",
  "    const kept = [...wanted, ...TS].filter((t) => t in dev);",
  "    if (kept.length === 0) continue;",
  "    p.dependencies ??= {};",
  "    for (const t of kept) { p.dependencies[t] = dev[t]; delete dev[t]; }",
  '    fs.writeFileSync(file, JSON.stringify(p, null, 2) + "\\n");',
  "  }",
  "} else {",
  "  for (const name of wanted) {",
  '    if (installed(name) === undefined) throw new Error("The release command needs " + name + ", which is not installed: add it to package.json.");',
  "  }",
  "  const all = [...wanted, ...TS.filter((t) => installed(t) !== undefined)];",
  '  console.log(all.map((name) => name + "@" + read(installed(name)).version).join(" "));',
  "}",
];

/** Dockerfile lines writing the helper into the build stage. */
export function releaseToolsHelper(): string[] {
  return [`COPY <<'EOF' ${RELEASE_TOOLS_HELPER}`, ...HELPER, "EOF"];
}
