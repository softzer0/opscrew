import type { CheckResult } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { ContainerReading, ResourceReading } from "../../../status";
import { offer } from "../../../testing";
import type { PriceList, Readings, ServerHistory } from "../../types";

/** When the test readings were taken. */
export const AT = "2026-11-05T10:00:00.000Z";

export const GB = 1024 ** 3;
export const MB = 1024 ** 2;
const DAY_MS = 86_400_000;

/** `days` after {@link AT}, as ISO 8601 (`ms` more for the edges). */
export function afterAt(days: number, ms = 0): string {
  return new Date(Date.parse(AT) + days * DAY_MS + ms).toISOString();
}

/** A container as `status` reads it. */
export function container(service: string, restarts = 0): ContainerReading {
  return {
    service,
    cpuPercent: 5,
    memory: { usedBytes: 100 * MB },
    restarts,
    startedAt: "2026-11-04T08:00:00.000Z",
  };
}

/** One reading of a 4 GB server: its memory and disk at these shares. */
export function reading(
  o: { memory?: number; disk?: number; containers?: ContainerReading[]; totalGb?: number } = {},
): ResourceReading {
  const total = (o.totalGb ?? 4) * GB;
  const disk = 40 * GB;
  const used = Math.round(disk * (o.disk ?? 0.3));
  return {
    takenAt: AT,
    server: {
      cpus: 2,
      load15: 0.4,
      memory: { usedBytes: Math.round(total * (o.memory ?? 0.4)), totalBytes: total },
      disk: { usedBytes: used, freeBytes: disk - used, totalBytes: disk },
    },
    containers: o.containers ?? [container("app"), container("db")],
    unavailable: [],
    flags: [],
  };
}

/** 14 days of history, quiet unless `o` says. */
export function history(o: Partial<ServerHistory> = {}): ServerHistory {
  return { days: 14, cpuP95: 0.2, memoryP95: 0.4, loadOverCpus: 0, containers: [], ...o };
}

/** Hetzner's prices in nbg1: cx23 (4 GB) and cx33 (8 GB), IPv4 €0.50, backups 20%. */
export function hetznerPrices(): PriceList {
  return {
    provider: "hetzner",
    location: "nbg1",
    offers: [
      offer({ id: "cx23", vcpus: 2, memoryGb: 4, diskGb: 40, price: 5.49, source: "live", asOf: AT }),
      offer({ id: "cx33", vcpus: 4, memoryGb: 8, diskGb: 80, price: 8.49, source: "live", asOf: AT }),
    ],
    extras: {
      ipv4Monthly: { amount: 0.5, currency: "EUR" },
      backupPercent: 20,
      pricesIncludeVat: false,
      source: "live",
      asOf: AT,
    },
  };
}

/** The server's address, which no proposal may show. */
export const SERVER_ADDRESS = "203.0.113.10";

/** A host check result as `secure` gives it, on the test server's address. */
export function hostCheck(
  init: Pick<CheckResult, "id" | "status" | "severity" | "message"> & Partial<CheckResult>,
): CheckResult {
  return { title: init.id, target: SERVER_ADDRESS, ...init };
}

/** Readings of `plan` with nothing to report unless `overrides` say. */
export function readingsOf(plan: DeployPlan, overrides: Partial<Readings> = {}): Readings {
  return {
    at: AT,
    servers: {},
    plan,
    prices: [hetznerPrices()],
    upkeep: { pulls: [], tokens: [], hostChecks: {} },
    notRead: [],
    flags: "",
    ...overrides,
  };
}
