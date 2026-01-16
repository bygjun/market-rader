#!/usr/bin/env bash
set -euo pipefail

REGION="${REGION:-asia-northeast3}"
REPO="${REPO:-market-rader}"
JOB_SEND="${JOB_SEND:-market-rader}"
JOB_DRYRUN="${JOB_DRYRUN:-market-rader-dryrun}"
SECRET_NAME="${SECRET_NAME:-market-rader-env-b64}"
STATE_BUCKET="${STATE_BUCKET:-}"
HISTORY_OBJECT="${HISTORY_OBJECT:-market-rader/seen.json}"
SCHEDULER_JOB="${SCHEDULER_JOB:-market-rader-daily}"
SCHEDULER_SA_NAME="${SCHEDULER_SA_NAME:-market-rader-scheduler}"
SCHEDULE="${SCHEDULE:-0 9 * * *}"
TIME_ZONE="${TIME_ZONE:-Asia/Seoul}"
BUILD_MODE="${BUILD_MODE:-local}" # local | cloudbuild

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud not found. Install Google Cloud CLI first."
  exit 1
fi

active_acct="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
if [ -z "${active_acct:-}" ]; then
  echo "No active gcloud auth found."
  echo "Run: gcloud auth login"
  exit 1
fi

PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
if [ -z "${PROJECT:-}" ] || [ "${PROJECT}" = "(unset)" ]; then
  echo "No gcloud project set."
  echo "Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

if [ ! -f ".env" ]; then
  echo "Missing .env in repo root. Create it (see .env.example) before deploying."
  exit 1
fi

echo "Project: ${PROJECT}"
echo "Region: ${REGION}"
echo "Job (send): ${JOB_SEND}"
echo "Job (dry-run): ${JOB_DRYRUN}"
echo "Repo: ${REPO}"

gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  cloudresourcemanager.googleapis.com

gcloud artifacts repositories create "${REPO}" \
  --repository-format=docker \
  --location="${REGION}" >/dev/null 2>&1 || true

echo "Upserting Secret Manager secret: ${SECRET_NAME}"
if gcloud secrets describe "${SECRET_NAME}" >/dev/null 2>&1; then
  base64 < .env | gcloud secrets versions add "${SECRET_NAME}" --data-file=-
else
  base64 < .env | gcloud secrets create "${SECRET_NAME}" --data-file=-
fi

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
echo "Granting runtime secret access to: ${RUNTIME_SA}"
gcloud secrets add-iam-policy-binding "${SECRET_NAME}" \
  --member "serviceAccount:${RUNTIME_SA}" \
  --role "roles/secretmanager.secretAccessor" >/dev/null || true

if [ -z "${STATE_BUCKET}" ]; then
  STATE_BUCKET="${PROJECT}-${REPO}-state"
fi
HISTORY_PATH="gs://${STATE_BUCKET}/${HISTORY_OBJECT}"

echo "Upserting state bucket: gs://${STATE_BUCKET}"
if ! gcloud storage buckets describe "gs://${STATE_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${STATE_BUCKET}" \
    --location "${REGION}" \
    --uniform-bucket-level-access
fi

echo "Granting runtime bucket access to: ${RUNTIME_SA}"
gcloud storage buckets add-iam-policy-binding "gs://${STATE_BUCKET}" \
  --member "serviceAccount:${RUNTIME_SA}" \
  --role "roles/storage.objectAdmin" >/dev/null || true

IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/app:latest"
if [ "${BUILD_MODE}" = "cloudbuild" ]; then
  echo "Building image with Cloud Build: ${IMAGE}"
  gcloud builds submit --tag "${IMAGE}"
else
  echo "Building image locally and pushing to Artifact Registry: ${IMAGE}"
  printf 'y\n' | gcloud auth configure-docker "${REGION}-docker.pkg.dev" >/dev/null
  # Cloud Run Jobs requires linux/amd64 in this region; build and push that platform.
  DOCKER_BUILDKIT=1 docker buildx build --platform linux/amd64 -t "${IMAGE}" --push .
fi

echo "Upserting Cloud Run Job (send): ${JOB_SEND}"
if gcloud run jobs describe "${JOB_SEND}" --region "${REGION}" >/dev/null 2>&1; then
  gcloud run jobs update "${JOB_SEND}" \
    --image "${IMAGE}" \
    --region "${REGION}" \
    --set-secrets "ENV_B64=${SECRET_NAME}:latest" \
    --set-env-vars "TZ=${TIME_ZONE},HISTORY_PATH=${HISTORY_PATH}" \
    --max-retries 0 \
    --task-timeout 7200
else
  gcloud run jobs create "${JOB_SEND}" \
    --image "${IMAGE}" \
    --region "${REGION}" \
    --set-secrets "ENV_B64=${SECRET_NAME}:latest" \
    --set-env-vars "TZ=${TIME_ZONE},HISTORY_PATH=${HISTORY_PATH}" \
    --max-retries 0 \
    --task-timeout 7200
fi

echo "Upserting Cloud Run Job (dry-run): ${JOB_DRYRUN}"
if gcloud run jobs describe "${JOB_DRYRUN}" --region "${REGION}" >/dev/null 2>&1; then
  gcloud run jobs update "${JOB_DRYRUN}" \
    --image "${IMAGE}" \
    --region "${REGION}" \
    --set-secrets "ENV_B64=${SECRET_NAME}:latest" \
    --set-env-vars "TZ=${TIME_ZONE},HISTORY_PATH=${HISTORY_PATH}" \
    --args=--dry-run \
    --max-retries 0 \
    --task-timeout 7200
else
  gcloud run jobs create "${JOB_DRYRUN}" \
    --image "${IMAGE}" \
    --region "${REGION}" \
    --set-secrets "ENV_B64=${SECRET_NAME}:latest" \
    --set-env-vars "TZ=${TIME_ZONE},HISTORY_PATH=${HISTORY_PATH}" \
    --args=--dry-run \
    --max-retries 0 \
    --task-timeout 7200
fi

echo "Creating scheduler service account (if missing): ${SCHEDULER_SA_NAME}"
gcloud iam service-accounts create "${SCHEDULER_SA_NAME}" >/dev/null 2>&1 || true
SCHEDULER_SA_EMAIL="${SCHEDULER_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

echo "Granting roles/run.invoker to scheduler SA on job"
gcloud run jobs add-iam-policy-binding "${JOB_SEND}" \
  --region "${REGION}" \
  --member "serviceAccount:${SCHEDULER_SA_EMAIL}" \
  --role "roles/run.invoker" >/dev/null

CLOUD_SCHEDULER_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
echo "Allowing Cloud Scheduler service agent to mint tokens for ${SCHEDULER_SA_EMAIL}"
gcloud iam service-accounts add-iam-policy-binding "${SCHEDULER_SA_EMAIL}" \
  --member "serviceAccount:${CLOUD_SCHEDULER_AGENT}" \
  --role "roles/iam.serviceAccountTokenCreator" >/dev/null

RUN_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB_SEND}:run"
echo "Upserting Cloud Scheduler job: ${SCHEDULER_JOB} (${SCHEDULE} ${TIME_ZONE})"
if gcloud scheduler jobs describe "${SCHEDULER_JOB}" --location "${REGION}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${SCHEDULER_JOB}" \
    --location "${REGION}" \
    --schedule "${SCHEDULE}" \
    --time-zone "${TIME_ZONE}" \
    --http-method POST \
    --uri "${RUN_URI}" \
    --oauth-service-account-email "${SCHEDULER_SA_EMAIL}" \
    --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform"
else
  gcloud scheduler jobs create http "${SCHEDULER_JOB}" \
    --location "${REGION}" \
    --schedule "${SCHEDULE}" \
    --time-zone "${TIME_ZONE}" \
    --http-method POST \
    --uri "${RUN_URI}" \
    --oauth-service-account-email "${SCHEDULER_SA_EMAIL}" \
    --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform"
fi

echo "OK. Next:"
echo "- Dry-run execution: gcloud run jobs execute \"${JOB_DRYRUN}\" --region \"${REGION}\" --wait"
echo "- Real execution (sends email): gcloud run jobs execute \"${JOB_SEND}\" --region \"${REGION}\" --wait"
