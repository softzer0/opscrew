# Contract: `opscrew-preview`, the preview server's command

Owner: `packages/iac-templates/src/previews/` (T2204) renders it. Callers: the preview workflow
(T2205) through the preview key; `opscrew preview …` (T2210) through the environment's deploy key;
cron (`gc`). The host plan (T2206) installs it at `/srv/apps/<app>/bin/opscrew-preview`, where
`<app>` is the preview environment's app name (`shop-preview`).

## How it gets its request

- **Through the preview key** (`restrict,command="/srv/apps/<app>/bin/opscrew-preview"`):
  `SSH_ORIGINAL_COMMAND` holds the request; the script's own arguments are empty. Only `up`, `down`
  and `list` are allowed this way.
- **Otherwise** (the deploy key, cron): the script's arguments are the request; every command is
  allowed.

The request is split on single spaces into at most 4 words; anything else (other whitespace, quotes,
`;`, `$`, a fifth word, an empty request) is refused before anything is read or written.

## Requests

| Request | Arguments | Through the preview key | Does |
|---|---|---|---|
| `up <n> <image> <commit>` | `n`: `^[1-9][0-9]{0,5}$`; `image`: `^<IMAGE_NAME>@sha256:[0-9a-f]{64}$` with the recipe's `IMAGE_NAME`; `commit`: `^[0-9a-f]{40}$` (the pull request's head, shown to people). Stdin: the registry token, one line, at most 4096 bytes | yes | creates preview `n` (cap checked) or updates it |
| `down <n>` | `n` as above | yes | removes preview `n`; nothing to remove is success |
| `list` | none | yes | one line per preview |
| `gc` | none | no | `down` for each preview idle longer than `LIFETIME_DAYS` |
| `logs <n>` | `n` as above | no | the last 200 lines of each of the preview's containers |

## Output and exit codes

Whatever the steps print (pulls, the release command, the seed, containers) goes to
`/srv/apps/<app>-pr-<n>/up.log` on the server, never to the caller. The caller gets only the
script's own lines; the last line is always `opscrew-preview: <state> <detail>`:

| Exit | State | Detail | When |
|---|---|---|---|
| 0 | `running` | `pr-<n>.<base>` | `up` succeeded (created or updated) |
| 0 | `removed` | `<n>` | `down` succeeded, or there was nothing to remove |
| 0 | `listed` | `<count>/<cap>` | `list` |
| 2 | `refused` | one of `request`, `number`, `image`, `commit`, `token`, `command` | the request breaks a rule above; nothing was changed |
| 3 | `cap` | `<count>/<cap>` | a new preview while `count` previews exist and `count >= CAP` |
| 4 | `failed` | one of `pull`, `release`, `start`, `health`, `edge` | `up` failed at that step; on an update the rollback script put the previous image back, on a creation nothing is routed |
| 5 | `seed-failed` | `pr-<n>.<base>` | the preview runs but its seed command failed; the next `up` tries the seed again |
| 6 | `busy` | `<seconds>` | a lock was held longer than 600 seconds |

`list` prints, before its last line, one line per preview:
`<n> <state> <commit> <created> <updated> <digest>` where `state` is `running`, `seed-failed` or
`failed`, times are seconds since 1970 and `digest` is the image's `sha256:` value.

## Rules the script keeps

- Every value it writes into a file or a command comes from `settings.env` (validated by OpsCrew
  before rendering), from `template/`, from `values.env`, from a request word that matched its
  pattern, or from `/dev/urandom` in the format a placeholder names.
- Each `up` fills `template/` again, so a changed recipe reaches the preview; a generated value is
  made once, the first time its name appears, kept in the preview's `secrets.env` (0600), and reused.
- The seed runs after a successful start while `.seeded` is absent; `.seeded` is written when it
  succeeds.
- Locks: the recipe's `.lock` only while counting previews and creating a new preview's folder; the
  preview's own `.lock` for its `up`, `down` and `gc`; `list` and `logs` take none.
- The registry login lives in the preview's `.docker` folder only while `up` runs.
- `down` can be repeated and finishes a removal a cancelled run left half done.
- Every `up`, `down` and `gc` appends one line to `/srv/apps/<app>/previews.log`: the time, the
  request's command and number, the caller (`key` or `local`), and the state.
