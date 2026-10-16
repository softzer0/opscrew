output "ssh_service_token_client_id" {
  description = "Client id of the deploy workflow's service token (TUNNEL_SERVICE_TOKEN_ID); null without a service hostname."
  value       = one(cloudflare_zero_trust_access_service_token.ssh[*].client_id)
  sensitive   = true
}

output "ssh_service_token_client_secret" {
  description = "Client secret of the deploy workflow's service token (TUNNEL_SERVICE_TOKEN_SECRET); null without a service hostname."
  value       = one(cloudflare_zero_trust_access_service_token.ssh[*].client_secret)
  sensitive   = true
}
