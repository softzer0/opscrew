/**
 * @opscrew/detect: deterministic repository analysis. Lists project files (gitignore-aware),
 * reads git metadata without a git binary and detects frameworks, app kind, build/start
 * commands, port, environment variables, services (self-hostable and hosted), workers, cron jobs,
 * SQLite files, object storage, builder platform and Docker files, the local workspace packages
 * the app's build uses, and the site a server-less target publishes (`detectSite`).
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
  type CloudflareAdapter,
  type CloudflareFramework,
  detectSite,
  type NextWorkersOption,
  type SiteDetection,
} from "./site";
export {
  BUILT_IN_HEALTH_FILES,
  builtInHealthEndpoint,
  type NestGlobalPrefix,
  nestGlobalPrefix,
  nestRoutePath,
} from "./sources";
