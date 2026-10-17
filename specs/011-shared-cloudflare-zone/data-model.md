# Data model: Several OpsCrew apps in one Cloudflare zone

## Shared OpsCrew rule (in Cloudflare)

| Field | Value |
|---|---|
| `ref` | `opscrew-block-probes` (phase `http_request_firewall_custom`) or `opscrew-strict-tls` (phase `http_config_settings`) |
| `description` | `OpsCrew: block probes for secrets and admin panels` / `OpsCrew: verify the origin certificate (Full (strict) TLS)` |
| `expression` | `(http.host in {"a.example.com" "b.example.com"})`, then ` and (<probe paths>)` for the block rule; hostnames sorted, lower case |
| `action` | `block` / `set_config` with `action_parameters: { ssl: "strict" }` |
| `enabled` | `true` |

Validation:
- An OpsCrew rule is "as OpsCrew writes it" when its action, `action_parameters`, `enabled`, and its
  expression with the hostname set taken out all equal the template.
- Its hostname set must parse: quoted lower-case names, separated by spaces.
- The expression stays at or under 4,096 characters.

## Local record `.opscrew/cloudflare.json`

```json
{
  "zoneId": "<32 hex>",
  "hostnames": {
    "opscrew-block-probes": ["shop.example.com", "www.shop.example.com"],
    "opscrew-strict-tls": ["shop.example.com", "www.shop.example.com"]
  },
  "createdEntrypoints": ["http_request_firewall_custom"]
}
```

- The file is written after each successful shared apply, and is the only source of "this app's
  hostnames".
- `createdEntrypoints` lists the phases whose entrypoint this app created. It is informational only,
  because destroy deletes an entrypoint only when it is empty.
- The file is never committed (`.opscrew/` is ignored) and holds no secret.
- It has a zod schema; a damaged file stops every command that reads it, and nothing is changed.

## Shared plan

| Field | Meaning |
|---|---|
| `zoneId`, `accountId` | where the changes go |
| `changes[]` | each change is one of the kinds below |
| `findings[]` | blocking findings; any finding means the plan cannot be applied |
| `hash` | SHA-256 of the canonical JSON of `zoneId`, `accountId`, `changes` and `expect` |

The kinds of change:
- `create-entrypoint` (phase, first rule);
- `add-rule` (phase, rule);
- `update-hostnames` (phase, rule id, `add[]`, `remove[]`);
- `delete-rule` (phase, rule id);
- `delete-entrypoint` (phase, ruleset id);
- `create-organization` (auth domain);
- `create-identity-provider` (one-time PIN).

`expect` holds, per touched phase, OpsCrew's rule as it was read (absent, or its `id` and
hostnames), so the apply can re-check (R4).

The kinds of finding:
- `hostname-claimed`;
- `no-rule-slot`;
- `expression-too-long`;
- `rule-changed`;
- `permission-missing`.

## State transitions of a shared rule

- absent → created with app A's hostnames (`create-entrypoint` or `add-rule`)
- A's hostnames → A + B (`update-hostnames`, add)
- A + B → B (`update-hostnames`, remove; A's destroy)
- B → absent (`delete-rule`; then `delete-entrypoint` when the ruleset has no other rule)
- any → changed by someone (`rule-changed` finding; nothing changes until the user restores it
  or deletes the rule)
