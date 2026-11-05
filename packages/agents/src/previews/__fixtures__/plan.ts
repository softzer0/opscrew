import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ApprovalRequest, RemoteExec } from "@opscrew/contracts";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { updateServerAddresses } from "../../shared";
import {
  createProject,
  createTestPhaseDeps,
  PREVIEW_ZONE,
  previewTestPlan,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  type TestPhaseDeps,
  testPlan,
} from "../../testing";

/** A commit and a digest the preview command lists. */
export const COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const DIGEST = `sha256:${"ab".repeat(32)}`;

/** The hosts of previews 42 and 7 in the preview zone, as the server lists them. */
export const HOST_42 = `pr-42-a1b2c3d4e5.${PREVIEW_ZONE}`;
export const HOST_7 = `pr-7-f6g7h8i9j0.${PREVIEW_ZONE}`;

/**
 * The preview command's `list` answer: previews 42 (running, created 2026-10-10, updated
 * 2026-10-11) and 7 (failed, 2026-10-10), cap 3, each with its address.
 */
export const LIST_OUTPUT = [
  `42 running ${COMMIT} 1791590400 1791676800 ${DIGEST} ${HOST_42}`,
  `7 failed ${COMMIT} 1791590400 1791590400 ${DIGEST} ${HOST_7}`,
  "opscrew-preview: listed 2/3",
].join("\n");

/** A fake deploy shell: `answer` gets each command; the commands run are kept in `commands`. */
export function fakeShell(
  answer: (command: string) => { exitCode: number; stdout: string; stderr?: string },
): { commands: string[]; remote: (host: string) => RemoteExec } {
  const commands: string[] = [];
  return {
    commands,
    remote: (host) => ({
      host,
      run: async (command) => {
        commands.push(command);
        return { stderr: "", ...answer(command) };
      },
    }),
  };
}

/**
 * A project (git, prod's plan) with the preview environment's plan, its server's address and its
 * deploy key on this computer, and deps for that environment. `answer` decides approvals.
 */
export async function previewProject(
  options: {
    own?: boolean;
    answer?: boolean[] | ((request: ApprovalRequest) => boolean);
    env?: Record<string, string | undefined>;
  } = {},
): Promise<{ deps: TestPhaseDeps; plan: DeployPlan; root: string }> {
  const plan = previewTestPlan(options);
  const project = await createProject(testPlan({ deployed: true }));
  const deps = await createTestPhaseDeps({
    root: project.root,
    environment: "preview",
    env: { OPSCREW_HOME: join(project.root, ".home-opscrew"), ...options.env },
    ...(options.answer !== undefined
      ? { approvalHandler: new ScriptedApprovalHandler(options.answer) }
      : {}),
  });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    deployment: { ipv4: SERVER_IPV4 },
  }));
  await mkdir(dirname(deps.paths.files.deployKey), { recursive: true });
  // Only its presence matters: the fake shell never reads it.
  await writeFile(deps.paths.files.deployKey, "placeholder\n");
  return { deps, plan, root: project.root };
}
