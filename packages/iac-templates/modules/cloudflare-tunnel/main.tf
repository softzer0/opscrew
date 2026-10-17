# A remotely managed Cloudflare Tunnel: its routes live in Cloudflare (config_src = "cloudflare"),
# and the connector on the server only needs the tunnel token (output "token").
resource "cloudflare_zero_trust_tunnel_cloudflared" "this" {
  account_id = var.account_id
  name       = var.name
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id

  config = {
    # Every route in order, then a final rule that answers 404 for any other hostname (and for
    # the paths a route with a path does not match).
    ingress = concat(
      [
        for route in var.routes : {
          hostname       = route.hostname
          path           = route.path
          service        = route.service
          origin_request = route.no_tls_verify ? { no_tls_verify = true } : null
        }
      ],
      [
        {
          hostname       = null
          path           = null
          service        = "http_status:404"
          origin_request = null
        },
      ],
    )
  }
}

resource "cloudflare_dns_record" "route" {
  for_each = toset([for route in var.routes : route.hostname])

  zone_id = var.zone_id
  name    = each.value
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  ttl     = 1
  proxied = true
  comment = "Managed by OpsCrew"
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id
}
