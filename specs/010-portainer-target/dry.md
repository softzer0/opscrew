# DRY pass over features 000–010 (2026-10-17)

The founder found the "This project is not a git repository." check copied five times and asked
for a DRY pass. Two mechanical scans over the non-test source (blocks of 3+ normalised lines in two
or more places: 726; string literals of 30+ characters repeated: 108; scripts in `.tools/scratch`)
were triaged by four read-only reviewers. This file is the lead's record of their findings and
decisions. Tasks T1034–T1039 in `tasks.md` carry them out.

Rules for every task:
- **Behaviour, tests and rendered output stay the same** unless a line here says otherwise: same
  messages, same snapshots, same finding ids, severities and policy messages.
- **The safety core is not weakened.** In approval, typed-confirmation, redaction, deletion and
  purchase paths only the duplicated plumbing is merged. Write-retry rules, purchase answer
  classification, certificate pinning, the dead-man switch and plan hashes stay exactly as they are.
- **The reviewers' KEEP lists stay as they are.**
- **One wording per message:** where copies differed, the wording named here wins.

## C. Core, contracts, plan-schema, detect, iac-engine, runtime-claude, connectors (~230 lines)

1. **`zodIssues(error, max = 3, at = [])`** in `core/src/values.ts`. It replaces 8 copies (core
   http, fake-runtime, runtime-claude, detect, portainer client/inspect/plan, iac-engine
   `problems()`). The model-output mismatch message is built once, for the runtime and the fake
   alike.
2. **`parseAnswer(schema, value, provider, what, hint?)`** in `core/src/http.ts`. It replaces the 6
   provider copies (cloudflare, github, godaddy, namecheap, porkbun, portainer).
   - Wording: "<Provider> returned an unexpected answer when trying to <what>: <issues>."
   - The default hint is "The <Provider> API may have changed; please report this to OpsCrew."
   - Porkbun and Portainer keep their scrub/redaction.
3. **`checkRegistrationYears(years)`** in `core/src/errors.ts`. It replaces 6 copies.
   - Message: "A domain can be registered for 1 to 10 years, not N."
   - Hint: "Pass a whole number of years between 1 and 10."
4. **Registrar texts** in core:
   - `DOMAIN_TAKEN_REASON`;
   - `connectAfterBuyingHint(where, domain)` (9 copies; the word "instead" is dropped);
   - `NEW_PRICE_HINT`.
5. **Generic provider hints** in core:
   - `CONNECTION_HINT` ("internet");
   - `RATE_LIMIT_HINT`;
   - `statusPageHint(url)`;
   - `maybeDoneHint(where)`.
6. **`durationText(ms)`** in `core/src/text.ts` (on `plural`). It replaces hetzner, DO, iac-engine,
   github and the inline copies; agents' two copies are T1036's. Whole seconds and minutes only.
7. **`errorText(error, fallback?)`** in core. It covers the `verifyCredentials` catch blocks, and
   Hetzner and DO keep their fallback text. The agents and CLI copies are T1036's and T1038's.
8. **`stripBom`, `readTextIfExists` and `exists`** in `core/src/paths.ts`. These replace core's
   audit and state copies, plan-schema, and detect. Agents' `readIfExists` and `exists` become
   re-uses (T1036).
9. **`#parseJson(text, what, hint)`** in iac-engine's engine (3 copies).
10. **`requestJson` gains `query`, plus `jsonClient(options, { timeoutMs, retry })`**, used by the
    Hetzner and DO clients.
11. **`realSleep`** in core, replacing 11 lambdas in the connectors. Agents' 3 copies are T1036's.
12. **Unused existing helpers:**
    - `plural`, `isRecord`/`messageOf` and `normalizeHostName`;
    - `pollAction` for GitHub's `waitForWorkflowRun`;
    - `linesOf` in ssh-host `apply.ts`;
    - Hetzner's `TOKEN_HINT` and Cloudflare's `CLOUDFLARE_TOKEN_PAGE` exported and used.
13. **Repeated titles and texts:**
    - ssh-host `TITLES`;
    - the portainer plan titles;
    - `REGISTRY_ACCESS`;
    - detect's release-command tail (the Prisma note loses "yourself").
14. **Small helpers:** `isoDateOr(value)` in core, and runtime-claude's `#toolFields`.

KEEP:
- the hand-rolled HTTP loops of cloudflare, godaddy, github, namecheap and porkbun (their write and
  retry rules);
- purchase answer classification;
- GoDaddy's polling;
- ssh-host shell fragments;
- certificate pinning;
- apply-time ownership checks;
- approvals and policy;
- calls of `step`/`issue`;
- schemas and data;
- the Hetzner and DO factories and catalogs;
- the catalog memo;
- Portainer's create and update paths.

## D. CLI, MCP server, plugin, iac-templates, secops (~255 lines)

1. **`approvalDecision(clock, approver, approved, extra?)`** in core, plus the reason constants
   `PHRASE_MISMATCH`, `CANCELLED_BY_USER` and `DECLINED_BY_USER`, and `systemClock`. These are
   added to core in T1034 and used in the CLI, MCP and agents. Approval logic is untouched.
2. **MCP `data` no longer spreads `undefined`**, because `clean()` already drops it. The truthy
   checks stay.
3. **`IDEMPOTENT_WRITE` annotations** in MCP `tools/shared.ts`. The destructive and read-only
   objects stay written out.
4. **`engineOption()`** for the CLI's `--engine` (5 copies).
5. **The CLI uses agents' `stringOutput`** instead of its own copy; MCP `outputsLines` too.
6. **Exported from the secops root:** `SEVERITY_LABEL`, `prose` and `findingLocation`. Agents'
   secure report uses them (T1037).
7. **`taxLabel(currency, includesVat)` and `formatMoney`** in `core/src/text.ts` (T1034). They are
   used in MCP design, agents' `plan-apply` and `options`, and iac-templates' runbook. The runbook
   stays byte-identical.
8. **MCP deploy:**
   - a local `noSavedPlan(what, hash)`;
   - one `PLAN_AGAIN` hint ("Call opscrew_plan again, show the new plans to the user and apply
     their hashes.");
   - one branch for `refusalWithNextStep`.
9. **Certificate texts exported from agents:** `CHECK_PORTAINER_CERTIFICATE` and
   `NEW_CERTIFICATE_WARNING`, used by the CLI and MCP.
10. **`OWN_SERVER_BACKUPS_NOTE`** and the Portainer notes become constants everywhere. MCP says
    "your/yours".
11. **The CLI's domain approval wiring** becomes `domainApprovals(ctx, confirm, opts)`, plus a
    `HELD_BY_DESCRIPTION` constant.
12. **`askTypedName(prompts, message, name)`** in `cli/src/approval.ts`, for destroy and retarget.
    The typed name stays in the terminal.
13. **DECIDED, not done:** merging `printPlanHash`/`printPlanHashes`. T1029's review showed the
    merged version reads worse.
14. **`CHECK_MARK`** in agents' `shared/check-results.ts`, used by MCP deploy, MCP init and CLI
    init.
15. **`jsBuildStage(facts, dir)`** in iac-templates' docker stacks (byte-identical).
16. **`deployJob(name, permissions, steps)`** in `workflow/shared.ts` (byte-identical).
17. **iac-templates' `runbookHead`** is exported and used by agents' Portainer verify
    (byte-identical).
18. **Small items:**
    - `composeLiteral` moves to `runtime/services.ts`, plus a `RELEASE_NOTE` constant;
    - MCP `elicitOptions(extra)`;
    - MCP domain uses agents' `REGISTRAR_IDS` (a const tuple, `z.enum`);
    - secops probe `base`;
    - the next-step constants;
    - `APP_NAME_VARIABLE` in `infra/hcl.ts`.

KEEP:
- MCP `{ text, data }` returns;
- declarations;
- secops `check`/`makeFinding`/`result` calls;
- lockfile sets;
- secops SSH args;
- iac-templates' HCL, provider lists and Dockerfile lines;
- `FlagConfirmation`'s two constructions;
- the not-interactive refusals;
- one-liners;
- `servicesFor`/`lazyServicesFor`;
- `chooseOption` wiring;
- the max-price parsers;
- the money formats;
- the host-key dialog checks.

## A. Agents deploy side: provision, shared, providers, portainer, destroy, retarget (~520 lines)

1. **`runPhase(deps, phase, run)`** in `shared/phase-status.ts`, which marks the phase failed and
   rethrows (10 copies).
   - It records the redacted user-facing message (cut to 300 characters), or "unexpected error".
   - A failed state write never hides the original error.
2. **`gitClient(deps)` and `requireGitRepo(deps)`**, in a new `shared/github.ts` (with
   `githubCoordinates` moved there).
   - One hint: "Run OpsCrew from a clone of your GitHub repository, or run `git init`, commit your
     code and add your GitHub remote, then try again."
3. **`githubClientFromToken(deps)`** in `shared/github.ts`. It registers the token with the
   redactor in one place (6 copies).
4. **Destroy's own-server host plans use `approveAndApplyHostPlan`.** `HostPlanStep` gains `intro`
   and `refused`.
   - DECIDED: the audit actions keep their names ("host teardown …", "host undo …") through a step
     field.
   - `allowDestroy`, the typed name and `teardown.app === name` stay.
5. **`connectAndInspectOwnServer(deps, opts)` and `inspectOwnHost`** in `shared/own-server.ts`.
   `connectOwnServer` takes `hostKey: string | undefined` and the services directly. Destroy and
   drift also print the pinned-key line.
6. **`readyNewServer` and `confirmChangedHostKey`** in `shared/wait.ts`, with the wait constants
   once. Retarget's first-boot wording.
7. **Destroy's blocker stops use `adapterBlocked`.**
8. **`readValidJson(file, schema)`** in `shared/files.ts` (5 copies).
9. **`planStop(message, problems, hint)`** in `shared/adapter-plan.ts` (6 copies; the safety checks
   themselves stay where they are).
10. **`trackedFiles(deps, paths, { deleted })`** in `shared/github.ts` (4 copies).
11. **DECIDED, not done:** `accessRenderInput`. Feature 011 replaces the Zero Trust choice.
12. **`ensureDeployKey(paths, redactor)`** registers the key in one place, plus
    `deployKeyMissing(...)`.
13. **`resolveGitHub` warns by itself** (3 copies).
14. **Hint and text helpers:**
    - `continuesHint(command)`;
    - `DRIFT_THEN_DESTROY`;
    - `refusalReason(approval)` (8 copies, in `shared/approvals.ts`, also used by
      `PlanRefusedError`);
    - `stateNotHere(plan, cannot, hint)`.
15. **`savedPlanOf`:** retarget uses provision's `toSaved`, which is stricter on `--approve`.
16. **`applyStackPlanAudited` and the split of `inspectRecordedPortainer`**
    (`portainerClientFor` + `inspectAudited`), used by `portainer-flow`.
17. **Existing helpers that are not used:**
    - `readIfExists`, at two hand-rolled ENOENT reads;
    - retarget's `moveOf` in `servers.ts` and `run.ts`.
18. **`recordTeardown(deps, plan, approvals, opts)`** in `destroy/common.ts` (3 copies).
19. **Small texts:**
    - `designOptionLine`;
    - the registry-token help (the stack-plan wording);
    - `neededScopes`;
    - `nextStepLines`;
    - the retarget hint constants.
20. **Agents' copies of core helpers:**
    - `durationText`, `realSleep`, `errorText` (init) and `readIfExists`/`exists`, from T1034;
    - `taxLabel`/`formatMoney` (D7);
    - `approvalDecision` and the reason constants (D1).

KEEP:
- approval-refused throws (different messages);
- calls of `runStep`, `deployBranchFor`, `publishDeployment`, `deploySecretsStep`,
  `confirmDeletion`, `takeSnapshotBeforeDelete` and `openSession`;
- `cloudflareConnector`/`vpsConnector` calls;
- the deletion and protection-lift flows;
- `removeDeploySecrets` against `setDeploySecrets`;
- data and schema declarations;
- one-liners;
- `existingStateEngine` against `provisionEngine`;
- `savedInfrastructureHash(es)`;
- the PR-body, audit and git appends;
- `SshRemoteExec` constructions.

## B. Agents planning side: domain, dns, init, adapt, analyze, design, drift, verify, secure, interview (~400 lines)

Overlaps with A are merged there:
- B1 is A1 (`runPhase`). It also fixes a bug: in adapt, design, secure, verify and portainer, a
  failed state write replaced the real error.
- B2 is A2 (git).
- B4 is A8 (`readValidJson`). DECIDED: a missing file or invalid content gives `undefined`; any
  other read error (for example EACCES) is thrown.
- B5 is A5 (own-server inspection).
- B6 is A7 (`adapterBlocked`). Drift keeps "so it compared nothing there" through a `nothing`
  option.

1. **`desiredStacks(plan, opts)`** in `shared/portainer-stacks.ts`, used by drift and by provision's
   `portainer-flow`. Drift must compare against exactly what provision applies.
2. **`PORTAINER_TOKEN_STEPS`**, exported from `@opscrew/connector-portainer` (T1034) and used by
   init, interview and provision.
3. **Cloudflare token help.** `CLOUDFLARE_TOKEN_PAGE` is exported from the connector (C12), and
   `cloudflareTokenHint(permissions, rerun)` goes in `domain/common.ts`. One of the two different
   `cloudflareTokenMissing` functions is renamed.
4. **Runbook helpers.** iac-templates exports `cell`, `runbookHead`, `deployRows` and the external
   database cell (T1035). Agents' Portainer verify uses them; output is byte-identical.
5. **`webOnlyFromCloudflare`** is exported from iac-templates (T1035) and used by secure probes and
   provision. Check first that the schema makes its `dns.domain` test a no-op.
6. **`readDeployPublicKey(deps, cannot)` and `copyDeployKeyHint(paths, then)`** in
   `shared/ssh-keys.ts`; this goes with A12.
7. **`pinnedPublicKey(deps, connection, inspect)`** in `shared/portainer-stacks.ts`. The pin check
   is unchanged, and provision keeps its memo.
8. **`errorMessage(error)`** in core (T1034), replacing about 17 inline copies.
9. **Small items:**
   - `setPortainerOrigin(redactor, env, url)`;
   - `readOptionalArtifact` moves into plan-schema's io (T1034);
   - `cloudflareConnector(deps)` is called directly;
   - `lowerFirst`/`upperFirst` in core (T1034);
   - `PHRASE_MISMATCH` (D1);
   - `provisionedElsewhereHint(command)`;
   - purchase approval text helpers (`autoRenewOffLine`, `zoneLine`, `registeredSummary`; every
     check stays);
   - the GitHub token "how to create" sentences;
   - verify's local `get()`;
   - secure's local `hide()`.

KEEP:
- `checkResult` calls;
- the approval-refused throws;
- imports, types and schemas;
- the language-specific health scanners;
- destructuring one-liners;
- buy's two setup sequences;
- connect's waiting texts;
- manage's pending result;
- the init check returns;
- the bind tokenizer loops;
- the `CloudflareClient` constructions;
- the MCP question loaders.

## Totals

About 1,400 lines across the four areas, and one wording for roughly 50 messages and hints. One bug
is fixed along the way (B1). Nothing is weakened in the safety core.
