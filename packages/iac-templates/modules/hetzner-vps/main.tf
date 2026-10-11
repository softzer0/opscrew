resource "hcloud_ssh_key" "deploy" {
  name       = "${var.name}-deploy"
  public_key = var.ssh_public_key
  labels     = var.labels
}

resource "hcloud_firewall" "this" {
  name   = "${var.name}-firewall"
  labels = var.labels

  rule {
    description = "SSH"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.ssh_allowed_cidrs
  }

  rule {
    description = "HTTP"
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = var.http_allowed_cidrs
  }

  rule {
    description = "HTTPS"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = var.http_allowed_cidrs
  }

  rule {
    description = "HTTP/3"
    direction   = "in"
    protocol    = "udp"
    port        = "443"
    source_ips  = var.http_allowed_cidrs
  }

  rule {
    description = "Ping"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_server" "this" {
  name               = var.name
  server_type        = var.server_type
  location           = var.location
  image              = var.image
  backups            = var.backups
  ssh_keys           = [hcloud_ssh_key.deploy.id]
  firewall_ids       = [hcloud_firewall.this.id]
  delete_protection  = var.delete_protection
  rebuild_protection = var.delete_protection
  labels             = var.labels

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    ssh_public_key = var.ssh_public_key
  })

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  lifecycle {
    # Changing these would rebuild the server and lose its data; OpsCrew never does that silently.
    ignore_changes = [user_data, image, ssh_keys]
  }
}
