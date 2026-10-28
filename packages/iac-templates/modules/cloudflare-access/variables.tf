variable "account_id" {
  description = "Cloudflare account id (Access belongs to the account)."
  type        = string
}

variable "app_name" {
  description = "App name, used in the names of the Access applications, policies and service token."
  type        = string
}

variable "service_hostname" {
  description = "Hostname of the service the deploy workflow reaches with the service token through the tunnel (SSH, or Portainer's webhook); null for none. Only the service token gets through."
  type        = string
  default     = null
}

variable "service_label" {
  description = "What service_hostname serves, in the name of its Access application: OpsCrew <label> (<app_name>), for example SSH or Portainer webhook."
  type        = string
  default     = "SSH"
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

variable "beszel_hostname" {
  description = "Hostname Beszel's dashboard is served on through the tunnel; null for none. Only beszel_allowed_emails get through, after a one-time PIN."
  type        = string
  default     = null
}

variable "beszel_allowed_emails" {
  description = "Email addresses Access lets through to Beszel's dashboard."
  type        = list(string)
  default     = []
}

variable "one_time_pin_identity_provider_id" {
  description = "Id of the account's one-time PIN login method, which the Portainer and Beszel Access applications use. Required with portainer_hostname or beszel_hostname."
  type        = string
  default     = null
}
