# Only Cloudflare reaches your server: origin protection

When your app's hostnames are behind Cloudflare's proxy (the orange cloud), visitors meet
Cloudflare first: its firewall, OpsCrew's probe block and your own rules. Limiting your server to
Cloudflare's addresses is not enough on its own, because anyone with a Cloudflare account can point
their own zone at your server's address and reach it through Cloudflare. Origin protection closes
that gap: your server accepts connections for your app only from Cloudflare acting for **your**
zone.

## What OpsCrew sets up

For each proxied hostname of the app, OpsCrew:

- **serves a Cloudflare origin certificate** for exactly the app's proxied hostnames. Only
  Cloudflare trusts it, so a visitor who goes around Cloudflare gets no certificate their browser
  accepts. It is valid for 15 years, Cloudflare's longest, so your site keeps working if you stop
  using OpsCrew.
- **requires a client certificate of the app's own.** OpsCrew makes it, uploads it to your zone and
  turns on Cloudflare's per-hostname Authenticated Origin Pulls, so Cloudflare presents it when it
  connects to your server for these hostnames. Your server refuses any TLS connection for them
  without it. Cloudflare's shared certificate, which every Cloudflare customer can send, is never
  used.
- **refuses every other hostname.** A connection for a name the server does not serve is closed.

The private keys are made on your computer. The origin certificate's key goes only to your server,
as a deploy secret, and the client certificate's key only to Cloudflare. Both are kept in OpsCrew's
generated values on your computer, which the [recovery copy](secrets-recovery.md) encrypts. No key
is ever in a plan, a log, a report or your repository.

It works on servers OpsCrew creates (Hetzner Cloud, DigitalOcean), on
[a server you already have](own-server.md) with either [proxy](reverse-proxy.md), and in
[your Portainer](portainer-target.md) when OpsCrew's Caddy serves the app's stack (web mode
`caddy`).

Not covered, because there is no public origin to protect or OpsCrew does not run the proxy:

- hostnames served through a Cloudflare Tunnel;
- an app in your Portainer behind your own reverse proxy (web mode `proxy`); `opscrew secure` says
  so;
- hostnames with DNS only (the grey cloud). They get a public certificate instead, with
  [CAA records](tls-and-caa.md).

## What you need

Your `CLOUDFLARE_API_TOKEN` needs, besides the permissions every OpsCrew deployment uses:

- **Zone → SSL and Certificates → Edit**, for the origin certificate, the client certificate and
  the per-hostname settings;
- **Zone → Zone Settings → Edit**, for the [minimum TLS version](tls-and-caa.md#the-minimum-tls-version).

`npx opscrew init` lists every permission the token needs. Edit the token at
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) and add
the two to the zone's permissions.

## What happens when you provision

`npx opscrew provision` shows these changes in the
[Cloudflare plan](cloudflare.md#the-cloudflare-plan), next to OpsCrew's rules, for example:

```text
Upload this app's client certificate to Cloudflare (SHA-256 …)
Turn on this app's client certificate for shop.example.com, www.shop.example.com (SHA-256 …)
Create a Cloudflare origin certificate for shop.example.com, www.shop.example.com (15 years)
```

Nothing changes until you approve that plan's hash. The order keeps the site up throughout:
Cloudflare starts sending the client certificate (OpsCrew waits up to five minutes until Cloudflare
reports it active) before your server starts requiring it, and the deploy puts the certificate on
the server before the app's site switches to it. Turning the protection off goes the other way.

When only the certificate or a secret changed, OpsCrew starts the deploy workflow itself, and the
plan's approval text says so first.

In scripts (`provision --plan-only`, then `provision --approve <hash> …`, as the MCP tools do too),
a server gets origin protection with the first provision: the approved run writes the site with the
certificates the Cloudflare plan created, and the deploy-setup pull request brings it.

In [your Portainer](portainer-target.md), the stack plan follows the Cloudflare plan and is approved
by its own hash, because the stack gets the certificates the Cloudflare plan creates.
`provision --plan-only` says so and prints only the Cloudflare plan's hash. The run that applies
that plan then stops before it changes anything in Portainer: it prints the stack plan with its hash
and asks you to run again with `--approve` and that hash. The MCP tools show the stack plan in its
own dialog instead. The same happens whenever a Cloudflare plan gives the stack a new origin
certificate.

## Day to day

- `npx opscrew status` shows both certificates and when they expire.
- `npx opscrew provision` replaces the origin certificate when fewer than 30 days are left, or when
  the app's proxied hostnames change. `status`, `secure` and `provision` warn 30 days ahead. The old
  certificate is revoked once your server serves the new one.
- `npx opscrew secure` checks from the server itself that a connection without the client
  certificate is refused, that the certificate comes from Cloudflare's Origin CA, and that an
  unknown hostname is refused. It also lists anything missing, such as the token permissions.
- `npx opscrew drift` reports a per-hostname setting turned off or pointing at another certificate,
  and an origin certificate deleted at Cloudflare. Run `npx opscrew provision` to put them back.
- `npx opscrew destroy` revokes the app's origin certificates and deletes its client certificate
  and per-hostname settings. Other apps in the zone and your own settings stay as they are.

## When the token lacks the permissions

Provision says which permission to add and carries on: the app keeps today's protection (the
server's firewall accepts web traffic only from Cloudflare's addresses, with a public certificate),
and `npx opscrew secure` lists the gap until you add them. Run `npx opscrew provision` again
afterwards.

## Moving a hostname off Cloudflare's proxy

Switching a hostname from proxied to DNS only takes two provision runs, so no request fails:

1. The first run stops requiring the client certificate for it, while the hostname stays proxied.
   It says to run again.
2. The second run switches the DNS record. The hostname then gets a public certificate from the
   server's proxy.

## Known limits

- **Moving the app to another Cloudflare zone** leaves its origin and client certificates in the
  old zone. OpsCrew sets up new ones in the new zone, but does not clean up the old zone: revoke the
  origin certificate there by hand (**SSL/TLS → Origin Server** in the old zone's dashboard), and
  delete its per-hostname client certificate with Cloudflare's API.
- **Your own proxy rules are not used in a Portainer stack yet.** The stack's Caddy gets origin
  protection, but not your [additions](reverse-proxy.md#your-own-rules); provision warns when you
  have them.
- **The client certificate is never replaced by OpsCrew.** It is valid for 15 years. When it nears
  its expiry, `status` and `secure` warn and give the steps to replace it by hand.
- **A brief error for the zone's other apps, now and then.** When OpsCrew turns on the client
  certificate for a new hostname (a new app or environment in the zone), Cloudflare can fail a few
  requests to the zone's other proxied hostnames with error 520, for a fraction of a second. It
  comes from Cloudflare applying the setting: OpsCrew changes nothing for those hostnames. It is
  rare, and a reload works.
- **Another app's settings win.** When one of this app's hostnames already has a per-hostname
  setting with a certificate that is not this app's, OpsCrew stops and says how to free the
  hostname, as it does for [OpsCrew's rules](cloudflare.md#a-hostname-another-app-already-uses).
