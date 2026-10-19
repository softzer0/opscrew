# The image supply chain

Every image OpsCrew builds says what is in it and where it came from, and OpsCrew keeps the images
and the tools behind them current. This page shows how to read that record, how to sign images,
how updates reach you, and how deploys can be tagged and old images cleaned up.

## What is in an image, and where it came from

Each image is pushed to GitHub Container Registry as `ghcr.io/<owner>/<repo>:<commit>` together
with two records:

- an **SBOM** (software bill of materials): every package in the image, with its version;
- a **provenance** record: the workflow run that built the image, the repository and the commit.

Anyone who can pull the image can read both. For a private repository, log in first with
`docker login ghcr.io`. Then:

```bash
docker buildx imagetools inspect ghcr.io/<owner>/<repo>:<commit> --format '{{json .Provenance}}'
docker buildx imagetools inspect ghcr.io/<owner>/<repo>:<commit> --format '{{json .SBOM}}'
```

`<owner>/<repo>` is your repository in lower case, and `<commit>` the full commit hash. The deploy
run's summary also shows the image's digest, which you can use instead of the tag
(`ghcr.io/<owner>/<repo>@sha256:…`).

The provenance never holds a secret value or GitHub's event data, such as commit messages or email
addresses. Build values that are not secret can appear in it (see
[Values the build needs](builders.md#values-the-build-needs)).

## Signing images

Signing is off by default. When it is on, the deploy workflow signs each image with
[cosign](https://docs.sigstore.dev/)'s keyless signing: there is no key to keep, and the signature
is stored next to the image. Turn it on in the interview, or with `supplyChain.sign: true` in
`opscrew/plan.yaml`, then run `npx opscrew provision`.

**For a private repository, signing makes its name public.** Keyless signatures are recorded in
Sigstore's public transparency log, and each entry shows the repository's name and the path of the
deploy workflow. OpsCrew says so in the interview before you turn it on.

To check a signature, with cosign installed:

```bash
cosign verify ghcr.io/<owner>/<repo>@sha256:<digest> \
  --certificate-identity "https://github.com/<owner>/<repo>/.github/workflows/opscrew-deploy.yml@refs/heads/main" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The identity is the deploy workflow on your deploy branch: use your branch instead of `main` if it
has another name, and the path in `cicd.workflowPath` (in `opscrew/plan.yaml`) if you changed it.
To accept any workflow of your repository instead, replace `--certificate-identity "…"` with
`--certificate-identity-regexp '^https://github.com/<owner>/<repo>/'`.

## Updates with Dependabot

OpsCrew pins every image and tool it uses to an exact version, and GitHub's Dependabot keeps those
pins current. When your repository has no `.github/dependabot.yml`, the pull request that
`npx opscrew provision` opens with the deployment setup adds one, together with the deploy workflow
and the Compose files it watches, so Dependabot's first check finds them. It covers:

- your app's packages (npm, pnpm and Yarn, Bun, pip, Poetry, Pipenv, uv, Bundler, Go modules,
  Composer, Cargo, NuGet, Maven or Gradle, whichever your app uses);
- the base images of the Dockerfile, when the image is built from one;
- the images in OpsCrew's Compose files (`opscrew/runtime`): Postgres, the cache, Caddy and the
  others;
- the GitHub Actions in your workflows.

Dependabot checks weekly. Minor and patch updates come grouped, one pull request per ecosystem, so
you get few of them. Major updates of your libraries come as separate pull requests. The Node.js,
Python, Caddy and Postgres images get no major updates at all: a new major version can break your
app's libraries, and a new Postgres major cannot read the old one's data. Those moves are yours (see
[Runtime versions](builders.md#runtime-versions)).

When your repository already has a Dependabot configuration, OpsCrew leaves it as it is and lists
the entries it would add, in the output of `npx opscrew provision` and in that pull request.

When Dependabot updates a pin in a file OpsCrew generated, OpsCrew keeps the newer pin on the next
`npx opscrew provision` and does not put the old one back.

## Deploy tags

OpsCrew can tag each deploy that passes its health check. The tag is named after the time of the
deploy in UTC, such as `deploy-20261018-142233`, and points at the deployed commit, so you can see
what ran when and find the version to go back to. Optionally, each tag also gets a GitHub Release
that names the image's digest. A deploy that fails gets neither.

Tags are off by default. Turn them on in the interview, or in `opscrew/plan.yaml`:

```yaml
cicd:
  deployTags:
    enabled: true
    release: true   # also a GitHub Release with the image digest
```

then run `npx opscrew provision`. Only the tagging step may write to your repository. Tags made by
the deploy start no other workflow, so do not build anything that waits for them.

## Old images are cleaned up

Each deploy adds an image to GitHub Container Registry. After each healthy deploy, OpsCrew keeps the
newest 10 deployed images, with their SBOM, provenance and signature, and deletes older ones. It
never deletes the image that is running or the one before it, so the previous version stays
available. Images you tagged yourself are kept too. The intermediate images that Buildpacks and
Railpack builds leave behind are always deleted.

To keep more or fewer, set `cicd.imageRetention.keep` (2 to 100) in `opscrew/plan.yaml`. To keep
every deployed image, set `cicd.imageRetention.enabled: false`. Then run `npx opscrew provision`.
