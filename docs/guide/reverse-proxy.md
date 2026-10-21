# The reverse proxy: Caddy or nginx, and your own rules

Every OpsCrew app on a server sits behind one shared edge in `/srv/edge`: a reverse proxy that
serves HTTPS, and kamal-proxy behind it, which switches deploys without downtime. The proxy is
**Caddy** by default, or **nginx** with certbot if you prefer it. Either way you can add your own
rules for each app.

## Choosing the proxy

Set `target.edge` in `opscrew/plan.yaml`, then run `npx opscrew provision`:

```yaml
target:
  provider: hetzner
  edge: nginx # or caddy, the default
```

Visitors get the same protections from both:

- TLS 1.2 and 1.3 only, and HTTP redirected to HTTPS;
- the same security headers: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: strict-origin-when-cross-origin`, and no server version;
- WebSockets and long requests (up to 300 seconds);
- a refusal for hostnames the server does not serve;
- uploads: no limit on Caddy; on nginx up to `app.maxBodyMb` in `opscrew/plan.yaml` (100 MB unless
  you change it).

An app in [your Portainer](portainer-target.md) always uses Caddy in its stack.

**One proxy per server.** Every OpsCrew app on a server shares the same proxy. When the server
already holds other OpsCrew apps, provision refuses a different choice before changing anything.
While the server holds only this app, the proxy can be switched: the plan shows the switch and the
short interruption it causes (a few seconds for proxied hostnames, under a minute for DNS-only ones,
while the new proxy gets its certificates). Switching several apps at once is not supported yet.

## Certificates

- **Proxied hostnames** use a Cloudflare origin certificate on both proxies; see
  [origin protection](origin-protection.md).
- **DNS-only hostnames with Caddy:** Caddy gets and renews the certificates itself.
- **DNS-only hostnames with nginx:** certbot gets the first certificate during the first deploy,
  checks for renewal twice a day and renews 45 days before expiry. After a renewal nginx checks its
  configuration and reloads, without dropping connections. You do nothing.

With nginx, if the first certificate cannot be obtained, for example because the domain does not
point at the server yet, the deploy says why and keeps the site on plain HTTP until the next deploy
(Caddy keeps trying by itself). When you hit
Let's Encrypt's rate limit (after repeated failed deploys), the message names the limit and when to
try again. `npx opscrew status`, `verify` and `secure` warn 30 days before a certificate expires,
with certbot's reason when its renewal keeps failing. See also
[CAA records](tls-and-caa.md#caa-records).

## Your own rules

Put rules for one app in its additions file, in the proxy's own syntax:

- Caddy: `opscrew/proxy/additions.caddy`, imported inside the app's site;
- nginx: `opscrew/proxy/additions.nginx`, included in the app's HTTPS `server` block.

For example, a header and a redirect with Caddy:

```caddy
header /docs/* Cache-Control "public, max-age=3600"
redir /old-pricing /pricing 301
```

The same with nginx (a `location` passes its requests on to the app with `proxy_pass`):

```nginx
location /docs/ {
    add_header Cache-Control "public, max-age=3600";
    proxy_pass http://kamal-proxy;
}
location = /old-pricing { return 301 /pricing; }
```

Commit the file; the next `npx opscrew provision` and deploy put it live. Before any change,
OpsCrew checks it three ways, and an addition that fails any of them is refused with its line and
the reason, while the running configuration stays as it was:

1. **OpsCrew's rules** allow only the directives listed below, and refuse among them anything
   unsafe: TLS settings (OpsCrew manages TLS), admin or status endpoints, traffic sent anywhere but
   the app, another app's hostnames, files served from the server, includes, scripting, Caddy
   placeholders that read files or the environment, and request logs sent off the server.
2. **The proxy's own checker** (`caddy validate` or `nginx -t`) on your computer when Docker is
   there, and always in the deploy job before anything is uploaded.
3. **gixy-ng**, an nginx configuration analyser, when it is installed on your computer.

A file for the other proxy (an `additions.nginx` on a Caddy server, for instance) is refused with
how to convert it.

### What additions may contain

| Proxy | Allowed |
|---|---|
| nginx | `location`, `if`, `add_header`, `proxy_set_header` (at server level), `proxy_hide_header`, `proxy_redirect`, `proxy_pass` (to the app only), `proxy_intercept_errors`, the `proxy_*_timeout` settings, `proxy_buffering`, `proxy_request_buffering`, `error_page`, `return`, `rewrite`, `break`, `internal`, `limit_req` (with a zone named `opscrew_…`), `limit_req_status`, `allow`, `deny`, `client_max_body_size`, `expires`, `etag`, `charset` and the `gzip` settings |
| Caddy | `header`, `request_header`, `redir`, `rewrite`, `uri`, `respond`, `error`, `abort`, `handle`, `handle_path`, `route`, `handle_response`, `encode`, `basic_auth`, `request_body`, `reverse_proxy` (to the app only), `copy_response`, `copy_response_headers`, and `@name` matchers on path, header, method, query, host, client address and protocol |

Anything else is refused as "not supported in additions yet". Tell OpsCrew if you need a directive
that is missing.

## Coming from Vercel: `vercel.json`

When your app has routing rules in `vercel.json` (`redirects`, `rewrites`, `headers`, `cleanUrls`
and `trailingSlash`), `npx opscrew design` writes them into the app's additions file for the chosen
proxy, but only when the app has no additions file yet. Rules in `next.config.js` need nothing:
Next.js applies them itself.

- **Vercel's order is kept:** headers, then redirects (with `cleanUrls` and `trailingSlash` first),
  then rewrites. Redirects keep their status codes, and headers apply to the matching paths.
- **A rewrite to a path of the app applies the way Vercel applies it:** only when the app answers
  404 for the original path, because Vercel serves the app's own files first.
- **The file is yours.** Its header names `vercel.json` and its SHA-256. Edit it as you like. When
  `vercel.json` changes later, design says so and leaves the file alone.

Design lists every rule it left out, with the reason:

- rewrites to another site: the edge sends traffic only to the app;
- rules with `has` or `missing` conditions (on a cookie, a header or the query);
- the older `routes` property, and malformed entries;
- a header the edge already sends on every response, such as `Strict-Transport-Security`;
- patterns the proxy cannot express, such as more than nine groups on nginx;
- on nginx, a header rule whose paths overlap an earlier rule's, because nginx applies the headers
  of one `location` only.

**Only one fallback applies per request.** Vercel tries several rewrites in turn; the translation
gives each request at most one. With `cleanUrls` and a catch-all rewrite for a single-page app
together, an unknown path tries `<path>.html`, and then gets the app's own 404 instead of
`/index.html`. If your app relies on both, keep one of them, or adjust the additions file.

## Known limits

- **Portainer:** the stack's Caddy does not use your additions yet; provision warns when you have
  them.
- **Apache and Traefik** are not offered.
