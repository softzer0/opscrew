import { OFFSITE_KEY_VARS, STORAGE_KEY_VARS } from "@opscrew/agents";
import { IMAGES } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { ServerContainer } from "./components-support";
import {
  AGE_HEADER,
  addressesInSnapshotOutputs,
  bucketObjectProblems,
  changeScripts,
  differingServices,
  KAFKA_READ_SCRIPT,
  kafkaDigest,
  kafkaMessages,
  kafkaSeedScript,
  listedSnapshots,
  objectContentProblems,
  offsiteKey,
  offsiteSkip,
  onTheHour,
  rcloneDockerArgs,
  rcloneSettings,
  restartedServices,
  servicesIn,
  shownRestore,
  takenSnapshotId,
  withSnapshotServices,
} from "./snapshots-support";

const HASH = "a".repeat(64);

describe("offsiteSkip", () => {
  it("runs R2 only once its account has R2", () => {
    expect(offsiteSkip({}, "r2")).toContain("OPSCREW_E2E_R2=1");
    expect(offsiteSkip({ OPSCREW_E2E_R2: "1" }, "r2")).toBeUndefined();
  });

  it("runs Hetzner with both key variables in a region with Object Storage", () => {
    const key = {
      OPSCREW_E2E_HETZNER_S3_ACCESS_KEY_ID: "id",
      OPSCREW_E2E_HETZNER_S3_SECRET_ACCESS_KEY: "secret",
    };
    expect(offsiteSkip({ OPSCREW_E2E_HETZNER_S3_ACCESS_KEY_ID: "id" }, "hetzner")).toBe(
      "set OPSCREW_E2E_HETZNER_S3_SECRET_ACCESS_KEY",
    );
    expect(offsiteSkip(key, "hetzner")).toBeUndefined();
    expect(offsiteSkip({ ...key, OPSCREW_E2E_REGION: "us-east" }, "hetzner")).toContain(
      "not in OPSCREW_E2E_REGION=us-east",
    );
  });
});

describe("offsiteKey", () => {
  it("gives the bucket's key and the same key under the off-server copies' variables", () => {
    const got = offsiteKey({
      [STORAGE_KEY_VARS.accessKeyId]: "access",
      [STORAGE_KEY_VARS.secretAccessKey]: "secret",
    });
    expect(got.key).toEqual({ accessKeyId: "access", secretAccessKey: "secret" });
    expect(got.env).toEqual({
      [OFFSITE_KEY_VARS.accessKeyId]: "access",
      [OFFSITE_KEY_VARS.secretAccessKey]: "secret",
    });
  });

  it("throws without both halves", () => {
    expect(() => offsiteKey({ [STORAGE_KEY_VARS.accessKeyId]: "access" })).toThrow(/no access/);
  });
});

describe("withSnapshotServices", () => {
  const plan = { services: [] } as unknown as DeployPlan;
  const names = (p: DeployPlan) => p.services.map((service) => service.name);

  it("adds feature 023's services, and Kafka when asked, once", () => {
    expect(names(withSnapshotServices(plan, false))).toEqual(["db", "mysql", "queue"]);
    const withKafka = withSnapshotServices(plan, true);
    expect(names(withKafka)).toEqual(["db", "mysql", "queue", "kafka"]);
    expect(withKafka.services.at(-1)?.kind).toBe("kafka");
    expect(names(withSnapshotServices(withKafka, true))).toEqual(names(withKafka));
  });
});

describe("the data scripts", () => {
  it("changes a row in both databases with a plain marker only", () => {
    const changes = changeScripts("changed-run1");
    expect(changes.postgres).toContain("delete from opscrew_e2e_rows where id = 1");
    expect(changes.postgres).toContain("values (1001, 'changed-run1')");
    expect(changes.mysql).toContain('MYSQL_PWD="$MYSQL_PASSWORD"');
    expect(() => changeScripts("it's")).toThrow(/not plain/);
  });

  it("writes Kafka's messages into one topic, made when missing", () => {
    const messages = kafkaMessages("run1", "a", 2);
    expect(messages).toEqual(["e2e-kafka-run1-a1", "e2e-kafka-run1-a2"]);
    const script = kafkaSeedScript(messages);
    expect(script).toContain("--create --if-not-exists --topic opscrew-e2e --partitions 1");
    expect(script).toContain("printf '%s\\n' e2e-kafka-run1-a1 e2e-kafka-run1-a2 |");
    expect(() => kafkaSeedScript(["a b"])).toThrow(/not plain/);
    expect(() => kafkaSeedScript([])).toThrow(/No messages/);
  });

  it("reads exactly the topic's end offset of messages", () => {
    expect(KAFKA_READ_SCRIPT).toContain('--max-messages "$n"');
    const digest = kafkaDigest("count 2\nm1\nm2\n");
    expect(digest).toMatch(/^2:[0-9a-f]{64}$/);
    expect(kafkaDigest("count 2\nm1\nm2")).toBe(digest);
    expect(kafkaDigest("count 2\nm2\nm1")).not.toBe(digest);
    expect(kafkaDigest("count 0\n")).toMatch(/^0:/);
    expect(() => kafkaDigest("count 3\nm1\n")).toThrow(/3 messages, but 1/);
    expect(() => kafkaDigest("")).toThrow(/no count/);
  });

  it("names the services whose data differs", () => {
    const before = { postgres: "1", mysql: "2", jobs: "3", sqlite: "4", kafka: "5" };
    expect(differingServices(before, { ...before })).toEqual([]);
    expect(differingServices(before, { ...before, mysql: "x", kafka: "y" })).toEqual([
      "mysql",
      "kafka",
    ]);
  });
});

describe("what OpsCrew printed", () => {
  it("reads the snapshot's id, a data snapshot's or the provider's", () => {
    expect(
      takenSnapshotId("✓ Took the snapshot 20261107T101500Z of staging on the app's server."),
    ).toBe("20261107T101500Z");
    expect(
      takenSnapshotId(
        "✓ Took the snapshot 123456 of the server shop of prod at Hetzner Cloud (1 GB).",
      ),
    ).toBe("123456");
    expect(takenSnapshotId("Nothing was stopped. No snapshot was taken.")).toBeUndefined();
  });

  it("reads a restore's hash and the name to type", () => {
    const output = `Restore the snapshot x\nTyping shop-staging approves it.\nRestore hash: ${HASH}\n`;
    expect(shownRestore(output)).toEqual({ hash: HASH, confirm: "shop-staging" });
    expect(
      shownRestore(
        `Typing shop approves it. OpsCrew then leaves a one-time approval.\nRestore hash: ${HASH}`,
      ),
    ).toEqual({ hash: HASH, confirm: "shop" });
    expect(shownRestore(`Restore hash: ${HASH}`)).toBeUndefined();
  });

  const entry = {
    id: "20261107T101500Z",
    kind: "manual",
    taken: "2026-11-07T10:15:00Z",
    version: `sha256:${HASH}`,
    size: 10,
    services: [
      { name: "queue", kind: "valkey", server: "app", state: "copied", size: 4 },
      { name: "db", kind: "postgres", state: "copied", size: 6 },
      { name: "kafka", kind: "kafka", state: "skipped" },
    ],
    where: "on the app's server",
    offsite: false,
  };

  it("parses snapshot list --json and the services in each state", () => {
    const [listed] = listedSnapshots(JSON.stringify({ snapshots: [entry] }));
    expect(listed?.id).toBe(entry.id);
    expect(servicesIn(listed as NonNullable<typeof listed>)).toEqual(["db", "queue"]);
    expect(servicesIn(listed as NonNullable<typeof listed>, "skipped")).toEqual(["kafka"]);
    expect(() => listedSnapshots(JSON.stringify({ snapshots: [{ id: 1 }] }))).toThrow(
      /another shape/,
    );
  });

  it("checks a scheduled snapshot ran on the hour", () => {
    expect(onTheHour("2026-11-07T10:00:04Z")).toBe(true);
    expect(onTheHour("2026-11-07T10:09:59Z")).toBe(true);
    expect(onTheHour("2026-11-07T10:31:00Z")).toBe(false);
    expect(onTheHour("not a time")).toBe(false);
  });
});

describe("restartedServices", () => {
  const container = (over: Partial<ServerContainer>): ServerContainer => ({
    name: "shop-db-1",
    project: "shop",
    service: "db",
    memory: 0,
    memorySwap: 0,
    ports: [],
    networks: [],
    running: true,
    restarts: 0,
    oomKilled: false,
    startedAt: "2026-11-07T10:00:00Z",
    pid: 1,
    ...over,
  });

  it("names the project's containers that started again or went, never one-offs or others", () => {
    const db = container({});
    const kafka = container({ name: "shop-kafka-1", service: "kafka" });
    const app = container({ name: "shop-app-1", service: "app" });
    const other = container({ name: "blog-db-1", project: "blog" });
    const before = [db, kafka, app, other];
    const after = [
      db,
      { ...kafka, startedAt: "2026-11-07T10:05:00Z" },
      { ...other, startedAt: "2026-11-07T10:05:00Z" },
      container({ name: "shop-run-1", service: "box" }),
    ];
    expect(restartedServices(before, after, "shop")).toEqual(["app", "kafka"]);
    expect(restartedServices(before, before, "shop")).toEqual([]);
  });
});

describe("the off-server bucket", () => {
  const id = "20261107T101500Z";

  it("wants age files only, the copy's record, and one file per part", () => {
    const objects = [`${id}/db.dump.age`, `${id}/sqlite.tar.age`, `${id}/about.json.age`];
    expect(bucketObjectProblems(objects, id, 2)).toEqual([]);
    expect(bucketObjectProblems([...objects, `${id}/leak.txt`], id, 2)).toEqual([
      `backups/${id}/leak.txt is not an age file`,
      `backups/${id}/ holds 3 part files, not 2`,
    ]);
    expect(bucketObjectProblems([`${id}/db.dump.age`], id, 1)).toEqual([
      `backups/${id}/about.json.age is missing`,
    ]);
  });

  it("wants each object to start with age's header and hold no known value", () => {
    const known = [{ label: "dumped-value", value: "value-run1" }];
    expect(objectContentProblems("x.age", `${AGE_HEADER}\n-> X25519 abc\n`, known)).toEqual([]);
    expect(objectContentProblems("x.age", "PGDMP value-run1", known)).toEqual([
      "x.age does not start with age's header",
      "x.age contains: dumped-value",
    ]);
  });

  it("passes rclone's settings by name only", () => {
    const settings = rcloneSettings({
      provider: "Hetzner",
      endpoint: "https://fsn1.your-objectstorage.com",
      region: "fsn1",
      accessKeyId: "access",
      secretAccessKey: "secret",
    });
    expect(settings.RCLONE_CONFIG_OFFSITE_PROVIDER).toBe("Hetzner");
    expect(settings.RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET).toBe("true");
    const args = rcloneDockerArgs(settings, ["lsf", "offsite:b"]);
    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(args).toContain("RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY");
    expect(args).not.toContain("secret");
    expect(args.slice(-3)).toEqual([IMAGES.rclone.ref, "lsf", "offsite:b"]);
  });
});

describe("addressesInSnapshotOutputs", () => {
  it("searches only the snapshot and restore outputs", () => {
    const addresses = [{ label: "server-ipv4", value: "203.0.113.7" }];
    const outputs = new Map([
      ["#1 opscrew snapshot --env staging", "on 203.0.113.7"],
      ["#2 opscrew restore 20261107T101500Z", "fine"],
      ["#3 opscrew provision --yes", "your server at 203.0.113.7"],
    ]);
    expect(addressesInSnapshotOutputs(outputs, addresses)).toEqual([
      "the output of #1 opscrew snapshot --env staging contains: server-ipv4",
    ]);
  });
});
