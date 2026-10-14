locals {
  hosts           = var.www ? [var.domain, "www.${var.domain}"] : [var.domain]
  host_expression = "(http.host in {${join(" ", [for host in local.hosts : "\"${host}\""])}})"
  probe_paths = join(" or ", [
    "http.request.uri.path contains \"/.env\"",
    "starts_with(http.request.uri.path, \"/.git\")",
    "http.request.uri.path contains \"/wp-admin\"",
    "http.request.uri.path contains \"/wp-login.php\"",
    "http.request.uri.path contains \"/xmlrpc.php\"",
    "http.request.uri.path contains \"/phpmyadmin\"",
  ])
}

resource "cloudflare_dns_record" "a" {
  zone_id = var.zone_id
  name    = var.domain
  type    = "A"
  content = var.ipv4
  ttl     = 1
  proxied = var.proxied
  comment = "Managed by OpsCrew"
}

resource "cloudflare_dns_record" "aaaa" {
  count   = var.ipv6_record ? 1 : 0
  zone_id = var.zone_id
  name    = var.domain
  type    = "AAAA"
  content = var.ipv6
  ttl     = 1
  proxied = var.proxied
  comment = "Managed by OpsCrew"
}

# The AAAA record became optional (servers without IPv6); keeps the record already in the state.
moved {
  from = cloudflare_dns_record.aaaa
  to   = cloudflare_dns_record.aaaa[0]
}

resource "cloudflare_dns_record" "www" {
  count   = var.www ? 1 : 0
  zone_id = var.zone_id
  name    = "www.${var.domain}"
  type    = "CNAME"
  content = var.domain
  ttl     = 1
  proxied = var.proxied
  comment = "Managed by OpsCrew"
}

resource "cloudflare_ruleset" "config" {
  count       = var.manage_config_rule ? 1 : 0
  zone_id     = var.zone_id
  name        = "OpsCrew configuration rules"
  description = "Managed by OpsCrew"
  kind        = "zone"
  phase       = "http_config_settings"

  rules = [
    {
      description       = "OpsCrew: verify the origin certificate (Full (strict) TLS) for ${var.domain}"
      expression        = local.host_expression
      action            = "set_config"
      action_parameters = { ssl = "strict" }
      enabled           = true
    },
  ]
}

resource "cloudflare_ruleset" "waf" {
  count       = var.manage_waf_rules ? 1 : 0
  zone_id     = var.zone_id
  name        = "OpsCrew custom rules"
  description = "Managed by OpsCrew"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      description = "OpsCrew: block probes for secrets and admin panels on ${var.domain}"
      expression  = "${local.host_expression} and (${local.probe_paths})"
      action      = "block"
      enabled     = true
    },
  ]
}
