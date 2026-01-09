# CloudWatch Log Group for Migrations
resource "aws_cloudwatch_log_group" "migrations" {
  name              = "/ecs/${var.app_name}-${var.environment}/migrations"
  retention_in_days = 30

  tags = {
    Name = "${var.app_name}-${var.environment}-migrations-logs"
  }
}

# ECS Task Definition for running database migrations
# This is run as a one-off task, not a service
resource "aws_ecs_task_definition" "migrations" {
  family                   = "${var.app_name}-${var.environment}-migrations"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "migrations"
      image     = "${aws_ecr_repository.app.repository_url}:${var.app_image_tag}"
      essential = true

      # Run migrations
      command = ["node", "dist/migrate.js"]

      environment = [
        {
          name  = "NODE_ENV"
          value = "production"
        },
        {
          name  = "REDIS_URL"
          value = "redis://redis.${var.app_name}.local:6379"
        }
      ]

      secrets = local.common_secrets

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.migrations.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "migrations"
        }
      }
    }
  ])

  tags = {
    Name = "${var.app_name}-${var.environment}-migrations"
  }
}
