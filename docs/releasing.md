# Releasing OpsCrew

A release is the `opscrew` CLI on npm (`packages/cli`) and the Claude Code plugin, which pins the
same version. Follow these steps in order for every release.

## Before you start

- `main` is green: `pnpm check` and `node plugin/validate.mjs` pass, and the last CI runs on `main`
  succeeded.
- Every live test that covers what changed since the last release has passed, and
  [e2e-coverage.md](e2e-coverage.md) records the run.
- You have npm 11.15 or later (`npx -y npm@11.21.1` works too) and are logged in to npm with 2FA:
  `npm whoami` prints your user. Approving and unpublishing ask for a 2FA code; a token that
  bypasses 2FA cannot do either.

## 1. Choose the version

Until 1.0, raise the patch number (0.1.1 to 0.1.2). Raise the minor number (0.1.2 to 0.2.0) when
projects set up by the last release must be redone, for example when the files in `opscrew/`
change shape.

## 2. Write the changelog

List what changed since the last release:

```bash
git log --format='%h %s' v<last version>..HEAD
```

Add a section for the new version at the top of [CHANGELOG.md](../CHANGELOG.md), dated today
(UTC), and a link for it at the bottom. Write it for OpsCrew's users:
- sort the entries under Added, Changed, Fixed, Removed and Security (leave out empty headings);
- take them from the `feat`, `fix` and `perf` commits and from the guide pages that changed;
  leave out tests, refactors, specs and CI;
- say what a user notices, in plain words: name commands, flags and files, never task IDs or
  internal function names;
- link the guide page where a feature has one;
- include the Claude Code plugin's changes.

The GitHub release's notes are made from this section (step 5).

## 3. Bump the version and tag it

1. Set `version` in `packages/cli/package.json`.
2. Commit the changelog and the version together as `chore(release): <version>`.
3. Tag that commit and push both:

   ```bash
   git tag -a v<version> -m "OpsCrew <version>"
   git push origin main v<version>
   ```

The tag starts the Release workflow (`.github/workflows/release.yml`). It checks that the tag
matches `packages/cli`'s version, builds the CLI and stages it on npm through trusted publishing,
with no token. Watch it to the end with `gh run watch`.

## 4. Approve the staged version

The staged version is not public until a maintainer approves it:

```bash
npm stage list opscrew
npm stage approve <stage-id>
```

Or approve it on npmjs.com, under the package's Staged Packages. Then check that it is out:

```bash
npm view opscrew dist-tags.latest
npx -y opscrew@latest --version
```

To run the workflow again for the same version, first remove the staged one with
`npm stage reject <stage-id>`: npm refuses a version that is already staged.

## 5. Publish the GitHub release

Once npm has the version, publish its release on GitHub from the existing tag, with the
changelog's section as its notes:

```bash
node scripts/release-notes.mjs <version> > release-notes.md
gh release create v<version> --verify-tag --title "OpsCrew <version>" --notes-file release-notes.md
rm release-notes.md
```

The script makes the section's links absolute, at the tag, and adds the compare link.

## 6. Update the Claude Code plugin

Do this after npm has the version: the plugin's lockfile records its integrity from the registry.

1. Set `version` in `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and
   the exact `opscrew` version in `plugin/package.json`.
2. Regenerate the lockfile: run `npm install --package-lock-only --ignore-scripts` in `plugin/`.
3. Check it: `node plugin/validate.mjs` and `claude plugin validate plugin`.
4. Install it as Claude Code does: copy `plugin/package.json` and `plugin/package-lock.json` into
   an empty folder outside the repository and run `npm ci --ignore-scripts` there. Check that
   `node node_modules/opscrew/dist/opscrew.js --version` prints the new version, and that the size
   the plugin's README and [the plugin's guide page](guide/claude-code-plugin.md) give still holds.
5. Commit as `chore(plugin): <version>` and push. Watch the CI runs the push starts.
