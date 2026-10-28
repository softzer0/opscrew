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
  description = "Networks allowed to reach SSH (port 22)."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "http_allowed_cidrs" {
  description = "Networks allowed to reach HTTP/HTTPS (ports 80 and 443)."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "app_tag" {
  description = "The app's own tag, for example opscrew-app:shop; created with the Droplet and deleted with it."
  type        = string
}

variable "shared_tags" {
  description = "Tags shared with other apps, for example managed-by:opscrew; added to the Droplet by name and never deleted."
  type        = list(string)
  default     = []
}
