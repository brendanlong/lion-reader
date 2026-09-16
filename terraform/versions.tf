terraform {
  # 1.10+ for native S3 state locking (use_lockfile), so no DynamoDB table.
  required_version = ">= 1.10"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.22"
    }
    bunnynet = {
      source  = "BunnyWay/bunnynet"
      version = "~> 0.15"
    }
    mailgun = {
      source  = "wgebis/mailgun"
      version = "~> 0.10"
    }
  }

  # Shares the bucket with brendanlong.com, under a different key.
  backend "s3" {
    bucket       = "brendanlong-terraform-state"
    key          = "lionreader.com/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
