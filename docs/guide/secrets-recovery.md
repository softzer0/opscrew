# The recovery copy of your app's secrets

OpsCrew generates secrets for your app (database passwords, service keys, the deploy key) and keeps
them, with the infrastructure state, on the computer that ran `npx opscrew provision`. GitHub only
holds them as write-only deploy secrets. If that computer is lost, so are they, and a new computer
could not manage the deployment without resetting every database.

The recovery copy fixes that. OpsCrew keeps an encrypted copy of these files in your repository, as
`opscrew/secrets.sops.json`, and optionally in a folder you choose. Only your own key opens it. On a
new computer you restore everything with that key, and the next provision reuses it all: nothing is
generated again, and your data stays as it is.

## What is in the copy

Everything OpsCrew keeps on your computer for the app and cannot rebuild:

- the generated values (service passwords and keys, route-job secrets) and the deploy key;
- the infrastructure state and its passphrase;
- OpsCrew's records of the server and of the app's Cloudflare settings;
- in your Portainer, the stack's key, webhook and Portainer password files.

Values you supplied yourself (provider tokens, your app's own API keys, the storage key) are not in
it: they are already yours. Neither is history, such as approvals, costs and saved plans.

The copy is made with [SOPS](https://github.com/getsops/sops) and [age](https://age-encryption.org):
each value is encrypted with AES-256-GCM, and the data key is sealed to your age key and, if you add
one, a backup key. You can open it without OpsCrew (see below).

## The first time

The first `npx opscrew provision` that has secrets to keep asks:

1. whether you already have an age key: paste its public key (`age1…`), or leave it empty;
2. otherwise, where to write your new key: a full path outside the repository and outside
   `~/.opscrew`, for example `~/opscrew-shop-age-key.txt`. OpsCrew writes the key there once,
   readable only by you, and never prints it;
3. whether to add a second, offline backup key (its public key, `age1…`).

Then move the key file into your password manager and delete the file. OpsCrew keeps no copy of the
key, so without it (or the backup key) nobody, including you, can open the copy.

In a script, name the key file with `--key-out <path>`:

```bash
npx opscrew provision --approve <hash> --yes --key-out ~/opscrew-shop-age-key.txt
```

Without it, a script makes no copy yet and says how to make one.

**A public repository.** Before the copy is first committed to a public repository, OpsCrew warns
you: anyone can keep the encrypted file and try to open it later, and the names of the files it
holds are readable, though not their contents. A terminal asks once and remembers your answer. A
script writes only the folder copy (when you set a folder) and says how to commit it.

## Keeping it current

Whenever one of these files changes, the next pull request from `npx opscrew provision` (or from
`npx opscrew retarget --finish`) carries the updated copy. When you set a folder, OpsCrew writes the
folder copy at once.

```bash
npx opscrew secrets status          # last update, how many keys open it, whether it is behind
npx opscrew secrets folder ~/Backups/opscrew   # also write the copy there, as <app>.sops.json
npx opscrew secrets folder --none   # stop writing the folder copy
```

`npx opscrew status` shows the same: when the copy was last updated, how many keys open it, and
whether it is behind the files on your computer.

OpsCrew fetches the pinned sops version itself and checks its checksum, so you install nothing (set
`OPSCREW_SOPS_BIN` to use your own sops). If it cannot fetch sops, it says so, leaves your files as
they are, and the copy shows as behind until the next run.

## Restoring on a new computer

```bash
git clone https://github.com/<you>/<app>.git && cd <app>
npx opscrew secrets restore --key-file ~/opscrew-shop-age-key.txt
npx opscrew provision
```

Without `--key-file`, `restore` asks you to paste the key, without showing it. `--from <file>`
restores from another copy, such as the folder copy.

- **A wrong key** stops the restore: nothing is written.
- **Files that differ.** When a file on this computer already exists and differs from the copy,
  for example after a restore from an older commit, OpsCrew writes nothing. It lists the files, and
  for the generated values the names that differ (never the values). Run the command again with
  `--use-copy` to take the copy's version, or `--keep-local` to keep this computer's and restore
  the rest.
- **The copy changed on another computer.** When the copy in the repository is not the one this
  computer last wrote, provision stops before changing anything and says to run
  `npx opscrew secrets restore` first.

## A new key

```bash
npx opscrew secrets rotate --key-out ~/opscrew-shop-age-key-2.txt
```

OpsCrew writes the new key to that file (a terminal asks for the path when you leave out
`--key-out`), encrypts the copy to it and proposes `opscrew/secrets.sops.json` and
`opscrew/.sops.yaml` in a pull request. The backup key stays; `--backup <age1…>` replaces it and
`--no-backup` drops it.

Older commits of the copy can still be opened with the old key. If the old key may have leaked,
change the secrets themselves too: the generated passwords, the deploy key and the state passphrase.

## Opening the copy without OpsCrew

The copy is a standard SOPS file:

```bash
SOPS_AGE_KEY_FILE=~/opscrew-shop-age-key.txt sops decrypt opscrew/secrets.sops.json
```

It prints a JSON object whose `files` hold each file's content by its path: `home/<name>` for the
files in `~/.opscrew/projects/<project>/`, and `state/<path>` for those in `.opscrew/`.

## From Claude Code

The OpsCrew plugin has the same tools. A new key goes only to the file you name (`keyOut`), and a
restore reads only a key file you name (`keyFile`). Claude never sees, prints or asks for the key
itself.

## Known limits

- **Losing both keys** means the copy cannot be opened. The secrets can still be reset through the
  normal flows, at the cost of resetting the services that use them.
- **The folder setting is per computer.** Set it again with `npx opscrew secrets folder` on a new
  computer.
