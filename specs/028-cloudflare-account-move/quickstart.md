# Quickstart: Moving an app to another Cloudflare account

**Status**: DRAFT, revised after the lead's review. The user's guide page is
`docs/guide/cloudflare-move.md` (T2825); this file walks implementers and the lead through it.

## A user moves one app

Before: the app runs behind Cloudflare in account A, and `CLOUDFLARE_API_TOKEN` is A's token.

0. **Bring the app's files up to date** if they were made by an older OpsCrew: a Workers site's
   root and the deploy workflows gained what the move needs. Prepare stops and says so otherwise:

   ```bash
   npx opscrew provision     # then commit and push what it wrote
   ```

1. **Make account B and its token.** In B's dashboard, a token with the permissions OpsCrew's guide
   lists for A, on B, plus Zone → Zone → Edit for all zones of B (to add the domain), and the account
   permissions the app uses (Cloudflare Tunnel, Access, Workers R2 Storage, Workers Scripts). Turn
   Zero Trust and R2 on in B when the app uses them. Redo in B what OpsCrew doesn't move (the guide's
   list: the zone's plan, your own rules and settings, Email Routing…).

   ```bash
   export OPSCREW_NEW_CLOUDFLARE_API_TOKEN=…   # B's token; CLOUDFLARE_API_TOKEN stays A's
   export OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN=…  # a site on Cloudflare's hosting: B's Workers Scripts → Edit only
   ```

2. **Prepare**, in the app's repository:

   ```bash
   npx opscrew cloudflare move --to <B account id>
   ```

   OpsCrew checks both tokens, lists the other OpsCrew apps it finds in the zone, shows the summary
   and asks to start. Then each plan is shown and approved in turn: B's zone and the copied records,
   B's rules and origin TLS, B's records, tunnel, Access, Worker and buckets, B's connector beside
   A's, B's credentials added to GitHub, the first bucket copies, the mark. A keeps serving, and
   deploys keep working.

   With an R2 bucket: once B's bucket exists, OpsCrew asks for its key (R2 → Manage API tokens in B,
   limited to that bucket), or reads `OPSCREW_NEW_STORAGE_ACCESS_KEY_ID` /
   `OPSCREW_NEW_STORAGE_SECRET_ACCESS_KEY` (`OPSCREW_NEW_OFFSITE_…` for the snapshots' bucket).

3. **Every other app in the zone** prepares the same way from its own repository.

4. **Switch**, from any one of those repositories, with the registrar's credentials set
   (`PORKBUN_API_KEY` and `PORKBUN_SECRET_API_KEY`, `NAMECHEAP_API_USER` and `NAMECHEAP_API_KEY`, or
   `GODADDY_API_TOKEN`):

   ```bash
   npx opscrew cloudflare move --switch
   ```

   It refuses, naming the hostnames, while an app in the zone isn't prepared. With DNSSEC on, the
   first approval removes the DS record and the run stops: run it again after the time it prints (24
   to 48 hours), and approve again. Then the domain typed, the nameservers set, the wait for B's zone,
   the sites' custom domains attached, the certificates, and the measured gap. At Cloudflare
   Registrar or another registrar it prints what to do and goes on when run again.

5. **Finish**, in each repository, right after the switch (origin-protected apps first, as the
   switch's output lists them):

   ```bash
   npx opscrew cloudflare move --finish
   ```

   With an R2 bucket: the maintenance window (its length shown first). Then the secrets and one
   deploy, the connector, the state, and A's pieces after typing the app's name and each bucket's
   name. The app's mark goes last.

6. **Once every app in the zone is finished**, set `CLOUDFLARE_API_TOKEN` to B's token and the other
   `OPSCREW_NEW_*` values to their plain names; unset the `OPSCREW_NEW_*` variables. Commit `opscrew/`
   (the `terraform.tfvars.json` files now carry B's ids, and nothing else changed in them).

**Abort**, in each prepared repository, only before the switch changed anything:
`npx opscrew cloudflare move --abort`. Once the nameservers or the DS record changed, the move goes
on; moving back later is a move from B to A.

**In a script:** every step stops at each plan with its hash; run it again with `--approve <hash>`,
`--confirm <name>` for each typed name (the app, each bucket, the domain at the switch, the zone at
an abort), and `--allow-downtime` for the finish's window.

**Status:** `npx opscrew status` shows the move's step per environment, and the apps prepared when
`OPSCREW_NEW_CLOUDFLARE_API_TOKEN` is set; Claude Code's `opscrew_status` shows the same and names
the command to run in the terminal.

## Running the fakes

```bash
pnpm turbo run typecheck --filter=@opscrew/agents
npx vitest run --root packages/agents src/cloudflare-move
npx vitest run --root packages/cli test/e2e/cloudflare-move.test.ts
```

## The lead runs the spike, the rehearsal and the real move of opscrew.dev

The live pass is the real move of opscrew.dev, with every OpsCrew app it serves, from today's
account (A) to the new account the founder is making (B). It runs once, in legs over hours or days.

### What the founder provides

- **Account B** (free plan unless A's zone has a paid plan: see the checklist), with R2 and Zero
  Trust turned on. R2 asks for a payment method when it is turned on, even within its free tier.
- **Tokens for B** with the permissions above (`OPSCREW_E2E_MOVE_TOKEN_B`), and an R2 key in each
  account with Object Read & Write on every bucket (the pass's buckets come and go).
- **Where opscrew.dev is registered**, and the registrar's API keys if it is Porkbun, Namecheap or
  GoDaddy; at Cloudflare Registrar, the founder starts its move between accounts in A's dashboard
  and accepts it in B's when L4b asks.
- **A time** for the switch: opscrew.dev is on `.dev`, which browsers only reach over HTTPS
  (HSTS-preloaded), so the certificate gap is an outage for its visitors.

### Variables (`.env.e2e`, never committed)

| Variable | What |
|---|---|
| `OPSCREW_E2E_CLOUDFLARE_MOVE` | `1` runs the pass. |
| `OPSCREW_E2E_MOVE_ZONE` | `opscrew.dev`. |
| `OPSCREW_E2E_MOVE_TOKEN_A`, `OPSCREW_E2E_MOVE_ACCOUNT_A` | A's token (today's) and account id. |
| `OPSCREW_E2E_MOVE_TOKEN_B`, `OPSCREW_E2E_MOVE_ACCOUNT_B` | B's token and account id. |
| `OPSCREW_E2E_MOVE_R2_KEY_A_ID`, `…_A_SECRET`, `…_B_ID`, `…_B_SECRET` | An R2 key per account. |
| `OPSCREW_E2E_MOVE_DEPLOY_TOKEN_B` | B's Workers deploy token, when the zone serves a site on Cloudflare's hosting. |
| `PORKBUN_*`, `NAMECHEAP_*` or `GODADDY_API_TOKEN` | Only when opscrew.dev is at one of them (L4a). |
| `OPSCREW_E2E_HCLOUD_TOKEN`, `OPSCREW_E2E_GITHUB_TOKEN`, `OPSCREW_E2E_GITHUB_REPO`, `OPSCREW_E2E_GITHUB_REPO_B`, `OPSCREW_E2E_GHCR_READ_TOKEN` | As for the other passes: P's repository and Q's. |

### Order

1. **The spike** (T2802), on opscrew.dev's zone itself: a pending zone in B serves nothing, so it is
   safe while A serves. Its answers go into research R10 and the plan before wave 3.
2. **The rehearsal** (L0 to L2) on the final code: preflight, P and Q provisioned in A under load,
   prepare P to B, then abort: B holds nothing, A unchanged, no request failed.
3. **The real move** (L3 to L6): prepare P, Q and every real app (the lead runs each real app's
   prepare from its repository, per the checklist); the switch from this repository, with L4a (a
   registrar OpsCrew drives) or L4b (Cloudflare Registrar's dashboard move), whichever L0 found;
   every finish; the checks, the leak scan, P and Q destroyed.

```bash
PATH="$PWD/.tools/bin:$PATH" OPSCREW_TEST_TMP=D:/opscrew-test-tmp \
  npx vitest run --root packages/cli test/live/cloudflare-move.test.ts -t "L0"
```

Each leg runs on its own with `-t "<leg>"`; a leg that stops on a wait (DS records, activation, the
certificate) is run again after it.

### The lead's checklist (T2827)

- The OpsCrew apps the zone serves and their repositories (kept locally, never in these files).
- What OpsCrew doesn't move, as L0's inventory of A lists it (the zone's plan, rules and settings of
  the user's own, Email Routing, Workers or Pages projects and R2 buckets OpsCrew didn't make,
  Turnstile, analytics, Zero Trust settings beyond the organization and PIN login, tokens, members,
  notifications): each redone in B before the switch, or let go.
- The registrar and DNSSEC (L4a or L4b; the DS wait when DNSSEC is on).
- After the finish: `.env.e2e`'s Cloudflare tokens for the zone (`OPSCREW_E2E_CLOUDFLARE_TOKEN` and the
  others that reach it) become B's tokens; R2 on in B for the passes that use it.

### Cost and time

- P's server and Q's throwaway server for a few hours: a few cents. R2 within the free tier, no
  egress fees. B on Cloudflare's free plan unless A's zone is on a paid one. The registrar charges
  nothing for a nameserver change.
- Activation takes up to an hour on a free zone (Cloudflare re-checks it at most hourly); Universal
  SSL minutes, at worst 24 hours; DNSSEC adds 24 to 48 hours before the nameserver change.

### What goes into `docs/e2e-coverage.md`

The run's row (N of M legs) and its results: the nameserver change → active, active → certificate,
each hostname's first good answer, the custom domains' attach and certificates, the failures the
load saw before the switch (must be 0) and during it, what A's and B's nameservers answered while B
was pending and after activation, the R2 copy's figures and the window's length, the inventories of
A before and after, and the leftovers check.
