# Contract: the localhost target (015)

Owners:
- `packages/plan-schema`: the target (T1501a);
- `packages/core` (crypto): the local CA (T1501b);
- `packages/iac-templates`: localhost Compose, the edge and the script roots (T1506);
- `packages/agents` and the local `RemoteExec`: the flow (T1510).

## Local CA (`@opscrew/core`)

```ts
localCaCertificate(key: KeyObject, o: { commonName: string; days: number; now: Date }): string;   // PEM
signedLeafCertificate(o: {
  caKey: KeyObject; caCertificate: string; key: KeyObject; hostnames: string[]; days: number; now: Date;
}): string;   // PEM
```

The CA certificate is CA:TRUE (pathlen 0) with keyCertSign and cRLSign. A leaf certificate has SAN
DNS names, digitalSignature, and serverAuth.

A leaf is issued for 1 year. Callers must never exceed 825 days: Apple's platforms refuse TLS
server certificates valid for longer, locally trusted ones included (the T1501b review).

## Local executor (`@opscrew/connector-ssh-host`)

```ts
localExec(deps: { runner: CommandRunner; shell: string; env: NodeJS.ProcessEnv }): RemoteExec;
```

- It runs a rendered script by piping it to `shell -s`, the same as SSH does: `sh` on macOS and Linux, and on Windows Git for Windows' `bash.exe`, found next to `git`.
- It sets `OPSCREW_APPS_DIR` and `OPSCREW_EDGE_DIR` to `<OpsCrew home>/local/srv/apps` and `…/edge`.
- It never runs as root.

## The script roots (`@opscrew/iac-templates`)

- Every switch, edge and rollback script begins with `APPS_DIR="${OPSCREW_APPS_DIR:-/srv/apps}"` and `EDGE_DIR="${OPSCREW_EDGE_DIR:-/srv/edge}"`, and builds every path from them.
- The rendered output for a server is otherwise byte-identical to 014's (snapshot).

## Localhost Compose and edge (`@opscrew/iac-templates`)

`renderCompose(plan)` for a localhost target:
- **Data mounts** become named volumes, `opscrew-<app>_<service>_data`.
- **The app's port** is published only through the edge.
- **The edge** publishes `127.0.0.1:<https>:443` and `127.0.0.1:<http>:80`.
- **The certificates:** Caddy's sites use `tls /etc/caddy/tls/<app>/local.pem /etc/caddy/tls/<app>/local.key`, and nginx's servers the same files. The leaf certificate and key are written to the edge's TLS folder by the deploy, like the origin files.
- **Not on localhost:** ACME, certbot, origin TLS and the web filter. The catch-all stays.

## Agents

```ts
localPreflight(deps, plan): Promise<{ problems: string[]; notes: string[] }>;
planLocal(deps, plan): Promise<{ plan: LocalPlan; hash: string }>;   // host-apply
applyLocal(deps, plan, { approvedHash }): Promise<void>;
localTrust(deps, { action: "trust" | "untrust" }): Promise<{ command: string; done: boolean }>;
```

**The preflight checks:**
- `docker info` answers;
- `docker compose version` is 2.23 or newer;
- the sum of the stack's memory limits is at most `MemTotal`;
- the ports are free, or OpsCrew falls back to 8443/8080;
- the shell is found;
- the architecture against production's.

**Notes, given once:** Docker Desktop's licence terms with the free alternatives, and on another
architecture, that the image differs.

**`LocalPlan`** lists the containers, networks, volumes, folders and leaf certificates to create
or change, with their hostnames and ports. The hash is SHA-256 of its canonical JSON.

**`localTrust`:**
- it shows the exact command first, runs it only after the user agrees (interactive), and in
  scripts only prints it;
- macOS: `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db <ca.pem>`;
- Windows: `certutil -user -addstore Root <ca.pem>`;
- Linux: `certutil -d sql:$HOME/.pki/nssdb -A -t C,, -n "OpsCrew local CA" -i <ca.pem>`, and the
  system store only when asked, with sudo.

`untrust` reverses each.
