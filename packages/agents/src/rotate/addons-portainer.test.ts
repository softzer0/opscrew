// Feature 025 (T2511): `opscrew rotate portainer`, the admin password of the Portainer OpsCrew
// installed, changed through Portainer's API on the server (US8, FR-2511).
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { exists, OpsCrewError } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { portainerPasswordFile } from "../provision/own";
import { updateServerAddresses } from "../shared/server-record";
import { randomPassword } from "../shared/ssh-keys";
import { everythingShown, gitRemote } from "../snapshot/__fixtures__/world";
import {
  createTestPhaseDeps,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  type TestPhaseDeps,
  testPlan,
} from "../testing";
import { rotatePortainerPassword } from "./addons-portainer";
import { credentialsRecordFile } from "./record";

const NOW = new Date("2026-11-08T10:00:00.000Z");

/**
 * Portainer's API as `curl` reaches it on the server: the admin check, a login, the user, and the
 * password change, against the admin password in `$FAKE/password`. A shell function, so the script
 * finds it before any real curl.
 */
const FAKE_CURL = String.raw`curl() {
  method=GET; url=; fmt=; body=false
  while [ $# -gt 0 ]; do
    case "$1" in
      -X) method=$2; shift ;;
      -K|--data-binary) body=true; shift ;;
      -o|-H|--max-time) shift ;;
      -w) fmt=$2; shift ;;
      https://*) url=$1 ;;
    esac
    shift
  done
  input=''
  if [ "$body" = true ]; then input=$(cat | tr -d '\\'); fi
  echo "$method $url" >> "$FAKE/calls"
  printf '%s\n' "$input" >> "$FAKE/bodies"
  stored=$(cat "$FAKE/password")
  code=200
  case "$url" in
    */api/users/admin/check) code=204 ;;
    */api/auth)
      pw=$(printf '%s' "$input" | sed -n 's/.*"password":"\([^"]*\)".*/\1/p')
      if [ "$pw" = "$stored" ]; then printf '{"jwt":"tok"}'; else printf '{"message":"Invalid credentials"}'; fi ;;
    */api/users/me) printf '{"Id":1,"Username":"admin"}' ;;
    */api/users/1/passwd)
      cur=$(printf '%s' "$input" | sed -n 's/.*"password":"\([^"]*\)","newPassword".*/\1/p')
      new=$(printf '%s' "$input" | sed -n 's/.*"newPassword":"\([^"]*\)".*/\1/p')
      if [ "$cur" = "$stored" ]; then printf '%s' "$new" > "$FAKE/password"; code=204; else code=403; fi ;;
  esac
  if [ -n "$fmt" ]; then printf '%s' "$code"; fi
}
`;

/** The app's server: its commands run in a real `sh` with the fake Portainer API. */
class FakeServer {
  readonly commands: string[] = [];
  readonly inputs: string[] = [];
  offline = false;
  constructor(readonly dir: string) {}

  password(): Promise<string> {
    return readFile(join(this.dir, "password"), "utf8");
  }

  remote = (host: string): RemoteExec => ({
    host,
    run: (command, options) => {
      this.commands.push(command);
      this.inputs.push(options?.input ?? "");
      if (this.offline) {
        return Promise.resolve({ exitCode: 255, stdout: "", stderr: "ssh: connect: timed out" });
      }
      return new Promise<CommandResult>((resolve, reject) => {
        const child = spawn("sh", ["-c", `${FAKE_CURL}\n${command}`], {
          env: { ...process.env, FAKE: this.dir.replaceAll("\\", "/") },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
        child.stdin.end(options?.input ?? "");
      });
    },
  });
}

interface World {
  deps: TestPhaseDeps;
  plan: DeployPlan;
  handler: ScriptedApprovalHandler;
  server: FakeServer;
  current: string;
  run: () => ReturnType<typeof rotatePortainerPassword>;
}

/** Portainer on a cloud server, its admin password on this computer and in Portainer. */
async function world(answer?: ConstructorParameters<typeof ScriptedApprovalHandler>[0]) {
  const handler = new ScriptedApprovalHandler(answer ?? (() => true));
  const deps = await createTestPhaseDeps({
    approvalHandler: handler,
    runner: gitRemote(),
    clock: { now: () => NOW },
  });
  const plan = DeployPlanSchema.parse({
    ...testPlan({ deployed: true }),
    portainer: { enabled: true, version: "2.33.1", access: "local" },
  });
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    deployment: { ipv4: SERVER_IPV4 },
  }));
  const current = randomPassword(32);
  const file = portainerPasswordFile(deps.paths);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${current}\n`);
  const server = new FakeServer(await mkdtemp(join(deps.paths.root, "portainer-")));
  await writeFile(join(server.dir, "password"), current);
  const w: World = {
    deps,
    plan,
    handler,
    server,
    current,
    run: () => rotatePortainerPassword(deps, plan, { remote: server.remote }),
  };
  return w;
}

const local = async (w: World) =>
  (await readFile(portainerPasswordFile(w.deps.paths), "utf8")).trim();
const nextFile = (w: World) => `${portainerPasswordFile(w.deps.paths)}.next`;

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** Nothing printed, audited, asked, thrown or on a server's command line holds any of `values`. */
function expectNoValue(w: World, values: readonly string[], error?: unknown): void {
  const said = [everythingShown(w, error), ...w.server.commands].join("\n");
  for (const value of values) expect(said).not.toContain(value);
}

describe("rotatePortainerPassword", () => {
  it("sets a new admin password through Portainer's API on the server, then keeps it here", async () => {
    const w = await world();
    const result = await w.run();
    const next = await local(w);
    expect(next).not.toBe(w.current);
    expect(next).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(await w.server.password()).toBe(next);
    expect(await exists(nextFile(w))).toBe(false);
    // Both passwords reached the server only on the session's standard input.
    expect(w.server.inputs).toEqual([`${w.current}\n${next}\n`]);
    const calls = await readFile(join(w.server.dir, "calls"), "utf8");
    expect(calls.trim().split("\n")).toEqual([
      "GET https://127.0.0.1:9443/api/users/admin/check",
      "POST https://127.0.0.1:9443/api/auth",
      "GET https://127.0.0.1:9443/api/users/me",
      "PUT https://127.0.0.1:9443/api/users/1/passwd",
    ]);
    const [request] = w.handler.requests;
    expect(request).toMatchObject({ kind: "remote-exec", planHash: result.hash });
    const record = await readArtifact("credentials", credentialsRecordFile(w.deps.paths));
    expect(record.environments.prod?.portainer).toEqual({
      rotatedAt: NOW.toISOString(),
      generation: 2,
    });
    expectNoValue(w, [w.current, next]);
  });

  it("finishes a rotation whose password Portainer already took", async () => {
    const w = await world();
    const next = randomPassword(32);
    await writeFile(nextFile(w), `${next}\n`);
    await writeFile(join(w.server.dir, "password"), next);
    await w.run();
    expect(await local(w)).toBe(next);
    expect(await exists(nextFile(w))).toBe(false);
    const calls = await readFile(join(w.server.dir, "calls"), "utf8");
    expect(calls).not.toContain("PUT");
  });

  it("keeps both passwords when Portainer refuses the current one or the server does not answer", async () => {
    const w = await world();
    await writeFile(join(w.server.dir, "password"), randomPassword(32));
    const error = await failure(w.run());
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toContain("Portainer did not accept the admin password OpsCrew keeps.");
    expect(error.hint).toBe("Fix what it names, then run `opscrew rotate portainer` again.");
    expect(await local(w)).toBe(w.current);
    const kept = (await readFile(nextFile(w), "utf8")).trim();

    w.server.offline = true;
    const silent = await failure(w.run());
    expect(silent.message).toContain("did not answer over SSH");
    // The run after a failure goes on with the same new password, so its plan has the same hash.
    expect(w.handler.requests[1]?.planHash).toBe(w.handler.requests[0]?.planHash);
    expect((await readFile(nextFile(w), "utf8")).trim()).toBe(kept);
    expectNoValue(w, [w.current, kept], error);
  });

  it("changes nothing when the plan is not approved, and a run again asks the same hash", async () => {
    const refused = await world([false, true]);
    expect((await failure(refused.run())).code).toBe("APPROVAL_REFUSED");
    expect(refused.server.commands).toEqual([]);
    expect(await refused.server.password()).toBe(refused.current);
    expect(await local(refused)).toBe(refused.current);
    // The new password waits on this computer only (0600), so the next run asks the same hash.
    const kept = (await readFile(nextFile(refused), "utf8")).trim();
    await refused.run();
    const [first, second] = refused.handler.requests;
    expect(second?.planHash).toBe(first?.planHash);
    expect(await refused.server.password()).toBe(kept);
    expect(await local(refused)).toBe(kept);
    expect(await exists(nextFile(refused))).toBe(false);
  });

  it("refuses without Portainer", async () => {
    const none = await world();
    const plan = DeployPlanSchema.parse({ ...none.plan, portainer: undefined });
    expect(
      await failure(rotatePortainerPassword(none.deps, plan, { remote: none.server.remote })),
    ).toMatchObject({ code: "INVALID_INPUT" });
  });
});
