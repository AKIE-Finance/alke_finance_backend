# AlKÉ Finance — platform infrastructure (blueprint v3.2 §4.1, A7, D16).
#
# One stack per environment (staging | pilot | production), selected with
#   terraform init -backend-config=envs/<env>.backend.hcl
#   terraform apply -var-file=envs/<env>.tfvars
#
# Region: af-south-1 (Cape Town) for compute and the operational database.
# Personal data and identity documents: see the "documents" section — either a
# KMS-encrypted private S3 bucket in aws_region, or an external S3-compatible
# endpoint in Cameroon when Q4/D16 requires in-country storage. Nothing here is
# region-hard-coded except the default of var.aws_region.
#
# NOT YET RUN: this configuration was authored without terraform/aws CLIs on the
# authoring machine. Run `terraform init && terraform validate` before first use.

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state: bucket/table/region come from envs/<env>.backend.hcl
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = local.tags
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

locals {
  name       = "alke-${var.environment}"
  real_money = contains(["pilot", "production"], var.environment)
  tags = {
    Project     = "alke-finance"
    Environment = var.environment
    ManagedBy   = "terraform"
    DataClass   = "financial-pii"
  }
  # Feature flags the API validates at boot (src/config/env.validation.ts).
  api_environment = {
    APP_ENV          = var.environment
    PORT             = "3000"
    OTP_DEMO_MODE    = "false"
    PAYMENTS_MODE    = var.payments_mode
    SDB_CONNECTOR    = var.sdb_connector
    KYC_MODE         = var.kyc_mode
    CORS_ORIGINS     = join(",", var.cors_origins)
    JWT_EXPIRES_IN   = "15m"
    REDIS_URL        = "rediss://${module.redis.replication_group_primary_endpoint_address}:6379"
    DOCUMENTS_BUCKET = var.documents_backend == "s3" ? aws_s3_bucket.documents[0].bucket : var.documents_external_bucket
    DOCUMENTS_ENDPOINT = var.documents_backend == "s3" ? "" : var.documents_external_endpoint
    DOCUMENTS_REGION = var.documents_backend == "s3" ? var.aws_region : var.documents_external_region
    FX_RATES_BASE_URL = "https://open.er-api.com/v6/latest"
    SWAGGER_ENABLED  = var.environment == "production" ? "false" : "true"
  }
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = local.name
  cidr = var.vpc_cidr
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)

  public_subnets   = [cidrsubnet(var.vpc_cidr, 4, 0), cidrsubnet(var.vpc_cidr, 4, 1)]
  private_subnets  = [cidrsubnet(var.vpc_cidr, 4, 2), cidrsubnet(var.vpc_cidr, 4, 3)]
  database_subnets = [cidrsubnet(var.vpc_cidr, 4, 4), cidrsubnet(var.vpc_cidr, 4, 5)]

  create_database_subnet_group = true
  enable_nat_gateway           = true
  single_nat_gateway           = !local.real_money
  enable_dns_hostnames         = true

  # Flow logs are part of the audit evidence for the CIF dossier IT note.
  enable_flow_log                      = true
  create_flow_log_cloudwatch_iam_role  = true
  create_flow_log_cloudwatch_log_group = true
  flow_log_max_aggregation_interval    = 60
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public HTTPS into the load balancer"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Redirected to 443"
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "api" {
  name        = "${local.name}-api"
  description = "API tasks: only the ALB may reach port 3000"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "PostgreSQL: only API tasks"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id]
  }
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "Redis: only API tasks"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id]
  }
}

# ---------------------------------------------------------------------------
# Data stores
# ---------------------------------------------------------------------------
resource "random_password" "db" {
  length  = 40
  special = false
}

module "rds" {
  source  = "terraform-aws-modules/rds/aws"
  version = "~> 6.0"

  identifier = local.name

  engine               = "postgres"
  engine_version       = "16"
  family               = "postgres16"
  major_engine_version = "16"
  instance_class       = var.db_instance_class

  allocated_storage     = 20
  max_allocated_storage = 200
  storage_encrypted     = true

  db_name  = "alke"
  username = "alke"
  password = random_password.db.result
  port     = 5432

  manage_master_user_password = false

  multi_az               = var.environment == "production"
  db_subnet_group_name   = module.vpc.database_subnet_group
  vpc_security_group_ids = [aws_security_group.db.id]

  # Backups are the DR plan at pilot scale (blueprint §4.20): daily automated
  # snapshots with PITR, retention per environment, plus a quarterly restore drill.
  backup_retention_period  = var.backup_retention_days
  backup_window            = "01:00-02:00" # 02:00-03:00 Douala
  maintenance_window       = "Sun:03:00-Sun:04:00"
  copy_tags_to_snapshot    = true
  deletion_protection      = local.real_money
  skip_final_snapshot      = !local.real_money
  final_snapshot_identifier_prefix = "${local.name}-final"

  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  monitoring_interval                   = 60
  create_monitoring_role                = true
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]

  parameters = [
    { name = "log_min_duration_statement", value = "500" },
    { name = "rds.force_ssl", value = "1" },
  ]
}

module "redis" {
  source  = "terraform-aws-modules/elasticache/aws"
  version = "~> 1.0"

  replication_group_id = local.name
  description          = "AlKÉ ${var.environment}: rate limiting, OTP counters, job locks (no balances, blueprint §4.4)"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.redis_node_type

  num_cache_clusters         = local.real_money ? 2 : 1
  automatic_failover_enabled = local.real_money
  multi_az_enabled           = local.real_money

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  create_security_group = false
  security_group_ids    = [aws_security_group.redis.id]

  snapshot_retention_limit = local.real_money ? 3 : 0
}

# ---------------------------------------------------------------------------
# Identity documents storage (blueprint §4.10, D16)
# ---------------------------------------------------------------------------
resource "aws_kms_key" "documents" {
  count                   = var.documents_backend == "s3" ? 1 : 0
  description             = "${local.name} identity documents"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_s3_bucket" "documents" {
  count  = var.documents_backend == "s3" ? 1 : 0
  bucket = "${local.name}-documents-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "documents" {
  count                   = var.documents_backend == "s3" ? 1 : 0
  bucket                  = aws_s3_bucket.documents[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "documents" {
  count  = var.documents_backend == "s3" ? 1 : 0
  bucket = aws_s3_bucket.documents[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  count  = var.documents_backend == "s3" ? 1 : 0
  bucket = aws_s3_bucket.documents[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.documents[0].arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  count  = var.documents_backend == "s3" ? 1 : 0
  bucket = aws_s3_bucket.documents[0].id
  rule {
    id     = "retention"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Deny any unencrypted-transport access; the API reads with short-lived signed URLs only.
resource "aws_s3_bucket_policy" "documents" {
  count  = var.documents_backend == "s3" ? 1 : 0
  bucket = aws_s3_bucket.documents[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.documents[0].arn, "${aws_s3_bucket.documents[0].arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# ---------------------------------------------------------------------------
# Secrets (values for JWT and provider keys are set out-of-band, never in tfvars)
# ---------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${local.name}/DATABASE_URL"
  recovery_window_in_days = local.real_money ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://alke:${random_password.db.result}@${module.rds.db_instance_address}:5432/alke?schema=public&sslmode=require"
}

resource "aws_secretsmanager_secret" "jwt_secret" {
  name                    = "${local.name}/JWT_SECRET"
  recovery_window_in_days = local.real_money ? 30 : 0
}

resource "random_password" "jwt" {
  length  = 64
  special = false
}

# Initial value only; rotate with `aws secretsmanager put-secret-value` per the runbook.
resource "aws_secretsmanager_secret_version" "jwt_secret" {
  secret_id     = aws_secretsmanager_secret.jwt_secret.id
  secret_string = random_password.jwt.result
  lifecycle {
    ignore_changes = [secret_string]
  }
}

# Provider credentials: created empty, filled by the sponsor from the provider portals.
resource "aws_secretsmanager_secret" "providers" {
  for_each                = toset(var.provider_secret_names)
  name                    = "${local.name}/${each.key}"
  recovery_window_in_days = local.real_money ? 30 : 0
}

# ---------------------------------------------------------------------------
# Container platform
# ---------------------------------------------------------------------------
resource "aws_ecr_repository" "api" {
  name                 = "${local.name}-api"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

module "alb" {
  source  = "terraform-aws-modules/alb/aws"
  version = "~> 9.0"

  name    = local.name
  vpc_id  = module.vpc.vpc_id
  subnets = module.vpc.public_subnets

  create_security_group = false
  security_groups       = [aws_security_group.alb.id]

  enable_deletion_protection = local.real_money
  drop_invalid_header_fields = true

  access_logs = {
    bucket  = aws_s3_bucket.alb_logs.bucket
    enabled = true
  }

  listeners = {
    http-redirect = {
      port     = 80
      protocol = "HTTP"
      redirect = { port = "443", protocol = "HTTPS", status_code = "HTTP_301" }
    }
    https = {
      port            = 443
      protocol        = "HTTPS"
      ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-2021-06"
      certificate_arn = var.acm_certificate_arn
      forward         = { target_group_key = "api" }
    }
  }

  target_groups = {
    api = {
      name_prefix       = "api-"
      protocol          = "HTTP"
      port              = 3000
      target_type       = "ip"
      create_attachment = false # ECS registers tasks
      deregistration_delay = 30
      health_check = {
        enabled             = true
        path                = "/health/ready"
        matcher             = "200"
        interval            = 30
        timeout             = 5
        healthy_threshold   = 2
        unhealthy_threshold = 3
      }
    }
  }
}

resource "aws_s3_bucket" "alb_logs" {
  bucket        = "${local.name}-alb-logs-${data.aws_caller_identity.current.account_id}"
  force_destroy = !local.real_money
}

data "aws_elb_service_account" "this" {}

resource "aws_s3_bucket_policy" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = data.aws_elb_service_account.this.arn }
      Action    = "s3:PutObject"
      Resource  = "${aws_s3_bucket.alb_logs.arn}/*"
    }]
  })
}

module "ecs_cluster" {
  source  = "terraform-aws-modules/ecs/aws//modules/cluster"
  version = "~> 5.0"

  cluster_name = local.name

  fargate_capacity_providers = {
    FARGATE      = { default_capacity_provider_strategy = { weight = 100 } }
    FARGATE_SPOT = {}
  }

  cluster_settings = [{ name = "containerInsights", value = "enabled" }]
}

module "api_service" {
  source  = "terraform-aws-modules/ecs/aws//modules/service"
  version = "~> 5.0"

  name        = "${local.name}-api"
  cluster_arn = module.ecs_cluster.arn

  cpu    = var.api_cpu
  memory = var.api_memory

  desired_count            = var.api_desired_count
  enable_autoscaling       = local.real_money
  autoscaling_min_capacity = var.api_desired_count
  autoscaling_max_capacity = var.api_desired_count * 3

  enable_execute_command = !local.real_money # `aws ecs execute-command` shell on staging only

  container_definitions = {
    api = {
      cpu       = var.api_cpu
      memory    = var.api_memory
      essential = true
      image     = "${aws_ecr_repository.api.repository_url}:${var.api_image_tag}"

      port_mappings = [{ name = "http", containerPort = 3000, protocol = "tcp" }]

      environment = [for k, v in local.api_environment : { name = k, value = v }]

      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
        { name = "JWT_SECRET", valueFrom = aws_secretsmanager_secret.jwt_secret.arn },
      ]

      readonly_root_filesystem = false # Prisma engines write to /tmp
      enable_cloudwatch_logging              = true
      cloudwatch_log_group_retention_in_days = local.real_money ? 365 : 30

      health_check = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    }
  }

  load_balancer = {
    api = {
      target_group_arn = module.alb.target_groups["api"].arn
      container_name   = "api"
      container_port   = 3000
    }
  }

  subnet_ids            = module.vpc.private_subnets
  create_security_group = false
  security_group_ids    = [aws_security_group.api.id]

  # Task role: the API itself only needs the documents bucket.
  tasks_iam_role_statements = var.documents_backend == "s3" ? [
    {
      actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
      resources = ["${aws_s3_bucket.documents[0].arn}/*"]
    },
    {
      actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
      resources = [aws_kms_key.documents[0].arn]
    },
  ] : []
}

# ---------------------------------------------------------------------------
# Alerting (blueprint §4.21): technical alarms here; business metrics
# (mirror mismatch, ACK latency, payout age) are emitted by the API to the
# same SNS topic via CloudWatch custom metrics.
# ---------------------------------------------------------------------------
resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  for_each  = toset(var.alert_emails)
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.name}-alb-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = module.alb.arn_suffix }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy" {
  alarm_name          = "${local.name}-api-unhealthy-targets"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  dimensions = {
    LoadBalancer = module.alb.arn_suffix
    TargetGroup  = module.alb.target_groups["api"].arn_suffix
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${local.name}-rds-cpu"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { DBInstanceIdentifier = module.rds.db_instance_identifier }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${local.name}-rds-free-storage"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 2 * 1024 * 1024 * 1024 # 2 GiB
  comparison_operator = "LessThanThreshold"
  dimensions          = { DBInstanceIdentifier = module.rds.db_instance_identifier }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# ---------------------------------------------------------------------------
# GitHub Actions deploy role (OIDC, no long-lived keys). Set vars.AWS_DEPLOY_ROLE_ARN
# in the repository to the output `github_deploy_role_arn`.
# ---------------------------------------------------------------------------
data "aws_iam_openid_connect_provider" "github" {
  count = var.github_repository == "" ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "github_deploy" {
  count = var.github_repository == "" ? 0 : 1
  name  = "${local.name}-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github[0].arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        StringLike   = { "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:ref:refs/heads/main" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_deploy" {
  count = var.github_repository == "" ? 0 : 1
  role  = aws_iam_role.github_deploy[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = aws_ecr_repository.api.arn
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:DescribeServices", "ecs:DescribeTasks", "ecs:UpdateService", "ecs:RunTask", "ecs:DescribeTaskDefinition"]
        Resource = "*"
        Condition = { ArnEquals = { "ecs:cluster" = module.ecs_cluster.arn } }
      },
      { Effect = "Allow", Action = ["iam:PassRole"], Resource = [module.api_service.task_exec_iam_role_arn, module.api_service.tasks_iam_role_arn] },
    ]
  })
}
