/**
 * An app's environments (feature 015): the choice of environment, `env add`, `env set`,
 * `env list` and `env remove`, the branches each follows (FR-1537), the shared parts, which follow
 * the image (an environment's own design when it builds, its source's plan when it is promoted,
 * FR-1539), and the environment's own answers and paths.
 */
export {
  type AddEnvironmentOptions,
  type AddEnvironmentResult,
  addEnvironment,
  type EnvironmentQuestion,
  type EnvironmentQuestionId,
  environmentQuestions,
} from "./add";
export { setEnvironmentBranch } from "./branches";
export { type EnvironmentChoiceDeps, environmentFlag, resolveEnvironment } from "./choice";
export { type EnvironmentSummary, environmentDeployed, listEnvironments } from "./list";
export { environmentPaths } from "./paths";
export { removeEnvironment } from "./remove";
export { readEnvironmentRequirements } from "./requirements";
export {
  type RunnerAnswer,
  type RunnerChoice,
  requireMachineFits,
  runnerChoice,
  setEnvironmentRunner,
} from "./runner";
export { type EnvironmentSettings, setEnvironment } from "./set";
export { requireSharedParts, sharedPartsDiffer, withSharedParts } from "./shared-parts";
export { type DeploySource, setDeploySource } from "./source";
