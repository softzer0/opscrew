import { posix } from "node:path";
import type { DeployPlan } from "@opscrew/plan-schema";

/**
 * The app's folder in its image, where the app runs, for the plan's builder:
 * - Buildpacks `/workspace` and Railpack `/app`, which build the app's folder;
 * - OpsCrew's generated Dockerfile `/app` (every generated runtime stage has `WORKDIR /app`);
 * - the user's own Dockerfile: its last stage's working directory, as detection read it
 *   (`app.build.workdir`).
 * An image built from the repository root holds the whole repository (a generated Node.js or
 * Next.js image, and Buildpacks and Railpack for a JavaScript workspace member), so an app in a
 * subfolder (the folder of its Dockerfile, `app.dockerfile`) runs from `<root>/<folder>`; a
 * generated Python image holds only the app's folder. Undefined when unknown: an own Dockerfile
 * without a known `WORKDIR`, or a plan without a builder yet. A folder OpsCrew gives the app,
 * such as a SQLite database's moved into a folder of its own, is `<appRoot>/<folder>`.
 */
export function appRoot(plan: {
  app: Pick<DeployPlan["app"], "build" | "dockerfile" | "buildContext">;
}): string | undefined {
  const { build, buildContext } = plan.app;
  const folder = posix.dirname(plan.app.dockerfile);
  const inFolder = (root: string) =>
    folder === "." || buildContext !== "." ? root : `${root}/${folder}`;
  switch (build?.builder) {
    case "buildpacks":
      return inFolder("/workspace");
    case "railpack":
      return inFolder("/app");
    case "generated-dockerfile":
      return build.runtime.language === "python" ? "/app" : inFolder("/app");
    case "own-dockerfile":
      return build.workdir;
    default:
      return undefined;
  }
}
