# How OpsCrew builds your app's image

Your app runs on the server as a container image. OpsCrew builds that image in your repository's
GitHub Actions on every deploy, with one of four builders, and holds every builder to the same
security baseline. You do not need to write a Dockerfile.

## How OpsCrew chooses

`npx opscrew design` picks the builder and says why in one sentence. It records the choice in
`opscrew/plan.yaml`, under `app.build`, and `npx opscrew status` shows it again later. It goes in
this order:

1. **Your own Dockerfile**, when the repository already has one. OpsCrew uses it as it is.
2. **OpsCrew's Dockerfile**, for the Node.js and Python apps it has one for: Next.js, Node.js
   servers such as Express, Fastify, NestJS, Hono or Koa, static sites (Vite, Astro, Angular,
   Create React App), FastAPI, Django and Flask. It works with npm, pnpm and Yarn, and with pip,
   Poetry, Pipenv and uv.
3. **Cloud Native Buildpacks** (Paketo), for Go, Java, .NET and Ruby, when the pinned Buildpacks
   builder offers the app's runtime version.
4. **Railpack** for everything else: Bun projects (Railpack builds and runs them with Bun), Rust,
   PHP (Laravel), other languages, and Go, Java, .NET or Ruby versions that Buildpacks does not
   offer. Railpack also replaces Buildpacks when the build
   needs a secret value, because Buildpacks has no way to keep one out of the image.

The same project always gets the same builder, and running design again with nothing changed
changes nothing.

## The comparison behind the order

OpsCrew built its example apps with every builder that applies to them and compared the results.
The builder OpsCrew picks for each app is in bold. Build times are in seconds, for a first build
and a repeat build with the cache; they were measured on one machine and vary by about 20%.
Buildpacks times leave out a one-off setup step that takes a few seconds on GitHub's runners.
Vulnerabilities are the HIGH and CRITICAL findings of a Trivy scan on the day of the comparison
(2026-10-18).

| App | Builder | Image size | Build, first / repeat | Runs as | HIGH / CRITICAL | Starts |
|---|---|---|---|---|---|---|
| Next.js 16 with Postgres (npm) | Buildpacks | fails: it cannot build Next.js 16 | | | | |
| | Railpack | 1,113 MB | 53 / 33 s | root¹ | 51 / 0 | yes |
| | **OpsCrew's Dockerfile** | 304 MB | 31 / 38 s | uid 1000 | 11 / 0 | yes |
| Express API (npm) | Buildpacks | 514 MB | 34 / 23 s | uid 1002 | 45 / 0 | yes |
| | Railpack | 657 MB | 37 / 21 s | root¹ | 51 / 0 | yes |
| | **OpsCrew's Dockerfile** | 272 MB | 11 / 12 s | uid 1000 | 11 / 0 | yes |
| FastAPI with Redis (pip) | Buildpacks | 527 MB | 35 / 17 s | uid 1002 | 19 / 0 | yes |
| | Railpack | 571 MB | 67 / 23 s | root¹ | 47 / 0 | yes |
| | **OpsCrew's Dockerfile** | 240 MB | 25 / 4 s | uid 10001 | 48 / 0 | yes |
| Django with Postgres (pip) | Buildpacks | 693 MB² | 42 / 20 s | uid 1002 | 19 / 0 | yes |
| | Railpack | 600 MB | 25 / 14 s | root¹ | 47 / 0 | yes |
| | **OpsCrew's Dockerfile** | 270 MB | 15 / 4 s | uid 10001 | 48 / 0 | yes |
| Static site (Vite) | Buildpacks | 209 MB | 36 / 19 s | uid 1002 | 15 / 0 | yes |
| | Railpack | 221 MB | 23 / 11 s | root¹ | 47 / 0 | yes |
| | **OpsCrew's Dockerfile** | 163 MB | 18 / 15 s | uid 65534 | 8 / 0 | yes |
| Web app in a pnpm workspace | Buildpacks | fails: it has no pnpm support | | | | |
| | Railpack | 1,383 MB | 55 / 36 s | root¹ | 53 / 0 | yes |
| | **OpsCrew's Dockerfile** | 339 MB | 46 / 47 s | uid 1000 | 13 / 0 | yes |
| Go API | **Buildpacks** | 204 MB | 32 / 21 s | uid 1002 | 21 / 0 | yes |
| | Railpack | 159 MB | 20 / 12 s | root¹ | 43 / 0 | yes |
| Rails API (Ruby 4.0.6) | **Buildpacks** | 731 MB | 52 / 17 s | uid 1002 | 13 / 1 | yes |
| | Railpack | 1,033 MB | 81 / 15 s | root¹ | 43 / 1 | yes |
| Laravel app | Buildpacks | 1,095 MB | 89 / 24 s | uid 1002 | 19 / 0 | no: its web server does not route Laravel |
| | **Railpack** | 1,637 MB | 62 / 36 s | root¹ | 141 / 4 | yes |
| Spring Boot API (Maven) | **Buildpacks** | 530 MB | 104 / 32 s | uid 1002 | 29 / 6 | yes |
| | Railpack | 954 MB | 74 / 33 s | root¹ | 48 / 3 | yes |
| .NET API | **Buildpacks** | 427 MB | 120 / 44 s | uid 1002 | 25 / 2 | yes |
| | Railpack | 1,201 MB | 81 / 28 s | root¹ | 131 / 4 | yes |
| Rust API | **Railpack** | 153 MB | 64 / 14 s | root¹ | 43 / 0 | yes |

¹ Railpack's own images run as root. OpsCrew adds a final layer that runs the app as user 10001.

² With Python 3.13 set. Without a version setting, Buildpacks uses Python 3.11, which Django 6.1
does not support, so OpsCrew always passes the app's Python version to Buildpacks.

In short: for Node.js and Python, OpsCrew's own Dockerfile gives images about half the size and
builds what Buildpacks cannot. For Java, .NET and Ruby, Buildpacks gives much smaller images than
Railpack, which keeps development dependencies and, for .NET and Java, the full SDK. For Go,
Railpack's image is a little smaller, but Buildpacks builds it as non-root without an extra layer,
with fewer vulnerabilities in the measured build.

## Choosing another builder

Set the builder in `opscrew/plan.yaml` and mark it as your choice:

```yaml
app:
  build:
    builder: railpack   # generated-dockerfile, own-dockerfile, buildpacks or railpack
    chosen: user
```

`generated-dockerfile` is OpsCrew's Dockerfile, and `own-dockerfile` the one in your repository.
Then run, in order:

1. `npx opscrew design` checks your choice and keeps it. When the builder cannot build your app (for
   example Buildpacks with pnpm, Bun or Rust, OpsCrew's Dockerfile for a Bun project, or a runtime
   version the builder does not offer), it says why and which builder works, and leaves
   `plan.yaml` as it is.
2. `npx opscrew adapt` writes OpsCrew's Dockerfile in its pull request, when you chose that one.
3. `npx opscrew provision` updates the deploy workflow.

To let OpsCrew choose again, set `chosen: auto` and run `npx opscrew design`.

## The baseline every image meets

- **It runs as a non-root user.** OpsCrew's Dockerfiles create one, Buildpacks images run as user
  1002, and Railpack images get a final layer that runs the app as user 10001. For Rails and
  Laravel, that layer also gives the user the folders the framework writes to (`tmp`, `log`,
  `storage`, `db` for Rails; `storage`, `bootstrap/cache`, `database` for Laravel).
- **Everything is pinned.** Base images (OpsCrew warns when it could only pin a tag), the
  Buildpacks builder and run images and Railpack's frontend are pinned by digest, the GitHub
  Actions by commit, and the pack and Railpack versions exactly. The Railpack download is checked against its SHA-256 checksum.
- **No secret is in the image.** Secret build values reach the build only as secret mounts, never as
  build arguments, so they are not in any layer, the image configuration or the provenance record.
- **It is scanned.** After each build, Trivy lists the image's HIGH and CRITICAL vulnerabilities in
  the workflow run. The scan reports and does not stop the deploy. Turn it off with
  `security.imageScan: false` in `opscrew/plan.yaml`.

## Your own Dockerfile

When your repository has a Dockerfile, OpsCrew builds with it and never changes it. `npx opscrew
adapt` checks it against the baseline and lists each finding with its fix in its pull request:

- the image runs as root (no `USER`, or `USER root`);
- a base image uses `latest` or no tag;
- a base image is pinned by tag only, not by digest;
- a secret value is written into an `ENV` or `ARG` line;
- a build argument's name says it holds a secret (`ARG NPM_TOKEN`), even without a value: a value
  passed with `--build-arg` is recorded in the image history, so the fix is a BuildKit secret mount
  (`RUN --mount=type=secret,id=NPM_TOKEN,env=NPM_TOKEN npm ci`).

The app must listen on the port in its `PORT` variable and answer its health route. When the new
version does not start or fails its health check, the deploy stops, the running version keeps
serving, and the message names the builder OpsCrew would choose and how to switch to it: set
`app.build.builder` to it and `app.build.chosen: user` in `opscrew/plan.yaml`, then run
`opscrew design`, `opscrew adapt` and `opscrew provision`.

## Runtime versions

Every builder uses the runtime version your app declares:

- Node.js: `engines.node` in `package.json`, `.nvmrc` or `.node-version`;
- Python: `requires-python`, `.python-version`, `runtime.txt` or the Pipfile;
- Ruby: `.ruby-version` or the Gemfile;
- Go: `go.mod`;
- Java: the release level in `pom.xml` or the Gradle build;
- .NET: the target framework in the project file;
- PHP: `require.php` in `composer.json`;
- Rust: `rust-toolchain.toml` or `rust-toolchain`.

An exact version is used as declared and never raised. OpsCrew only warns when it no longer gets
security fixes. Go is the exception: OpsCrew reads the `go` line of `go.mod` (or its `toolchain`
line, which wins) as a minimum within its release line, so `go 1.25.3` is a range that allows
1.25.3 and any later 1.25 release, never 1.26. For a range such as `>=3.11`, OpsCrew keeps the
version recorded in `opscrew/plan.yaml` when it is inside the range. Otherwise it picks the newest
version Buildpacks offers inside it (Go, Java, .NET, Ruby), or its default when the range allows
it, else the newest version the range names (Node.js, Python). It never picks one outside the
range.

When a Node.js or Python app declares nothing, OpsCrew looks for other evidence first:

- the version your own CI workflows set up (`node-version` or `python-version`);
- `.tool-versions` or `mise.toml`;
- the `FROM` line of an existing Dockerfile;
- the major version of `@types/node`;
- the Python versions your Django release supports.

Only without any of these does it use its default:

| Node.js | Python | Go | Java | .NET | Ruby | PHP | Rust |
|---|---|---|---|---|---|---|---|
| 24 | 3.14 | 1.26 | 25 | 10.0 | 3.4 | 8.4 | 1.98 |

These are the current Node.js LTS release and, for the other languages, a well-established release
rather than the newest one.

The chosen version is recorded in `app.build.runtime.version` in `opscrew/plan.yaml` and kept on
later runs: a newer OpsCrew default never moves your app. When your repository has no version file,
the adapt pull request adds one (`.nvmrc`, `.python-version`, `.ruby-version` or
`rust-toolchain.toml`), so the version is written down in your repository too.

Moving to a new major version is up to you, because your libraries may not support it yet.
Dependabot proposes only minor and patch updates for the Node.js and Python images (see
[The image supply chain](supply-chain.md)). To move, change the version your app declares (for
example `.nvmrc`), or `app.build.runtime.version` when it declares none, and run
`npx opscrew design`. OpsCrew warns that libraries may break.

## Production settings for Rails and Laravel

Rails and Laravel start in development mode unless they are told otherwise. So
`npx opscrew design` adds their production settings to `app.env` in `opscrew/plan.yaml`, and
`npx opscrew provision` gives them to the app on the server:

- Rails: `RAILS_ENV=production`, and a generated `SECRET_KEY_BASE`;
- Laravel: `APP_ENV=production`, `APP_DEBUG=false`, `LOG_CHANNEL=stderr` (the logs go to the
  container's output), and a generated `APP_KEY` in the format `php artisan key:generate` uses.

OpsCrew generates each key once, keeps it on your computer (in `~/.opscrew/projects/<project>/`)
and reuses it on later runs, so sessions and encrypted data stay valid. It never prints, logs or
commits the key.

To use your own value instead, do one of these:

- **In scripts,** put the value in the file that `OPSCREW_APP_ENV_FILE` names. A value there wins
  over OpsCrew's. In a terminal, OpsCrew does not take these settings from your project's `.env`,
  because that file holds your development values (such as `APP_ENV=local`).
- **Anywhere,** set the variable's `source` to `user` in `opscrew/plan.yaml`. Then
  `npx opscrew provision` asks you for the value in a terminal, or reads it from the
  `OPSCREW_APP_ENV_FILE` file in scripts. A later `npx opscrew design` keeps `source: user`, and
  `secret: true` too.

```yaml
app:
  env:
    - name: APP_KEY
      secret: true
      source: user
```

## Values the build needs

Most environment variables reach your app only when it runs on the server. Variables that a
frontend reads at build time go into the build instead: names starting with `NEXT_PUBLIC_`,
`VITE_`, `REACT_APP_`, `PUBLIC_`, `NUXT_PUBLIC_`, `EXPO_PUBLIC_` or `GATSBY_`. The values of these
variables are compiled into the JavaScript your visitors download, so anyone can read them. Never
put a secret in them.

`npx opscrew provision` stores these values as GitHub Actions secrets, like the others. OpsCrew
treats the ones not marked secret as public: with a Dockerfile they are build arguments, which the
image's provenance record lists. The ones marked secret in `opscrew/plan.yaml` (`secret: true` on
the variable) reach the build only as secret mounts, so they are not in the build arguments, the
image configuration or the provenance. Whatever your code compiles into the frontend is still
public.
