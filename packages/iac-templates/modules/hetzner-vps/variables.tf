variable "name" {
  description = "Server name; also prefixes the firewall and SSH key names."
  type        = string
}

variable "location" {
  description = "Hetzner Cloud location, for example nbg1."
  type        = string
}

variable "server_type" {
  description = "Hetzner Cloud server type, for example cx23."
  type        = string
}

variable "image" {
  description = "Operating system image."
  type        = string
  default     = "ubuntu-24.04"
}

variable "backups" {
  description = "Enable Hetzner automated backups (they cost extra; `opscrew design` shows the price)."
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

variable "delete_protection" {
  description = "Protect the server against accidental deletion and rebuilds."
  type        = bool
  default     = true
}

variable "labels" {
  description = "Labels added to every resource."
  type        = map(string)
  default     = {}
}

variable "web" {
  description = "Whether the server serves the web: false leaves ports 80 and 443 closed, in the cloud firewall and in ufw."
  type        = bool
  default     = true
}

variable "wireguard_port" {
  description = "UDP port of the app's private WireGuard network, open to everyone; null for none."
  type        = number
  default     = null
}

variable "ssh_key_id" {
  description = "Id of the deploy key when another server of the app already holds it (Hetzner refuses the same key twice); null creates the key here."
  type        = string
  default     = null
}
