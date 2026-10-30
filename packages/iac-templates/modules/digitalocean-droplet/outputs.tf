output "ipv4_address" {
  description = "Public IPv4 address of the Droplet."
  value       = digitalocean_droplet.this.ipv4_address
}

output "ipv6_address" {
  description = "Public IPv6 address of the Droplet."
  value       = digitalocean_droplet.this.ipv6_address
}

output "server_id" {
  description = "DigitalOcean Droplet id, as a string."
  value       = tostring(digitalocean_droplet.this.id)
}

output "server_name" {
  description = "Droplet name."
  value       = digitalocean_droplet.this.name
}

output "ssh_key_id" {
  description = "Id of the deploy key, for the app's other Droplets."
  value       = local.ssh_key_id
}

output "app_tag_name" {
  description = "The app's own tag, for the app's other Droplets; null when this module does not manage it."
  value       = one(digitalocean_tag.app[*].name)
}
