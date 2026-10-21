/**
 * Reads images from GitHub's container registry (GHCR) through its registry API (the OCI
 * distribution API), with a pull token issued for the user's GitHub token.
 */
import type { FetchLike } from "@opscrew/contracts";
import {
  CONNECTION_HINT,
  durationText,
  OpsCrewError,
  parseAnswer,
  type Redactor,
  sha256Hex,
} from "@opscrew/core";
import { z } from "zod";

const GHCR = "https://ghcr.io";

/** Index types first, so a multi-arch image answers with its index; then single manifests. */
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const SLSA_V1 = "https://slsa.dev/provenance/v1";
const IN_TOTO = "application/vnd.in-toto+json";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** An OCI tag. */
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
/** An OCI repository name (lower case, `/`-separated). */
const NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
/** A GitHub Actions run URL, as buildx writes it into `runDetails.builder.id`. */
const BUILD_RUN =
  /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/attempts\/\d+)?$/;

const DigestSchema = z.string().regex(DIGEST);
const AnnotationsSchema = z.record(z.string(), z.string()).optional();
const IndexSchema = z.looseObject({
  manifests: z
    .array(z.looseObject({ digest: DigestSchema, annotations: AnnotationsSchema }))
    .optional(),
});
const ManifestSchema = z.looseObject({
  layers: z.array(
    z.looseObject({ mediaType: z.string(), digest: DigestSchema, annotations: AnnotationsSchema }),
  ),
});
const StatementSchema = z.looseObject({ predicateType: z.string() });
const SlsaV1Schema = z.looseObject({
  predicate: z.looseObject({
    runDetails: z.looseObject({ builder: z.looseObject({ id: z.string() }) }),
  }),
});
const PullTokenSchema = z.looseObject({ token: z.string().min(1) });

const DENIED_HINT =
  "GitHub's container registry needs a classic token with read:packages, since it may not accept fine-grained tokens. Set OPSCREW_GHCR_READ_TOKEN to one (or use the GitHub CLI's login after `gh auth refresh -s read:packages`), then run the command again.";

/** A user name and token for GHCR's basic authentication. */
export interface RegistryCredential {
  username: string;
  token: string;
}

/** The build an image's SLSA v1 provenance names (`runDetails.builder.id`). */
export interface ImageProvenance {
  /** The builder id, for a GitHub build the run's URL. */
  builderId: string;
  /** The GitHub Actions run, when the builder id is one. */
  runId?: number;
  /** `owner/repo` of that run. */
  repository?: string;
}

export interface GhcrReaderOptions {
  fetch: FetchLike;
  /** The user's GitHub login and token, used when a call is given no credential of its own. */
  credentials: () => Promise<RegistryCredential>;
  /** Every pull token is registered here as soon as it arrives. */
  redactor: Redactor;
  timeoutMs: number;
}

/** GHCR's repository name of an image (lower case, as GHCR requires). */
function imageName(owner: string, image: string): string {
  const name = `${owner}/${image}`.toLowerCase();
  if (!NAME.test(name)) {
    throw new OpsCrewError("INVALID_INPUT", `"${owner}/${image}" is not a GHCR image name.`);
  }
  return name;
}

function parseJson<S extends z.ZodType>(schema: S, bytes: Buffer, what: string): z.output<S> {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    json = undefined;
  }
  return parseAnswer(schema, json, "GHCR", what);
}

/** Reads tags, manifests and provenance from GHCR. */
export class GhcrReader {
  readonly #options: GhcrReaderOptions;

  constructor(options: GhcrReaderOptions) {
    this.#options = options;
  }

  /** The digest `tag` points to (the image index's), or `undefined` when GHCR has no such tag. */
  async taggedDigest(
    owner: string,
    image: string,
    tag: string,
    credential?: RegistryCredential,
  ): Promise<string | undefined> {
    const name = imageName(owner, image);
    if (!TAG.test(tag)) {
      throw new OpsCrewError("INVALID_INPUT", `"${tag}" is not an image tag.`);
    }
    const what = `read ghcr.io/${name}:${tag}`;
    const token = await this.#pullToken(name, what, credential);
    const found = await this.#get(token, `${name}/manifests/${tag}`, what);
    if (found === undefined) return undefined;
    const header = found.headers.get("docker-content-digest");
    return header !== null && DIGEST.test(header) ? header : `sha256:${sha256Hex(found.bytes)}`;
  }

  /**
   * The SLSA v1 provenance of the image index `digest`: its attestation manifest's in-toto layer.
   * `undefined` when GHCR has no such digest, or the image carries no SLSA v1 provenance.
   */
  async imageProvenance(
    owner: string,
    image: string,
    digest: string,
    credential?: RegistryCredential,
  ): Promise<ImageProvenance | undefined> {
    const name = imageName(owner, image);
    if (!DIGEST.test(digest)) {
      throw new OpsCrewError("INVALID_INPUT", `"${digest}" is not an image digest (sha256:…).`);
    }
    const what = `read the provenance of ghcr.io/${name}@${digest}`;
    const token = await this.#pullToken(name, what, credential);
    const index = await this.#getByDigest(token, name, "manifests", digest, what);
    if (index === undefined) return undefined;
    const attestation = parseJson(IndexSchema, index, what).manifests?.find(
      (entry) => entry.annotations?.["vnd.docker.reference.type"] === "attestation-manifest",
    );
    if (attestation === undefined) return undefined;
    const manifest = await this.#getByDigest(token, name, "manifests", attestation.digest, what);
    if (manifest === undefined) return undefined;
    for (const layer of parseJson(ManifestSchema, manifest, what).layers) {
      const predicateType = layer.annotations?.["in-toto.io/predicate-type"];
      if (layer.mediaType !== IN_TOTO || (predicateType ?? SLSA_V1) !== SLSA_V1) continue;
      const blob = await this.#getByDigest(token, name, "blobs", layer.digest, what);
      if (blob === undefined || parseJson(StatementSchema, blob, what).predicateType !== SLSA_V1) {
        continue;
      }
      const builderId = parseJson(SlsaV1Schema, blob, what).predicate.runDetails.builder.id;
      const run = BUILD_RUN.exec(builderId);
      return run?.[1] !== undefined && run[2] !== undefined
        ? { builderId, runId: Number(run[2]), repository: run[1] }
        : { builderId };
    }
    return undefined;
  }

  /**
   * A pull token for `name`, for `credential` or else the user's GitHub token. Both tokens are
   * registered with the redactor before anything can print them.
   */
  async #pullToken(name: string, what: string, credential?: RegistryCredential): Promise<string> {
    if (credential !== undefined)
      this.#options.redactor.addLiteral(credential.token, "ghcr-read-token");
    const { username, token } = credential ?? (await this.#options.credentials());
    const query = new URLSearchParams({ service: "ghcr.io", scope: `repository:${name}:pull` });
    const basic = Buffer.from(`${username}:${token}`).toString("base64");
    const answer = await this.#send(`${GHCR}/token?${query}`, `Basic ${basic}`, what);
    if (answer.status === 401 || answer.status === 403) throw this.#denied(what);
    if (answer.status !== 200) {
      throw new OpsCrewError("PROVIDER_ERROR", `GHCR could not ${what} (HTTP ${answer.status}).`);
    }
    const pull = parseJson(PullTokenSchema, answer.bytes, what).token;
    this.#options.redactor.addLiteral(pull, "ghcr-token");
    return pull;
  }

  /** `GET /v2/<path>`; `undefined` on 404. */
  async #get(
    token: string,
    path: string,
    what: string,
  ): Promise<{ headers: Headers; bytes: Buffer } | undefined> {
    const answer = await this.#send(`${GHCR}/v2/${path}`, `Bearer ${token}`, what);
    if (answer.status === 404) return undefined;
    if (answer.status === 401 || answer.status === 403) throw this.#denied(what);
    if (answer.status !== 200) {
      throw new OpsCrewError("PROVIDER_ERROR", `GHCR could not ${what} (HTTP ${answer.status}).`);
    }
    return answer;
  }

  /** A manifest or blob by digest, checked against that digest; `undefined` on 404. */
  async #getByDigest(
    token: string,
    name: string,
    kind: "manifests" | "blobs",
    digest: string,
    what: string,
  ): Promise<Buffer | undefined> {
    const found = await this.#get(token, `${name}/${kind}/${digest}`, what);
    if (found === undefined) return undefined;
    if (`sha256:${sha256Hex(found.bytes)}` !== digest) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `GHCR sent content for ${digest} that does not match that digest, when trying to ${what}.`,
        { hint: "Run the command again; if it keeps happening, report it to OpsCrew." },
      );
    }
    return found.bytes;
  }

  async #send(
    url: string,
    authorization: string,
    what: string,
  ): Promise<{ status: number; headers: Headers; bytes: Buffer }> {
    const signal = AbortSignal.timeout(this.#options.timeoutMs);
    try {
      const response = await this.#options.fetch(url, {
        headers: { Accept: MANIFEST_ACCEPT, Authorization: authorization },
        signal,
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers: response.headers, bytes };
    } catch (error) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        signal.aborted
          ? `GHCR did not answer within ${durationText(this.#options.timeoutMs)} when trying to ${what}.`
          : `Could not reach GHCR to ${what}.`,
        { hint: CONNECTION_HINT, cause: error },
      );
    }
  }

  #denied(what: string): OpsCrewError {
    return new OpsCrewError("CREDENTIALS_INVALID", `GHCR refused to ${what}.`, {
      hint: DENIED_HINT,
    });
  }
}
