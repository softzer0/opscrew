# Contract: builder choice, build job and switch (012)

## `chooseBuilder` (packages/agents, design; T1203)

```ts
export interface BuilderChoice {
  builder: "generated-dockerfile" | "own-dockerfile" | "buildpacks" | "railpack";
  chosen: "auto" | "user";
  reason: string;                       // one plain sentence naming the deciding fact
  runtime: { language: RuntimeLanguage; version: string };
  /** What an automatic choice would be; printed by a failed deploy when the user's choice is in use. */
  automatic: BuilderChoice["builder"];
}
export function chooseBuilder(
  facts: ProjectFacts,
  plan: Pick<DeployPlan, "app"> | undefined,   // the current plan, for a user's choice
  arch: "amd64" | "arm64",
): BuilderChoice | { refused: string };       // refused: no builder can meet the baseline
```

**Rules,** checked in this order:
1. **The user's choice.** With `plan.app.build.chosen === "user"`, the user's builder is kept if it
   supports the language and `arch`. Otherwise the result is `{ refused }`, naming what it lacks.
2. **An own Dockerfile.** A Dockerfile present in the repository (`facts.docker.dockerfile`) gives
   `own-dockerfile`.
3. **The generated Dockerfile.** If `detectStack(facts)` supports the stack, the result is
   `generated-dockerfile`.
4. **Buildpacks.** For Go, Java, .NET or Ruby, where `BUILDPACKS_OFFERS[lang]` includes the
   declared version (or the default) and the Noble builder has `arch`, the result is `buildpacks`.
5. **Railpack** for everything else.

**Versions.** The declared version is normalised to major (Node) or major.minor (others). If no
version is declared, `RUNTIME_DEFAULTS[lang]` applies.

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
- Signing and deploy tags each run in their own job, holding only `id-token: write` or
  `contents: write`.

## Switch (packages/iac-templates, runtime and workflow; T1206)

**Compose (server targets):**
- `app`: no `container_name`, no host `ports`. It has `healthcheck`, `stop_grace_period` and
  `restart: unless-stopped`. Its image comes from `${APP_IMAGE}`.
- `proxy`: kamal-proxy, pinned. It sits on the internal network, holds the volume
  `kamal-proxy-config:/home/kamal-proxy/.config/kamal-proxy`, and has no host ports.
- `caddy`: `reverse_proxy proxy:80`; everything else stays as today.

**The deploy script:**
1. It runs the release command first, as today.
2. Then, depending on `deploy.strategy`:
   - **`rolling`:**
     1. start a second `app` container without recreating the first;
     2. `kamal-proxy deploy app --target <new>:<port> --health-check-path <healthPath> --deploy-timeout 60s --drain-timeout <drainSeconds>s`;
     3. remove the old container on success;
     4. on failure, remove the new container and exit non-zero with the builder hint.
   - **`recreate`:** `docker compose up -d app`, then the same `kamal-proxy deploy`.

**Guarantees:**
- `db`, `cache` and `proxy` are never restarted by a deploy.
- With `rolling`, an image whose health check never passes receives no request.
