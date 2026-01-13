#!/bin/bash
set -euo pipefail

# Run database migrations on AWS ECS
#
# Usage:
#   ./scripts/run-migrations-aws.sh
#
# Environment variables:
#   AWS_REGION - AWS region (default: us-west-2)
#   ECS_CLUSTER - ECS cluster name (default: lion-reader-prod)

AWS_REGION="${AWS_REGION:-us-west-2}"
ECS_CLUSTER="${ECS_CLUSTER:-lion-reader-prod}"
TASK_FAMILY="${ECS_CLUSTER}-migrations"

echo "=== Running Database Migrations ==="
echo "Cluster: ${ECS_CLUSTER}"
echo "Region: ${AWS_REGION}"
echo ""

# Get the VPC configuration from the API service
echo "Getting network configuration..."
NETWORK_CONFIG=$(aws ecs describe-services \
  --cluster "$ECS_CLUSTER" \
  --services "${ECS_CLUSTER}-api" \
  --region "$AWS_REGION" \
  --query 'services[0].networkConfiguration' \
  --output json)

SUBNETS=$(echo "$NETWORK_CONFIG" | jq -r '.awsvpcConfiguration.subnets | join(",")')
SECURITY_GROUPS=$(echo "$NETWORK_CONFIG" | jq -r '.awsvpcConfiguration.securityGroups | join(",")')

echo "Subnets: ${SUBNETS}"
echo "Security Groups: ${SECURITY_GROUPS}"
echo ""

# Run the migration task
echo "Starting migration task..."
TASK_ARN=$(aws ecs run-task \
  --cluster "$ECS_CLUSTER" \
  --task-definition "$TASK_FAMILY" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SECURITY_GROUPS}],assignPublicIp=DISABLED}" \
  --region "$AWS_REGION" \
  --query 'tasks[0].taskArn' \
  --output text)

echo "Migration task started: ${TASK_ARN}"
TASK_ID=$(echo "$TASK_ARN" | rev | cut -d'/' -f1 | rev)

# Wait for the task to complete
echo ""
echo "Waiting for migration to complete..."
aws ecs wait tasks-stopped \
  --cluster "$ECS_CLUSTER" \
  --tasks "$TASK_ARN" \
  --region "$AWS_REGION"

# Check the exit code
EXIT_CODE=$(aws ecs describe-tasks \
  --cluster "$ECS_CLUSTER" \
  --tasks "$TASK_ARN" \
  --region "$AWS_REGION" \
  --query 'tasks[0].containers[0].exitCode' \
  --output text)

echo ""
if [ "$EXIT_CODE" = "0" ]; then
  echo "✓ Migrations completed successfully!"
else
  echo "✗ Migrations failed with exit code: ${EXIT_CODE}"
  echo ""
  echo "View logs:"
  echo "  aws logs tail /ecs/${ECS_CLUSTER}/migrations --follow"
  exit 1
fi

# Show recent logs
echo ""
echo "Recent migration logs:"
aws logs tail "/ecs/${ECS_CLUSTER}/migrations" \
  --region "$AWS_REGION" \
  --since 5m \
  --format short 2>/dev/null || echo "(No recent logs found)"
