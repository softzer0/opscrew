// Feature 025 (T2505): the rotation record, the values' generations and the two-computer guard.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { appPaths } from "../apps/list";
import { generatedValuesFile, recordGeneratedEntries } from "../shared/app-secrets";
import { createTestPhaseDeps } from "../testing";
import {
  assertValuesCurrent,
  credentialsRecordFile,
  keepValueGenerations,
  readCredentialsRecord,
  recordRotation,
} from "./record";
import { tokenDatesFile, tokenFirstSeen } from "./record-tokens";

const NOW = new Date("2026-11-08T10:00:00.000Z");
const clock = { now: () => NOW };

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("the rotation record", () => {
  it("is opscrew/credentials.yaml for the first app, beside a further app's prod plan for it", async () => {
    const deps = await createTestPhaseDeps({ environment: "staging" });
    expect(credentialsRecordFile(deps.paths)).toBe(
      join(deps.paths.root, "opscrew", "credentials.yaml"),
    );
    const further = appPaths(deps.paths, "admin", "staging");
    expect(credentialsRecordFile(further)).toBe(
      join(deps.paths.root, "opscrew", "apps", "admin", "credentials.yaml"),
    );
  });

  it("reads as empty without the file", async () => {
    const deps = await createTestPhaseDeps();
    expect(await readCredentialsRecord(deps)).toEqual({ schemaVersion: 1, environments: {} });
  });

  it("records a rotation: rotatedAt, one generation more, madeAt kept, other entries kept", async () => {
    const deps = await createTestPhaseDeps({ clock });
    const file = credentialsRecordFile(deps.paths);
    await writeArtifact("credentials", file, {
      schemaVersion: 1,
      environments: {
        prod: {
          db: { madeAt: "2026-01-02T03:04:05.000Z", generation: 1 },
          cache: { rotatedAt: "2026-05-01T00:00:00.000Z", generation: 3 },
          "deploy-key": { generation: 1 },
        },
        staging: { db: { generation: 2 } },
      },
    });
    const written = await recordRotation(deps, ["db", "cache", "app:APP_KEY"]);
    const read = await readArtifact("credentials", file);
    expect(read).toEqual(written);
    expect(read.environments).toEqual({
      prod: {
        db: { madeAt: "2026-01-02T03:04:05.000Z", rotatedAt: NOW.toISOString(), generation: 2 },
        cache: { rotatedAt: NOW.toISOString(), generation: 4 },
        "deploy-key": { generation: 1 },
        // Made before the record had it: its first value was generation 1.
        "app:APP_KEY": { rotatedAt: NOW.toISOString(), generation: 2 },
      },
      staging: { db: { generation: 2 } },
    });
  });

  it("starts the file for an environment it does not have yet", async () => {
    const deps = await createTestPhaseDeps({ clock, environment: "staging" });
    await recordRotation(deps, ["network"]);
    expect(await readCredentialsRecord(deps)).toEqual({
      schemaVersion: 1,
      environments: { staging: { network: { rotatedAt: NOW.toISOString(), generation: 2 } } },
    });
  });
});

describe("the values' generations beside the generated values", () => {
  it("are kept with every other generated value, and the environment's own file gets them", async () => {
    const deps = await createTestPhaseDeps({ clock });
    const password = fakeSecret("generic-password", "grant");
    await recordGeneratedEntries(deps, "grants", { "laptop/cache": password });
    await keepValueGenerations(deps, { cache: 2 });
    await recordRotation(deps, ["db"]);
    const json = JSON.parse(await readFile(generatedValuesFile(deps), "utf8"));
    expect(json).toEqual({
      grants: { "laptop/cache": password },
      generations: { cache: 2, db: 2 },
    });

    // Another environment's rotation marks that environment's values, not prod's.
    const staging = await createTestPhaseDeps({
      clock,
      root: deps.paths.root,
      env: deps.env,
      environment: "staging",
    });
    await recordRotation(staging, ["db"]);
    const stagingJson = JSON.parse(await readFile(generatedValuesFile(staging), "utf8"));
    expect(stagingJson).toEqual({ generations: { db: 2 } });
    expect(JSON.parse(await readFile(generatedValuesFile(deps), "utf8")).generations).toEqual({
      cache: 2,
      db: 2,
    });
  });

  it("never write into damaged generated values", async () => {
    const deps = await createTestPhaseDeps();
    await mkdir(deps.paths.projectHomeDir, { recursive: true });
    await writeFile(generatedValuesFile(deps), "{not json");
    const error = await failure(keepValueGenerations(deps, { db: 2 }));
    expect(error.code).toBe("ARTIFACT_INVALID");
    expect(await readFile(generatedValuesFile(deps), "utf8")).toBe("{not json");
  });
});

describe("assertValuesCurrent, the two-computer guard", () => {
  it("passes without a record, and on the computer that rotated", async () => {
    const deps = await createTestPhaseDeps({ clock });
    await assertValuesCurrent(deps);
    await recordRotation(deps, ["db", "deploy-key"]);
    await recordRotation(deps, ["db"]);
    await assertValuesCurrent(deps);
  });

  it("stops another computer whose values are older, naming them and `opscrew secrets restore`", async () => {
    const rotated = await createTestPhaseDeps({ clock });
    await recordRotation(rotated, ["db", "deploy-key"]);
    // The same repository on a computer whose generated values were never rotated.
    const other = await createTestPhaseDeps({
      root: rotated.paths.root,
      env: { OPSCREW_HOME: join(rotated.paths.root, ".other-home") },
    });
    await recordGeneratedEntries(other, "grants", {
      "laptop/cache": fakeSecret("generic-password", "grant"),
    });
    const error = await failure(assertValuesCurrent(other));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "This computer has older values of db, deploy-key for the prod environment than opscrew/credentials.yaml records: another computer rotated them, and going on from here would put the old values back. Nothing was changed.",
    );
    expect(error.hint).toBe(
      "Run `opscrew secrets restore` to bring the current values from the recovery copy, then run the command again.",
    );

    // After a restore the values carry the generations; one still behind is named alone.
    await keepValueGenerations(other, { db: 2 });
    const one = await failure(assertValuesCurrent(other));
    expect(one.message).toContain("older values of deploy-key for the prod environment");
    expect(one.message).toContain(
      "rotated it, and going on from here would put the old value back",
    );
    await keepValueGenerations(other, { "deploy-key": 2 });
    await assertValuesCurrent(other);
  });

  it("looks only at its own environment and never at the user's tokens", async () => {
    const deps = await createTestPhaseDeps();
    await writeArtifact("credentials", credentialsRecordFile(deps.paths), {
      schemaVersion: 1,
      environments: {
        prod: { hetzner: { generation: 3 }, github: { generation: 2 }, db: { generation: 1 } },
        staging: { db: { generation: 5 } },
      },
    });
    await assertValuesCurrent(deps);
  });
});

describe("tokenFirstSeen", () => {
  it("records a token's fingerprint and date the first time (0600), never its value", async () => {
    let now = new Date("2026-11-01T00:00:00.000Z");
    const deps = await createTestPhaseDeps({ clock: { now: () => now } });
    const token = fakeSecret("hcloud-token");
    expect(await tokenFirstSeen(deps, "hetzner", token)).toBe("2026-11-01T00:00:00.000Z");
    now = new Date("2026-11-08T00:00:00.000Z");
    expect(await tokenFirstSeen(deps, "hetzner", token)).toBe("2026-11-01T00:00:00.000Z");

    const file = tokenDatesFile(deps.paths);
    expect(file).toBe(join(deps.paths.homeDir, "token-dates.json"));
    const text = await readFile(file, "utf8");
    expect(text).not.toContain(token);
    expect(Object.keys(JSON.parse(text).hetzner)).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("dates a new token of the same name from when it is first seen, keeping the other's date", async () => {
    let now = new Date("2026-11-01T00:00:00.000Z");
    const deps = await createTestPhaseDeps({ clock: { now: () => now } });
    const first = fakeSecret("hcloud-token");
    const second = fakeSecret("hcloud-token", "second");
    await tokenFirstSeen(deps, "hetzner", first);
    now = new Date("2026-11-08T00:00:00.000Z");
    expect(await tokenFirstSeen(deps, "hetzner", second)).toBe("2026-11-08T00:00:00.000Z");
    expect(await tokenFirstSeen(deps, "github", first)).toBe("2026-11-08T00:00:00.000Z");
    expect(await tokenFirstSeen(deps, "hetzner", first)).toBe("2026-11-01T00:00:00.000Z");
  });

  it("starts a damaged file again", async () => {
    const deps = await createTestPhaseDeps();
    await mkdir(deps.paths.homeDir, { recursive: true });
    await writeFile(tokenDatesFile(deps.paths), "[1, 2]");
    expect(await tokenFirstSeen(deps, "ntfy", fakeSecret("generic-password", "ntfy"))).toBe(
      deps.clock.now().toISOString(),
    );
  });
});
