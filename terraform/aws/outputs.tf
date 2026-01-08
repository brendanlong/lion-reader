# VPC Outputs
output "vpc_id" {
  description = "ID of the VPC"
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "IDs of public subnets"
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of private subnets"
  value       = aws_subnet.private[*].id
}

# ECR Outputs
output "ecr_repository_url" {
  description = "URL of the ECR repository"
  value       = aws_ecr_repository.app.repository_url
}

output "ecr_repository_name" {
  description = "Name of the ECR repository"
  value       = aws_ecr_repository.app.name
}

# RDS Outputs
output "rds_endpoint" {
  description = "RDS instance endpoint"
  value       = aws_db_instance.main.endpoint
}

output "rds_database_name" {
  description = "RDS database name"
  value       = aws_db_instance.main.db_name
}

# ECS Outputs
output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = aws_ecs_cluster.main.name
}

output "ecs_cluster_arn" {
  description = "ARN of the ECS cluster"
  value       = aws_ecs_cluster.main.arn
}

output "api_service_name" {
  description = "Name of the API ECS service"
  value       = aws_ecs_service.api.name
}

output "worker_service_name" {
  description = "Name of the Worker ECS service"
  value       = aws_ecs_service.worker.name
}

# ALB Outputs
output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer"
  value       = aws_lb.main.dns_name
}

output "alb_arn" {
  description = "ARN of the Application Load Balancer"
  value       = aws_lb.main.arn
}

# Application URL
output "app_url" {
  description = "URL of the application"
  value       = "https://${local.fqdn}"
}

# Redis Service Discovery
output "redis_endpoint" {
  description = "Redis service discovery endpoint"
  value       = "redis.${var.app_name}.local:6379"
}

# CloudWatch Log Groups
output "api_log_group" {
  description = "CloudWatch log group for API"
  value       = aws_cloudwatch_log_group.api.name
}

output "worker_log_group" {
  description = "CloudWatch log group for Worker"
  value       = aws_cloudwatch_log_group.worker.name
}

output "redis_log_group" {
  description = "CloudWatch log group for Redis"
  value       = aws_cloudwatch_log_group.redis.name
}

output "migrations_log_group" {
  description = "CloudWatch log group for migrations"
  value       = aws_cloudwatch_log_group.migrations.name
}

output "migrations_task_definition" {
  description = "ARN of the migrations task definition"
  value       = aws_ecs_task_definition.migrations.arn
}

# S3 Outputs
output "storage_bucket_name" {
  description = "Name of the S3 storage bucket"
  value       = aws_s3_bucket.storage.id
}

output "storage_bucket_url" {
  description = "Public URL for S3 storage bucket"
  value       = "https://${aws_s3_bucket.storage.bucket_regional_domain_name}"
}
