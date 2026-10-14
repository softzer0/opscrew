# A remotely managed Cloudflare Tunnel: its routes live in Cloudflare (config_src = "cloudflare"),
# and the connector on the server only needs the tunnel token (output "token").
locals {
  host_expression = "(http.host in {${join(" ", [for host in var.waf_hostnames : "\"${host}\""])}})"
  probe_paths = join(" or ", [
    "http.request.uri.path contains \"/.env\"",
    "starts_with(http.request.uri.path, \"/.git\")",
    "http.request.uri.path contains \"/wp-admin\"",
    "http.request.uri.path contains \"/wp-login.php\"",
    "http.request.uri.path contains \"/xmlrpc.php\"",
    "http.request.uri.path contains \"/phpmyadmin\"",
  ])
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "this" {
  account_id = var.account_id
  name       = var.name
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id

  config = {
    # Every route in order, then a final rule that answers 404 for any other hostname.
    ingress = concat(
      [
        for route in var.routes : {
          hostname       = route.hostname
          service        = route.service
          origin_request = route.no_tls_verify ? { no_tls_verify = true } : null
        }
      ],
      [
        {
          hostname       = null
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

resource "cloudflare_ruleset" "waf" {
  count       = var.manage_waf_rules && length(var.waf_hostnames) > 0 ? 1 : 0
  zone_id     = var.zone_id
  name        = "OpsCrew custom rules"
  description = "Managed by OpsCrew"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      description = "OpsCrew: block probes for secrets and admin panels on ${var.waf_hostnames[0]}"
      expression  = "${local.host_expression} and (${local.probe_paths})"
      action      = "block"
      enabled     = true
    },
  ]
}
