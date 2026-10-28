# Only the app's own tag is managed here. Deleting a DigitalOcean tag removes it from every
# resource in the account, so shared tags (managed-by:opscrew) are never resources: the Droplet
# create call adds them by name and creates them when missing.
resource "digitalocean_tag" "app" {
  name = var.app_tag
}

resource "digitalocean_ssh_key" "deploy" {
  name       = "${var.name}-deploy"
  public_key = var.ssh_public_key
}

resource "digitalocean_droplet" "this" {
  name       = var.name
  region     = var.region
  size       = var.size
  image      = var.image
  backups    = var.backups
  ipv6       = true
  monitoring = true
  ssh_keys   = [digitalocean_ssh_key.deploy.fingerprint]
  tags       = concat([digitalocean_tag.app.name], var.shared_tags)

  # The scheduled check's key goes in as a second authorized key (YAML-quoted); none without it.
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    ssh_public_key  = var.ssh_public_key
    check_key_entry = var.check_key_line == "" ? "" : "\n      - ${jsonencode(var.check_key_line)}"
  })

  # Daily backups at 04:00 UTC; the block is left out when backups are off.
  dynamic "backup_policy" {
    for_each = var.backups ? [1] : []
    content {
      plan = "daily"
      hour = 4
    }
  }

  lifecycle {
    # Changing these would rebuild the Droplet and lose its data; OpsCrew never does that silently.
    ignore_changes = [user_data, image, ssh_keys]
  }
}

# DigitalOcean firewalls block everything that is not allowed, outbound included, so outbound
# traffic is allowed explicitly.
resource "digitalocean_firewall" "this" {
  name        = "${var.name}-firewall"
  droplet_ids = [digitalocean_droplet.this.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.ssh_allowed_cidrs
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = var.http_allowed_cidrs
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = var.http_allowed_cidrs
  }

  inbound_rule {
    protocol         = "udp"
    port_range       = "443"
    source_addresses = var.http_allowed_cidrs
  }

  inbound_rule {
    protocol         = "icmp"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}
