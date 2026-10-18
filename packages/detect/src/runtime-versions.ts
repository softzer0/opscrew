import type { ProjectFacts } from "@opscrew/plan-schema";
import { parseJson, parseTomlSafe, type ReadText } from "./manifests";
import { depthOf } from "./paths";

type RuntimeVersions = ProjectFacts["runtimeVersions"];

/** First line that is neither empty nor a `#` comment, trimmed. */
export function firstLine(text: string | undefined): string | undefined {
  const line = text
    ?.split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#"));
  return line || undefined;
}

/** The first capture of `pattern` in `text`, trimmed. */
function capture(text: string | undefined, pattern: RegExp): string | undefined {
  return pattern.exec(text ?? "")?.[1]?.trim() || undefined;
}

function rustChannel(text: string | undefined): string | undefined {
  const toml = parseTomlSafe(text);
  const toolchain = toml?.toolchain as { channel?: unknown } | undefined;
  return typeof toolchain?.channel === "string" ? toolchain.channel : undefined;
}

function composerPhp(text: string | undefined): string | undefined {
  const php = (parseJson(text) as { require?: { php?: unknown } } | undefined)?.require?.php;
  return typeof php === "string" && php.trim() !== "" ? php.trim() : undefined;
}

/**
 * The text of the app's .NET project among `projects`: the shallowest, preferring a web project
 * (`Sdk="Microsoft.NET.Sdk.Web"`) and else skipping `*.Tests.csproj` among projects equally deep.
 */
async function dotnetProjectText(
  projects: readonly string[],
  read: ReadText,
): Promise<string | undefined> {
  const shallowest = Math.min(...projects.map(depthOf));
  const tied = projects.filter((path) => depthOf(path) === shallowest).sort();
  const texts = await Promise.all(tied.map(async (path) => ({ path, text: await read(path) })));
  return (
    texts.find(({ text }) => /\bSdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"/.test(text ?? "")) ??
    texts.find(({ path }) => !path.endsWith(".Tests.csproj")) ??
    texts[0]
  )?.text;
}

/**
 * The Ruby, Go, Java, .NET, PHP and Rust versions the app declares, as written. `find` gives the
 * path of a file by name in the app's folder or the repository root, nearest first;
 * `dotnetProjects` are the `.csproj` files in the app's folder.
 */
export async function declaredRuntimeVersions(
  find: (name: string) => string | undefined,
  read: ReadText,
  dotnetProjects: readonly string[],
): Promise<Omit<RuntimeVersions, "node" | "python">> {
  const text = async (name: string) => {
    const path = find(name);
    return path === undefined ? undefined : read(path);
  };
  const versions: Omit<RuntimeVersions, "node" | "python"> = {};

  const ruby =
    firstLine(await text(".ruby-version")) ??
    capture(await text("Gemfile"), /^\s*ruby\s+["']([^"']+)["']/m);
  if (ruby) versions.ruby = ruby;

  const goMod = await text("go.mod");
  const go = capture(goMod, /^toolchain\s+go(\S+)/m) ?? capture(goMod, /^go\s+(\S+)/m);
  if (go) versions.go = go;

  // Only literal versions count: a `${java.version}` reference falls back to the property itself.
  const pom = (await text("pom.xml"))?.replace(/<!--[\s\S]*?-->/g, "");
  const java =
    capture(pom, /<maven\.compiler\.release>\s*(\d[^<]*)</) ??
    capture(pom, /<java\.version>\s*(\d[^<]*)</) ??
    capture(
      (await text("build.gradle.kts")) ?? (await text("build.gradle")),
      /JavaLanguageVersion\.of\(\s*["']?(\d+)/,
    );
  if (java) versions.java = java;

  const dotnet =
    dotnetProjects.length === 0
      ? undefined
      : capture(
          await dotnetProjectText(dotnetProjects, read),
          /<TargetFramework>\s*net(\d+\.\d+)\s*</,
        );
  if (dotnet) versions.dotnet = dotnet;

  const php = composerPhp(await text("composer.json"));
  if (php) versions.php = php;

  const legacyToolchain = await text("rust-toolchain");
  const rust =
    rustChannel(await text("rust-toolchain.toml")) ??
    rustChannel(legacyToolchain) ??
    firstLine(legacyToolchain);
  if (rust) versions.rust = rust;

  return versions;
}
