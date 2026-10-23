# The DNS records of a site on GitHub Pages, all DNS only: Cloudflare's proxy would stop GitHub
# from issuing and renewing the site's certificate. No CAA record: OpsCrew writes none at a zone's
# apex (it would bind every name in the zone), and a name with a CNAME can hold no other record.
locals {
  # GitHub Pages' addresses for an apex domain.
  ipv4      = ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"]
  ipv6      = ["2606:50c0:8000::153", "2606:50c0:8001::153", "2606:50c0:8002::153", "2606:50c0:8003::153"]
  github_io = "${var.owner}.github.io"
}

resource "cloudflare_dns_record" "a" {
  for_each = var.apex ? toset(local.ipv4) : toset([])
  zone_id  = var.zone_id
  name     = var.domain
  type     = "A"
  content  = each.value
  ttl      = 1
  proxied  = false
  comment  = "Managed by OpsCrew"
}

resource "cloudflare_dns_record" "aaaa" {
  for_each = var.apex ? toset(local.ipv6) : toset([])
  zone_id  = var.zone_id
  name     = var.domain
  type     = "AAAA"
  content  = each.value
  ttl      = 1
  proxied  = false
  comment  = "Managed by OpsCrew"
}

# A subdomain points at the owner's GitHub Pages host.
resource "cloudflare_dns_record" "cname" {
  count   = var.apex ? 0 : 1
  zone_id = var.zone_id
  name    = var.domain
  type    = "CNAME"
  content = local.github_io
  ttl     = 1
  proxied = false
  comment = "Managed by OpsCrew"
}

# GitHub redirects www.<domain> to the domain once both point at it.
resource "cloudflare_dns_record" "www" {
  count   = var.www ? 1 : 0
  zone_id = var.zone_id
  name    = "www.${var.domain}"
  type    = "CNAME"
  content = local.github_io
  ttl     = 1
  proxied = false
  comment = "Managed by OpsCrew"
}
