output "ruleset_id" {
  description = "Id of the zone's WAF custom rules entrypoint ruleset. OpsCrew tells its own ruleset from another deployment's by this id."
  value       = cloudflare_ruleset.this.id
}
