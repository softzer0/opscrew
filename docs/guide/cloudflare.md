# Your domain on Cloudflare, and several apps in one zone

When your app's domain is on Cloudflare, OpsCrew protects every hostname of the app with two rules
in your Cloudflare zone. You can put several OpsCrew apps under one domain (`shop.example.com`,
`api.example.com`, `status.example.com`) and in one Cloudflare account: each app gets the same
protection, your own rules stay yours, and removing one app leaves the others as they are.

## The two rules OpsCrew keeps in your zone

OpsCrew keeps one rule of its own of each kind in the zone, whatever the number of apps:

- **"OpsCrew: block probes for secrets and admin panels"**, in **Security → WAF → Custom rules**.
  Cloudflare blocks requests for paths that bots probe for: `/.env`, `/.git`, `/wp-admin`,
  `/wp-login.php`, `/xmlrpc.php` and `/phpmyadmin`. They never reach your server.
- **"OpsCrew: verify the origin certificate (Full (strict) TLS)"**, in **Rules → Configuration
  Rules**. Cloudflare checks your server's certificate when it connects to it. Apps served through
  a Cloudflare Tunnel, and apps in your own Portainer, do not need it.

Each rule lists the hostnames of every OpsCrew app in the zone. Each app adds only its own
hostnames, remembers them in `.opscrew/cloudflare.json` on your computer, and later removes only
those. So the zone uses two rule slots, one of each kind, whether it has one OpsCrew app or twenty.

**Your own rules are never touched.** OpsCrew does not change, reorder or delete any rule it did not
create. It adds its rule after the rules already in the zone, and it creates a zone's custom rules
or configuration rules only when the zone has none of that kind yet. Rule kinds OpsCrew does not
use, such as redirects or cache rules, are never read or changed.

## The Cloudflare plan

Every `npx opscrew provision` first shows a **Cloudflare plan for your zone**: for each rule, the
hostnames of this app it adds or removes, and whether it creates or deletes OpsCrew's rule. Other
apps' hostnames are not listed one by one; the plan only says how many there are. The plan ends
with its hash. OpsCrew changes nothing in Cloudflare until you approve that exact plan, and it
asks before the infrastructure plan. When the app's hostnames are already in place, the plan says
so, nothing in Cloudflare changes and nothing is asked. `npx opscrew dns` shows a Cloudflare plan
too when the app's hostnames change (also after `npx opscrew domain connect` or
`npx opscrew domain buy` switched the domain): it removes the old ones and adds the new ones.

Just before it writes, OpsCrew reads the rule again. If it changed since the plan, for example
because you deployed another app into the same zone at the same moment, OpsCrew stops without
changing anything. Run the command again for a new plan.

In scripts, the Cloudflare plan's hash is one more `--approve`:

```bash
npx opscrew provision --plan-only --yes      # prints every plan's hash and the command to run
npx opscrew provision --approve <Cloudflare plan hash> --approve <infrastructure hash> --yes
```

`--yes` never approves the Cloudflare plan. A Cloudflare plan that deletes OpsCrew's rule (when the
last app's hostnames leave it) also needs the app's name: type it when the command asks in a
terminal. In a script, the command `npx opscrew provision --plan-only` prints already carries
`--confirm <app name>`. `npx opscrew dns` has no `--confirm`: run it in a terminal, or use
`npx opscrew provision` in the script.

When Portainer gets a subdomain and the account has no one-time PIN login yet (see below), the
infrastructure plan needs the login that the Cloudflare plan adds. In a script, the first
`--plan-only` then prints only the Cloudflare plan's hash. The run that approves it applies it and
stops at the infrastructure plan, printing its hash for the next run. In a terminal, OpsCrew simply
asks for one plan after the other.

From Claude Code, the OpsCrew plugin shows the same Cloudflare plan, and you approve it in a dialog
(typing the app's name when the plan deletes OpsCrew's rule). Claude cannot approve it for you.

## Sharing a Cloudflare account between apps

Cloudflare Access (used for a Cloudflare Tunnel's SSH hostname, for Portainer on a subdomain and for
Portainer's Cloudflare redeploys) needs the account's **Zero Trust organization**. Portainer's login
on a subdomain also needs the account's **one-time PIN login**, which sends a code by email.
Every app in the account shares both. OpsCrew creates them in the Cloudflare plan only when they
are missing, reuses them when they are there (also when you set them up yourself), and never
changes or deletes them. They cost nothing.

## Limits

- **Rule slots.** Each Cloudflare plan allows only so many rules of each kind in a zone: Free 5
  custom rules and 10 configuration rules, Pro 20 and 25, Business 100 and 50, Enterprise 1,000
  and 300. OpsCrew needs one slot of each kind for all its apps together. When the zone's slots are
  all used by your own rules, OpsCrew stops before changing anything and says how many rules the
  zone's plan allows. Delete or merge one of your rules, or move the zone to a higher plan.
- **Hostnames per rule.** Cloudflare accepts rule expressions of up to 4,096 characters, which is
  about 60 to 100 hostnames, depending on their length. OpsCrew counts before it plans and stops
  with a plain message when one more app would not fit. Give the app fewer hostnames, or destroy
  OpsCrew apps in the zone you no longer need.

## A hostname another app already uses

OpsCrew never takes a hostname from another app. When this app's hostname is already in OpsCrew's
rule but this app did not add it, OpsCrew stops, changes nothing and says so. This happens when
another OpsCrew app uses that hostname, or when the app that added it is gone without a
`destroy` (for example, its project folder was deleted). To free the hostname:

- If the other app still exists, run `npx opscrew destroy` in its project, or give this app
  another hostname.
- If the other app is gone, open the rule in the Cloudflare dashboard (**Security → WAF → Custom
  rules**, or **Rules → Configuration Rules**), remove the hostname from its list and save. Then
  run the command again.

If `.opscrew/cloudflare.json` is damaged, copy it back from the computer that deployed the app.
If it is lost, delete it and remove the app's hostnames from OpsCrew's rules in the dashboard;
OpsCrew then adds them again as for a new app.

## When someone changes OpsCrew's rule

`npx opscrew drift` reports when one of this app's hostnames is missing from a rule, when OpsCrew's
rule is gone, and when someone changed the rule beyond its hostnames (its action, its paths, its
setting, or turned it off). The next `npx opscrew provision` adds a missing hostname back after you
approve it, and recreates a deleted rule with this app's hostnames (other apps add theirs on their
next provision). OpsCrew never overwrites a rule someone changed in another way: it shows what
differs and how to put it back, and changes nothing until you have.

## Removing an app

`npx opscrew destroy` removes only this app's hostnames from OpsCrew's rules, as part of what it
shows before you type the app's name. When no other OpsCrew app is left in a rule, it deletes the
rule, and also the zone's rule list of that kind when OpsCrew created it and nothing else is in
it. The other apps in the zone keep their protection, their tunnels and their Access logins. The
account's Zero Trust organization and one-time PIN login always stay.

## Cloudflare token permissions

Give your `CLOUDFLARE_API_TOKEN` these permissions for the zone:

- Zone → Zone → Read
- Zone → DNS → Edit
- Zone → Zone WAF → Edit (the probe block)
- Zone → Config Rules → Edit (the strict TLS rule)
- Zone → SSL and Certificates → Edit ([origin protection](origin-protection.md))
- Zone → Zone Settings → Edit (the [minimum TLS version](tls-and-caa.md#the-minimum-tls-version))

Where the app uses Cloudflare Access (tunnel mode on your own server, Portainer on a subdomain or
Portainer's Cloudflare redeploys), also add Account → Access: Organizations, Identity Providers, and Groups →
Edit, plus the tunnel and Access permissions listed in
[Deploy to a server you already have](own-server.md#cloudflare-token-permissions) and
[Deploy to a Portainer you already run](portainer-target.md#the-tokens-and-what-they-may-do).

`npx opscrew init` reads both rule lists and names the permission that is missing.
