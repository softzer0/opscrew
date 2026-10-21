import type { CheckResult, CommandResult, CommandRunner } from "@opscrew/contracts";

/** The outside audits `opscrew secure --deep` runs. */
export type DeepTool = "lynis" | "ssh-audit" | "testssl";

/** Each tool's display name in the report. */
export const DEEP_TOOL_NAME: Readonly<Record<DeepTool, string>> = {
  lynis: "Lynis",
  "ssh-audit": "ssh-audit",
  testssl: "testssl.sh",
};

/**
 * The pins the deeper checks run from (the caller passes OpsCrew's `IMAGES` and `TOOLS`): images as
 * `repo:tag@sha256:<digest>`, Lynis as its release tarball.
 */
export interface DeepPins {
  /** The minimal image Lynis's throwaway container runs on the server (Alpine, with busybox). */
  lynisImage: string;
  lynis: { version: string; url: string; sha256: string };
  sshAudit: string;
  testssl: string;
}

/** One tool's run: its version, its results (noise marked) and, for Lynis, the hardening index. */
export interface DeepToolResult {
  tool: DeepTool;
  version: string;
  results: CheckResult[];
  hardeningIndex?: number;
}

/** Runs `docker` on the user's machine. */
export interface LocalDocker {
  run(args: readonly string[], options: { timeoutMs: number }): Promise<CommandResult>;
}

/** A {@link LocalDocker} over a command runner. */
export function localDocker(runner: CommandRunner): LocalDocker {
  return { run: (args, options) => runner.run("docker", args, options) };
}
