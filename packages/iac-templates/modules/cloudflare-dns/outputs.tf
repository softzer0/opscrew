output "hostnames" {
  description = "Hostnames that point at the server."
  value       = local.hosts
}

output "url" {
  description = "Public URL of the app."
  value       = "https://${var.domain}"
}

output "ruleset_ids" {
  description = "Ids of the zone entrypoint rulesets this module manages, by phase (null when it manages none). OpsCrew tells its own rulesets from another deployment's by these ids."
  value = {
    http_config_settings         = one(cloudflare_ruleset.config[*].id)
    http_request_firewall_custom = one(cloudflare_ruleset.waf[*].id)
  }
}
