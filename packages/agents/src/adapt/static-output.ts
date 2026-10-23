import type { SiteDetection } from "@opscrew/detect";
import type { ServerlessProvider } from "@opscrew/plan-schema";
import { frameworkName } from "../analyze/summary";
import { serverlessName } from "../shared";

/** The folder each static site framework's build writes by default, relative to the site's. */
const DEFAULT_OUTPUT: Readonly<Record<string, (dir: string) => boolean>> = {
  astro: (dir) => dir === "dist",
  vite: (dir) => dir === "dist",
  "create-react-app": (dir) => dir === "build",
  angular: (dir) => dir === "dist" || dir.startsWith("dist/"),
  hugo: (dir) => dir === "public",
  nuxt: (dir) => dir === ".output/public",
  sveltekit: (dir) => dir === "build",
  next: (dir) => dir === "out",
};

/**
 * The note for a static site whose published folder (`outputDir`, from the plan) is not where its
 * framework's build writes by default, or undefined: a static site needs no code change, but a
 * folder set elsewhere is worth a look.
 */
export function staticOutputNote(
  site: SiteDetection,
  outputDir: string,
  provider: ServerlessProvider,
): string | undefined {
  const { framework } = site;
  const usual = framework === undefined ? undefined : DEFAULT_OUTPUT[framework];
  if (framework === undefined || usual === undefined || usual(outputDir)) return undefined;
  return `The site needs no code change. ${serverlessName(provider)} publishes ${outputDir} (target.site.outputDir in opscrew/plan.yaml), which is not where a ${frameworkName(framework)} build writes by default: check that the app's build writes there.`;
}
