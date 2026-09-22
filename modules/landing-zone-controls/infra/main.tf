# A minimal landing-zone foundation, kept deliberately small.
#
# This is plan-only material. `make verify` formats and validates it and never
# runs `terraform apply`, because applying it would create real folders and real
# organization policies against a real organization, and nothing in this
# repository should be able to do that by accident.
#
# Applying it needs an organization ID, the organization-policy administrator
# role, and a decision that is not a lab's to make. See README.md.

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

variable "organization_id" {
  type        = string
  description = "Numeric organization ID. No default: this must be supplied deliberately."
}

variable "allowed_regions" {
  type        = list(string)
  description = "Regions resources may be created in."
  default     = ["europe-west1", "europe-west4"]
}

# The three folders the model uses. Workloads are split from the place that
# holds the evidence of how they were administered.
resource "google_folder" "production" {
  display_name = "production"
  parent       = "organizations/${var.organization_id}"
}

resource "google_folder" "nonprod" {
  display_name = "nonprod"
  parent       = "organizations/${var.organization_id}"
}

resource "google_folder" "security" {
  display_name = "security"
  parent       = "organizations/${var.organization_id}"
}

# Constraints set at the organization, inherited by every descendant.
resource "google_org_policy_policy" "no_public_bucket" {
  name   = "organizations/${var.organization_id}/policies/storage.publicAccessPrevention"
  parent = "organizations/${var.organization_id}"

  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "no_service_account_keys" {
  name   = "organizations/${var.organization_id}/policies/iam.disableServiceAccountKeyCreation"
  parent = "organizations/${var.organization_id}"

  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "no_external_ip" {
  name   = "organizations/${var.organization_id}/policies/compute.vmExternalIpAccess"
  parent = "organizations/${var.organization_id}"

  spec {
    rules {
      deny_all = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "allowed_regions" {
  name   = "organizations/${var.organization_id}/policies/gcp.resourceLocations"
  parent = "organizations/${var.organization_id}"

  spec {
    rules {
      values {
        allowed_values = [for r in var.allowed_regions : "in:${r}-locations"]
      }
    }
  }
}

output "folders" {
  description = "The folder IDs the rest of the foundation attaches to."
  value = {
    production = google_folder.production.folder_id
    nonprod    = google_folder.nonprod.folder_id
    security   = google_folder.security.folder_id
  }
}
