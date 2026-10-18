/**
 * Anonymous container registry lookups (the Docker Registry HTTP API v2), shared by
 * `scripts/update-pins.mjs` and `opscrew adapt`. The caller injects `fetch`.
 */
import type { FetchLike } from "@opscrew/contracts";

/** The registry host and repository name of an image, with Docker Hub's defaults. */
export function registryOf(repo: string): { host: string; name: string } {
  const [first, ...rest] = repo.split("/");
  if (rest.length > 0 && first !== undefined && /[.:]/.test(first)) {
    return { host: first, name: rest.join("/") };
  }
  return { host: "registry-1.docker.io", name: rest.length > 0 ? repo : `library/${repo}` };
}

/** Manifest types to ask for, so a multi-arch image answers with its index digest. */
export const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** The parameters of a registry's `WWW-Authenticate: Bearer …` challenge. */
export function parseBearerChallenge(header: string): {
  realm: string;
  service?: string;
  scope?: string;
} {
  if (!/^Bearer\s/i.test(header)) throw new Error(`Not a bearer challenge: ${header}`);
  const params: Record<string, string> = {};
  for (const [, key, value] of header.matchAll(/(\w+)="([^"]*)"/g)) {
    if (key !== undefined && value !== undefined) params[key] = value;
  }
  const { realm, service, scope } = params;
  if (realm === undefined) throw new Error(`The bearer challenge names no realm: ${header}`);
  return {
    realm,
    ...(service === undefined ? {} : { service }),
    ...(scope === undefined ? {} : { scope }),
  };
}

/**
 * `GET` or `HEAD` of `/v2/<name>/<path>` on the image's registry, asking anonymously and answering
 * a bearer challenge with an anonymous pull token. Throws when the registry refuses.
 */
export async function registryRequest(
  fetch: FetchLike,
  repo: string,
  path: string,
  options: { method?: "GET" | "HEAD"; accept?: string } = {},
): Promise<Response> {
  const { method = "GET", accept = MANIFEST_ACCEPT } = options;
  const { host, name } = registryOf(repo);
  const url = `https://${host}/v2/${name}/${path}`;
  let response = await fetch(url, { method, headers: { Accept: accept } });
  if (response.status === 401) {
    const challenge = parseBearerChallenge(response.headers.get("www-authenticate") ?? "");
    const tokenUrl = new URL(challenge.realm);
    if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
    tokenUrl.searchParams.set("scope", challenge.scope ?? `repository:${name}:pull`);
    const tokenResponse = await fetch(tokenUrl);
    if (!tokenResponse.ok) {
      throw new Error(`${host} refused a pull token for ${repo} (${tokenResponse.status}).`);
    }
    const body = (await tokenResponse.json()) as { token?: unknown; access_token?: unknown };
    const token = body.token ?? body.access_token;
    if (typeof token !== "string") throw new Error(`${host} sent no pull token for ${repo}.`);
    response = await fetch(url, {
      method,
      headers: { Accept: accept, Authorization: `Bearer ${token}` },
    });
  }
  if (!response.ok) throw new Error(`${host} answered ${response.status} for ${repo} ${path}.`);
  return response;
}

/** The digest (`sha256:<hex>`) of `repo:tag`: its multi-arch index, else its one manifest. */
export async function imageDigest(fetch: FetchLike, repo: string, tag: string): Promise<string> {
  const response = await registryRequest(fetch, repo, `manifests/${tag}`, { method: "HEAD" });
  const digest = response.headers.get("docker-content-digest") ?? "";
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`The registry sent no digest for ${repo}:${tag}.`);
  }
  return digest;
}
