variable "aws_region" {
  description = "AWS region to deploy to"
  type        = string
  default     = "us-west-2"
}

variable "environment" {
  description = "Environment name (e.g., prod, staging)"
  type        = string
  default     = "prod"
}

variable "app_name" {
  description = "Application name"
  type        = string
  default     = "lion-reader"
}

variable "domain_name" {
  description = "Domain name for the application"
  type        = string
  default     = "lionreader.com"
}

variable "subdomain" {
  description = "Subdomain for the application (empty string for apex domain)"
  type        = string
  default     = ""
}

# VPC Configuration
variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets"
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets"
  type        = list(string)
  default     = ["10.0.10.0/24", "10.0.11.0/24"]
}

# RDS Configuration
variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.micro"
}

variable "db_name" {
  description = "Database name"
  type        = string
  default     = "lionreader"
}

variable "db_username" {
  description = "Database master username"
  type        = string
  default     = "lionreader"
}

variable "db_password" {
  description = "Database master password"
  type        = string
  sensitive   = true
}

# ECS Configuration
variable "api_cpu" {
  description = "CPU units for API task (256 = 0.25 vCPU)"
  type        = number
  default     = 256
}

variable "api_memory" {
  description = "Memory for API task in MB"
  type        = number
  default     = 512
}

variable "worker_cpu" {
  description = "CPU units for worker task (256 = 0.25 vCPU)"
  type        = number
  default     = 256
}

variable "worker_memory" {
  description = "Memory for worker task in MB"
  type        = number
  default     = 512
}

variable "redis_cpu" {
  description = "CPU units for Redis task (256 = 0.25 vCPU)"
  type        = number
  default     = 256
}

variable "redis_memory" {
  description = "Memory for Redis task in MB"
  type        = number
  default     = 512
}

variable "api_desired_count" {
  description = "Desired number of API tasks"
  type        = number
  default     = 1
}

variable "worker_desired_count" {
  description = "Desired number of worker tasks"
  type        = number
  default     = 1
}

# Application Configuration
variable "app_image_tag" {
  description = "Docker image tag to deploy"
  type        = string
  default     = "latest"
}

variable "allow_all_signups" {
  description = "Allow all signups or invite-only"
  type        = bool
  default     = false
}

variable "worker_concurrency" {
  description = "Number of concurrent jobs for worker"
  type        = number
  default     = 1
}

variable "fetcher_contact_email" {
  description = "Contact email for feed fetcher User-Agent"
  type        = string
  default     = ""
}
