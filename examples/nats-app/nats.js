import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { connect } from "@nats-io/transport-node";

/**
 * Connects to NATS (`NATS_URL`, `nats://<token>@<host>:4222`) and sets up a JetStream work queue
 * for jobs, with the worker's durable consumer, and the key-value bucket `app`.
 */
export async function openNats() {
  const url = new URL(process.env.NATS_URL ?? "nats://localhost:4222");
  const token = decodeURIComponent(url.username) || undefined;
  const nc = await connect({ servers: url.host, token });
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "JOBS", subjects: ["jobs.*"], retention: "workqueue" });
  await jsm.consumers.add("JOBS", { durable_name: "worker", ack_policy: "explicit" });
  const kv = await new Kvm(nc).create("app");
  return { nc, js: jetstream(nc), kv };
}
