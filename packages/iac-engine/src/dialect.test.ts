import { describe, expect, it } from "vitest";
import { checkDialect, sanitizeHcl } from "./dialect";

const summary = (files: { path: string; content: string }[]) =>
  checkDialect(files).map((i) => `${i.file}:${i.line} ${i.construct} ${i.onlyIn}`);

describe("checkDialect", () => {
  it("accepts common-subset HCL", () => {
    const content = `terraform {
  required_version = ">= 1.6"
  required_providers {
    hcloud = { source = "hetznercloud/hcloud", version = "~> 1.70" }
  }
  backend "local" {}
}

provider "hcloud" {
  token = var.hcloud_token
}

module "server" {
  source   = "./modules/hetzner-vps"
  name     = var.name
  for_each = toset(var.names)
}

resource "terraform_data" "x" {
  input = "\${var.a}-{literal}"
  # encryption { } in a comment is fine
}
`;
    expect(checkDialect([{ path: "main.tf", content }])).toEqual([]);
  });

  it("flags OpenTofu-only constructs with file and line", () => {
    const content = `terraform {
  encryption {
    method "aes_gcm" "x" {}
  }
  backend "s3" {
    bucket = var.bucket
    key    = "state/\${local.env}.tfstate"
    region = "eu-central-1"
  }
}

provider "aws" {
  alias    = "by_region"
  for_each = var.regions
  region   = each.value
}

module "app" {
  source  = "git::https://example.com/\${var.repo}.git"
  version = "1.0.0"
}
`;
    expect(summary([{ path: "infra/main.tf", content }])).toEqual([
      "infra/main.tf:2 encryption-block tofu",
      "infra/main.tf:6 backend-variables tofu",
      "infra/main.tf:7 backend-variables tofu",
      "infra/main.tf:14 provider-for-each tofu",
      "infra/main.tf:19 module-source-variables tofu",
    ]);
  });

  it("flags Terraform-only constructs and engine-specific files", () => {
    const content = `terraform {
  cloud {
    organization = "acme"
  }
}
`;
    expect(
      summary([
        { path: "versions.tf", content },
        { path: "override.tofu", content: "" },
        { path: "main.tofu.json", content: "{}" },
        { path: "app.tfstack.hcl", content: "" },
        { path: "prod.tfdeploy.hcl", content: "" },
      ]),
    ).toEqual([
      "versions.tf:2 cloud-block terraform",
      "override.tofu:1 tofu-file tofu",
      "main.tofu.json:1 tofu-file tofu",
      "app.tfstack.hcl:1 terraform-stack-file terraform",
      "prod.tfdeploy.hcl:1 terraform-stack-file terraform",
    ]);
  });

  it("ignores lookalikes in strings, heredocs, comments and nested blocks", () => {
    const content = `locals {
  doc = <<-EOT
    terraform {
      encryption {}
    }
  EOT
  s = "terraform { cloud {} }"
}
/* terraform {
  cloud {}
} */
resource "x" "y" {
  encryption {
    enabled = true
  }
  backend "z" { a = var.b }
}
provider "p" {
  dynamic "x" {
    for_each = var.items
  }
}
`;
    expect(checkDialect([{ path: "main.tf", content }])).toEqual([]);
  });

  it("flags a single-line backend with variables", () => {
    const content = 'terraform {\n  backend "local" { path = var.state_path }\n}\n';
    expect(summary([{ path: "a.tf", content }])).toEqual(["a.tf:2 backend-variables tofu"]);
  });
});

describe("sanitizeHcl", () => {
  it("keeps line structure and interpolations, blanks literals and comments", () => {
    const out = sanitizeHcl(`a = "x\${var.y}z" # c\nb = 1`);
    expect(out.split("\n")).toHaveLength(2);
    expect(out).toContain("var.y");
    expect(out).not.toContain("x");
    expect(out).not.toContain("#");
  });
});
