/**
 * @opscrew/detect: deterministic repository analysis. Lists project files (gitignore-aware),
 * reads git metadata without a git binary and detects frameworks, app kind, build/start
 * commands, port, environment variables, services, builder platform and Docker files.
 * All paths are repo-relative POSIX paths on every platform.
 */
export { normalizeAppDir } from "./app-dir";
export {
  type DetectOptions,
  detectProject,
  detectProjectDetails,
  type ProjectDetection,
} from "./detect";
export {
  CLIENT_EXPOSED_PREFIXES,
  extractEnvReferences,
  isClientExposed,
  isEnvExampleFile,
  isSecretLikely,
  parseEnvExampleKeys,
} from "./env";
export {
  type ListProjectFilesOptions,
  listProjectFiles,
  type ProjectFileList,
  SKIPPED_DIRECTORIES,
} from "./files";
export { type GitRemote, parseGitRemote, readGitInfo } from "./git";
export {
  BUILT_IN_HEALTH_FILES,
  builtInHealthEndpoint,
  type NestGlobalPrefix,
  nestGlobalPrefix,
  nestRoutePath,
} from "./sources";
