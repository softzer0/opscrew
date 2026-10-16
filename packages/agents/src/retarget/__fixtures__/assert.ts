import type { AuditInput } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { readArtifact, type Retarget } from "@opscrew/plan-schema";
import { expect } from "vitest";
import { runRetarget } from "../run";
import type { RetargetOptions, RetargetResult } from "../types";
import { APP, type MoveEvent, type MoveHarness } from "../../testing";

/**
 * SC-502: every apply follows an approval of the same plan hash, and an apply that deletes follows
 * an approval with `allowDestroy` and the typed app name (plus the typed confirmation hook when
 * `typed` is set, as in interactive runs).
 */
export function expectGated(events: readonly MoveEvent[], typed = false): void {
  const applies = events.flatMap((event, index) =>
    event.type === "apply" ? [{ event, index }] : [],
  );
  for (const { event, index } of applies) {
    const before = events.slice(0, index);
    const approval = before.findLast(
      (e) =>
        e.type === "approval" && e.kind === "iac-apply" && e.approved && e.planHash === event.hash,
    );
    expect(approval, `approval before apply ${event.hash}`).toBeDefined();
    if (event.deletes.length > 0 && approval?.type === "approval") {
      expect(approval.allowDestroy).toBe(true);
      expect(approval.confirmation).toBe(APP);
      if (typed) expect(before.some((e) => e.type === "confirm" && e.name === APP)).toBe(true);
    }
  }
}

/** The trail as short lines: approvals, applies, server operations, copies, dispatches. */
export function trail(events: readonly MoveEvent[]): string[] {
  return events.flatMap((e) => {
    switch (e.type) {
      case "approval":
        return [`approve ${e.kind}${e.approved ? "" : " (refused)"}`];
      case "apply": {
        const parts = [
          e.moves > 0 ? `moves=${e.moves}` : "",
          e.creates.length > 0 ? `creates=${e.creates.length}` : "",
          e.updates.length > 0 ? `updates=${e.updates.length}` : "",
          e.deletes.length > 0 ? `deletes=${e.deletes.length}` : "",
        ].filter(Boolean);
        return [`apply ${parts.join(" ")}`];
      }
      case "remote":
        // Read-only checks are left out.
        return ["ready?", "health", "services?", "verify dump"].includes(e.op)
          ? []
          : [`${e.host} ${e.op}`];
      case "scp":
        return [`scp ${e.from} -> ${e.to}`];
      case "dispatch":
        return [`dispatch ${e.ref}`];
      case "confirm":
        return [`confirm ${e.name}`];
      case "snapshot":
        return [`snapshot ${e.serverId}`];
      default:
        return [];
    }
  });
}

/** Everything a run showed or audited. */
export function everythingPrinted(h: MoveHarness): string {
  return `${h.reporter.text()}\n${JSON.stringify(h.audit.entries)}`;
}

/** Runs `opscrew retarget` with the harness's services. */
export function run(h: MoveHarness, options: RetargetOptions = {}): Promise<RetargetResult> {
  return runRetarget(h.deps, { services: h.services, ...options });
}

/** The OpsCrew error a promise rejects with. */
export async function caught(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** The move recorded in `opscrew/plan.yaml`. */
export async function moveOnDisk(h: MoveHarness): Promise<Retarget | undefined> {
  return (await readArtifact("plan", h.paths.files.plan)).retarget;
}

/** Simulates the process dying right after the audit entry `action` was written (once). */
export function crashOn(h: MoveHarness, action: string): void {
  const append = h.audit.append.bind(h.audit);
  let armed = true;
  h.audit.append = async (entry: AuditInput) => {
    await append(entry);
    if (armed && entry.action === action) {
      armed = false;
      throw new Error("interrupted");
    }
  };
}

/** Simulates the process dying right after `step` was recorded in `opscrew/plan.yaml`. */
export function crashAfter(h: MoveHarness, step: string): void {
  crashOn(h, `retarget ${step}`);
}

/** Runs non-interactively like a script: approves each plan hash it prints until it stops otherwise. */
export async function drive(
  h: MoveHarness,
  options: RetargetOptions = {},
): Promise<RetargetResult> {
  let approve: string | undefined;
  for (let i = 0; i < 10; i++) {
    h.cli.approve = approve;
    h.cli.allowDowntime = options.allowDowntime;
    const result = await run(h, {
      ...options,
      ...(approve !== undefined ? { approvePlanHash: approve } : {}),
    });
    if (result.pendingPlanHash === undefined || result.pendingPlanHash === approve) return result;
    approve = result.pendingPlanHash;
  }
  throw new Error("the move did not settle");
}
