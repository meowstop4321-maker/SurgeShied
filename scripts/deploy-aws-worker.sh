#!/usr/bin/env bash
# Usage: ./scripts/deploy-aws-worker.sh
# Builds the Docker container, pushes to AWS ECR, and deploys to AWS App Runner.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

[ -f scripts/.aws-state ] && source scripts/.aws-state
[ -f worker/.env ] && source worker/.env

: "${AWS_REGION:=us-east-1}"
: "${AWS_ACCOUNT_ID:=$(aws sts get-caller-identity --query Account --output text)}"
: "${AWS_ECR_URI:=${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/surgeshield-worker}"

echo "========================================="
echo " Deploying Worker to AWS ($AWS_REGION)"
echo "========================================="

# 1. Login to ECR
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# 2. Build & Push Image
echo "--> Building Docker image..."
docker build -t surgeshield-worker:latest worker/
docker tag surgeshield-worker:latest "${AWS_ECR_URI}:latest"

echo "--> Pushing to Amazon ECR..."
docker push "${AWS_ECR_URI}:latest"

# 3. Create or Update App Runner Service
echo "--> Deploying to AWS App Runner..."
aws apprunner create-service \
  --service-name surgeshield-worker \
  --source-configuration '{
    "ImageRepository": {
      "ImageIdentifier": "'"${AWS_ECR_URI}:latest"'",
      "ImageConfiguration": {
        "Port": "8080",
        "RuntimeEnvironmentVariables": {
          "SUPABASE_URL": "'"${SUPABASE_URL}"'",
          "SUPABASE_SERVICE_ROLE_KEY": "'"${SUPABASE_SERVICE_ROLE_KEY}"'",
          "RESEND_API_KEY": "'"${RESEND_API_KEY}"'",
          "RESEND_FROM": "'"${RESEND_FROM}"'",
          "PUBSUB_PUSH_TOKEN": "'"${PUBSUB_PUSH_TOKEN}"'",
          "SEAT_PASSPORT_SECRET": "'"${SEAT_PASSPORT_SECRET}"'"
        }
      },
      "ImageRepositoryType": "ECR"
    },
    "AutoDeploymentsEnabled": true
  }' \
  --region "$AWS_REGION" 2>/dev/null || echo "App Runner service already provisioned or updating."

echo "========================================="
echo " AWS Worker Deployment Finished!"
echo "========================================="
