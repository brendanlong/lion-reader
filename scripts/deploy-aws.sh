#!/bin/bash
set -euo pipefail

# Deploy Lion Reader to AWS ECS
#
# Usage:
#   ./scripts/deploy-aws.sh [IMAGE_TAG]
#
# Environment variables:
#   AWS_REGION - AWS region (default: us-west-2)
#   ECR_REPOSITORY - ECR repository URL (auto-detected from terraform if not set)
#   ECS_CLUSTER - ECS cluster name (default: lion-reader-prod)
#   API_SERVICE - API service name (default: lion-reader-prod-api)
#   WORKER_SERVICE - Worker service name (default: lion-reader-prod-worker)

IMAGE_TAG="${1:-$(git rev-parse --short HEAD)}"
AWS_REGION="${AWS_REGION:-us-west-2}"
ECS_CLUSTER="${ECS_CLUSTER:-lion-reader-prod}"
API_SERVICE="${API_SERVICE:-lion-reader-prod-api}"
WORKER_SERVICE="${WORKER_SERVICE:-lion-reader-prod-worker}"

# Get ECR repository URL from terraform or environment
if [ -z "${ECR_REPOSITORY:-}" ]; then
  if [ -f "terraform/aws/terraform.tfstate" ] || [ -d "terraform/aws/.terraform" ]; then
    ECR_REPOSITORY=$(cd terraform/aws && terraform output -raw ecr_repository_url 2>/dev/null || echo "")
  fi
fi

if [ -z "${ECR_REPOSITORY:-}" ]; then
  echo "Error: ECR_REPOSITORY not set and couldn't be auto-detected from terraform"
  echo "Set ECR_REPOSITORY environment variable or run terraform apply first"
  exit 1
fi

ECR_REGISTRY=$(echo "$ECR_REPOSITORY" | cut -d'/' -f1)
IMAGE_URI="${ECR_REPOSITORY}:${IMAGE_TAG}"

echo "=== Lion Reader AWS Deployment ==="
echo "Image tag: ${IMAGE_TAG}"
echo "ECR repository: ${ECR_REPOSITORY}"
echo "ECS cluster: ${ECS_CLUSTER}"
echo "Region: ${AWS_REGION}"
echo ""

# Step 1: Authenticate with ECR
echo "Step 1: Authenticating with ECR..."
aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "$ECR_REGISTRY"

# Step 2: Build the Docker image
echo ""
echo "Step 2: Building Docker image..."
docker build -t "lion-reader:${IMAGE_TAG}" .

# Step 3: Tag and push to ECR
echo ""
echo "Step 3: Pushing to ECR..."
docker tag "lion-reader:${IMAGE_TAG}" "$IMAGE_URI"
docker push "$IMAGE_URI"

# Also tag as latest
docker tag "lion-reader:${IMAGE_TAG}" "${ECR_REPOSITORY}:latest"
docker push "${ECR_REPOSITORY}:latest"

# Step 4: Get current task definitions
echo ""
echo "Step 4: Updating task definitions..."

# Function to update task definition with new image
update_task_definition() {
  local service_name="$1"
  local task_family="${service_name}"

  # Get current task definition
  local current_task_def=$(aws ecs describe-services \
    --cluster "$ECS_CLUSTER" \
    --services "$service_name" \
    --region "$AWS_REGION" \
    --query 'services[0].taskDefinition' \
    --output text)

  # Get task definition JSON and update image
  local task_def_json=$(aws ecs describe-task-definition \
    --task-definition "$current_task_def" \
    --region "$AWS_REGION" \
    --query 'taskDefinition')

  # Update the image in container definitions
  local new_container_defs=$(echo "$task_def_json" | jq --arg IMAGE "$IMAGE_URI" \
    '.containerDefinitions | map(if .name != "redis" then .image = $IMAGE else . end)')

  # Register new task definition
  local new_task_def=$(aws ecs register-task-definition \
    --family "$task_family" \
    --container-definitions "$new_container_defs" \
    --task-role-arn "$(echo "$task_def_json" | jq -r '.taskRoleArn')" \
    --execution-role-arn "$(echo "$task_def_json" | jq -r '.executionRoleArn')" \
    --network-mode "$(echo "$task_def_json" | jq -r '.networkMode')" \
    --requires-compatibilities "$(echo "$task_def_json" | jq -r '.requiresCompatibilities | join(" ")')" \
    --cpu "$(echo "$task_def_json" | jq -r '.cpu')" \
    --memory "$(echo "$task_def_json" | jq -r '.memory')" \
    --region "$AWS_REGION" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)

  echo "  New task definition: $new_task_def"
  echo "$new_task_def"
}

# Step 5: Update API service
echo ""
echo "Step 5: Deploying API service..."
API_TASK_DEF=$(update_task_definition "$API_SERVICE")

aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$API_SERVICE" \
  --task-definition "$API_TASK_DEF" \
  --region "$AWS_REGION" \
  --no-cli-pager > /dev/null

echo "  API service update initiated"

# Step 6: Update Worker service
echo ""
echo "Step 6: Deploying Worker service..."
WORKER_TASK_DEF=$(update_task_definition "$WORKER_SERVICE")

aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$WORKER_SERVICE" \
  --task-definition "$WORKER_TASK_DEF" \
  --region "$AWS_REGION" \
  --no-cli-pager > /dev/null

echo "  Worker service update initiated"

# Step 7: Wait for deployments to stabilize
echo ""
echo "Step 7: Waiting for deployments to stabilize..."
echo "  (This may take a few minutes)"

aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" \
  --services "$API_SERVICE" "$WORKER_SERVICE" \
  --region "$AWS_REGION"

echo ""
echo "=== Deployment Complete ==="
echo "Image: ${IMAGE_URI}"
echo ""
echo "View logs:"
echo "  aws logs tail /ecs/lion-reader-prod/api --follow"
echo "  aws logs tail /ecs/lion-reader-prod/worker --follow"
