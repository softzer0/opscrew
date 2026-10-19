# Contract: builder choice, build job and switch (012)

## `chooseBuilder` (packages/agents, design; T1203)

```ts
export interface BuilderChoice {
  builder: "generated-dockerfile" | "own-dockerfile" | "buildpacks" | "railpack";
  chosen: "auto" | "user";
  reason: string;                       // one plain sentence naming the deciding fact
  runtime: { language: RuntimeLanguage; version: string };
  /** The Compose health check's tool for this image (FR-1214). */
  probe: "node" | "python" | "ruby" | "php" | "wget" | "bash" | "none";
  /**
   * What OpsCrew would choose itself, leaving an own Dockerfile aside; a failed deploy names it
   * (FR-1206).
   */
  automatic: BuilderChoice["builder"];
  /** Plain warnings for design to print (an end-of-life version, a user's risky choice). */
  warnings: string[];
}
export function chooseBuilder(
  facts: ProjectFacts,
  plan: Pick<DeployPlan, "app"> | undefined,   // the current plan, for a user's choice
  arch: "amd64" | "arm64",
): BuilderChoice | { refused: string };       // refused: only a user's choice that cannot build the app
```

**Rules,** checked in this order:
1. **The user's choice.** With `plan.app.build.chosen === "user"`, the user's builder is kept if it
   can build the language (Buildpacks has no PHP in the pinned Noble builder). Otherwise the result
   is `{ refused }`, naming what it lacks.
2. **An own Dockerfile.** A production Dockerfile in the app's folder or the root
   (`facts.docker.dockerfile`; never `.devcontainer/**` or `Dockerfile.dev`) gives
   `own-dockerfile`. OpsCrew's own generated Dockerfile does not count.
3. **Bun** gives `railpack`.
4. **The generated Dockerfile.** If `detectStack(facts)` supports the Node or Python stack, the
   result is `generated-dockerfile`.
5. **Buildpacks.** For Go, Java, .NET or Ruby, where `BUILDPACKS_OFFERS[lang]` includes the
   version and the project has no secret build value (Buildpacks has no secret mounts), the result
   is `buildpacks`.
6. **Railpack** for everything else.

`arch` decides nothing: every builder builds amd64 and arm64 (research R7, R8); the build job runs
on a runner of the server's architecture.

**Versions.** The declared version is kept as declared (FR-1228 rule 1; a range resolves to the
newest supported version inside it). Without one, the evidence of FR-1228 rule 3 applies, then
`RUNTIME_DEFAULTS[lang]`; a version recorded in `plan.yaml` is kept on later runs.

**The result:**
- is deterministic: the same inputs give the same result and the same reason text;
- never depends on the network or a model.

## Build job (packages/iac-templates, workflow; T1205)

**Inputs:**
- `plan.app.build`;
- `plan.supplyChain`;
- `plan.cicd.deployTags`;
- `pins.ts`;
- the build values, split into `OPSCREW_BUILD_ENV` (non-secret, as build args) and
  `OPSCREW_BUILD_SECRETS` (BuildKit secrets).

**Output:**
- the job output `image`, the final index digest reference `ghcr.io/<repo>@sha256:…`, which every
  deploy uses;
- the job output `tag`, `ghcr.io/<repo>:<sha>`.

**Guarantees:**
- Every action is pinned by SHA. pack and Railpack are pinned by version and checksum, their images
  by digest.
- The final image is built by `docker/build-push-action` with `provenance: mode=max` and
  `sbom: true`.
- No secret value is passed as a build arg. Only the names of secrets appear in the workflow.
- Trivy scans the final digest; it only reports, as today.
- Buildpacks and Railpack builds push an intermediate `ghcr.io/<repo>:build-<sha>`. Only the sealed
  final tag is deployed.
- Signing and deploy tags each run in their own job: signing holds `id-token: write` and
  `packages: write` (to push the signature), deploy tags only `contents: write`.

## Switch (packages/iac-templates, runtime and workflow; T1206)

**Compose (server targets):**
- `app`: no `container_name`, no host `ports`. It has `healthcheck` (none for an own Dockerfile,
  FR-1214), `stop_grace_period` and `restart: unless-stopped`. Its image comes from `${APP_IMAGE}`.
- `proxy`: kamal-proxy, pinned. It sits on the internal network, holds the volume
  `kamal-proxy-config:/home/kamal-proxy/.config/kamal-proxy`, and has no host ports.
- `caddy`: `reverse_proxy proxy:80`; everything else stays as today.

**The deploy script:**
1. It runs the release command first, as today.
2. Then, depending on `deploy.strategy`:
   - **`rolling`:**
     1. start a second `app` container without recreating the first;
     2. `kamal-proxy deploy app --target <new>:<port> --health-check-path <healthPath> --deploy-timeout 60s --drain-timeout <drainSeconds>s --target-timeout 300s`, with stdin from `/dev/null`;
     3. remove the old container on success;
     4. on failure, remove the new container and exit non-zero with the builder hint.
   - **`recreate`:** `docker compose up -d app`, then the same `kamal-proxy deploy`.

**Guarantees:**
- `db`, `cache` and `proxy` are never restarted by a deploy.
- With `rolling`, an image whose health check never passes receives no request.
