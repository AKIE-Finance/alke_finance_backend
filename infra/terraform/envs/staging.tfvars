environment        = "staging"
aws_region         = "af-south-1"
vpc_cidr           = "10.40.0.0/16"
db_instance_class  = "db.t4g.small"
backup_retention_days = 7
redis_node_type    = "cache.t4g.micro"
api_cpu            = 512
api_memory         = 1024
api_desired_count  = 1
api_image_tag      = "staging"

payments_mode = "sandbox"
sdb_connector = "simulated"
kyc_mode      = "simulated"

cors_origins        = ["https://admin.staging.alke.finance"]
acm_certificate_arn = "arn:aws:acm:af-south-1:000000000000:certificate/REPLACE"
alert_emails        = ["dev@alke.finance"]
github_repository   = "AKIE-Finance/alke_finance_backend"

# Synthetic users only on staging: documents may stay in-region.
documents_backend = "s3"
