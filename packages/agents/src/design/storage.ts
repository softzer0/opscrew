import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { formatMoney, listText, OpsCrewError } from "@opscrew/core";
import {
  FILES_VOLUME,
  IMAGES,
  portainerStackName,
  SQLITE_VOLUME,
  STORAGE_NAMES,
  STORAGE_PRICES,
  type StoragePrice,
  serviceSpec,
  sqliteVolumeOwner,
} from "@opscrew/iac-templates";
import type {
  DeployPlan,
  DeployProvider,
  ProjectFacts,
  Requirements,
  UserScale,
} from "@opscrew/plan-schema";
import { providerProfile } from "../providers";
import { convertMoney } from "./cost";

/** The object storage a plan uses: a provider's bucket, or Garage on the user's server. */
export type ObjectStorage = NonNullable<NonNullable<DeployPlan["storage"]>["objectStorage"]>;
type StorageProvider = ObjectStorage["provider"];

/**
 * When a deployed plan on SQLite or with a kept folder changes `app.build.builder` so that its
 * image runs as another user: Docker gives the `sqlite` and `files` volumes their owner only when
 * it creates them, so they keep the old user's and the new image may not write to them. Says how
 * to give each volume both plans have the new owner: with the edge's pinned Caddy image, which
 * every server has and which has `chown`, on a server; with the same as a one-off container in
 * Portainer. For the user's own Dockerfile, the new owner is its image's user. Undefined otherwise.
 */
export function volumeOwnerWarning(previous: DeployPlan, plan: DeployPlan): string | undefined {
  const deployed =
    previous.deployment.firstDeployAt !== undefined &&
    previous.deployment.destroyedAt === undefined;
  const before = previous.app.build?.builder;
  const after = plan.app.build?.builder;
  const both = (kind: "sqlite" | "files") =>
    previous.storage?.[kind] !== undefined && plan.storage?.[kind] !== undefined;
  const volumes = [
    ...(both("sqlite")
      ? [{ name: SQLITE_VOLUME, title: "its SQLite volume", data: "database" }]
      : []),
    ...(both("files")
      ? [
          {
            name: FILES_VOLUME,
            title: `the volume of its kept folder ${plan.storage?.files?.dir}/`,
            data: "files",
          },
        ]
      : []),
  ];
  if (!deployed || volumes.length === 0) return undefined;
  const oldOwner = sqliteVolumeOwner(previous);
  const owner = sqliteVolumeOwner(plan);
  if (before === after || (owner !== undefined && owner === oldOwner)) return undefined;
  const chownTo = owner ?? "<uid>:<gid>";
  const ownImage =
    owner === undefined
      ? ` Put in ${chownTo} the user your Dockerfile's image runs as (its USER), as numbers.`
      : "";
  const keep = volumes.length === 1 ? "keeps" : "keep";
  const changed = `The app's image is now built with ${after} instead of ${before} (app.build.builder in opscrew/plan.yaml), but ${listText(volumes.map((v) => v.title))} ${keep} the owner Docker gave ${volumes.length === 1 ? "it" : "them"} when ${volumes.length === 1 ? "it was" : "they were"} made${oldOwner === undefined ? "" : ` (${oldOwner})`}, so the new version may not be able to write its ${listText(volumes.map((v) => v.data))}.`;
  if (plan.target.provider === "portainer") {
    const names = volumes.map((v) => `${portainerStackName(plan)}_${v.name}`);
    const mounted =
      names.length === 1
        ? `with the volume ${names[0]} mounted at /d`
        : `once with each of the volumes ${listText(names)} mounted at /d`;
    return `${changed} Before you deploy it, run a one-off container in Portainer with the image ${IMAGES.caddy.ref}, user 0, entrypoint chown and command -R ${chownTo} /d, ${mounted}.${ownImage}`;
  }
  const commands = volumes.map(
    (v) =>
      `\`docker run --rm --user 0 --entrypoint chown -v ${plan.app.name}_${v.name}:/d ${IMAGES.caddy.ref} -R ${chownTo} /d\``,
  );
  return `${changed} Before you deploy it, run on the server: ${commands.join(" and ")}.${ownImage}`;
}

/** What the app is expected to store and serve by its users a month (data-model.md). */
const EXPECTED_USE: Readonly<Record<UserScale, ObjectStorage["expected"]>> = {
  "<1k": { storageGb: 10, egressGbPerMonth: 50 },
  "1k-10k": { storageGb: 50, egressGbPerMonth: 250 },
  "10k-100k": { storageGb: 250, egressGbPerMonth: 1_000 },
  ">100k": { storageGb: 1_000, egressGbPerMonth: 5_000 },
};

/** The expected use for the interview's number of users. */
export function expectedStorageUse(users: UserScale): ObjectStorage["expected"] {
  return { ...EXPECTED_USE[users] };
}

/** Hetzner Object Storage's locations (research R3); other Hetzner locations have none. */
export const HETZNER_STORAGE_LOCATIONS: readonly string[] = ["fsn1", "nbg1", "hel1"];
/** Droplet locations whose Spaces region has another name. */
const SPACES_REGION: Readonly<Record<string, string>> = { nyc1: "nyc3" };

/**
 * The region of `provider`'s object storage at its server location `location`: the location
 * itself at Hetzner where it has object storage (else undefined), the Spaces region at
 * DigitalOcean.
 */
export function storageRegionAt(
  provider: "hetzner" | "digitalocean",
  location: string,
): string | undefined {
  if (provider === "digitalocean") return SPACES_REGION[location] ?? location;
  return HETZNER_STORAGE_LOCATIONS.includes(location) ? location : undefined;
}

/** One priced object storage choice. */
export interface StorageOffer {
  provider: StorageProvider;
  /** The bucket's region or location. */
  region: string;
  price: StoragePrice;
  /** Only the user's choice, never the default: Garage on a cloud server (FR-1316). */
  optIn?: true;
}

/** The monthly price of `provider` for `expected`, rounded to cents. */
export function storagePrice(
  provider: StorageProvider,
  expected: ObjectStorage["expected"],
): StoragePrice {
  const price = STORAGE_PRICES[provider].monthlyPrice(expected);
  return { ...price, amount: Math.round(price.amount * 100) / 100 };
}

/**
 * The object storage options for where the app runs, priced for `expected` and cheapest first
 * (FR-1316): Garage on the app's server on every target (opt-in on a cloud server), the cloud
 * provider's own storage where its location has it, and Cloudflare R2 when the domain is on
 * Cloudflare (it needs OpsCrew's Cloudflare token and account). Ties keep that order.
 */
export function storageOffers(
  requirements: Pick<Requirements, "provider" | "region" | "dnsProvider" | "domain">,
  expected: ObjectStorage["expected"],
): StorageOffer[] {
  const provider: DeployProvider = requirements.provider ?? "hetzner";
  const cloud = provider === "hetzner" || provider === "digitalocean";
  const offers: Omit<StorageOffer, "price">[] = [
    { provider: "garage", region: "garage", ...(cloud ? { optIn: true as const } : {}) },
  ];
  if (cloud && requirements.region !== undefined) {
    const locations = providerProfile(provider).regionLocations[requirements.region];
    const location = locations
      .map((l) => storageRegionAt(provider, l))
      .find((region) => region !== undefined);
    if (location !== undefined) offers.push({ provider, region: location });
  }
  if (requirements.dnsProvider === "cloudflare" && requirements.domain !== undefined) {
    offers.push({ provider: "r2", region: "auto" });
  }
  const priced = offers.map((offer) => ({
    ...offer,
    price: storagePrice(offer.provider, expected),
  }));
  // Compared at the fixed rate design compares budgets at.
  const inEur = (price: StoragePrice) => convertMoney(price, "EUR").amount;
  return priced.sort((a, b) => inEur(a.price) - inEur(b.price));
}

/** The offer design picks unless the user chooses one: the cheapest that is not opt-in. */
export function defaultStorageOffer(offers: readonly StorageOffer[]): StorageOffer | undefined {
  return offers.find((offer) => offer.optIn !== true);
}

/**
 * `Cloudflare R2 $0.00/month`; for Garage also its memory on the server, and that the files live
 * only there.
 */
export function storageOfferText(offer: Pick<StorageOffer, "provider" | "price">): string {
  const text = `${STORAGE_NAMES[offer.provider]} ${formatMoney(offer.price)}/month`;
  if (offer.provider !== "garage") return text;
  return `${text} plus ${serviceSpec("garage").memory.defaultMb} MB of the server's memory, with the files on that server only`;
}

/** A SQLite database the app finds through a variable, moved into a folder of its own. */
export interface SqliteMove {
  /** Who reads the variable. */
  reader: "Laravel" | "Prisma";
  /** The folder the database moves to, relative to the app. */
  dir: string;
  /** The variable that points the app there (its value: `sqliteVariableValue`). */
  variable: "DB_DATABASE" | "DATABASE_URL";
  /** Where detection found the database: a folder that also holds the app's own files. */
  from: string;
}

/**
 * Where a SQLite database moves when the framework reads its path from the environment and its
 * folder also holds the app's own files: Laravel's stock `database/database.sqlite` (next to the
 * migrations) to `storage/database`, with `DB_DATABASE`; Prisma's `file:` database inside
 * `prisma/` (next to the schema) to `data`, with `DATABASE_URL`. Undefined otherwise.
 */
export function sqliteMove(
  facts: Pick<ProjectFacts, "sqlite" | "frameworks" | "services">,
): SqliteMove | undefined {
  const sqlite = facts.sqlite;
  if (sqlite === undefined) return undefined;
  const laravel = facts.frameworks.some((framework) => framework.name === "laravel");
  if (laravel && sqlite.paths.includes("database/database.sqlite")) {
    return {
      reader: "Laravel",
      dir: "storage/database",
      variable: "DB_DATABASE",
      from: "database",
    };
  }
  const prisma = facts.services.some(
    (service) => service.kind === "sqlite" && service.evidence.includes("prisma:sqlite"),
  );
  if (prisma && (sqlite.dir === "prisma" || sqlite.dir.startsWith("prisma/"))) {
    return { reader: "Prisma", dir: "data", variable: "DATABASE_URL", from: sqlite.dir };
  }
  return undefined;
}

/** Files a SQLite database keeps next to it, and the placeholders that keep a folder in Git. */
const DATABASE_FILE =
  /(?:\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?|^\.git(?:keep|ignore)|^\.keep)$/;
/** The placeholders that keep a folder in Git, and the `.htaccess` that denies the web a folder. */
const KEPT_FOLDER_FILE = /^(?:\.git(?:keep|ignore)|\.keep|\.htaccess)$/;

/**
 * The first file (sorted, relative to `dir`) in the app's folder `dir` whose name `allowed` does
 * not match, ignoring folders; undefined when there is none or `dir` does not exist yet.
 */
async function firstOwnFile(
  root: string,
  facts: Pick<ProjectFacts, "appDir">,
  dir: string,
  allowed: RegExp,
): Promise<string | undefined> {
  const base = join(root, facts.appDir, dir);
  let entries: Dirent[];
  try {
    entries = await readdir(base, { recursive: true, withFileTypes: true });
  } catch {
    return undefined;
  }
  return entries
    .filter((entry) => !entry.isDirectory() && !allowed.test(entry.name))
    .map((entry) => relative(base, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort()[0];
}

/**
 * Refuses SQLite's folder when a persistent volume on it would hide the app's own files from the
 * image: the app's root (Django's `db.sqlite3` next to `manage.py`), or a folder that holds the
 * app's code or schema. A folder that does not exist yet is fine. (A database the framework finds
 * through a variable is moved instead, `sqliteMove`, and its new folder checked.)
 * @throws OpsCrewError `INVALID_INPUT` with the change to make.
 */
export async function checkSqliteFolder(
  root: string,
  facts: Pick<ProjectFacts, "appDir">,
  dir: string,
): Promise<void> {
  const refuse = (holds: string) =>
    new OpsCrewError(
      "INVALID_INPUT",
      `The app keeps its SQLite database in ${dir === "." ? "the app's own folder" : `${dir}/`}, which ${holds}. OpsCrew keeps the database's folder on a persistent volume, and that volume would hide those files from the app. plan.yaml was not changed.`,
      {
        hint: "Move the database into a folder of its own, for example data/ (data/app.sqlite3), change the app's database path to it, then run `opscrew analyze` and `opscrew design` again.",
      },
    );
  if (dir === ".") throw refuse("holds the app's code");
  const first = await firstOwnFile(root, facts, dir, DATABASE_FILE);
  if (first !== undefined) throw refuse(`also holds the app's own files (${dir}/${first})`);
}

/**
 * Refuses the folder an app writes to and keeps (`storage.files.dir`) as {@link checkSqliteFolder}
 * refuses SQLite's: when it holds the app's own files, which the volume on it would keep at their
 * first version. Git's placeholders, a `.htaccess` (a shared-hosting app's, denying the web the
 * folder) and empty folders are fine, and so is a folder that does not exist yet. (The plan's
 * schema refuses the app's own folder.)
 * @throws OpsCrewError `INVALID_INPUT` with the change to make.
 */
export async function checkKeptFolder(
  root: string,
  facts: Pick<ProjectFacts, "appDir">,
  dir: string,
): Promise<void> {
  const first = await firstOwnFile(root, facts, dir, KEPT_FOLDER_FILE);
  if (first === undefined) return;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `The app keeps the files it writes in ${dir}/, which also holds the app's own files (${dir}/${first}). OpsCrew keeps that folder on a persistent volume, and the volume would hide new versions of those files from the app. plan.yaml was not changed.`,
    {
      hint: `Move the app's own files out of ${dir}/, or have the app write its files to a folder of their own, then run \`opscrew analyze\` and \`opscrew design\` again.`,
    },
  );
}
