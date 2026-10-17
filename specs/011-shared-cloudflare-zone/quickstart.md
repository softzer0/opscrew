# Quickstart: validating "Several OpsCrew apps in one Cloudflare zone"

## Offline (every check)

```bash
pnpm turbo run typecheck test --filter=@opscrew/connector-cloudflare --filter=@opscrew/agents \
  --filter=opscrew --filter=@opscrew/mcp-server
OPSCREW_IT=1 PATH="$PWD/.tools/bin:$PATH" pnpm turbo run test --filter=@opscrew/iac-templates
```

Expected:
- the adapter's plan and apply tests pass against the fake zone: create the entrypoint, add,
  update, remove, delete, re-check, read back;
- every root validates with both engines, without `cloudflare_ruleset` or
  `cloudflare_zero_trust_organization` resources.

## Live (gated, see docs/e2e.md)

1. Run the own-server live test (`OPSCREW_E2E_OWN_SERVER=1`) and the Portainer live test
   (`OPSCREW_E2E_PORTAINER=1`).
2. Each deploys app A, then app B, into the same zone and account. Then check:
   - `curl https://<A or B>/.env` answers Cloudflare's block page;
   - the zone has exactly one rule with `ref` `opscrew-block-probes` and one with
     `opscrew-strict-tls`, each listing A's and B's hostnames;
   - the user rule the test seeded in each phase is unchanged.
3. `opscrew destroy` A: B still answers through its tunnel, B's Access login works, and the shared
   rules list only B.
4. `opscrew destroy` B: OpsCrew's rules are gone. The seeded rules, the Zero Trust organization and
   the one-time-PIN identity provider remain. The leak check finds nothing.

## By hand (a user's zone)

1. Deploy two apps under one domain with `opscrew provision`.
2. Each provision shows a "Cloudflare shared rules" plan. Approve it. In the dashboard, Security →
   WAF → Custom rules shows one "OpsCrew: block probes…" rule listing both hostnames.
3. Run `opscrew drift`: nothing to report. Remove one hostname from the rule by hand and run drift
   again: it is reported. The next `opscrew provision` puts it back after approval.
