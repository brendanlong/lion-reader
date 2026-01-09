# SSM Parameters for application secrets
# Note: The DATABASE_URL is constructed from RDS outputs

# Database URL parameter (constructed from RDS instance)
resource "aws_ssm_parameter" "database_url" {
  name        = "/${var.app_name}/${var.environment}/database-url"
  description = "PostgreSQL connection string"
  type        = "SecureString"
  value       = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.main.endpoint}/${var.db_name}"

  tags = {
    Name = "${var.app_name}-${var.environment}-database-url"
  }
}

# Placeholder for optional secrets - these can be set manually or via CI/CD
# Uncomment and set values as needed

# resource "aws_ssm_parameter" "allowlist_secret" {
#   name        = "/${var.app_name}/${var.environment}/allowlist-secret"
#   description = "Admin API secret for managing invites"
#   type        = "SecureString"
#   value       = "CHANGE_ME"
#
#   lifecycle {
#     ignore_changes = [value]
#   }
# }

# resource "aws_ssm_parameter" "email_webhook_secret" {
#   name        = "/${var.app_name}/${var.environment}/email-webhook-secret"
#   description = "Webhook secret for email processing"
#   type        = "SecureString"
#   value       = "CHANGE_ME"
#
#   lifecycle {
#     ignore_changes = [value]
#   }
# }

# resource "aws_ssm_parameter" "groq_api_key" {
#   name        = "/${var.app_name}/${var.environment}/groq-api-key"
#   description = "Groq API key for narration"
#   type        = "SecureString"
#   value       = "CHANGE_ME"
#
#   lifecycle {
#     ignore_changes = [value]
#   }
# }

# resource "aws_ssm_parameter" "google_client_id" {
#   name        = "/${var.app_name}/${var.environment}/google-client-id"
#   description = "Google OAuth client ID"
#   type        = "SecureString"
#   value       = "CHANGE_ME"
#
#   lifecycle {
#     ignore_changes = [value]
#   }
# }

# resource "aws_ssm_parameter" "google_client_secret" {
#   name        = "/${var.app_name}/${var.environment}/google-client-secret"
#   description = "Google OAuth client secret"
#   type        = "SecureString"
#   value       = "CHANGE_ME"
#
#   lifecycle {
#     ignore_changes = [value]
#   }
# }

# resource "aws_ssm_parameter" "sentry_dsn" {
#   name        = "/${var.app_name}/${var.environment}/sentry-dsn"
#   description = "Sentry DSN for error tracking"
#   type        = "SecureString"
#   value       = "CHANGE_ME"
#
#   lifecycle {
#     ignore_changes = [value]
#   }
# }
