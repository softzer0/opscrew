locals {
  # coalesce's result is known not to be null before apply, so another Droplet's count (below) is
  # known when it gets this id.
  ssh_key_id = coalesce(var.ssh_key_id, one(digitalocean_ssh_key.deploy[*].id))
  web_rules = [
    { protocol = "tcp", port = "80" },
    { protocol = "tcp", port = "443" },
    { protocol = "udp", port = "443" },
  ]
}

# Only the app's own tag is managed here. Deleting a DigitalOcean tag removes it from every
# resource in the account, so shared tags (managed-by:opscrew) are never resources: the Droplet
# create call adds them by name and creates them when missing. Another Droplet of the app passes
# no app_tag and gets the app's tag in shared_tags instead, so only one module manages it.
resource "digitalocean_tag" "app" {
  count = var.app_tag == null ? 0 : 1
  name  = var.app_tag
}

# DigitalOcean refuses the same public key twice, so another Droplet of the app passes the app
# server's key (ssh_key_id) and none is created here.
resource "digitalocean_ssh_key" "deploy" {
  count      = var.ssh_key_id == null ? 1 : 0
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
  ssh_keys   = [local.ssh_key_id]
  tags       = concat(digitalocean_tag.app[*].name, var.shared_tags)

  # The scheduled check's key goes in as a second authorized key (YAML-quoted); none without it.
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    ssh_public_key  = var.ssh_public_key
    check_key_entry = var.check_key_line == "" ? "" : "\n      - ${jsonencode(var.check_key_line)}"
    web             = var.web
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

  # SSH from the allowed networks; no rule once public SSH is closed (an empty list), when SSH
  # answers on the app's private network only.
  dynamic "inbound_rule" {
    for_each = length(var.ssh_allowed_cidrs) == 0 ? [] : [var.ssh_allowed_cidrs]
    content {
      protocol         = "tcp"
      port_range       = "22"
      source_addresses = inbound_rule.value
    }
  }

  # Ports 80 and 443, only on a Droplet that serves the web.
  dynamic "inbound_rule" {
    for_each = var.web ? local.web_rules : []
    content {
      protocol         = inbound_rule.value.protocol
      port_range       = inbound_rule.value.port
      source_addresses = var.http_allowed_cidrs
    }
  }

  inbound_rule {
    protocol         = "icmp"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # WireGuard answers nothing without a valid key, and devices roam, so it is open to all.
  dynamic "inbound_rule" {
    for_each = var.wireguard_port[*]
    content {
      protocol         = "udp"
      port_range       = tostring(inbound_rule.value)
      source_addresses = ["0.0.0.0/0", "::/0"]
    }
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

# A tag and a deploy key created as single resources keep their places in the state.
moved {
  from = digitalocean_tag.app
  to   = digitalocean_tag.app[0]
}

moved {
  from = digitalocean_ssh_key.deploy
  to   = digitalocean_ssh_key.deploy[0]
}
