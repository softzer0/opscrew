# The Worker's name: renaming the Worker replaces its script, which ignores every other change.
resource "terraform_data" "worker" {
  input = var.worker
}

# The Worker's shell. Terraform creates it once, with a placeholder that answers 503 until
# OpsCrew's first deploy, and never updates it: the deploy workflow uploads the app's code, files
# and secrets with Wrangler, and the Wrangler config holds the Worker's settings. Any update from
# here would upload and activate a version of its own, which no OpsCrew build could be traced to.
resource "cloudflare_workers_script" "this" {
  account_id         = var.account_id
  script_name        = var.worker
  main_module        = "worker.js"
  compatibility_date = "2026-10-01"

  content = <<-EOT
    export default {
      fetch() {
        return new Response("Not deployed yet", { status: 503 });
      },
    };
  EOT

  # Should the script ever be updated from here, the deployed files and the app's secrets and
  # variables stay.
  keep_assets   = true
  keep_bindings = ["secret_text", "plain_text"]

  lifecycle {
    ignore_changes       = all
    replace_triggered_by = [terraform_data.worker]
  }
}

# The workers.dev address and the versions' preview URLs, off unless the plan turns them on, so
# the shell answers on neither before the first deploy. The Wrangler config sets the same values.
resource "cloudflare_workers_script_subdomain" "this" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.this.script_name
  enabled          = var.workers_dev
  previews_enabled = var.preview_urls
}

# One custom domain per hostname. Each creates its own proxied DNS record and certificate.
resource "cloudflare_workers_custom_domain" "domain" {
  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = var.domain
  service    = cloudflare_workers_script.this.script_name
}

# www is a custom domain too, for its record and certificate. The zone's shared redirect rule
# sends its requests to the domain.
resource "cloudflare_workers_custom_domain" "www" {
  count      = var.www ? 1 : 0
  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = "www.${var.domain}"
  service    = cloudflare_workers_script.this.script_name
}
