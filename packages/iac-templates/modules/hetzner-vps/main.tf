locals {
  # coalesce's result is known not to be null before apply, so another server's count (below) is
  # known when it gets this id.
  ssh_key_id = coalesce(var.ssh_key_id, one(hcloud_ssh_key.deploy[*].id))
  web_rules = [
    { description = "HTTP", protocol = "tcp", port = "80" },
    { description = "HTTPS", protocol = "tcp", port = "443" },
    { description = "HTTP/3", protocol = "udp", port = "443" },
  ]
}

# Hetzner refuses the same public key twice, so another server of the app passes the app
# server's key (ssh_key_id) and none is created here.
resource "hcloud_ssh_key" "deploy" {
  count      = var.ssh_key_id == null ? 1 : 0
  name       = "${var.name}-deploy"
  public_key = var.ssh_public_key
  labels     = var.labels
}

resource "hcloud_firewall" "this" {
  name   = "${var.name}-firewall"
  labels = var.labels

  # SSH from the allowed networks; no rule once public SSH is closed (an empty list), when SSH
  # answers on the app's private network only.
  dynamic "rule" {
    for_each = length(var.ssh_allowed_cidrs) == 0 ? [] : [var.ssh_allowed_cidrs]
    content {
      description = "SSH"
      direction   = "in"
      protocol    = "tcp"
      port        = "22"
      source_ips  = rule.value
    }
  }

  # Ports 80 and 443, only on a server that serves the web.
  dynamic "rule" {
    for_each = var.web ? local.web_rules : []
    content {
      description = rule.value.description
      direction   = "in"
      protocol    = rule.value.protocol
      port        = rule.value.port
      source_ips  = var.http_allowed_cidrs
    }
  }

  rule {
    description = "Ping"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  # WireGuard answers nothing without a valid key, and devices roam, so it is open to all.
  dynamic "rule" {
    for_each = var.wireguard_port[*]
    content {
      description = "WireGuard"
      direction   = "in"
      protocol    = "udp"
      port        = tostring(rule.value)
      source_ips  = ["0.0.0.0/0", "::/0"]
    }
  }

  lifecycle {
    # The server attaches this firewall (firewall_ids, so it is protected from its first boot);
    # Hetzner mirrors that attachment into apply_to, which is not set here. Ignoring it keeps
    # `opscrew drift` from reporting a change nobody made; a detached firewall still shows up as
    # drift on the server's firewall_ids.
    ignore_changes = [apply_to]
  }
}

resource "hcloud_server" "this" {
  name               = var.name
  server_type        = var.server_type
  location           = var.location
  image              = var.image
  backups            = var.backups
  ssh_keys           = [local.ssh_key_id]
  firewall_ids       = [hcloud_firewall.this.id]
  delete_protection  = var.delete_protection
  rebuild_protection = var.delete_protection
  labels             = var.labels

  # The scheduled check's key goes in as a second authorized key (YAML-quoted); none without it.
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    ssh_public_key  = var.ssh_public_key
    check_key_entry = var.check_key_line == "" ? "" : "\n      - ${jsonencode(var.check_key_line)}"
    web             = var.web
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

# A deploy key created as a single resource keeps its place in the state.
moved {
  from = hcloud_ssh_key.deploy
  to   = hcloud_ssh_key.deploy[0]
}
