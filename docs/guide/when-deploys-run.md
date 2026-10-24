# When a push deploys your app

Each deploy workflow OpsCrew writes runs on a push to the branch its environment follows, but only
when the push changes a path the run reads. A push that changes only your README, another app's
folder or OpsCrew's reports deploys nothing.

## The paths a deploy reads

A push deploys the app when it changes any of these:

- **The app's folder** (`app.buildContext` in `opscrew/plan.yaml`), with everything in it.
- **The folders and files in `app.sharedPaths`**: what the build uses outside the app's folder,
  such as the workspace packages of a monorepo.
- **The repository root's files, except Markdown**, for a Node.js site in a folder: the
  workspace's `package.json`, lockfile and workspace file, `.npmrc`, `tsconfig.base.json`,
  `turbo.json` and the like.
- **The Dockerfile** the app's image is built from, also when it lies outside the app's folder.
- **The files OpsCrew wrote that the run reads**: the compose file, the proxy's configuration and
  the other files the deploy copies to the server, or the Portainer stack.
- **The workflow file itself.**

An app whose folder is the repository root reads nearly everything, so its deploy runs on any
push except one that changes only OpsCrew's own files under `opscrew/`, other deploy workflows, or
the folders of the repository's other apps.

## Add a folder the build uses

Design fills `app.sharedPaths` with the local workspace packages it finds your build using. When
your build reads something else outside the app's folder, add it to `opscrew/plan.yaml`:

```yaml
app:
  sharedPaths:
    - packages/ui
    - packages/config
    - shared/theme.css
```

Each entry is a path from the repository root: a folder (with everything in it) or a single file.
`.` stands for the whole repository, so every push deploys. A later `opscrew design` keeps your
entries. Run `npx opscrew provision` to write the workflow again with the new paths, and merge its
pull request.

## Pushes with many files

GitHub looks at only the first 300 changed files of a push when it checks a workflow's paths. A
push that changes more files (a large merge, a mass rename) can skip a deploy even though it
changed the app. When that happens, run the workflow by hand: open the repository's **Actions**
tab on GitHub, pick the app's deploy workflow and choose **Run workflow** on the deploy branch.
