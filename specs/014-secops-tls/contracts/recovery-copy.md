# Contract: the recovery copy and the pinned-tools fetcher (014)

Owners:
- `packages/core`: the fetcher, the sops runner, age keys (T1401b);
- `packages/agents/src/secrets`: the copy (T1404).

Consumers: `packages/agents` provision, retarget and status, and `packages/cli` and
`packages/mcp-server` (T1411).

## Fetcher (`@opscrew/core`)

```ts
interface LocalToolPin {
  name: "sops";
  version: string;
  assets: Partial<Record<`${"linux" | "darwin" | "windows"}-${"amd64" | "arm64"}`,
    { url: string; sha256: string }>>;
  envOverride: string;               // "OPSCREW_SOPS_BIN"
}
fetchPinnedTool(pin: LocalToolPin, deps: { fetch; fs; env; homeDir; platform; arch }):
  Promise<{ path: string; source: "override" | "cache" | "download" }>;
```

- **The cache:** `<homeDir>/tools/<name>/<version>/<name>[.exe]`. It is checked by SHA-256 on every
  call, so a changed file is downloaded again. An override is used as it is, and the report names
  it.
- **Errors** (plain English): the platform has no pinned asset; a download failed (with the URL);
  a checksum differs (download again, or place the file by hand).

## sops runner (`@opscrew/core`)

```ts
sopsEncrypt(bin: string, input: { plaintext: string; recipients: string[]; filename: string }, deps: { exec; redactor; env }):
  Promise<string>;                   // encrypted JSON; plaintext only on stdin
sopsDecrypt(bin: string, input: { encrypted: string; identity: string; filename: string }, deps: { exec; redactor; env }):
  Promise<string>;                   // plaintext JSON on stdout, never written to disk
```

- The arguments are `encrypt|decrypt --input-type json --output-type json --filename-override
  <filename>`, plus `--age <recipients>` for encrypt.
- The child's environment is `deps.env` without any `SOPS_*` variable, so the user's own sops
  settings add no recipient and open no file with another key. The identity is added only as
  `SOPS_AGE_KEY`, and the plaintext goes only on stdin.
- The identity and every decrypted value are registered with the redactor before any message can
  name them.
- A wrong key is mapped from sops's exit code and message to `SECRETS_KEY_REJECTED`.

## age keys (`@opscrew/core`)

```ts
generateAgeIdentity(random?): { identity: string; recipient: string };   // AGE-SECRET-KEY-1…, age1…
ageRecipientOf(identity: string): string;
isAgeRecipient(text: string): boolean;
```

The keys are X25519 through `node:crypto`, written in Bech32, and tested against age's published
vectors.

## The copy (`packages/agents/src/secrets`)

```ts
refreshRecoveryCopy(deps, plan): Promise<
  | { changed: false; warning?: string }
  | { changed: true; repositoryFiles: RenderedFile[]; folderCopy?: string; firstKey?: KeyHandover }
>;
restoreRecoveryCopy(deps, input: { identity: string; onConflict?: "use-copy" | "keep-local" }):
  Promise<{ restored: string[]; conflicts?: { paths: string[]; values: string[] } }>;
rotateRecoveryKey(deps, input: { backup?: string | null }): Promise<{ handover: KeyHandover; files: RenderedFile[] }>;
recoveryStatus(deps): Promise<{
  exists: boolean; lastModified?: string; recipients: number; behind: boolean; folder?: string;
}>;

interface KeyHandover { path: string }   // the 0600 file the key was written to, once; never printed
```

**`opscrew/secrets.sops.json` (committed):**

```json
{
  "files": {
    "home/generated_values.json": "ENC[AES256_GCM,data:…,type:str]",
    "home/deploy_key": "ENC[…]",
    "state/tfstate/prod.tfstate": "ENC[…]"
  },
  "sops": { "age": [{ "recipient": "age1…", "enc": "…" }], "lastmodified": "…", "mac": "…", "version": "3.13.3" }
}
```

**Rules:**
- **Paths** are `home/<name>` or `state/<relative path>`, from plan.md §5's list only. Restore
  refuses any other path.
- **Restore** writes files atomically with their modes: 0600 for `home/*` and for
  `state/tfstate/*`, 0644 otherwise. It never writes a file whose content would not change.
- **A conflict** (a local file that exists and differs) writes nothing until the user chooses. The
  message lists paths, and for `generated_values.json` the names of the values that differ, never
  values.
- **The public-repository check** reads the repository's visibility through the GitHub connector.
  Interactive runs ask, and the answer is recorded in `.opscrew/recovery.json`. Non-interactive
  runs write only the folder copy and say how to commit the copy.
- **Another machine's copy:** when the repository's copy differs from `copySha256` (the copy this
  machine last wrote), `refreshRecoveryCopy` stops with `SECRETS_COPY_CHANGED_ELSEWHERE` and says to
  run `opscrew secrets restore` first.
- **No sops:** when the fetch fails, `refreshRecoveryCopy` returns `{ changed: false, warning }`,
  and the caller shows the warning and goes on.
- **The key file** is written once, 0600, with exclusive create. Its path is outside the repository
  and outside `~/.opscrew`, and is asked for (CLI) or given (`--key-out`, MCP `keyOut`).
- **The pull request** gets `opscrew/secrets.sops.json`, `opscrew/.sops.yaml` and the
  `.gitattributes` lines (`opscrew/secrets.sops.json text eol=lf`,
  `opscrew/.sops.yaml text eol=lf`).

## CLI and MCP (T1411)

| Command | Does |
|---|---|
| `opscrew secrets status` | the copy's last update, its recipients, whether it is behind, the folder |
| `opscrew secrets restore [--key-file <path>] [--use-copy\|--keep-local]` | a hidden prompt when no file is given (CLI only) |
| `opscrew secrets rotate [--backup <age1…>\|--no-backup] [--key-out <path>]` | a new key, written to the file; the copy in a pull request |
| `opscrew secrets folder <path>\|--none` | sets or clears the folder copy |

MCP tools mirror these. A new key is always written to `keyOut` (required there), and restore takes
only `keyFile`. The CLI asks for the path when `--key-out` is not given. No surface ever prints a
key.
