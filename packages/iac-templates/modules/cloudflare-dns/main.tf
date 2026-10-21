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

# CAA at the app's own name, naming only the authorities the server's proxy uses, and only when
# that proxy gets the certificate (DNS only). `www` is a CNAME, so lookups follow it here. The
# renderer passes no issuers for an app on the zone apex: CAA there would bind every name in the
# zone.
resource "cloudflare_dns_record" "caa" {
  for_each = var.proxied ? toset([]) : toset(var.caa_issuers)
  zone_id  = var.zone_id
  name     = var.domain
  type     = "CAA"
  ttl      = 1
  data = {
    flags = 0
    tag   = "issue"
    value = each.value
  }
  comment = "Managed by OpsCrew"
}
