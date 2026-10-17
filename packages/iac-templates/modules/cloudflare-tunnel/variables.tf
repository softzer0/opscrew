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
  description = "Public hostnames the tunnel serves and the service on the server each one reaches, for example http://localhost:18080 or ssh://localhost:22. A route with a path (a regular expression, for example ^/api/) serves only the request paths it matches. Requests for any other hostname or path get a 404."
  type = list(object({
    hostname      = string
    path          = optional(string)
    service       = string
    no_tls_verify = optional(bool, false)
  }))
}
