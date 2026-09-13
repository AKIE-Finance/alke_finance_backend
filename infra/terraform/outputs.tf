output "alb_dns_name" {
  description = "Point the API hostname (CNAME) here."
  value       = module.alb.dns_name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.api.repository_url
}

output "ecs_cluster_name" {
  value = module.ecs_cluster.name
}

output "ecs_service_name" {
  value = module.api_service.name
}

output "rds_endpoint" {
  value = module.rds.db_instance_address
}

output "documents_bucket" {
  value = var.documents_backend == "s3" ? aws_s3_bucket.documents[0].bucket : var.documents_external_bucket
}

output "github_deploy_role_arn" {
  description = "Set as repository variable AWS_DEPLOY_ROLE_ARN for the CI deploy job."
  value       = var.github_repository == "" ? null : aws_iam_role.github_deploy[0].arn
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}
