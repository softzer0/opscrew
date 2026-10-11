output "hostnames" {
  description = "Hostnames that point at the server."
  value       = local.hosts
}

output "url" {
  description = "Public URL of the app."
  value       = "https://${var.domain}"
}
