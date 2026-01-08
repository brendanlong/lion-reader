# Lion Reader AWS Terraform Configuration

This Terraform configuration deploys Lion Reader to AWS using:

- **ECS Fargate** for running the API, Worker, and Redis containers
- **RDS PostgreSQL** (db.t4g.micro) for the database
- **Application Load Balancer** for HTTPS termination and health-check-based deployments
- **ECR** for Docker image storage
- **Route 53** for DNS management
- **ACM** for SSL/TLS certificates
- **SSM Parameter Store** for secrets management

## Architecture

```
                    ┌─────────────────┐
                    │   Route 53      │
                    │ lionreader.com  │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │       ALB       │
                    │  (HTTPS:443)    │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
    ┌─────────▼─────────┐   │   ┌──────────▼──────────┐
    │   ECS Fargate     │   │   │   ECS Fargate       │
    │      (API)        │   │   │     (Worker)        │
    │   Port 3000       │   │   │   Background jobs   │
    └─────────┬─────────┘   │   └──────────┬──────────┘
              │             │              │
              │     ┌───────▼───────┐      │
              │     │ ECS Fargate   │      │
              │     │   (Redis)     │      │
              │     │  Port 6379    │      │
              │     └───────────────┘      │
              │                            │
              └──────────┬─────────────────┘
                         │
                ┌────────▼────────┐
                │  RDS PostgreSQL │
                │  (db.t4g.micro) │
                └─────────────────┘
```

## Prerequisites

1. **AWS CLI** configured with appropriate credentials
2. **Terraform** >= 1.5.0
3. **Domain** in Route 53 (lionreader.com)

## Cost Estimate

| Resource | Monthly Cost |
|----------|--------------|
| ECS Fargate (API) | ~$10-15 |
| ECS Fargate (Worker) | ~$10-15 |
| ECS Fargate (Redis) | ~$10-15 |
| RDS PostgreSQL (db.t4g.micro) | ~$13 |
| ALB | ~$16 + data |
| S3 (storage) | ~$1-5 |
| **Total** | **~$60-70/month** |

Note: ECS tasks run in public subnets with public IPs to avoid NAT Gateway costs (~$32/month saved). Security groups still block all inbound traffic except from the ALB.

## Initial Setup

### 1. Create terraform.tfvars

```bash
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` with your values:

```hcl
db_password           = "your-secure-password"  # Generate with: openssl rand -base64 32
fetcher_contact_email = "your-email@example.com"
```

### 2. Initialize Terraform

```bash
terraform init
```

### 3. Review the plan

```bash
terraform plan
```

### 4. Apply the configuration

```bash
terraform apply
```

This will take 10-15 minutes to create all resources.

### 5. Build and push the Docker image

```bash
# Get ECR login
aws ecr get-login-password --region us-west-2 | docker login --username AWS --password-stdin $(terraform output -raw ecr_repository_url | cut -d'/' -f1)

# Build the image (from project root)
cd ../..
docker build -t lion-reader .

# Tag and push
docker tag lion-reader:latest $(cd terraform/aws && terraform output -raw ecr_repository_url):latest
docker push $(cd terraform/aws && terraform output -raw ecr_repository_url):latest
```

### 6. Run database migrations

The first deployment will need migrations. You can run them by:

```bash
# Update the ECS task to run migrations, or
# Connect to the database directly and run migrations
```

### 7. Force a new deployment

```bash
aws ecs update-service \
  --cluster $(terraform output -raw ecs_cluster_name) \
  --service $(terraform output -raw api_service_name) \
  --force-new-deployment

aws ecs update-service \
  --cluster $(terraform output -raw ecs_cluster_name) \
  --service $(terraform output -raw worker_service_name) \
  --force-new-deployment
```

## Deployment Strategy

### API Service

The API uses a **rolling deployment** strategy:

1. ECS spins up a new task with the new image
2. ALB health checks the new task at `/api/health`
3. Once healthy, traffic shifts to the new task
4. Old task is drained and terminated

Configuration:
- `minimum_healthy_percent = 100` - Always keep at least 1 task running
- `maximum_percent = 200` - Allow up to 2 tasks during deployment
- `health_check_grace_period_seconds = 60` - Wait 60s before health checking

### Worker Service

The Worker uses a simple replacement strategy:
- `minimum_healthy_percent = 0` - Can stop the old worker before starting new
- `maximum_percent = 100` - Only 1 worker at a time

This is fine because the worker processes jobs from a database queue and can be stopped/started safely.

## CI/CD Deployment

To deploy a new version:

```bash
# Build and push new image
docker build -t lion-reader .
docker tag lion-reader:latest <ECR_URL>:<TAG>
docker push <ECR_URL>:<TAG>

# Update task definition with new image tag
aws ecs update-service \
  --cluster lion-reader-prod \
  --service lion-reader-prod-api \
  --force-new-deployment

aws ecs update-service \
  --cluster lion-reader-prod \
  --service lion-reader-prod-worker \
  --force-new-deployment
```

See `scripts/deploy-aws.sh` for a complete deployment script.

## Adding Secrets

To add additional secrets via SSM Parameter Store:

```bash
aws ssm put-parameter \
  --name "/lion-reader/prod/my-secret" \
  --type "SecureString" \
  --value "secret-value"
```

Then add the secret to the task definition in `ecs.tf`:

```hcl
secrets = concat(local.common_secrets, [
  {
    name      = "MY_SECRET"
    valueFrom = "arn:aws:ssm:us-west-2:ACCOUNT_ID:parameter/lion-reader/prod/my-secret"
  }
])
```

## Monitoring

### CloudWatch Logs

View logs in CloudWatch:
- API: `/ecs/lion-reader-prod/api`
- Worker: `/ecs/lion-reader-prod/worker`
- Redis: `/ecs/lion-reader-prod/redis`

### Health Check

The API exposes `/api/health` which returns:
- Database connectivity status
- Redis connectivity status
- Overall health status

## Troubleshooting

### Task won't start

Check CloudWatch logs:
```bash
aws logs tail /ecs/lion-reader-prod/api --follow
```

### Database connection issues

Verify security groups allow traffic:
```bash
aws ec2 describe-security-groups --group-ids <sg-id>
```

### Redis connection issues

Redis uses AWS Cloud Map for service discovery. The hostname is:
```
redis.lion-reader.local:6379
```

Verify the service is registered:
```bash
aws servicediscovery list-instances --service-id <service-id>
```

## Destroying Infrastructure

⚠️ **Warning**: This will delete all data including the database!

```bash
# Remove deletion protection first
terraform apply -var="..." -target=aws_db_instance.main

# Then destroy
terraform destroy
```

## Remote State (Recommended for Production)

Uncomment the S3 backend in `main.tf` and create the S3 bucket and DynamoDB table:

```bash
aws s3 mb s3://lion-reader-terraform-state --region us-west-2
aws dynamodb create-table \
  --table-name lion-reader-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```
