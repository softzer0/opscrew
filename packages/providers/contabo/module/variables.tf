variable "name" {
  description = "Server name (its display name in the Customer Control Panel); also prefixes the firewall and SSH key names."
  type        = string
}

variable "location" {
  description = "Contabo region, for example EU."
  type        = string
}

variable "server_type" {
  description = "Contabo product id of the plan, for example V153 (Cloud VPS 4)."
  type        = string
}

variable "image" {
  description = "Id of the operating system image at Contabo (Ubuntu 24.04)."
  type        = string
}

variable "ssh_public_key" {
  description = "Public half of the OpsCrew deploy key (ssh-ed25519 ...)."
  type        = string
}

variable "check_key_line" {
  description = "The scheduled check's authorized_keys line for the deploy user (its key, restricted to OpsCrew's read-only command for the disk and the scheduled snapshots), written at the first boot; empty for none."
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
  description = "The app's own tag, for example opscrew-app:shop, assigned to the server; OpsCrew finds the app's servers by it."
  type        = string
}

variable "app_tag_id" {
  description = "Id of the app's tag when another server of the app or the root module already holds it; null creates the tag here."
  type        = string
  default     = null
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
  description = "Id of the deploy key when another server of the app already holds it (one key serves all of them); null creates the key here."
  type        = string
  default     = null
}
