output "tunnel_id" {
  description = "UUID of the tunnel."
  value       = cloudflare_zero_trust_tunnel_cloudflared.this.id
}

output "token" {
  description = "Token the connector on the server runs the tunnel with. Secret: it goes only into a root-only file on the server."
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.this.token
  sensitive   = true
}
