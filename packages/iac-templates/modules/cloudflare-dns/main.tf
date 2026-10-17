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
