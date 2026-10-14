variable "account_id" {
  description = "Cloudflare account id (Access belongs to the account)."
  type        = string
}

variable "app_name" {
  description = "App name, used in the names of the Access applications, policies and service token."
  type        = string
}

variable "ssh_hostname" {
  description = "Hostname the deploy workflow reaches SSH on through the tunnel; null for none. Only the service token gets through."
  type        = string
  default     = null
}

variable "portainer_hostname" {
  description = "Hostname Portainer is served on through the tunnel; null for none. Only portainer_allowed_emails get through, after a one-time PIN."
  type        = string
  default     = null
}

variable "portainer_allowed_emails" {
  description = "Email addresses Access lets through to Portainer."
  type        = list(string)
  default     = []
}

variable "create_organization" {
  description = "Create the account's Zero Trust organization. OpsCrew sets this only when the account has none yet (or when this configuration already created it)."
  type        = bool
  default     = false
}

variable "organization_auth_domain" {
  description = "Team domain of the Zero Trust organization OpsCrew creates, for example example-com-opscrew.cloudflareaccess.com."
  type        = string
  default     = null
}

variable "one_time_pin_identity_provider_id" {
  description = "Id of the account's existing one-time PIN login method; null makes this module create one (an account can have only one)."
  type        = string
  default     = null
}
