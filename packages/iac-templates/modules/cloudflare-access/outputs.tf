output "ssh_service_token_client_id" {
  description = "Client id of the deploy workflow's service token (TUNNEL_SERVICE_TOKEN_ID); null without an SSH hostname."
  value       = one(cloudflare_zero_trust_access_service_token.ssh[*].client_id)
  sensitive   = true
}

output "ssh_service_token_client_secret" {
  description = "Client secret of the deploy workflow's service token (TUNNEL_SERVICE_TOKEN_SECRET); null without an SSH hostname."
  value       = one(cloudflare_zero_trust_access_service_token.ssh[*].client_secret)
  sensitive   = true
}

output "ssh_application_id" {
  description = "Id of the Access application in front of the SSH hostname; null without one."
  value       = one(cloudflare_zero_trust_access_application.ssh[*].id)
}

output "portainer_application_id" {
  description = "Id of the Access application in front of Portainer; null without one."
  value       = one(cloudflare_zero_trust_access_application.portainer[*].id)
}
