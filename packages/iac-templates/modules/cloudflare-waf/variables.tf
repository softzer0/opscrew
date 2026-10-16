variable "zone_id" {
  description = "Cloudflare zone id of the hostnames."
  type        = string
}

variable "hostnames" {
  description = "Hostnames the rule protects (the app's hostnames; the first one names the rule)."
  type        = list(string)
}
