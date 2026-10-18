# Data model: 012

Everything is unreleased, so the schemas change directly, without migrations.

## `opscrew/plan.yaml` (packages/plan-schema)

```yaml
app:
  # … existing fields: name, port, healthPath, buildContext, dockerfile, releaseCommand, env
  build:
    builder: generated-dockerfile   # generated-dockerfile | own-dockerfile | buildpacks | railpack
    chosen: auto                    # auto (from chooseBuilder) | user (the user set builder)
    reason: "Next.js with pnpm: OpsCrew's Dockerfile builds it; Buildpacks has no pnpm."
    runtime:                        # what the builder is given
      language: node                # node | python | ruby | go | java | dotnet | php | rust | other
      version: "24"                 # declared by the app, else pins.ts's default for the language
deploy:
  strategy: rolling                 # rolling | recreate
  drainSeconds: 30                  # 5–300; the old copy's grace for open requests
  reason: "…"                       # only when not rolling, e.g. "the server has 512 MB of memory"
supplyChain:
  sign: false                       # cosign keyless; for a private repository its name and workflow become public
cicd:
  # … existing fields
  deployTags:
    enabled: false
    release: false                  # also a GitHub Release naming the image digest
  imageRetention:
    enabled: true                   # founder 2026-10-18: on by default
    keep: 10                        # 2–100; never the running or the previous image
```

**Validation:**
- `own-dockerfile` needs `app.dockerfile` to exist in the repository. adapt checks this and names
  the file.
- `generated-dockerfile` needs a stack `detectStack` supports. Otherwise design says which builder
  applies.
- `chosen: user` keeps the user's builder through every later design, unless the baseline or the
  architecture rules it out (FR-1202). OpsCrew then says why and changes nothing until the user
  edits the field.
- For the Portainer target, design always records `deploy.strategy: recreate`, since Portainer
  recreates the stack (FR-1217). The schema itself does not refuse `rolling`.
- `runtime.version` is a major, major.minor or major.minor.patch string, kept as precise as the app
  declares it, because FR-1228 rule 1 keeps exact versions. It is required for every language except
  `other`, where Railpack picks the version. It is not checked against the builder here;
  `chooseBuilder` does that by prefix at the declared precision.

## `ProjectFacts` (opscrew/architecture.json)

`runtimeVersions` gains these fields. Each is optional, and records the version as declared, not
yet normalised:

| Field | Read from |
|---|---|
| `ruby` | `.ruby-version`, Gemfile `ruby "…"` |
| `go` | `go.mod` `toolchain go…`, else `go …` |
| `java` | Maven `maven.compiler.release` / `java.version`, Gradle toolchain `languageVersion` |
| `dotnet` | `TargetFramework` `netX.Y` in the project file |
| `php` | `composer.json` `require.php` |
| `rust` | `rust-toolchain.toml` `channel`, `rust-toolchain` |

`node` and `python` stay as today.

## `pins.ts` (packages/iac-templates)

```ts
export const IMAGES: Record<ImageKey, { ref: string /* repo:tag@sha256:… */ }>;
export const TOOLS: Record<ToolKey, { version: string; sha256: Record<"amd64" | "arm64", string> }>;
export const ACTIONS: Record<ActionKey, string /* owner/name@<40-hex sha> # vX */>;
export const RUNTIME_DEFAULTS: Record<RuntimeLanguage, string>;   // node: "24", python: "…", …
export const BUILDPACKS_OFFERS: Record<"go" | "java" | "dotnet" | "ruby", string[]>;  // versions the pinned builder provides
```

`scripts/update-pins.mjs` rewrites this file. Tests read it and never fetch.

## Generated files

| File | Written by | Rewritten by OpsCrew? |
|---|---|---|
| `Dockerfile`, `.dockerignore` | adapt, for `generated-dockerfile` | yes, with newer pins kept |
| `.github/dependabot.yml` | adapt, when absent | never once present |
| `.github/workflows/opscrew-deploy.yml` | provision | yes, with newer pins kept |
| runtime `compose.yaml`, `Caddyfile` | provision | yes, with newer pins kept |

## Image record (in GHCR)

The image index for `ghcr.io/<repo>:<sha>` holds the image manifest plus two buildx attestation
manifests: the SBOM (SPDX) and the provenance (SLSA, mode=max). With `supplyChain.sign`, a cosign
signature sits next to it. The deploy uses the index digest.
