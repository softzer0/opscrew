variable "account_id" {
  description = "Cloudflare account id (tunnels belong to the account)."
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone id of the hostnames the tunnel serves."
  type        = string
}

variable "name" {
  description = "Name of the tunnel, for example opscrew-shop."
  type        = string
}

variable "routes" {
  description = "Public hostnames the tunnel serves and the service on the server each one reaches, for example http://localhost:18080 or ssh://localhost:22. Requests for any other hostname get a 404."
  type = list(object({
    hostname      = string
    service       = string
    no_tls_verify = optional(bool, false)
  }))
}

variable "manage_waf_rules" {
  description = "Block common probes on the waf_hostnames with a WAF custom rule. OpsCrew turns this off when the zone already has its own custom rules."
  type        = bool
  default     = false
}

variable "waf_hostnames" {
  description = "Hostnames the WAF custom rule protects (the app's hostnames)."
  type        = list(string)
  default     = []
}
