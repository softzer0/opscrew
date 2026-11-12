import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";

/** A deploy key on a repository, as GitHub lists it. */
export interface DeployKey {
  id: number;
  title: string;
  /** The public key as GitHub keeps it: its type and base64 body, without a comment. */
  key: string;
  readOnly: boolean;
}

/** {@link GitHubClient.addDeployKey}'s answer: the key's id, and whether it was there already. */
export interface AddedDeployKey {
  id: number;
  state: "added" | "existing";
}

export const DeployKeySchema = z.looseObject({
  id: z.number(),
  title: z.string(),
  key: z.string(),
  read_only: z.boolean(),
});

export const DeployKeysSchema = z.array(DeployKeySchema);

/** One SSH public key line of `/meta`: its type and base64 body. */
const HOST_KEY = /^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/;

export const MetaSchema = z.looseObject({
  ssh_keys: z.array(z.string().regex(HOST_KEY)).min(1),
});

/** The hosts a deploy key's clone reaches GitHub at: SSH on port 22, and on 443. */
const GITHUB_SSH_HOSTS = ["github.com", "[ssh.github.com]:443"] as const;

export function toDeployKey(key: z.infer<typeof DeployKeySchema>): DeployKey {
  return { id: key.id, title: key.title, key: key.key, readOnly: key.read_only };
}

/** The type and base64 body of an OpenSSH public key line, without its comment. */
export function keyBody(publicKey: string): string {
  return publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
}

/** `known_hosts` lines: each of GitHub's host keys for `github.com` and `[ssh.github.com]:443`. */
export function knownHostsLines(sshKeys: readonly string[]): string[] {
  return GITHUB_SSH_HOSTS.flatMap((host) => sshKeys.map((key) => `${host} ${key}`));
}

/** GitHub's 422 when the key is already a deploy key (or a user's key) somewhere else. */
const KEY_IN_USE = /key is already in use/i;

/** The plain error for a key GitHub already holds elsewhere, or `undefined` for any other 422. */
export function keyInUse(json: unknown, owner: string, repo: string): OpsCrewError | undefined {
  if (!KEY_IN_USE.test(JSON.stringify(json ?? ""))) return undefined;
  return new OpsCrewError(
    "PROVIDER_ERROR",
    `GitHub refused the deploy key for ${owner}/${repo}: the key is already in use. A deploy key serves one repository only, and a key on a GitHub account can't be a deploy key.`,
    {
      hint: "Remove the key from the other repository or GitHub account, then run the command again.",
    },
  );
}
