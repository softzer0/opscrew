output "tunnel_id" {
  description = "UUID of the tunnel."
  value       = cloudflare_zero_trust_tunnel_cloudflared.this.id
}

output "waf_ruleset_id" {
  description = "Id of the zone's WAF custom rules entrypoint ruleset this module manages (null when it manages none). OpsCrew tells its own ruleset from another deployment's by this id."
  value       = one(module.waf[*].ruleset_id)
}

output "token" {
  description = "Token the connector on the server runs the tunnel with. Secret: it goes only into a root-only file on the server."
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.this.token
  sensitive   = true
}
