terraform {
  required_version = ">= 1.6.0"

  required_providers {
    contabo = {
      source  = "contabo/contabo"
      version = "~> 0.1.44"
    }
  }
}
