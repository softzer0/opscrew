output "ipv4_address" {
  description = "Public IPv4 address of the server."
  value       = hcloud_server.this.ipv4_address
}

output "ipv6_address" {
  description = "Public IPv6 address of the server."
  value       = hcloud_server.this.ipv6_address
}

output "server_id" {
  description = "Hetzner Cloud server id."
  value       = hcloud_server.this.id
}

output "server_name" {
  description = "Server name."
  value       = hcloud_server.this.name
}

output "ssh_key_id" {
  description = "Id of the deploy key, for the app's other servers on Hetzner Cloud."
  value       = local.ssh_key_id
}
