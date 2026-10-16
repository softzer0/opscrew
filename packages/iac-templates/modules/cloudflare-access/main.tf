# Cloudflare Access in front of the hostnames the tunnel serves:
# - The service the deploy workflow reaches (SSH, or Portainer's webhook): a Service Auth policy
#   that lets exactly one service token through.
# - Portainer (opt-in): the listed email addresses, after a one-time PIN sent to that address.
locals {
  service   = var.service_hostname != null
  portainer = var.portainer_hostname != null
  one_time_pin_id = (
    var.one_time_pin_identity_provider_id != null
    ? var.one_time_pin_identity_provider_id
    : one(cloudflare_zero_trust_access_identity_provider.one_time_pin[*].id)
  )
}

resource "cloudflare_zero_trust_organization" "this" {
  count       = var.create_organization ? 1 : 0
  account_id  = var.account_id
  name        = var.organization_auth_domain
  auth_domain = var.organization_auth_domain
}

resource "cloudflare_zero_trust_access_service_token" "ssh" {
  count      = local.service ? 1 : 0
  account_id = var.account_id
  name       = "OpsCrew deploy (${var.app_name})"
  # Deploys must not stop working when a token expires; rotate it by re-running provision.
  duration = "forever"

  depends_on = [cloudflare_zero_trust_organization.this]
}

resource "cloudflare_zero_trust_access_policy" "ssh" {
  count      = local.service ? 1 : 0
  account_id = var.account_id
  name       = "OpsCrew deploy (${var.app_name})"
  decision   = "non_identity"
  include = [
    { service_token = { token_id = cloudflare_zero_trust_access_service_token.ssh[0].id } },
  ]

  depends_on = [cloudflare_zero_trust_organization.this]
}

resource "cloudflare_zero_trust_access_application" "ssh" {
  count                     = local.service ? 1 : 0
  account_id                = var.account_id
  name                      = "OpsCrew ${var.service_label} (${var.app_name})"
  type                      = "self_hosted"
  domain                    = var.service_hostname
  destinations              = [{ type = "public", uri = var.service_hostname }]
  app_launcher_visible      = false
  service_auth_401_redirect = true
  session_duration          = "24h"
  policies = [
    { id = cloudflare_zero_trust_access_policy.ssh[0].id, precedence = 1 },
  ]
}

resource "cloudflare_zero_trust_access_identity_provider" "one_time_pin" {
  count      = local.portainer && var.one_time_pin_identity_provider_id == null ? 1 : 0
  account_id = var.account_id
  name       = "One-time PIN"
  type       = "onetimepin"
  config     = {}

  depends_on = [cloudflare_zero_trust_organization.this]
}

resource "cloudflare_zero_trust_access_policy" "portainer" {
  count      = local.portainer ? 1 : 0
  account_id = var.account_id
  name       = "OpsCrew Portainer (${var.app_name})"
  decision   = "allow"
  include    = [for email in var.portainer_allowed_emails : { email = { email = email } }]

  depends_on = [cloudflare_zero_trust_organization.this]
}

resource "cloudflare_zero_trust_access_application" "portainer" {
  count                     = local.portainer ? 1 : 0
  account_id                = var.account_id
  name                      = "OpsCrew Portainer (${var.app_name})"
  type                      = "self_hosted"
  domain                    = var.portainer_hostname
  destinations              = [{ type = "public", uri = var.portainer_hostname }]
  allowed_idps              = [local.one_time_pin_id]
  auto_redirect_to_identity = true
  app_launcher_visible      = false
  session_duration          = "24h"
  policies = [
    { id = cloudflare_zero_trust_access_policy.portainer[0].id, precedence = 1 },
  ]
}
