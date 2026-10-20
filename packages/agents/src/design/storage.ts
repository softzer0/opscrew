import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { formatMoney, OpsCrewError } from "@opscrew/core";
import {
  IMAGES,
  portainerStackName,
  SQLITE_VOLUME,
  STORAGE_NAMES,
  STORAGE_PRICES,
  type StoragePrice,
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
 * When a deployed plan on SQLite changes `app.build.builder` so that its image runs as another
 * user: Docker gives the `sqlite` volume its owner only when it creates it, so the volume keeps the
 * old user's and the new image may not write to it. Says how to give it the new owner: with the
 * edge's pinned Caddy image, which every server has and which has `chown`, on a server; with the
 * same as a one-off container in Portainer. For the user's own Dockerfile, the new owner is its
 * image's user. Undefined otherwise.
 */
export function sqliteOwnerWarning(previous: DeployPlan, plan: DeployPlan): string | undefined {
  const deployed =
    previous.deployment.lastDeployAt !== undefined && previous.deployment.destroyedAt === undefined;
  const before = previous.app.build?.builder;
  const after = plan.app.build?.builder;
  if (!deployed || previous.storage?.sqlite === undefined || plan.storage?.sqlite === undefined) {
    return undefined;
  }
  const oldOwner = sqliteVolumeOwner(previous);
  const owner = sqliteVolumeOwner(plan);
  if (before === after || (owner !== undefined && owner === oldOwner)) return undefined;
  const chownTo = owner ?? "<uid>:<gid>";
  const ownImage =
    owner === undefined
      ? ` Put in ${chownTo} the user your Dockerfile's image runs as (its USER), as numbers.`
      : "";
  const changed = `The app's image is now built with ${after} instead of ${before} (app.build.builder in opscrew/plan.yaml), but its SQLite volume keeps the owner Docker gave it when it was made${oldOwner === undefined ? "" : ` (${oldOwner})`}, so the new version may not be able to write its database.`;
  if (plan.target.provider === "portainer") {
    const volume = `${portainerStackName(plan)}_${SQLITE_VOLUME}`;
    return `${changed} Before you deploy it, run a one-off container in Portainer with the image ${IMAGES.caddy.ref}, user 0, entrypoint chown and command -R ${chownTo} /d, with the volume ${volume} mounted at /d.${ownImage}`;
  }
  const volume = `${plan.app.name}_${SQLITE_VOLUME}`;
  return `${changed} Before you deploy it, run on the server: \`docker run --rm --user 0 --entrypoint chown -v ${volume}:/d ${IMAGES.caddy.ref} -R ${chownTo} /d\`.${ownImage}`;
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
const HETZNER_STORAGE = new Set(["fsn1", "nbg1", "hel1"]);
/** Droplet locations whose Spaces region has another name. */
const SPACES_REGION: Readonly<Record<string, string>> = { nyc1: "nyc3" };

/** One priced object storage choice. */
export interface StorageOffer {
  provider: StorageProvider;
  /** The bucket's region or location. */
  region: string;
  price: StoragePrice;
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
 * (FR-1316): the cloud provider's own storage where its location has it, Garage on a server the
 * user owns or a Portainer, and Cloudflare R2 when the domain is on Cloudflare (it needs OpsCrew's
 * Cloudflare token and account). Ties keep that order.
 */
export function storageOffers(
  requirements: Pick<Requirements, "provider" | "region" | "dnsProvider" | "domain">,
  expected: ObjectStorage["expected"],
): StorageOffer[] {
  const provider: DeployProvider = requirements.provider ?? "hetzner";
  const offers: Omit<StorageOffer, "price">[] = [];
  if (provider === "own" || provider === "portainer") {
    offers.push({ provider: "garage", region: "garage" });
  } else if (requirements.region !== undefined) {
    const locations = providerProfile(provider).regionLocations[requirements.region];
    const location =
      provider === "hetzner"
        ? locations.find((l) => HETZNER_STORAGE.has(l))
        : locations.map((l) => SPACES_REGION[l] ?? l)[0];
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

/** `Cloudflare R2 $0.00/month`. */
export function storageOfferText(offer: Pick<StorageOffer, "provider" | "price">): string {
  return `${STORAGE_NAMES[offer.provider]} ${formatMoney(offer.price)}/month`;
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
  let entries: string[];
  try {
    entries = await readdir(join(root, facts.appDir, dir), { recursive: true });
  } catch {
    return;
  }
  const own = entries
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => !DATABASE_FILE.test(entry.split("/").at(-1) ?? ""))
    .sort();
  const [first] = own;
  if (first !== undefined) throw refuse(`also holds the app's own files (${dir}/${first})`);
}
