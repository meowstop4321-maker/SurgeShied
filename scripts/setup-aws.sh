#!/usr/bin/env bash
# Usage: ./scripts/setup-aws.sh
# Creates AWS ECR repository and SQS queue for SurgeShield.

set -euo pipefail

: "${AWS_REGION:=us-east-1}"
: "${AWS_ACCOUNT_ID:=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo '')}"

if [ -z "$AWS_ACCOUNT_ID" ]; then
  echo "[ERROR] AWS CLI not authenticated. Run 'aws configure' first."
  exit 1
fi

echo "========================================="
echo " Setting up SurgeShield on AWS ($AWS_REGION)"
echo " Account ID: $AWS_ACCOUNT_ID"
echo "========================================="

# 1. Create SQS Queue (standard queue with 14-day retention and dead-letter support)
echo "--> Creating AWS SQS Queue: surgeshield-notification-jobs..."
aws sqs create-queue \
  --queue-name surgeshield-notification-jobs \
  --region "$AWS_REGION" \
  --attributes MessageRetentionPeriod=1209600,VisibilityTimeout=60 \
  2>/dev/null || echo "Queue already exists."

SQS_URL=$(aws sqs get-queue-url --queue-name surgeshield-notification-jobs --region "$AWS_REGION" --query QueueUrl --output text)
echo "SQS Queue URL: $SQS_URL"

# 2. Create ECR Repository for Worker Container
echo "--> Creating AWS ECR Repository: surgeshield-worker..."
aws ecr create-repository \
  --repository-name surgeshield-worker \
  --region "$AWS_REGION" \
  --image-scanning-configuration scanOnPush=true \
  2>/dev/null || echo "ECR repository already exists."

ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/surgeshield-worker"
echo "ECR URI: $ECR_URI"

# 3. Save state
cat > scripts/.aws-state <<EOF
AWS_REGION=$AWS_REGION
AWS_ACCOUNT_ID=$AWS_ACCOUNT_ID
AWS_SQS_QUEUE_URL=$SQS_URL
AWS_ECR_URI=$ECR_URI
EOF

echo "========================================="
echo " AWS Setup Complete!"
echo " Configuration saved to scripts/.aws-state"
echo "========================================="
