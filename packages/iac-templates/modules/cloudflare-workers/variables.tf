variable "account_id" {
  description = "Cloudflare account id (the Worker belongs to the account)."
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone id of the domain."
  type        = string
}

variable "worker" {
  description = "Name of the Worker, unique in the account, for example example-app."
  type        = string
}

variable "domain" {
  description = "Hostname of the app, for example app.example.com."
  type        = string
}

variable "www" {
  description = "Also serve www.<domain>."
  type        = bool
  default     = false
}

variable "workers_dev" {
  description = "Serve the Worker on its workers.dev address."
  type        = bool
  default     = false
}

variable "preview_urls" {
  description = "Give each version of the Worker its own preview URL."
  type        = bool
  default     = false
}
