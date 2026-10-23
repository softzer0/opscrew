variable "zone_id" {
  description = "Cloudflare zone id of the domain."
  type        = string
}

variable "domain" {
  description = "Hostname of the site, for example docs.example.com."
  type        = string
}

variable "apex" {
  description = "The domain is the zone's apex: A and AAAA records to GitHub Pages instead of a CNAME."
  type        = bool
}

variable "owner" {
  description = "GitHub account that owns the repository, in lower case: a subdomain and www point at <owner>.github.io."
  type        = string
}

variable "www" {
  description = "Also serve www.<domain>."
  type        = bool
  default     = false
}
