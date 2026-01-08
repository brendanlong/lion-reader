# ECS Cluster
resource "aws_ecs_cluster" "main" {
  name = "${var.app_name}-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name = "${var.app_name}-${var.environment}-cluster"
  }
}

# CloudWatch Log Group for API
resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.app_name}-${var.environment}/api"
  retention_in_days = 14

  tags = {
    Name = "${var.app_name}-${var.environment}-api-logs"
  }
}

# CloudWatch Log Group for Worker
resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${var.app_name}-${var.environment}/worker"
  retention_in_days = 14

  tags = {
    Name = "${var.app_name}-${var.environment}-worker-logs"
  }
}

# Common environment variables for both API and Worker
locals {
  common_env_vars = [
    {
      name  = "NODE_ENV"
      value = "production"
    },
    {
      name  = "NEXT_PUBLIC_APP_URL"
      value = "https://${local.fqdn}"
    },
    {
      name  = "ALLOW_ALL_SIGNUPS"
      value = tostring(var.allow_all_signups)
    },
    {
      name  = "REDIS_URL"
      value = "redis://redis.${var.app_name}.local:6379"
    },
    {
      name  = "FETCHER_CONTACT_EMAIL"
      value = var.fetcher_contact_email
    }
  ]

  # Secrets from SSM Parameter Store
  common_secrets = [
    {
      name      = "DATABASE_URL"
      valueFrom = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/${var.app_name}/${var.environment}/database-url"
    }
  ]
}

# ECS Task Definition for API
resource "aws_ecs_task_definition" "api" {
  family                   = "${var.app_name}-${var.environment}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = "${aws_ecr_repository.app.repository_url}:${var.app_image_tag}"
      essential = true

      portMappings = [
        {
          containerPort = 3000
          hostPort      = 3000
          protocol      = "tcp"
        }
      ]

      # Override command to run only the API (not the worker)
      command = ["node", "node_modules/next/dist/bin/next", "start"]

      environment = concat(local.common_env_vars, [
        {
          name  = "PORT"
          value = "3000"
        },
        {
          name  = "HOSTNAME"
          value = "0.0.0.0"
        },
        {
          name  = "DISABLE_EMBEDDED_WORKER"
          value = "true"
        }
      ])

      secrets = local.common_secrets

      healthCheck = {
        command     = ["CMD-SHELL", "wget -q --spider http://localhost:3000/api/health || exit 1"]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "api"
        }
      }
    }
  ])

  tags = {
    Name = "${var.app_name}-${var.environment}-api"
  }
}

# ECS Task Definition for Worker
resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.app_name}-${var.environment}-worker"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = "${aws_ecr_repository.app.repository_url}:${var.app_image_tag}"
      essential = true

      # Run only the worker
      command = ["node", "dist/worker.js"]

      environment = concat(local.common_env_vars, [
        {
          name  = "WORKER_CONCURRENCY"
          value = tostring(var.worker_concurrency)
        }
      ])

      secrets = local.common_secrets

      # Worker doesn't expose ports, so no health check via HTTP
      # ECS will monitor the process

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "worker"
        }
      }
    }
  ])

  tags = {
    Name = "${var.app_name}-${var.environment}-worker"
  }
}

# ECS Service for API
resource "aws_ecs_service" "api" {
  name            = "${var.app_name}-${var.environment}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  # Rolling deployment: spin up new task, wait for health check, drain old task
  deployment_configuration {
    minimum_healthy_percent = 100
    maximum_percent         = 200
  }

  # Wait for new task to be healthy before stopping old task
  health_check_grace_period_seconds = 60

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }

  # Ensure ALB is ready before creating service
  depends_on = [aws_lb_listener.https]

  # Ignore changes to task definition and desired count (managed by CI/CD)
  lifecycle {
    ignore_changes = [task_definition]
  }

  tags = {
    Name = "${var.app_name}-${var.environment}-api"
  }
}

# ECS Service for Worker
resource "aws_ecs_service" "worker" {
  name            = "${var.app_name}-${var.environment}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  # Simple deployment for worker (no need for rolling)
  deployment_configuration {
    minimum_healthy_percent = 0
    maximum_percent         = 100
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }

  # Ignore changes to task definition (managed by CI/CD)
  lifecycle {
    ignore_changes = [task_definition]
  }

  tags = {
    Name = "${var.app_name}-${var.environment}-worker"
  }
}
