# A WAF custom rule that blocks probes for secrets and admin panels on the app's hostnames. It is
# the zone's http_request_firewall_custom entrypoint ruleset, so the calling module creates it only
# when the zone has none of its own.
locals {
  host_expression = "(http.host in {${join(" ", [for host in var.hostnames : "\"${host}\""])}})"
  probe_paths = join(" or ", [
    "http.request.uri.path contains \"/.env\"",
    "starts_with(http.request.uri.path, \"/.git\")",
    "http.request.uri.path contains \"/wp-admin\"",
    "http.request.uri.path contains \"/wp-login.php\"",
    "http.request.uri.path contains \"/xmlrpc.php\"",
    "http.request.uri.path contains \"/phpmyadmin\"",
  ])
}

resource "cloudflare_ruleset" "this" {
  zone_id     = var.zone_id
  name        = "OpsCrew custom rules"
  description = "Managed by OpsCrew"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      description = "OpsCrew: block probes for secrets and admin panels on ${var.hostnames[0]}"
      expression  = "${local.host_expression} and (${local.probe_paths})"
      action      = "block"
      enabled     = true
    },
  ]
}
