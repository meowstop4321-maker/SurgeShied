# ☁️ SurgeShield AWS Architecture & Deployment Guide

SurgeShield is cloud-agnostic and supports running seamlessly on **Amazon Web Services (AWS)**.

---

## 🗺️ AWS Architecture Mapping

| SurgeShield Component | AWS Equivalent Service | Role |
|---|---|---|
| **Worker (Background Engine)** | **AWS App Runner** / **AWS ECS Fargate** | Runs the containerized Node.js worker (Ghost Seat sweeps, Resend emails, Circuit Guardian). |
| **Container Registry** | **Amazon ECR** | Stores and scans the `surgeshield-worker` Docker image. |
| **Async Message Queue** | **Amazon SQS** | High-throughput asynchronous queuing for notification jobs. |
| **Frontend Hosting** | **Amazon S3 + CloudFront** / **AWS Amplify** | Global CDN distribution for the React + Vite SPA. |
| **Transactional Database** | **PostgreSQL (Supabase or AWS RDS Aurora)** | Atomic row locks (`SELECT ... FOR UPDATE`), RLS, and SHA-256 audit ledger. |

---

## 📋 What Is Needed From AWS?

To deploy to AWS, you will need:

### 1. AWS Credentials
* `AWS_ACCESS_KEY_ID`
* `AWS_SECRET_ACCESS_KEY`
* `AWS_REGION` (e.g. `us-east-1` or `us-west-2`)
* Configure via the CLI:
  ```bash
  aws configure
  ```

### 2. AWS Resources (Automated via Scripts)
The included scripts will automatically create these:
* **Amazon SQS Queue:** `surgeshield-notification-jobs`
* **Amazon ECR Repository:** `surgeshield-worker`
* **AWS App Runner Service:** `surgeshield-worker`
* **Amazon S3 Bucket:** For hosting `frontend/dist/` assets

---

## 🚀 Step-by-Step AWS Deployment

```bash
# 1. Authenticate with AWS CLI
aws configure

# 2. Provision SQS Queue & ECR Repo
./scripts/setup-aws.sh

# 3. Build & Deploy Worker to AWS App Runner
./scripts/deploy-aws-worker.sh

# 4. Deploy Frontend to S3 + CloudFront
./scripts/deploy-aws-frontend.sh <your-s3-bucket-name> [optional-cloudfront-dist-id]
```
