// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import type { DeployPlan, RuntimeLanguage } from "@opscrew/plan-schema";
import { appRoot } from "../app-root";
import { SECRET_FILE_PATTERNS } from "../docker";
import { supercronicAdd } from "../docker/stacks";
import { ACTIONS, IMAGES, TOOLS, toolDownloadUrl } from "../pins";
import {
  buildArch,
  buildRunner,
  buildsOnRunner,
  DEPLOY_SECRETS,
  DIGEST_REF_PATTERN,
  DOCKER_CONTEXT_HOST,
  environmentName,
  environmentTag,
  GHCR_LOGIN,
  hasCronJobs,
  job,
  run,
  secret,
  sqliteFolder,
  supercronicArch,
} from "./shared";

/**
 * The Buildpacks setting that selects the runtime version, per language the Paketo builder
 * builds: Buildpacks ignores some version files (`.python-version`), so OpsCrew always passes the
 * version recorded in `app.build.runtime`.
 */
const BUILDPACKS_VERSION_SETTING: Partial<Record<RuntimeLanguage, string>> = {
  node: "BP_NODE_VERSION",
  python: "BP_CPYTHON_VERSION",
  go: "BP_GO_VERSION",
  java: "BP_JVM_VERSION",
  dotnet: "BP_DOTNET_FRAMEWORK_VERSION",
  ruby: "BP_MRI_VERSION",
};

/**
 * Railpack's setting for the runtime version, per language (Railpack v0.42.0's providers read
 * `RAILPACK_<NAME>_VERSION`), so it builds with the version recorded in `app.build.runtime`. For
 * Node, Go, .NET and Rust, Railpack lets a version file mise reads (`.nvmrc`, go.mod's `go` line,
 * …) override it. PHP has none: Railpack reads `require.php` in composer.json, where design found
 * the version too.
 */
const RAILPACK_VERSION_SETTING: Partial<Record<RuntimeLanguage, string>> = {
  node: "RAILPACK_NODE_VERSION",
  python: "RAILPACK_PYTHON_VERSION",
  go: "RAILPACK_GO_VERSION",
  java: "RAILPACK_JDK_VERSION",
  dotnet: "RAILPACK_DOTNET_VERSION",
  ruby: "RAILPACK_RUBY_VERSION",
  rust: "RAILPACK_RUST_VERSION",
};

/** `NAME=<version>` of the plan's runtime for a builder's version settings, if it has one. */
function versionSetting(
  plan: DeployPlan,
  settings: Partial<Record<RuntimeLanguage, string>>,
): string | undefined {
  const runtime = plan.app.build?.runtime;
  const name = runtime && settings[runtime.language];
  return name === undefined || runtime?.version === undefined
    ? undefined
    : `${name}=${runtime.version}`;
}

/**
 * The folders under `/app` a framework writes to, which the Railpack seal gives to the app's user
 * (Rails for Ruby, Laravel for PHP): Railpack images run as root, and uid 10001 cannot create
 * them in the root-owned `/app`. The web root (`public`) stays root's.
 */
const RAILPACK_WRITABLE: Partial<Record<RuntimeLanguage, readonly string[]>> = {
  ruby: ["tmp", "log", "storage", "db"],
  php: ["storage", "bootstrap/cache", "database"],
};

/**
 * More seal lines per language. PHP: FrankenPHP's binary carries the file capability
 * `cap_net_bind_service`, which Compose's `cap_drop: ALL` with no-new-privileges cannot grant, so
 * starting it fails ("Operation not permitted"). The app listens on its own port (8080 by
 * default), not a low one, so the seal copies the binary over itself, which drops the capability.
 * Railpack's Laravel start runs `php artisan storage:link`, which uid 10001 cannot do in the
 * root-owned web root, so the seal makes the link (`public/storage` → `storage/app/public`) and
 * the start finds it already there.
 */
const RAILPACK_SEAL: Partial<Record<RuntimeLanguage, readonly string[]>> = {
  php: [
    'RUN bin="$(command -v frankenphp)" && cp "$bin" "$bin.new" && mv "$bin.new" "$bin"',
    "RUN if [ -d /app/public ]; then ln -sfn ../storage/app/public /app/public/storage; fi",
  ],
};

/** The user every Railpack image runs as after the seal. */
export const RAILPACK_USER = "10001:10001";

/** `owner/name@<sha> # vX` for `uses:`. */
const uses = (key: keyof typeof ACTIONS) => `  uses: ${ACTIONS[key]}`;

/**
 * `name` (`ghcr.io/<owner>/<repo>`) and `image` (`<name>:<commit tag>`, {@link environmentTag}),
 * lower case as GHCR needs. On the environment's own runner without bash 4's `${…,,}` (macOS's
 * bash 3.2), with `tr`.
 */
function imageName(plan: DeployPlan): string[] {
  return [
    "- id: image",
    "  name: Choose the image name",
    ...run([
      "set -euo pipefail",
      buildsOnRunner(plan)
        ? `repo="$(printf '%s' "$GITHUB_REPOSITORY" | tr '[:upper:]' '[:lower:]')"`
        : 'repo="${GITHUB_REPOSITORY,,}"',
      'echo "name=ghcr.io/${repo}" >> "$GITHUB_OUTPUT"',
      `echo "image=ghcr.io/\${repo}:${environmentTag("${GITHUB_SHA}", environmentName(plan))}" >> "$GITHUB_OUTPUT"`,
    ]),
  ];
}

/**
 * `<name>:build-<commit tag>`, the intermediate image a seal build starts from, tagged per
 * environment as the final image is, so that another environment's image retention never takes
 * it for its own.
 */
function intermediateImage(plan: DeployPlan): string {
  return `\${{ steps.image.outputs.name }}:build-${environmentTag("${{ github.sha }}", environmentName(plan))}`;
}

const SETUP_BUILDX = [
  "# Keeps the GitHub event (commit messages, emails) out of the provenance; it still names the",
  "# workflow run, and the repository and commit of the checkout.",
  "- name: Set up Docker Buildx",
  uses("setupBuildx"),
  "  with:",
  "    driver-opts: provenance-add-gha=false",
];

/**
 * The final `build-push-action` step (`push`): pushed as `<name>:<commit tag>` with a mode=max
 * provenance and an SBOM; its `digest` output is the image index digest the deploy uses.
 */
function finalBuild(name: string, inputs: readonly string[], cache: string): string[] {
  return [
    "- id: push",
    `  name: ${name}`,
    uses("buildPush"),
    "  with:",
    ...inputs.map((line) => `    ${line}`),
    "    push: true",
    "    tags: ${{ steps.image.outputs.image }}",
    "    provenance: mode=max",
    "    sbom: true",
    `    cache-from: type=gha${cache === "" ? "" : `,${cache}`}`,
    `    cache-to: type=gha,mode=${cache === "" ? "max" : `min,${cache}`}`,
  ];
}

/** The seal's supercronic line when the plan has cron jobs (see {@link supercronicArch}). */
function supercronicSeal(plan: DeployPlan): string[] {
  const arch = supercronicArch(plan);
  return arch === undefined ? [] : [supercronicAdd(arch)];
}

/** The user of the pinned Paketo run image (`IMAGES.paketoRun`), which a Buildpacks image runs as. */
export const BUILDPACKS_RUN_USER = "1002:1001";

/**
 * The seal's lines that make an app's SQLite folder ({@link sqliteFolder}) the app's user's, so
 * Docker gives a new volume on it that owner; none without SQLite. Buildpacks: the app's files
 * belong to the build user, so root makes the folder for the run image's user, which the image
 * runs as again. The user's own Dockerfile: `WORKDIR` makes the folder as the image's user, with
 * or without a shell in the image, and then returns to the app's folder; a folder the Dockerfile
 * already copies keeps its owner. (Railpack's seal adds it to its writable folders.)
 */
function sqliteSeal(plan: DeployPlan): string[] {
  const folder = sqliteFolder(plan);
  if (folder === undefined) return [];
  switch (plan.app.build?.builder) {
    case "buildpacks":
      return [
        "USER root",
        `RUN mkdir -p ${folder} && chown -R ${BUILDPACKS_RUN_USER} ${folder}`,
        `USER ${BUILDPACKS_RUN_USER}`,
      ];
    case "own-dockerfile":
      return [`WORKDIR ${folder}`, `WORKDIR ${appRoot(plan)}`];
    default:
      return [];
  }
}

/**
 * True when the build pushes a `build-<commit>` intermediate that a seal build turns into the
 * final image: Buildpacks, Railpack, and the user's own Dockerfile when the plan has cron jobs or
 * SQLite.
 */
export function sealsImage(plan: DeployPlan): boolean {
  const builder = plan.app.build?.builder;
  return (
    builder === "buildpacks" ||
    builder === "railpack" ||
    (builder === "own-dockerfile" && (hasCronJobs(plan) || plan.storage?.sqlite !== undefined))
  );
}

/**
 * `generated-dockerfile` and `own-dockerfile` (and a plan without a builder yet). OpsCrew's own
 * Dockerfile already holds supercronic when the plan has cron jobs, and the SQLite folder; the
 * user's own one builds `build-<commit>` instead, and the seal adds them.
 */
function dockerfileSteps(plan: DeployPlan): string[] {
  const source = [
    `context: ${JSON.stringify(plan.app.buildContext || ".")}`,
    `file: ${JSON.stringify(plan.app.dockerfile || "Dockerfile")}`,
  ];
  const values = [
    `build-args: ${secret(plan, DEPLOY_SECRETS.buildEnv)}`,
    `secrets: ${secret(plan, DEPLOY_SECRETS.buildSecrets)}`,
  ];
  if (!sealsImage(plan)) {
    const note = "# The provenance records build arguments: only non-secret values go there.";
    return finalBuild("Build and push the image", [...source, note, ...values], "");
  }
  return [
    "- id: own",
    "  name: Build the image from your Dockerfile",
    uses("buildPush"),
    "  with:",
    ...[...source, ...values].map((line) => `    ${line}`),
    "    push: true",
    `    tags: ${intermediateImage(plan)}`,
    "    provenance: false",
    "    cache-from: type=gha",
    "    cache-to: type=gha,mode=max",
    ...sealSteps(plan, "own", [...supercronicSeal(plan), ...sqliteSeal(plan)]),
  ];
}

/**
 * Writes the seal's Dockerfile, `FROM` the intermediate image by digest (`$BASE`), plus `extra`
 * lines, outside the checkout so that it stays clean for the provenance's commit.
 */
function sealSteps(plan: DeployPlan, digestOf: string, extra: readonly string[]): string[] {
  const lines = ['"FROM $BASE"', ...extra.map((line) => `'${line}'`)].join(" ");
  return [
    "- name: Write the seal Dockerfile",
    "  env:",
    `    BASE: ${intermediateImage(plan)}@\${{ steps.${digestOf}.outputs.digest }}`,
    ...run([
      "set -euo pipefail",
      'mkdir -p "$RUNNER_TEMP/seal"',
      `printf '%s\\n' ${lines} > "$RUNNER_TEMP/seal/Dockerfile"`,
    ]),
    ...finalBuild(
      "Seal and push the image",
      [
        "# The checkout is the context, so the provenance names its repository and commit; the",
        "# seal copies nothing from it.",
        'context: "."',
        "file: ${{ runner.temp }}/seal/Dockerfile",
      ],
      "scope=seal",
    ),
  ];
}

/**
 * Adds the `NAME=value` lines of `input` to the bash array `array` as `--env` arguments: `pair`
 * (`"$line"` for the whole line, `"${line%%=*}="` for the name only).
 */
function envPairs(array: string, input: string, pair = '"$line"'): string[] {
  return [
    "while IFS= read -r line; do",
    '  [[ -z "$line" || "$line" == \\#* ]] && continue',
    `  ${array}+=(--env ${pair})`,
    `done <<< ${input}`,
  ];
}

/**
 * On the environment's own runner, which may be macOS (bash 3.2, no `sha256sum`): sets the bash
 * array `sha256` to `sha256sum`, or to macOS's `shasum -a 256`.
 */
const PORTABLE_SHA256 =
  "if command -v sha256sum > /dev/null; then sha256=(sha256sum); else sha256=(shasum -a 256); fi";

/**
 * `"${name[@]}"`, the bash array `name` as arguments; on the environment's own runner in the form
 * bash 3.2 (macOS) accepts under `set -u` when the array is empty.
 */
function arrayArgs(plan: DeployPlan, name: string): string {
  return buildsOnRunner(plan) ? `\${${name}[@]+"\${${name}[@]}"}` : `"\${${name}[@]}"`;
}

/**
 * The wrapper that stands in for `tool` on a self-hosted runner that is not Linux: it runs the
 * tool's Linux build ({@link IMAGES}' `linuxTools`) through Docker, with the Docker socket and the
 * runner's work folder (the checkout and `$RUNNER_TEMP`) mounted at the paths this shell has
 * (Git Bash's `/c/…` on Windows, which Docker gets as `C:/…`, with `MSYS_NO_PATHCONV=1` so Git
 * Bash leaves the paths alone). It turns Windows paths in the arguments into those. pack reads
 * the job's registry login from the job's own Docker settings ({@link OWN_DOCKER_CONFIG}), which
 * hold it in the file, not in a credential store the container cannot read.
 */
function linuxToolWrapper(tool: "pack" | "railpack"): string[] {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'if [[ "$RUNNER_OS" == Windows ]]; then temp="$(cygpath -u "$RUNNER_TEMP")"; else temp="$RUNNER_TEMP"; fi',
    'work="$(dirname "$temp")"',
    'mount="$work"',
    'if [[ "$RUNNER_OS" == Windows ]]; then mount="$(cd "$work" && pwd -W)"; fi',
    "windows='^[A-Za-z]:[\\\\/]'",
    "args=()",
    'for arg in "$@"; do',
    '  if [[ "$RUNNER_OS" == Windows && "$arg" =~ $windows ]]; then arg="$(cygpath -u "$arg")"; fi',
    '  args+=("$arg")',
    "done",
    `MSYS_NO_PATHCONV=1 exec docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$mount:$work" -w "$(pwd)" -e DOCKER_CONFIG="$temp/docker" ${IMAGES.linuxTools.ref} "$temp/opscrew-linux/${tool}" \${args[@]+"\${args[@]}"}`,
  ];
}

/**
 * Installs the pinned release archive of `tool` (pack or Railpack) for the plan's
 * {@link buildArch} after checking it against the SHA-256 in pins.ts, never against a checksum from
 * the same release: into /usr/local/bin on GitHub's machines; on the environment's own runner,
 * whose user has no sudo, into the job's `$RUNNER_TEMP/bin`, which it adds to the job's `PATH`.
 * These are Linux builds: on a local runner that is not Linux (Windows or macOS)
 * `$RUNNER_TEMP/bin` gets {@link linuxToolWrapper} instead.
 */
function installTool(plan: DeployPlan, tool: "pack" | "railpack", name: string): string[] {
  const arch = buildArch(plan);
  const archive = `"$RUNNER_TEMP/${tool}.tar.gz"`;
  const binary = `"$(find "$RUNNER_TEMP/${tool}" -type f -name ${tool} | head -n 1)"`;
  const download = [
    `curl -fsSL --retry 3 -o ${archive} ${toolDownloadUrl(tool, arch)}`,
    `echo "${TOOLS[tool].sha256[arch]}  $RUNNER_TEMP/${tool}.tar.gz" | ${buildsOnRunner(plan) ? '"${sha256[@]}"' : "sha256sum"} -c -`,
    `mkdir -p "$RUNNER_TEMP/${tool}"`,
    // Git Bash's tar takes `C:\…` for a remote host's path: the own runner's uses relative paths.
    buildsOnRunner(plan)
      ? `(cd "$RUNNER_TEMP" && tar -xzf ${tool}.tar.gz -C ${tool})`
      : `tar -xzf ${archive} -C "$RUNNER_TEMP/${tool}"`,
  ];
  if (!buildsOnRunner(plan)) {
    return [
      `- name: Install ${name} ${TOOLS[tool].version}`,
      ...run([
        "set -euo pipefail",
        ...download,
        `sudo install -m 0755 ${binary} /usr/local/bin/${tool}`,
      ]),
    ];
  }
  const native = `install -m 0755 ${binary} "$RUNNER_TEMP/bin/${tool}"`;
  // A runner machine is Linux; the local runner's computer may not be.
  const local = plan.environment?.runner === "local";
  return [
    ...(local
      ? [
          `# ${name}'s Linux build. On a computer that is not Linux it runs in a pinned Linux container`,
          "# through Docker.",
        ]
      : []),
    `- name: Install ${name} ${TOOLS[tool].version}`,
    ...run([
      "set -euo pipefail",
      PORTABLE_SHA256,
      ...download,
      'mkdir -p "$RUNNER_TEMP/bin"',
      ...(local
        ? [
            'if [[ "$RUNNER_OS" == Linux ]]; then',
            `  ${native}`,
            "else",
            '  mkdir -p "$RUNNER_TEMP/opscrew-linux"',
            `  install -m 0755 ${binary} "$RUNNER_TEMP/opscrew-linux/${tool}"`,
            `  cat > "$RUNNER_TEMP/bin/${tool}" <<'WRAPPER'`,
            ...linuxToolWrapper(tool),
            "WRAPPER",
            `  chmod 0755 "$RUNNER_TEMP/bin/${tool}"`,
            "fi",
          ]
        : [native]),
      'echo "$RUNNER_TEMP/bin" >> "$GITHUB_PATH"',
    ]),
  ];
}

/**
 * Removes the secret files `.dockerignore` lists ({@link SECRET_FILE_PATTERNS}) from the checkout
 * of the build `context`, outside `node_modules` and `.git`, printing each path (never its
 * content): pack does not read `.dockerignore`, so they would end up in the image.
 */
function removeSecretFiles(context: string): string[] {
  const name = (pattern: string) => pattern.replace(/^!/, "").replace(/^\*\*\//, "");
  const unique = (patterns: string[]) => [...new Set(patterns.map(name))];
  const secret = unique(SECRET_FILE_PATTERNS.filter((pattern) => !pattern.startsWith("!")));
  const kept = unique(SECRET_FILE_PATTERNS.filter((pattern) => pattern.startsWith("!")));
  const names = secret.map((pattern) => `-name '${pattern}'`).join(" -o ");
  const keep = kept.map((pattern) => `! -name '${pattern}'`).join(" ");
  return [
    "- name: Keep secret files out of the Buildpacks build",
    ...run([
      "set -euo pipefail",
      "while IFS= read -r -d '' file; do",
      '  rm -f -- "$file"',
      '  echo "removed ${file#./} from the build: Buildpacks does not read .dockerignore"',
      `done < <(find ${context} \\( -name node_modules -o -name .git \\) -prune -o -type f \\( ${names} \\) ${keep} -print0)`,
    ]),
  ];
}

/**
 * Buildpacks: the secret files leave the checkout, then pack builds `build-<commit>` with the
 * version setting and the non-secret build values (`--env`), pushes it with its cache image (the
 * environment's own, `buildcache` or `buildcache-<env>`: {@link environmentTag}), and reports its
 * digest in `report.toml`; then the seal. pack has no secret mounts, so it never reads
 * the secret build values. pack uploads the whole context, where `.git` would keep every committed
 * file, the removed secret files too, so `.git` waits in `$RUNNER_TEMP` while pack runs; the trap
 * puts it back even when pack fails, before the seal, whose provenance reads it.
 */
function buildpacksSteps(plan: DeployPlan): string[] {
  const setting = versionSetting(plan, BUILDPACKS_VERSION_SETTING);
  const context = plan.app.buildContext || ".";
  return [
    ...installTool(plan, "pack", "pack"),
    ...removeSecretFiles(JSON.stringify(context)),
    "- id: pack",
    "  name: Build the image with Buildpacks",
    "  env:",
    "    NAME: ${{ steps.image.outputs.name }}",
    `    BUILD_ENV: ${secret(plan, DEPLOY_SECRETS.buildEnv)}`,
    ...run([
      "set -euo pipefail",
      "# pack uploads the whole folder. .git holds every committed file, the removed secret files",
      "# too, so it waits outside while pack runs, and is back for the seal's provenance.",
      `git_dir=${JSON.stringify(`${context}/.git`)}`,
      'if [[ -e "$git_dir" ]]; then',
      '  mv "$git_dir" "$RUNNER_TEMP/opscrew-git"',
      '  trap \'mv "$RUNNER_TEMP/opscrew-git" "$git_dir"\' EXIT',
      "fi",
      setting === undefined ? "settings=()" : `settings=(--env ${setting})`,
      ...envPairs("settings", '"${BUILD_ENV:-}"'),
      // pack writes a file instead when the folder is missing.
      'report="$RUNNER_TEMP/pack-report"',
      'mkdir -p "$report"',
      `pack build "$NAME:build-${environmentTag("$GITHUB_SHA", environmentName(plan))}" --path ${JSON.stringify(context)} \\`,
      `  --builder ${IMAGES.paketoBuilder.ref} \\`,
      `  --run-image ${IMAGES.paketoRun.ref} \\`,
      `  ${arrayArgs(plan, "settings")} --publish --cache-image "$NAME:${environmentTag("buildcache", environmentName(plan))}" --report-output-dir "$report"`,
      'digest="$(sed -nE \'s/^[[:space:]]*digest = "(sha256:[0-9a-f]{64})".*/\\1/p\' "$report/report.toml" | head -n 1)"',
      'if [[ -z "$digest" ]]; then',
      '  echo "::error::pack did not report the digest of the image it pushed; re-run the workflow."',
      "  exit 1",
      "fi",
      'echo "digest=$digest" >> "$GITHUB_OUTPUT"',
    ]),
    ...sealSteps(plan, "pack", [...supercronicSeal(plan), ...sqliteSeal(plan)]),
  ];
}

/**
 * Railpack: installs the pinned CLI (checksum from pins.ts), plans the build with the runtime
 * version, the non-secret build values and the names of the secret ones, and builds
 * `build-<commit>` with its frontend, all values as BuildKit secrets; then the seal, which gives
 * uid 10001 the framework's writable folders and the SQLite folder, and makes the image run as it.
 */
function railpackSteps(plan: DeployPlan): string[] {
  const context = JSON.stringify(plan.app.buildContext || ".");
  const language = plan.app.build?.runtime.language ?? "other";
  const sqlite = sqliteFolder(plan);
  const writable = [
    ...new Set([
      ...(RAILPACK_WRITABLE[language] ?? []).map((dir) => `/app/${dir}`),
      ...(sqlite === undefined ? [] : [sqlite]),
    ]),
  ];
  const setting = versionSetting(plan, RAILPACK_VERSION_SETTING);
  return [
    ...installTool(plan, "railpack", "Railpack"),
    "- id: prepare",
    "  name: Plan the Railpack build",
    "  env:",
    `    BUILD_ENV: ${secret(plan, DEPLOY_SECRETS.buildEnv)}`,
    `    BUILD_SECRETS: ${secret(plan, DEPLOY_SECRETS.buildSecrets)}`,
    ...run([
      "set -euo pipefail",
      "# The plan lists the names; the build reads the values as BuildKit secrets. Railpack",
      "# never sees a secret value here, only its name.",
      setting === undefined ? "values=()" : `values=(--env ${setting})`,
      ...envPairs("values", '"${BUILD_ENV:-}"'),
      ...envPairs("values", '"${BUILD_SECRETS:-}"', '"${line%%=*}="'),
      "for attempt in 1 2 3; do",
      "  code=0",
      `  railpack prepare ${context} --plan-out "$RUNNER_TEMP/railpack-plan.json" --info-out "$RUNNER_TEMP/railpack-info.json" ${arrayArgs(plan, "values")} || code=$?`,
      "  # 75 is a temporary failure, such as a download; anything else is final.",
      '  if [[ "$code" -ne 75 ]]; then break; fi',
      "  sleep 10",
      "done",
      'if [[ "$code" -ne 0 ]]; then',
      '  echo "::error::Railpack could not plan the build (exit code $code); its output above says why."',
      "  exit 1",
      "fi",
      // A new non-secret value changes the cache key, so it is not served from the cache.
      ...(buildsOnRunner(plan)
        ? [
            PORTABLE_SHA256,
            'echo "hash=$(printf \'%s\' "${BUILD_ENV:-}" | "${sha256[@]}" | cut -d \' \' -f 1)" >> "$GITHUB_OUTPUT"',
          ]
        : [
            'echo "hash=$(printf \'%s\' "${BUILD_ENV:-}" | sha256sum | cut -d \' \' -f 1)" >> "$GITHUB_OUTPUT"',
          ]),
    ]),
    "- id: railpack",
    "  name: Build the image with Railpack",
    uses("buildPush"),
    "  with:",
    `    context: ${context}`,
    "    file: ${{ runner.temp }}/railpack-plan.json",
    "    push: true",
    `    tags: ${intermediateImage(plan)}`,
    "    provenance: false",
    "    build-args: |",
    `      BUILDKIT_SYNTAX=${IMAGES.railpackFrontend.ref}`,
    "      secrets-hash=${{ steps.prepare.outputs.hash }}",
    "    # The frontend reads every value the plan lists as a secret, the runtime version too.",
    "    secrets: |",
    ...(setting === undefined ? [] : [`      ${setting}`]),
    `      ${secret(plan, DEPLOY_SECRETS.buildEnv)}`,
    `      ${secret(plan, DEPLOY_SECRETS.buildSecrets)}`,
    "    cache-from: type=gha,scope=railpack",
    "    cache-to: type=gha,mode=min,scope=railpack",
    ...sealSteps(plan, "railpack", [
      ...(writable.length === 0
        ? []
        : [
            `RUN mkdir -p ${writable.join(" ")} && chown -R ${RAILPACK_USER} ${writable.join(" ")}`,
          ]),
      ...(RAILPACK_SEAL[language] ?? []),
      ...supercronicSeal(plan),
      `USER ${RAILPACK_USER}`,
    ]),
  ];
}

/** Checks the final digest and records `<name>@<digest>` as `ref`, which every deploy uses. */
function record(plan: DeployPlan): string[] {
  const tag = environmentTag("$GITHUB_SHA", environmentName(plan));
  return [
    "- id: final",
    "  name: Record the image digest",
    "  env:",
    "    NAME: ${{ steps.image.outputs.name }}",
    "    DIGEST: ${{ steps.push.outputs.digest }}",
    ...run([
      "set -euo pipefail",
      'ref="$NAME@$DIGEST"',
      `if [[ ! "$ref" =~ ${DIGEST_REF_PATTERN} ]]; then`,
      '  echo "::error::Could not read the digest of the pushed image; re-run the workflow."',
      "  exit 1",
      "fi",
      'echo "ref=$ref" >> "$GITHUB_OUTPUT"',
      `echo "Pushed \\\`$NAME:${tag}\\\` as \\\`$ref\\\`." >> "$GITHUB_STEP_SUMMARY"`,
    ]),
  ];
}

/**
 * The report-only scan. On the environment's own runner the socket's path reaches Docker as it is
 * (`MSYS_NO_PATHCONV=1`: Git Bash on Windows would turn it into a Windows path).
 */
function scan(plan: DeployPlan): string[] {
  const noPathConv = buildsOnRunner(plan) ? "MSYS_NO_PATHCONV=1 " : "";
  return [
    "# The scan runs after the registry logout, so it never holds the job's packages: write token.",
    "- name: Scan the image (report only)",
    "  env:",
    "    IMAGE: ${{ steps.final.outputs.ref }}",
    ...run([
      "set -euo pipefail",
      'docker pull --quiet "$IMAGE"',
      "docker logout ghcr.io",
      // It only reports, so a scan that cannot run (Trivy's database out of reach) warns instead.
      `if ! ${noPathConv}docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ${IMAGES.trivy.ref} image --no-progress --severity HIGH,CRITICAL --exit-code 0 "$IMAGE"; then`,
      '  echo "::warning::The image scan (Trivy) could not run, so this build has no scan report. The deploy goes on: the scan only reports."',
      "fi",
    ]),
  ];
}

/**
 * The environment's own runner runs as a user who keeps Docker settings of their own (the local
 * runner's computer) or runs other environments' builds at once (a runner machine), so each build
 * job keeps its registry login (which the login action and the scan log out of again) and its
 * Buildx builder in Docker settings of its own, in its temp folder. It keeps the daemon the current
 * Docker context names (Docker Desktop's) and the user's CLI plugins (buildx). The settings start
 * with a ghcr.io entry: settings without any make docker log in to the computer's credential store
 * (the macOS keychain, Windows' credential manager), where the user's own login lives.
 */
const OWN_DOCKER_CONFIG = [
  "- name: Keep this job's Docker login and builder to itself",
  ...run([
    "set -euo pipefail",
    // Read with the user's settings, which hold the context.
    ...DOCKER_CONTEXT_HOST,
    'plugins="${DOCKER_CONFIG:-$HOME/.docker}/cli-plugins"',
    'mkdir -p "$RUNNER_TEMP/docker"',
    'if [[ -d "$plugins" ]]; then ln -s "$plugins" "$RUNNER_TEMP/docker/cli-plugins"; fi',
    `printf '{"auths":{"ghcr.io":{}}}\\n' > "$RUNNER_TEMP/docker/config.json"`,
    'echo "DOCKER_CONFIG=$RUNNER_TEMP/docker" >> "$GITHUB_ENV"',
  ]),
];

/**
 * The `build` job: builds the image with the plan's builder on a runner of the server's
 * architecture and pushes it to GHCR (`app.build` absent: the Dockerfile, as before). Buildpacks,
 * Railpack and, with cron jobs or SQLite, the user's own Dockerfile push
 * `<name>:build-<commit tag>` first, then a seal build, which adds supercronic when the plan has
 * cron jobs and makes the SQLite folder the app's user's ({@link sqliteSeal}). Every builder ends
 * in one `build-push-action` build with a mode=max provenance and an SBOM. Outputs: `image`, the final
 * index digest reference, and `tag`, `<name>:<commit tag>` (the commit for prod, `<commit>-<env>`
 * for another environment: {@link environmentTag}). Then the optional report-only scan.
 *
 * With `environment.build` `runner` it runs on the environment's own runner ({@link buildRunner}),
 * every step with bash, and with the same steps in forms macOS's bash 3.2 and Git Bash run; pack
 * and Railpack go into the job's temp folder, through Docker off Linux ({@link installTool}). It
 * first moves the Docker settings into the job's temp folder ({@link OWN_DOCKER_CONFIG}), and its
 * checkout keeps the job's token out of the runner's kept workspace.
 */
export function buildJob(plan: DeployPlan): string[] {
  const builder = plan.app.build?.builder;
  const steps =
    builder === "buildpacks"
      ? buildpacksSteps(plan)
      : builder === "railpack"
        ? railpackSteps(plan)
        : dockerfileSteps(plan);
  const own = buildsOnRunner(plan);
  return job({
    id: "build",
    name: "Build the image",
    runsOn: buildRunner(plan),
    shell: own ? "bash" : undefined,
    permissions: ["contents: read", "packages: write"],
    outputs: ["image: ${{ steps.final.outputs.ref }}", "tag: ${{ steps.image.outputs.image }}"],
    steps: [
      ...(own ? OWN_DOCKER_CONFIG : []),
      `- uses: ${ACTIONS.checkout}`,
      ...(own ? ["  with:", "    persist-credentials: false"] : []),
      ...imageName(plan),
      ...SETUP_BUILDX,
      ...GHCR_LOGIN,
      ...steps,
      ...record(plan),
      ...(plan.security.imageScan ? scan(plan) : []),
    ],
  });
}
