variable "zone_id" {
  description = "Cloudflare zone id of the domain."
  type        = string
}

variable "domain" {
  description = "Hostname of the app, for example app.example.com."
  type        = string
}

variable "ipv4" {
  description = "Public IPv4 address of the server."
  type        = string
}

variable "ipv6" {
  description = "Public IPv6 address of the server."
  type        = string
}

variable "proxied" {
  description = "Send traffic through Cloudflare (hides the server IP, adds the WAF and caching)."
  type        = bool
  default     = true
}

variable "www" {
  description = "Also serve www.<domain>."
  type        = bool
  default     = false
}

variable "manage_config_rule" {
  description = "Set Full (strict) TLS for this hostname with a configuration rule. OpsCrew turns this off when the zone already has its own configuration rules."
  type        = bool
  default     = true
}

variable "manage_waf_rules" {
  description = "Block common probes with a WAF custom rule. OpsCrew turns this off when the zone already has its own custom rules."
  type        = bool
  default     = true
}
