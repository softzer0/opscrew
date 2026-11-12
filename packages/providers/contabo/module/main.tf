locals {
  # coalesce's result is known not to be null before apply, so another server's count (below) is
  # known when it gets these ids.
  ssh_key_id = coalesce(var.ssh_key_id, one(contabo_secret.deploy[*].id))
  app_tag_id = coalesce(var.app_tag_id, one(contabo_tag.app[*].id))

  # A Contabo firewall rule lists its IPv4 and IPv6 sources apart, and Contabo reads an empty list
  # as any source. So a family with no network gets a source that no packet from the internet
  # carries: 127.0.0.1/32 or ::1/128.
  ssh_ipv4  = coalescelist([for cidr in var.ssh_allowed_cidrs : cidr if !strcontains(cidr, ":")], ["127.0.0.1/32"])
  ssh_ipv6  = coalescelist([for cidr in var.ssh_allowed_cidrs : cidr if strcontains(cidr, ":")], ["::1/128"])
  http_ipv4 = coalescelist([for cidr in var.http_allowed_cidrs : cidr if !strcontains(cidr, ":")], ["127.0.0.1/32"])
  http_ipv6 = coalescelist([for cidr in var.http_allowed_cidrs : cidr if strcontains(cidr, ":")], ["::1/128"])
  web_rules = [
    { protocol = "tcp", port = "80" },
    { protocol = "tcp", port = "443" },
    { protocol = "udp", port = "443" },
  ]
}

# One deploy key serves all the app's servers, so another server of the app passes the app
# server's key (ssh_key_id) and none is created here.
resource "contabo_secret" "deploy" {
  count = var.ssh_key_id == null ? 1 : 0
  name  = "${var.name}-deploy"
  type  = "ssh"
  value = var.ssh_public_key
}

# The app's tag, by which OpsCrew finds the app's servers; another server of the app passes the
# app server's tag (app_tag_id) and none is created here.
resource "contabo_tag" "app" {
  count = var.app_tag_id == null ? 1 : 0
  name  = var.app_tag
  color = "#0A78C3"
}

resource "contabo_instance" "this" {
  display_name = var.name
  product_id   = var.server_type
  region       = var.location
  image_id     = var.image
  # Monthly terms only: a removal cancels the server at the end of its term.
  period       = 1
  ssh_keys     = [tonumber(local.ssh_key_id)]
  default_user = "root"

  # The scheduled check's key goes in as a second authorized key (YAML-quoted); none without it.
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    ssh_public_key  = var.ssh_public_key
    check_key_entry = var.check_key_line == "" ? "" : "\n      - ${jsonencode(var.check_key_line)}"
    web             = var.web
  })

  lifecycle {
    # Changing these would reinstall the server and lose its data; OpsCrew never does that silently.
    # The provider never reads default_user or period back, so a server taken over with an import
    # block would otherwise show them as changes, and a default_user change reinstalls it.
    ignore_changes = [user_data, image_id, ssh_keys, default_user, period]
  }
}

resource "contabo_tag_assignment" "app" {
  tag_id        = tonumber(local.app_tag_id)
  resource_type = "instance"
  resource_id   = contabo_instance.this.id
}

# The firewall, which OpsCrew's Contabo connector makes after every apply (ADR 0029, D8): the
# provider cannot manage a Contabo firewall (it reports Contabo's own "Block all traffic" rule as
# a change on every plan, and cannot read a firewall that protects a server). The module only
# describes it here, so the plan, its approval and the security checks cover it, and outputs it
# as wanted_firewall. Contabo drops all other inbound traffic; outbound traffic is not filtered.
resource "terraform_data" "firewall" {
  input = {
    name        = "${var.name}-firewall"
    description = "OpsCrew's firewall of ${var.name}."
    server_ids  = [tostring(contabo_instance.this.id)]
    rules = concat(
      # SSH from the allowed networks; no rule once public SSH is closed (an empty list), when SSH
      # answers on the app's private network only.
      [
        for port in length(var.ssh_allowed_cidrs) == 0 ? [] : ["22"] :
        { protocol = "tcp", ports = [port], ipv4 = local.ssh_ipv4, ipv6 = local.ssh_ipv6 }
      ],
      # Ports 80 and 443, only on a server that serves the web.
      [
        for rule in var.web ? local.web_rules : [] :
        { protocol = rule.protocol, ports = [rule.port], ipv4 = local.http_ipv4, ipv6 = local.http_ipv6 }
      ],
      [{ protocol = "icmp", ports = [], ipv4 = ["0.0.0.0/0"], ipv6 = ["::/0"] }],
      # WireGuard answers nothing without a valid key, and devices roam, so it is open to all.
      [
        for port in var.wireguard_port[*] :
        { protocol = "udp", ports = [tostring(port)], ipv4 = ["0.0.0.0/0"], ipv6 = ["::/0"] }
      ],
    )
  }
}
