#!/usr/bin/env bash
# Usage: ./scripts/deploy-aws-frontend.sh <s3-bucket-name> [cloudfront-dist-id]
# Builds the React SPA and syncs to Amazon S3.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

BUCKET_NAME="${1:-${AWS_S3_BUCKET:-}}"
DIST_ID="${2:-${AWS_CLOUDFRONT_DIST_ID:-}}"

if [ -z "$BUCKET_NAME" ]; then
  echo "Usage: ./scripts/deploy-aws-frontend.sh <s3-bucket-name> [cloudfront-dist-id]"
  exit 1
fi

echo "========================================="
echo " Deploying Frontend to Amazon S3 ($BUCKET_NAME)"
echo "========================================="

# 1. Build Frontend
echo "--> Building production bundle..."
npm run build

# 2. Sync to S3
echo "--> Uploading to s3://$BUCKET_NAME..."
aws s3 sync frontend/dist "s3://${BUCKET_NAME}" --delete

# 3. Invalidate CloudFront (if provided)
if [ -n "$DIST_ID" ]; then
  echo "--> Invalidating CloudFront cache ($DIST_ID)..."
  aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*"
fi

echo "========================================="
echo " AWS Frontend Deployment Complete!"
echo "========================================="
