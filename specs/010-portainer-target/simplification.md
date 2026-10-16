# Simplification of features 000–010 (2026-10-16)

The founder asked for a full review of the code built so far for overengineering: code beyond what
the specs ask for, abstractions with one caller, duplicated helpers, workarounds and hacks where a
clean fix exists, defensive code for far-fetched edge cases, backward-compatibility shims (none
are wanted before the first release), and dead code. Eleven read-only reviewers covered the whole
repository by area; this file is the lead's consolidated record of their findings and decisions.
Tasks T1020–T1032 in `tasks.md` carry them out.

Rules for every task here:

- Behaviour stays the same unless a line below says otherwise; every existing test passes; every
  renderer's output stays byte-identical (snapshots unchanged) unless the task says otherwise.
- The safety core is not weakened: plan → policy → approval bound to the SHA-256 → apply; typed
  confirmation for deletions; redaction; schema validation; failing closed on approvals, secrets and
  data deletion. Where a finding touches it, only duplicated plumbing is merged.
- "Lines" are the reviewers' rough estimates of source removed.
- Lead decisions are marked DECIDED; "KEEP" lists complexity that earns its place.

## Area 9: packages/cli/test (live + e2e): ~700–900 lines, safety and leak checks kept
- Shared live harness (step(), log, opscrew/opscrewOk, readPlan, infraOutputs, afterAll collector), copied O↔P: -130, medium
- Shared step-1 bootstrap (prepareThrowawayRepo, waitForRootShell): -90, low
- Step selection with dependencies: STEPS=core|full|<list>, split step 2 into 2a "prepare", rollback its own step 3b; single-step rerun ~15 min: -40 net, medium. Do NOT reuse a kept server (constitution VII)
- portainer-cloud server create/delete reuse own-cloud createThrowawayServer(+firewall)/deleteThrowaway(+firewalls): -110, low
- live.test.ts re-implements own-cloud GitHubRepo helpers: -120, low-medium
- provisionUntilDone/deploy duplicated and drifted (O vs P): one shared version: -80, medium
- Cloudflare appResources and leftover checks duplicated: -55, low
- Tests re-implement product exports (hostKeyFingerprint, parseDotenv, detectPublicIpv4, providerProfile regionLocations): -45, low
- P reads server.json by hand → readPortainerConnection: -25, low
- Unit tests of constants and trivial helpers (keep only safety/leak helper tests): -100, low
- Small duplicated pairs (missingVariables, plan-hash parsers, duration): -35
- R5 compared twice in step 3: -15; step 5 diagnostics hack (manual Docker frame decode → docker logs over SSH; one DoH helper): -40
- answerAndDesign → opscrewOkWith: -12; repeats in P (appVolumes, registryAccesses, waitForAccessRefusal, mergeAdaptPullRequest, assertOneBelowZone): -55
- e2e: readArtifact, exampleNames, initRepoWithBareOrigin: -45; examples.test BASE answers: -90
- domain.test copies registrars.test setup: -40; httpGet vs httpsRequest: -25
- setupTokenFromLogs handles 4 formats for a pinned version (far-fetched): -20, medium
- example name validated 3 ways: -40; history comments: -30; rulesets compared twice: dup report

## Area 3: agents adapt/analyze/design: ~350–400 lines, low risk, no behaviour change
- Next.js health route lives in its own old module (health-route.ts) wrapped by files.ts: fold into the registry as a 7th handler: -120, medium
- List-join and plural helpers copied 6× here (16 repo-wide): one listText/plural in shared (or core): -30 here, -70 repo-wide
- appDirOf/appFolder/normalizeAppDir and joinRel/under duplicated: -15
- Next config names listed 4×; nextConfigEdit belongs in next-config.ts: -20
- exists/readIfExists copied across phases (adapt, destroy, provision, secure, drift, mcp): one set in shared: -50 in agents
- health/ insertion and module-resolution helpers duplicated (linesAfter ×3, resolveIn/resolveModule): -30
- Same user messages built in node.ts and python.ts: builders in types.ts: -25
- DECIDED KEEP: Node multi-app disambiguation (finding 8, ~110 lines; founder wants framework breadth)
- Dead code and barrel exports (liveDeploymentProvider, PLAYBOOKS, LOCATION_NAMES, unused re-exports): -40
- design/options own-server branch production never takes: -12
- own/portainer option skeletons copied from cloud (containersOf, noServerCost, one location constant): -30
- PushContext fields and duplicated say/warn/audit closures: -20; branch-name search written twice: -12
- repoPrefix bypasses GitClient: add GitClient.prefix(): -10
- Two scan.json readers plus a far-fetched fallback: one readScanReport, drop the fallback: -20
- providerSwitchBlock duplicated branches, STATE_FILE duplicated: -6; DNS proxy decision written twice: -4
- pr.ts optional inputs with fallbacks: make required: -8
- health/index catch-all hides bugs: catch only OpsCrewError/ErrnoException
- model-availability check twice, costUsd guard: -12; APP_KIND_TEXT vs LABELS: -8
- design/wording.ts layer: move strings into provider profiles: -25; nonLiveRates computed twice: -4

## Area 6: connectors ssh-host + portainer: ~500 lines (findings 1–11), safety untouched
- steps.ts: check/apply/verify wiring repeated 22×: one scripts({...}) factory: -130, low-medium
- canonicalJson + plan hash twice, sha256 five times: export canonicalJson + sha256Hex from @opscrew/core: -35
- IPv6 in canonicalCidr unused (web filter is IPv4 only): canonicalIpv4Cidr, reuse sortedNetworks: -60
- HostFacts webFilter/runtimeFiles optional for an "older format" never saved: make required (no-backward-compat rule): -25
- Interfaces duplicating zod schemas (HostStep/HostPlan/DesiredHost, StackChange/StackPlan/DesiredStacks, RawStack): z.infer: -30 to -120, medium
- Portainer role mapping written 6×: one ROLES table in names.ts: -30
- Teardown's optional app (appFromRecord, ROLE_SUFFIX): both callers pass app: make required: -30
- HACK: ssh-host withApplied defineProperty on any error: HostApplyError like StackApplyError: -10
- Defensive checks the types rule out (typeof deleteData, verifyLogin, approvedHash?., version regex 3×, secrets ?? {}, names ?? [], dead ownContainer): -30
- Unused index exports (both packages) and formatCertFingerprint: -45
- Fact fields nobody reads (os.idLike, codename, memoryAvailable, diskTotal, webServers, webFilter.commands, support, osType, edition): -30
- sshd drop-in rendered in TS and shell: pass DROPIN_B64 + hash like fail2ban: -8
- dead-man preamble ×3: -15; atomic-write idiom ×10 → write_file in APT_FUNCTIONS: -30, medium
- Small copies (imageOf/imageIn, tunnel/portainerLocation, app-name regex ×5 across packages, projectId and version regexes, privilege findings ×3): -30
- valueFingerprint single-value export: -20; inspect read/optional wrappers: -12
- andList ×4 across packages (core), Docker architecture mapping ×2 (connector export): -25
- HACK: redactError mutates the error with defineProperty: return a new OpsCrewError: -3
- Path constants in one place (constants.ts, APP_DIR); Portainer findings in one findings.ts style
- KEEP: dead-man switch, cert pinning, valuesDigest binding, re-check at apply, volume ownership, ufw parser + web filter

## Area 10: iac-templates + secops: ~500 lines (1–3, 9–12), no output change (byte-identical snapshots)
- Server vs Portainer runtime renderers duplicated (compose services, Caddyfile, cloudflared ×3): shared hardened()/dbService/cacheService/cloudflaredService/caddyfile(): -90, medium
- Three root builders repeat Cloudflare pieces (dns module, DNS vars/tfvars ×3, accountId, tunnel/access args, outputs, OwnRoot=PortainerRoot); WORKAROUND PORTAINER_ORIGIN_VARIABLE because VariableSpec lacks sensitive: dnsPieces/tunnelModule/accessPieces + sensitive flag: -110, medium
- Target-guard scaffolding (8 helpers incl. "not yet" errors for shipped 009/010, copies in agents vps-target.ts and providers/own.ts): keep cloudTarget()/portainerTarget(), export them, drop copies: -70 here, -40 agents
- WORKAROUND: Access module's ssh_hostname reused for the Portainer webhook (+ ssh_hostname_label): rename to service_hostname/service_label: -5
- cloud-init.yaml.tftpl byte-identical in hetzner-vps and digitalocean-droplet: one source copied by gen-modules (or an equality test): -114, medium
- WAF ruleset + probe paths written twice in HCL (cloudflare-dns and cloudflare-tunnel): small cloudflare-waf module: -25, medium
- SHIM: `moved` block in cloudflare-dns (no-backward-compat): delete: -5
- Module outputs nobody reads (access ids, dns hostnames, tunnel cname_target/hostnames): -25
- secops supabase/firebase rules re-implement createFinding, readText, isPlaceholderValue, dirname/compact/extension, lineAt; local isEnvFile shadows import: -70, low-medium (finding ids pinned)
- Plan policies repeat Hetzner checks for DigitalOcean: provider table + one loop: -60, medium (safety gate: keep ids/severities/messages)
- External scanner setup repeated (gitleaks/trivy/osv): externalScanner() factory: -35
- Token regexes in core redact AND secops secrets: one list exported from core: -25, medium
- isRecord ×9 repo-wide: export from core: -25
- Hand-rolled worker pool next to mapConcurrent: -12
- usesCloudflare re-spelled ×6, proxiedToCloudflareOnly ×3: shared helpers: -12
- Cloud vs own-server runbooks repeat sections: runbook/shared.ts: -45
- Dead/test-only exports and unused params (tunnelHostnames, PortainerStackOptions.image, _plan/_ctx params, modulesDirFor, httpAllowedCidrs, PlanProvider dup): -35
- RenderContext.trivyImage unused option + digest check; checkSshPort re-validates zod range: -20
- Two health-check loops: -10; health-path, digest regex, splice: -10
- FALLBACK "older facts": make facts.appDir required (lead schema change): -20
- secops `export *`: explicit export list
- Module inputs always the same value (hetzner labels, DO app_tag/shared_tags): locals: -15
- Rename src/portainer/ → portainer-host/ (clarity); trim long comments: -40
- KEEP: generated modules, SQL tokenizer, CVSS calculator, sanitizer, Portainer workflow rollback, depends_on module.access

## Area 4: agents retarget + destroy: ~900–1,000 lines; findings 1–5 first
- Cloudflare removal copied own.ts ↔ portainer.ts (plural, nonEmpty, list, cloudflareOnly, approve/applyCloudflareRemoval): one in destroy/common.ts with a wording object: -150, medium
- Bounded-deletion checks hand-written ×3 instead of assertDeletionPlan: -50
- finish/abort copy lift-protection and removal steps: liftMoveProtection/removeMoveServer helpers: -80
- Engine selection + passphrase loading ×7 repo-wide: one engineWithEnv in shared: -40 here, -120 repo-wide
- Typed confirmation inline ×2 instead of confirmDeletion: -45
- useLayout(session, name, layout) redundant arg ×9: -20
- SHIMS: "older OpsCrew" infraDeclaresVariable guard; 003 snapshot record format: delete: -35
- assertModulePrefix runtime checks for constant prefixes: literal type: -25
- WORKAROUND: requireTunnelClosed handles one tunnel; Portainer wraps entries: deletedTunnels() loop: -20
- HACK: retarget matches hint text to rewrite an error: planAndApply redesignHint/reason tag: -8
- WORKAROUND: Portainer teardown DeletionSession claims provider "own" + text .replace: DeletionScope.provider accepts portainer: -10
- plans.ts approved-pending branch ×2, summaryOf/savedOf: -30
- Approval entry built ×6: approvalEntry() in shared: -25
- Small helpers ×N (plural, stateExists, joinList, STATE_FILE ×2, plan stamp ×7, infra-missing readdir ×3, plan heading ×6): -60
- Change-symbol map ×3 (destroy/checks, plan-apply, drift/render): -15
- server-ops indirections/defensive checks (redactWith, assertService, port check dup, unused port option): -35
- Five poll loops: one pollUntil in shared/wait.ts: -25
- IP comparison 3 ways (one non-canonical): one sameIp (BlockList): -15
- Error-reason helpers ×3: -10
- Dead code/exports (continueCommand, deletionPlanIsBounded, DestroyContext.profile, ~18 destroy exports, 5 retarget exports): -40
- Move layouts + provider helpers duplicated in iac-templates fixtures/providers: export from iac-templates root: -70
- Restart-old-app block ×2: -15; partial-apply error wrapping ×2: -15; "What remains" GitHub lines ×3: -20; downtime wording ×3 + two MB bases: -10
- KEEP: prepareInfraPlan/applyInfraPlan/deletionStep, maintenance window rollback, unprotectPlanProblems, snapshot-before-delete, withoutData/excerpt/runRelease

## Area 1: agents provision + shared + providers: ~550 lines for findings 1–8
- BUGS to fix first: (15) ensureStatePassphrase/ensurePortainerPassword silently REPLACE a short value → encrypted state unreadable: one ensureSecretFile() that fails closed; (11) connectorFirst regex-patches refusal text, misses the Portainer wording (missing "nothing in Cloudflare was deleted"): build the message, flag for "done appended"
- Engine + state-encryption setup ×8 repo-wide: one projectEngine(deps, plan, {preference, services, readOnly}) → {engine, env}: -80
- provisionPortainer re-implements provisionFlow's skeleton (deploy branch choice, zone learn, planApproval, record(), secrets-or-warn, publish tail, SENSITIVE_OUTPUTS, stringOutput ×3): move into provision/steps.ts: -120, medium
- repo-write "Write the deployment files" block ×4: approveAndWriteRenderedFiles in shared/files.ts: -45
- Three hand-written Cloudflare REST clients in agents (zero-trust, tunnel-connections, portainer/access): add calls to connector-cloudflare: -120, medium
- Three DNS-over-HTTPS clients (provision lookupAddressRecord, verify public-dns, domain connect-dns): move lookupPublicAddresses to shared, delete lookupAddressRecord: -65
- Stale "not yet" scaffolding (ownServerNotYet still says 009 is coming, PORTAINER_TARGET_NOT_YET, vpsTarget unused) + narrowers copied in iac-templates; one set exported from one root, one "bug in OpsCrew" error: -70
- --approve split into approvePlanHash + approvePlanHashes and rejoined: one approveHashes list (CLI, MCP, agents): -25, medium
- SHIMS: switchesWebRoute fallback for records without appliedWeb; credentials before-ids kind; "requirements before 004 mean Hetzner": delete: -35
- Host-plan vs stack-plan describe/blocked near twins: describeAdapterPlan, adapterBlocked: -50
- HACK: ssh-host withApplied (same as report 6): HostApplyError
- errorBlocks split duplicated: -8; optional API methods only for fakes + runtime check of DEPLOY_BRANCH constant: make required, typed param: -25
- readIfExists ×13: one in shared/files.ts: -40
- STATE_FILE ×2 + "prod.tfstate" literal ×6 + non-empty check ×3: stateFile(paths)/hasState(paths): -20
- tunnel-touch helpers ×3: tunnelChange(): -12; outputs-or-reread ×4: planAndApply returns outputs: -15
- Zero Trust lookup injected in two places, disagreeing: one services.zeroTrust: -15
- Public-IP classification ×2 (agents vs ssh-host, differ on 0/8): export isPublicAddress: -15
- Duplicated text helpers/messages (keyText/keyWords, host-key hint ×2, token hint ×2, 403 hint ×2): -25
- Unused options/fields (ownServerConnector currency, PortainerProfile literal-false fields): -25
- Duplicate redaction registration loop + dotenv round trip in stack values: expose values.db: -12, medium
- Long comments: -60; split provision/portainer.ts (1822 lines) and shared/server-address.ts
- KEEP: SavedPlanSchema/findSavedPlan + hash re-check, maskSensitivePlanJson/redactJson, connectorFirst/waitForTunnelToClose intent, connectOwnServer host-key pinning + stdinBootstrap, value key/fingerprints/mayManagePhase

## Area 8: cli/src + mcp-server + plugin: ~600–700 src lines + ~1,000 fixture lines
- Saved host/stack plan readers ×4 (CLI provision, MCP deploy; agents destroy/drift too): one readSavedPlanChanges in agents (keep ENOENT vs damaged fail-closed): -100
- CLI test fixtures fork the agents fixtures (retarget 753 lines, FakeEngine ×5, FakeCloudflare ×2): export from @opscrew/agents/testing: -800 to -1,200, medium (tests)
- usageErrorsExit2 + scan exitOverride redundant (commander inherits exitOverride; handleError maps to 2): -35
- Error printing ×3 + duplicate exit-code constants: -40
- Typed-confirmation wrappers ×2, --confirm name pre-check ×4, hash-listed check ×5; new Date() instead of injected clock (constitution VI): FlagConfirmation + helpers: -70, medium (approval paths)
- PhaseDeps built in CLI, MCP and agents testing: one buildPhaseDeps in agents: -35
- approvePlanHash + approvePlanHashes (same as report 1): -35, medium
- Apply-command builders ×4 (two in MCP disagree on --engine) + Portainer flag conversion ×2 + REPLACEABLE_TOKENS dup: -50
- TEST SEAMS in production branches (approval handler attached ⇒ interactive; fake prompts ⇒ plain-text secret prompt; test catalog ⇒ skip own inspection): tests set isInteractive, UiPrompts.password: -20
- Own-server design inspection ×2 with the same type cast: agents helper: -30
- MCP elicitation plumbing scattered (CallExtra ×4, REQUIRES_USER ×2, handler built ×4, "cannot show dialogs" ×3): tools/elicitation.ts: -50
- Scan phase implemented twice (CLI + MCP): one runScanPhase: -30
- MCP name hiding: runTool/runToolBody split, two whole-name implementations, server.json read twice: -30, medium (privacy tests)
- HACK: MCP interview matches error message text; catch-all withHint drops useful hints (401 token hint): reason codes: -15, medium
- quietReporter ×4: -27; two WeakMap service registries: -25; approval request rendering ×2 (MCP mislabels costDelta): -20
- Status rendering ×2: -25; helpers that exist elsewhere (relativeTo, exists, systemClock ×3, isOwnServer/isPortainer/isUnpriced ×2): -25
- Dead files/options/exports (cli/ui/index.ts, cli/src/index.ts, MCP index re-exports, tmpDir, PLANNING_TOOLS, ~25 needless exports): -40
- domain.ts duplications (servicesFor ×2, fields(), refusal hint two ways, --account quoting inconsistent): -35
- Near-duplicate branches/messages (design own/portainer, statusData, "already matches" ×3): -40; printPlanHash/printPlanHashes: -15
- portainerAccessFor hides the address twice: -12
- plugin validate.mjs beyond spec: -80; MCP INSTRUCTIONS ~3,000 chars repeating SKILL.md: trim to hard rules (medium: model behaviour)
- KEEP: NonInteractiveApprovalHandler, ElicitationApprovalHandler, runTool redact-then-hide pipeline, stdio console redirection, TypedConfirmationHandler undo-host approval

## Area 2: agents domain + dns + init: ~500 lines for 1–5, 10–14
- Cloudflare purchase vs elsewhere purchase = two copies of one flow (owned branch, --max-price refusal, approval + recheck, record + send + wait, finish/setUpOwned/completed): one flow with {quote, setUp, approvalLines, summary}: -180, medium-high (keep typed approval, price bound, record before register, one send)
- ~75 `...(x === undefined ? {} : {x})` spreads although exactOptionalPropertyTypes is OFF; record.ts/connect-state.ts rebuild parsed objects: pass through, z.infer: -70
- "No Cloudflare token" written 5 ways + two requireZoneToken + two ZONE_PERMISSIONS: one requireCloudflareToken: -45
- Sandbox-only `zones.simulated` branches ×36 through production: make SANDBOX_ZONES a quiet no-op impl: -50, medium
- Optional DomainZoneApi methods + far-fetched "this build cannot copy DNS records" + flag-and-method double checks: make required: -35 (registrar contract part is separate, lead/ADR)
- DS wait state: 4 timestamps, 3 constants, `as Date` ×4: {dsSeen, switchAfter} only moving later: -50, medium-high (with SC-703 order tests)
- DoH client ×3 (connect-dns has no timeout → can hang): one dohQuery: -40
- Project-files approval text ×5, approveReplace ×2, kept-domain warning ×3: -50
- resolveDomainServices builds the object ×3 + test-only branch: -30
- Small helpers (listText ×4, plural ×4, sameDs ×2, switchContext, host normalisers ×5, set/hasEnv ×3, formatMoney ×2, other-registrar lists): -50
- Domain-name parsers ×3, dns re-implements project helpers: -30; normaliseOffer copies normaliseCheck: -30
- "Continue next run" error wrapper ×3, double redaction: -15; dead/over-wide exports: -30
- init reads plan/requirements twice with bare catch: -20; unreachable defensive branches + failFrom(): -12
- HACK: init sniffs message text (permission regex, /balance/, /works.$/): use error codes: -10
- DECIDED KEEP (18): MX split + two-SPF rules (protect real email setups)
- DECIDED CUT (19): stale DS removal after the switch (beyond spec, own approval path); keep the warning + dashboard link: -60
- SHIM: purchase record registrar optional for pre-007 records: required, one markPurchase: -12
- accountOption threaded only for an MCP hint + overload: -15; domain fakes duplicated in CLI: -300 tests; small connect cleanups: -10
- KEEP: purchase record + REJECTED_CODES + 30-minute rule, connect order + fail-closed DS lookup, BIND parser, re-quote in cents + confirmPhrase, init token registration + guard/withBudget

## Area 7: other connectors (cloudflare, digitalocean, github, godaddy, hetzner, namecheap, porkbun): ~1,100–1,300 lines (a third tests)
- Hetzner and DigitalOcean HTTP clients near-identical (request with timeout + retry rules, untilAborted, listAll, waitForAction, toError): one requestJson + pollAction in @opscrew/core (also gives Cloudflare/GoDaddy/GitHub the missing request timeout): -200, medium (keep write/no-retry rules exactly)
- DECIDED: Connector.tools() never called anywhere: drop from the contract + tool definitions/safe/run/sourceNote (contract change, ADR note): -155
- untilAborted + {json}|{error} wrapper defend against a fake that ignores abort: pass signal, fix the fake: -60
- Dead methods/exports (hetzner listImages/getServer, namecheap getDomainInfo/setRegistrarLock, porkbun listAll, GitClient.root, godaddy premiumQuoteReason, unused root exports): -130
- Fake fetch ×5 in tests: one fakeFetch in @opscrew/core/testing: -350 tests
- Cloudflare check-and-parse ×15 (#get used twice): generalise #get: -40
- DECIDED (stricter, fail closed): Cloudflare "no registration" regex guesses → only the live-confirmed answers: -20
- Cloudflare Registrar schemas read guessed alias fields: keep documented + live-seen names: -35, medium
- Domain helpers ×N (years check ×4, normalizeDomain ×7, fqdn ×3, IPv4 regex ×2): core helpers: -50
- "Outcome unknown, purchase may have started" ×5: maybeStarted() in core: -30
- Porkbun createDomain dry-run/real overloads: previewDomain + createDomain: -20
- quote() repeats check() (Porkbun, Namecheap): -45
- BUG (decided, fix): GoDaddy check() positional fallback can mislabel a domain: match by name only
- HACK: GoDaddy rebuilds agreement types from display text: carry types in RegistrationQuote (contract field): -10, medium
- detectPublicIpv4 in Cloudflare connector only serves Namecheap: move: -20
- Namecheap ContactCard double address mapping: -35; address-book scan up to 20 entries (far-fetched): -8
- Pagination loops guarding against infinite APIs: -20; unused fields/options + snapshot timeout ×3: -30
- Hetzner/DO connector glue copied (token, client, lazy catalogue, memo reset): memo() + userMessage(): -30
- GitHub owner/repo/branch validation ×3: -15; run search possibly obsolete (check return_run_details): -35, medium, unconfirmed
- Exceptions as control flow (NotOurDns, NotFound): absentOn option: -15; GoDaddy leftovers: -10; Porkbun second bulk check: -8
- KEEP: purchase-answer classification, never retrying writes, GoDaddy strict schemas + contact masking, GitHub branch re-read + blob SHA, DO snapshot lookup

## Area 5: agents drift/verify/secure/interview/portainer/testing: ~1,000 lines
- DECIDED: verify stale-DNS = T1017 explain layer under T1018 workaround: one step (DoH once per unresolved host → pin addresses for fetch + TLS, register them with addLiteral), drop staleNote/stale set/hideAddresses/withoutAddresses/quiet: -130, medium (live-tested path)
- Name replacement ×4 (routeNames, withoutOwnServer, withoutServerAddress, checks.ts; portainerAddressNames = routeNames; escapeRegExp ×5): one replaceNames + addressNames in shared: -80
- Host-plan approve/apply/audit ×2 (portainer/run applyAddonPlan, provision/own applyOwnHostPlan) + planPortainer enable block ×2: one approveAndApplyHostPlan: -85, medium (safety path, keep every gate step)
- HACK: portainer/run string surgery on errors (forThisCommand rewrites another module's hint, REFUSAL_ENDING regex, hash precomputed twice): pass command + shown: -45
- BUG (fix): `portainer enable/disable` audited as phase "provision"; drift/portainer.ts audits as "provision"
- Engine + passphrase ×8 (driftEngine and stateEngine the same twice in drift/infra.ts): same as report 1 → one phaseEngine + encryptionEnv: -50
- Barrels export ~70 unused names; checkDns/checkSiteReachable wrappers: -70
- Three hand-written Cloudflare clients (same as report 1): connector methods: -60
- Portainer desired state/client built ×N (DesiredStacks ×2, web→ports ×3, recorded-stack-by-role ×4, pinned client ×5, inspect+audit ×2): -70
- Interview follow-ups duplicated own/Portainer (splitServerAnswers/splitPortainerAnswers, has*, isBlank ×3, withDefault ×3, port parsing ×2): -60
- SHIM: DriftReport.provider optional "before 004"; report sorted twice: required, sort once: -25
- Drift report assembly ×2: finishDriftReport: -35
- Small helpers (byAddress ×2, stringOutput ×7, exists ×3): -35; list joiner ×16: -40; host normaliser ×30: core normalizeHostName: -25
- DoH ×3 (same as reports 1/2): -45
- verify/secure duplicate helpers (IPv6 443 probe, tally, RANK copies SEVERITY_RANK, result/check): -40
- secure/run.ts two near-identical server branches: -30
- HACK: drift/host.ts fake range ["0.0.0.0/32"] sentinel; unused projectId param: -6
- interview/portainer indirections (re-export, sameCertificate, usable, recordedText): -15
- KEEP: desiredFingerprints/asRemote, compareInfrastructure (no sidecar, deleted in finally), nodeFetchWithLookup, reachPortainer, portainer/pending.ts

## Area 11: core + plan-schema + contracts + runtime-claude + iac-engine + detect: ~750–850 lines
- BUG (fix first): two secret-env-name lists in core (env.ts vs redact.ts) drifted: _SECRET_KEY/_ACCESS_KEY/_AUTHTOKEN values (DJANGO_SECRET_KEY, MINIO_ACCESS_KEY) stripped from the agent env but NOT masked in engine logs: one isSecretEnvName used by both
- DECIDED: in-process tool path dead (ToolDefinition/ToolContext/ToolResult/mutates, PhaseRequest.builtinTools/tools, Connector.tools(), runtime-claude tools.ts, mcpServers branch, connector tools()): delete; policy → deny every mcp__ tool: -250 to -300 (contract change, ADR)
- Approval checks ×3 in core (free exports + gate methods, validateRequest blocks, latestApprovedPlan, findApprovedPlan in the contract): one HASH_BOUND table + assertApproved: -120, medium (safety gate, keep messages)
- WORKAROUND: optional engine capabilities (providerSchemas, stateResources) only for fakes + plainContents fallback: make required in IacEngine (contract, ADR): -60
- Stale "Portainer not yet" constants in plan-schema + copies in agents and iac-templates: one set of guards in iac-templates ("bug in OpsCrew"): -50
- SHIM: requirements.provider optional "before 004 = Hetzner": required: -10
- plan-schema refinements hand-type params to dodge self-reference: object schema then superRefine: -30
- WORKAROUND: plan-schema and detect copy core's atomic write (5 vs 20 retries) and OpsCrewError shape: depend on core (package.json + lockfile, lead): -50
- redactDeep ×2 (runtime-claude, core): -20; token usage computed, never read: -30
- ProjectFiles unused entries, ensureProjectHome unused, deploy_secrets.json joined by hand ×3: -15
- Registrar capabilities optional + default never used: required: -20
- Contract fields/values unused (aws/gcp/azure/contabo/namecheap provider ids, missingScopes, catalog fields): -35
- Unused dependency tinyglobby (detect, secops, cli): remove (lead, lockfile)
- Unused exports and test-only options: -35
- detectProjectDetails 550 lines, configs read twice, cd-prefix ×3, byDepth ×2: split: -20 (clarity)
- schemeKind ×2: -10; builtin tool names ×4: -6
- iac-engine plan JSON parsed by hand (constitution: zod for external input): small zod schema: -30
- JSONL store leftovers (warnings ×2, byPhase): -15
- DECIDED KEEP (21): Spring Boot Actuator property parsing (founder wants breadth, FR-816)
- Defensive code for unlikely cases (24.8-day timeout clamp, redacting the audit timestamp, always-passed optional params): -10
- KEEP: core policy (lexer, wrappers, glob sampling, realpath), runtime-claude PhaseRun gating, iac-engine apply (hash + private copy + re-show), redactor, audit append queue + state retries

## Totals (approx.)
- Source: ~6,500–7,500 lines across all 11 areas; tests/fixtures: ~2,000–2,500 more
- Bugs found: redaction gap (core env names); state passphrase/Portainer password silently replaced; Portainer refusal message missing "nothing in Cloudflare deleted"; audit phase "provision" for drift and portainer enable/disable; GoDaddy positional mismatch; domain connect DoH without timeout; MCP --account quoting inconsistent; MCP approval dialog labels a cost change as "Monthly cost"
