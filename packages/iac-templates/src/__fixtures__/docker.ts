import { spawnSync } from "node:child_process";

/** The PHP base of the tests on Docker: Composer's image, PHP on Alpine. */
export const COMPOSER_IMAGE =
  "composer:2@sha256:8de2184c6de224f4689e8f80ed5f5edaf0030b6b8b7839a22a2bcb6722ac87d0";

/** Whether the local Docker has the image `ref`. */
export function hasImage(ref: string): boolean {
  return spawnSync("docker", ["image", "inspect", ref], { stdio: "ignore" }).status === 0;
}

/** What {@link docker} runs with: its folder, its stdin, its environment and its time limit. */
export interface DockerOptions {
  cwd?: string;
  input?: string;
  /** Replaces this process's environment; by default it, without Git Bash's path conversion. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Runs `docker args` for the tests on Docker and returns its output, trimmed; a failure throws with
 * the end of its output.
 */
export function docker(args: string[], o: DockerOptions = {}): string {
  const result = spawnSync("docker", args, {
    cwd: o.cwd,
    input: o.input,
    env: o.env ?? { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
    encoding: "utf8",
    timeout: o.timeoutMs ?? 1_800_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`.slice(-6000);
    throw new Error(`docker ${args.join(" ")} failed (${result.status ?? result.signal}):\n${output}`);
  }
  return result.stdout.trim();
}
