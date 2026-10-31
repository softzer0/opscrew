variable "name" {
  description = "Droplet name; also prefixes the firewall and SSH key names."
  type        = string
}

variable "region" {
  description = "DigitalOcean region, for example fra1."
  type        = string
}

variable "size" {
  description = "DigitalOcean Droplet size, for example s-1vcpu-2gb."
  type        = string
}

variable "image" {
  description = "Operating system image."
  type        = string
  default     = "ubuntu-24-04-x64"
}

variable "backups" {
  description = "Enable DigitalOcean daily backups (they cost extra; `opscrew design` shows the price; kept up to four weeks after the Droplet is deleted)."
  type        = bool
  default     = false
}

variable "ssh_public_key" {
  description = "Public half of the OpsCrew deploy key (ssh-ed25519 ...)."
  type        = string
}

variable "check_key_line" {
  description = "The scheduled check's authorized_keys line for the deploy user (its key, restricted to df), written at the first boot; empty for none."
  type        = string
  default     = ""
}

variable "ssh_allowed_cidrs" {
  description = "Networks allowed to reach SSH (port 22); empty for no SSH rule (public SSH closed)."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "http_allowed_cidrs" {
  description = "Networks allowed to reach HTTP/HTTPS (ports 80 and 443)."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "app_tag" {
  description = "The app's own tag, for example opscrew-app:shop; created with the Droplet and deleted with it. Null on the app's other Droplets, which get the tag in shared_tags."
  type        = string
  default     = null
}

variable "shared_tags" {
  description = "Tags shared with other apps or Droplets, for example managed-by:opscrew; added to the Droplet by name and never deleted."
  type        = list(string)
  default     = []
}

variable "web" {
  description = "Whether the Droplet serves the web: false leaves ports 80 and 443 closed, in the cloud firewall and in ufw."
  type        = bool
  default     = true
}

variable "wireguard_port" {
  description = "UDP port of the app's private WireGuard network, open to everyone; null for none."
  type        = number
  default     = null
}

variable "ssh_key_id" {
  description = "Id of the deploy key when another Droplet of the app already holds it (DigitalOcean refuses the same key twice); null creates the key here."
  type        = string
  default     = null
}
