environment        = "pilot"
aws_region         = "af-south-1"
vpc_cidr           = "10.41.0.0/16"
db_instance_class  = "db.t4g.medium"
backup_retention_days = 35
redis_node_type    = "cache.t4g.small"
api_cpu            = 1024
api_memory         = 2048
api_desired_count  = 2
api_image_tag      = "pilot"

# Real money: the API refuses simulated payments/KYC on this environment.
payments_mode = "live"
sdb_connector = "file"
kyc_mode      = "smileid"

cors_origins        = ["https://admin.alke.finance"]
acm_certificate_arn = "arn:aws:acm:af-south-1:000000000000:certificate/REPLACE"
alert_emails        = ["ops@alke.finance", "dev@alke.finance"]
github_repository   = "" # pilot deploys are manual (tag promotion), not on push

# Real identity documents. Decision D16 / counsel question Q4 (Law 2024/017 art. 19):
# keep "external" with a Cameroon-resident S3-compatible endpoint unless a transfer
# authorisation has been obtained, in which case switch to "s3".
documents_backend           = "external"
documents_external_endpoint = "https://s3.REPLACE-cameroon-provider.example"
documents_external_bucket   = "alke-pilot-documents"
documents_external_region   = "cm-douala-1"
