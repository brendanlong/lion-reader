# CloudWatch Log Group for Redis
resource "aws_cloudwatch_log_group" "redis" {
  name              = "/ecs/${var.app_name}-${var.environment}/redis"
  retention_in_days = 7

  tags = {
    Name = "${var.app_name}-${var.environment}-redis-logs"
  }
}

# ECS Task Definition for Redis
resource "aws_ecs_task_definition" "redis" {
  family                   = "${var.app_name}-${var.environment}-redis"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.redis_cpu
  memory                   = var.redis_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  container_definitions = jsonencode([
    {
      name      = "redis"
      image     = "redis:7-alpine"
      essential = true

      portMappings = [
        {
          containerPort = 6379
          hostPort      = 6379
          protocol      = "tcp"
        }
      ]

      # Redis configuration for memory efficiency
      command = [
        "redis-server",
        "--maxmemory", "400mb",
        "--maxmemory-policy", "allkeys-lru",
        "--appendonly", "no"
      ]

      healthCheck = {
        command     = ["CMD", "redis-cli", "ping"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 10
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.redis.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "redis"
        }
      }
    }
  ])

  tags = {
    Name = "${var.app_name}-${var.environment}-redis"
  }
}

# ECS Service for Redis
resource "aws_ecs_service" "redis" {
  name            = "${var.app_name}-${var.environment}-redis"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.redis.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.redis.id]
    assign_public_ip = false
  }

  # Service discovery for Redis
  service_registries {
    registry_arn = aws_service_discovery_service.redis.arn
  }

  tags = {
    Name = "${var.app_name}-${var.environment}-redis"
  }
}

# Service Discovery Namespace
resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = "${var.app_name}.local"
  vpc         = aws_vpc.main.id
  description = "Private DNS namespace for ${var.app_name}"

  tags = {
    Name = "${var.app_name}-${var.environment}-namespace"
  }
}

# Service Discovery for Redis
resource "aws_service_discovery_service" "redis" {
  name = "redis"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  tags = {
    Name = "${var.app_name}-${var.environment}-redis-discovery"
  }
}
