# Certificates, CAA records and the minimum TLS version

Every OpsCrew app is served over HTTPS only, with TLS 1.2 and 1.3. This page explains where the
certificates come from, how they are renewed, and two cheap protections OpsCrew adds in your
Cloudflare zone: CAA records and the zone's minimum TLS version.

## Where each certificate comes from

| The hostname is | Its certificate | Renewed by |
|---|---|---|
| behind Cloudflare's proxy | a Cloudflare origin certificate on your server, valid for 15 years (see [origin protection](origin-protection.md)); visitors see Cloudflare's own certificate | `npx opscrew provision`, when fewer than 30 days are left |
| DNS only, with Caddy | Let's Encrypt, with ZeroSSL as Caddy's fallback | Caddy, by itself |
| DNS only, with nginx | Let's Encrypt, obtained by certbot during the first deploy | certbot, twice a day when it is due, with a reload that drops no connection |
| served through a Cloudflare Tunnel | Cloudflare's edge | Cloudflare |

`npx opscrew status` lists each certificate OpsCrew manages with its expiry. `status`,
`npx opscrew verify` and `npx opscrew secure` warn when fewer than 30 days are left, and on nginx
they give certbot's reason when its last renewal failed. See
[the reverse proxy](reverse-proxy.md#certificates) for what happens when the first certificate
cannot be obtained.

## CAA records

A CAA record says which certificate authorities may issue certificates for a name. OpsCrew adds CAA
records at the app's own DNS-only hostnames on your server, naming only the authorities its proxy
uses:

- with Caddy: `letsencrypt.org` and `sectigo.com` (ZeroSSL's);
- with nginx: `letsencrypt.org`.

They are part of the infrastructure plan, next to the app's DNS records, and need no extra token
permission. The `www` name follows the domain's own records.

- **The zone's apex** (`example.com` itself) never gets a CAA record from OpsCrew, because it
  applies to every name below it. When your app is served on the apex, `npx opscrew secure`
  advises a CAA record you can add yourself.
- **Your own CAA records** are left alone. If you already have one at one of the app's hostnames,
  OpsCrew reports it instead of replacing it.
- **Proxied hostnames** get no CAA record from OpsCrew: Cloudflare manages the certificates for its
  edge.
- `npx opscrew destroy` removes the app's CAA records.

## The minimum TLS version

A new Cloudflare zone still accepts TLS 1.0 and 1.1 from visitors at its edge. OpsCrew raises the
zone's minimum to TLS 1.2, in the [Cloudflare plan](cloudflare.md#the-cloudflare-plan) you
approve, only when it harms no one:

- the zone's minimum is still the default, 1.0;
- every proxied record in the zone belongs to an OpsCrew app.

OpsCrew records in `.opscrew/cloudflare.json` that it set it. Otherwise it changes nothing, and
`npx opscrew secure` advises the change, so you can decide for your other sites. OpsCrew never
lowers the minimum, and `npx opscrew destroy` leaves it as it is.

This needs the token permission **Zone → Zone Settings → Edit**. Without it, OpsCrew changes nothing
in the zone's settings and says which permission to add.
