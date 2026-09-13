variable "environment" {
  description = "staging | pilot | production (blueprint §4.1)"
  type        = string
  validation {
    condition     = contains(["staging", "pilot", "production"], var.environment)
    error_message = "environment must be staging, pilot or production."
  }
}

variable "aws_region" {
  description = "Compute and database region. af-south-1 (Cape Town) per blueprint A7."
  type        = string
  default     = "af-south-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

# --- Sizing -----------------------------------------------------------------
variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "backup_retention_days" {
  description = "RDS automated backup retention (PITR window)."
  type        = number
  default     = 7
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "api_cpu" {
  type    = number
  default = 512
}

variable "api_memory" {
  type    = number
  default = 1024
}

variable "api_desired_count" {
  type    = number
  default = 1
}

variable "api_image_tag" {
  description = "ECR image tag to run. CI pushes both the commit SHA and the environment name."
  type        = string
  default     = "staging"
}

# --- Application flags (validated at boot by the API) -----------------------
variable "payments_mode" {
  description = "sandbox | live. 'simulated' is refused by the API on pilot/production."
  type        = string
  default     = "sandbox"
}

variable "sdb_connector" {
  description = "simulated | file | sftp | api"
  type        = string
  default     = "simulated"
}

variable "kyc_mode" {
  description = "simulated | smileid"
  type        = string
  default     = "simulated"
}

variable "cors_origins" {
  description = "Allowed browser origins (back-office URL)."
  type        = list(string)
}

variable "acm_certificate_arn" {
  description = "ACM certificate for the API hostname, in aws_region."
  type        = string
}

variable "alert_emails" {
  type    = list(string)
  default = []
}

variable "provider_secret_names" {
  description = "Secrets Manager entries created empty for the sponsor to fill."
  type        = list(string)
  default = [
    "MTN_MOMO_SUBSCRIPTION_KEY", "MTN_MOMO_API_USER", "MTN_MOMO_API_KEY",
    "ORANGE_MONEY_CLIENT_ID", "ORANGE_MONEY_CLIENT_SECRET", "ORANGE_MONEY_MERCHANT_KEY",
    "CINETPAY_API_KEY", "CINETPAY_SITE_ID", "CINETPAY_SECRET_KEY",
    "SMILE_IDENTITY_API_KEY", "AFRICAS_TALKING_API_KEY", "SENDGRID_API_KEY", "SENTRY_DSN",
  ]
}

variable "github_repository" {
  description = "owner/repo allowed to assume the deploy role via OIDC. Empty disables the role."
  type        = string
  default     = ""
}

# --- Identity documents location (blueprint D16 / Q4) -----------------------
variable "documents_backend" {
  description = "s3 = KMS-encrypted private bucket in aws_region. external = S3-compatible endpoint in Cameroon (credentials via Secrets Manager)."
  type        = string
  default     = "s3"
  validation {
    condition     = contains(["s3", "external"], var.documents_backend)
    error_message = "documents_backend must be s3 or external."
  }
}

variable "documents_external_endpoint" {
  type    = string
  default = ""
}

variable "documents_external_bucket" {
  type    = string
  default = ""
}

variable "documents_external_region" {
  type    = string
  default = "cm-douala-1"
}
