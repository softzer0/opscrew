output "ipv4_address" {
  description = "Public IPv4 address of the server."
  value       = contabo_instance.this.ip_config[0].v4[0].ip
}

# Contabo answers the address in full (…:0000:0000:0000:0001); cidrhost gives it back shortened
# (…::1), as Cloudflare stores the AAAA record, so the record never looks changed.
output "ipv6_address" {
  description = "Public IPv6 address of the server, shortened, or null when it has none."
  value       = try(cidrhost("${contabo_instance.this.ip_config[0].v6[0].ip}/128", 0), null)
}

output "server_id" {
  description = "Contabo instance id."
  value       = contabo_instance.this.id
}

output "server_name" {
  description = "Server name (its display name)."
  value       = contabo_instance.this.display_name
}

output "ssh_key_id" {
  description = "Id of the deploy key, for the app's other servers on Contabo."
  value       = local.ssh_key_id
}

# The root module reads every server module's shared tag from app_tag_name. On Contabo a tag is
# assigned by its id, so this holds the id.
output "app_tag_name" {
  description = "Id of the app's tag, for the app's other servers on Contabo."
  value       = local.app_tag_id
}

output "wanted_backup" {
  description = "Contabo's Auto Backup, which OpsCrew's Contabo connector turns on after the apply when on is true: the server id and on."
  value       = terraform_data.backup.input
}

output "wanted_firewall" {
  description = "The firewall OpsCrew's Contabo connector makes after every apply: its name, description, server ids and rules."
  value       = terraform_data.firewall.input
}
