locals {
  hosts           = var.www ? [var.domain, "www.${var.domain}"] : [var.domain]
  host_expression = "(http.host in {${join(" ", [for host in local.hosts : "\"${host}\""])}})"
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

module "waf" {
  source = "../cloudflare-waf"
  count  = var.manage_waf_rules ? 1 : 0

  zone_id   = var.zone_id
  hostnames = local.hosts
}
