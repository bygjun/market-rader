# market-rader

Gemini grounded search만으로 경쟁사/카테고리 동향을 조사해 주간 리포트를 생성하고 이메일로 발송하는 자동화 워크플로우입니다.

## 준비물

- Node.js 20+
- Gemini API Key (`GEMINI_API_KEY`)
- SMTP 계정 (메일 발송용)

## 설치

```bash
cd market-rader
npm i
cp .env.example .env
```

## 설정

- `config/research.json`에서 카테고리/경쟁사/조사 키워드를 관리합니다.
- 소스 수집 방식:
  - 기본값: `source_provider="gemini_grounded"` (Gemini grounded search로 URL 수집)
  - 옵션: `source_provider="searchapi_google_news"` + `.env`에 `SEARCHAPI_API_KEY` 설정 (Google News 검색 결과로 URL 수집)
- `min_companies_per_category`로 카테고리별 최소 기업 수를 늘릴 수 있습니다(필요 시 watchlist 외 기업도 자동 탐색).
- `prefer_startups`, `min_startups_per_category`, `excluded_companies`로 대기업 편향을 줄이고 스타트업/스케일업 위주로 구성할 수 있습니다.
- 링크 환각 방지를 위해 기본적으로 2단계로 동작합니다: (1) grounded search로 소스 URL 목록 수집 → (2) 그 URL만 사용해 리포트 작성. (소스가 0개면 1단계 재시도/설정 조정이 필요할 수 있습니다)
- 메일에서 회사명은 가능하면 공식 홈페이지로 링크됩니다(출처 링크는 별도로 표기).
- 리포트에는 `overseas_competitor_updates`(해외 경쟁사 동향) 섹션이 포함되며, 최근 업데이트가 없으면 빈 배열로 출력됩니다.
- (선택) `verify_source_urls=true`로 켜면 HTTP 상태체크로 404 링크를 추가로 제거/수정합니다.
- (선택) 같은 주(ISO week) 내 중복 발송 방지를 위해 `history_path`(기본: `out/seen.json`)에 이번 주에 보낸 URL을 저장합니다.
  - `drop_items_without_valid_url=true`일 때는 404/soft-404 뿐 아니라, 특정 사이트가 “없는 경로를 홈으로 보여주는” 케이스(200이지만 실제 콘텐츠가 아닌 경우)도 자동으로 제거합니다.

## 실행

드라이런(메일 발송 없이 파일 생성):

```bash
npm run report -- --dry-run
```

현재 API 키로 사용 가능한 Gemini 모델 확인:

```bash
npm run models
```

기준일 지정(백필/테스트):

```bash
npm run report -- --dry-run --as-of 2026-01-13
```

메일 발송:

```bash
npm run report
```

출력:
- `out/report.json`
- `out/email.html`

API 키 없이 템플릿 확인(샘플 리포트로 렌더링):

```bash
npm run report -- --dry-run --input-report config/sample-report.json
```

## GitHub Actions (매일 실행)

`.github/workflows/daily.yml` 사용.

### 스케줄이 안 돌 때 체크

- 스케줄 트리거는 **기본 브랜치(default branch)** 에 있는 워크플로만 실행됩니다(예: `main`). PR/다른 브랜치에만 있으면 수동 실행은 되더라도 스케줄은 안 뜰 수 있습니다.
- 이 저장소가 **fork** 라면 `schedule` 이벤트는 실행되지 않습니다(상위 저장소에서만 스케줄을 돌릴 수 있습니다).
- 저장소에 **60일 이상 활동이 없으면** GitHub가 스케줄 워크플로를 자동으로 비활성화할 수 있습니다. 이 경우 `Actions` 탭에서 워크플로를 다시 활성화하거나, `cron` 값을 수정해 커밋하면 재활성화됩니다.
- `cron`은 **UTC 기준**이고, GitHub Actions 스케줄은 종종(가끔 1~2시간까지) 지연될 수 있습니다. 그래서 이 프로젝트는 06:00 KST(21:00 UTC)에 트리거한 뒤, 워크플로 내부에서 09:00 KST까지 대기 후 실행합니다. (수동 실행은 기본값으로 대기를 스킵)
- `Actions` 탭에서 해당 워크플로를 열고, 실행 목록에서 이벤트가 `schedule` 인 실행이 생성되는지 확인해 보세요.

필수 Secrets:
- `GEMINI_API_KEY`
- (선택) `GEMINI_MODEL`, `REQUIRE_GROUNDING`
- `source_provider="searchapi_google_news"`를 쓰는 경우: `SEARCHAPI_API_KEY`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`
- `MAIL_FROM`, `MAIL_TO`

또는 단일 Secret `ENV_B64`에 `.env` 파일 전체를 base64로 인코딩해서 넣으면(권장) 위 Secrets 없이도 동작합니다.

이미 `MARKET_RADER_SECRET_YML`로 만들어둔 경우, Actions에서 해당 Secret을 읽어 `.env`로 변환해 실행하도록 설정되어 있습니다(간단한 `KEY: value` YAML 또는 `.env` 텍스트/ base64 모두 지원).

## Cloud Run Jobs (CLI 배포 + 스케줄러)

GitHub Actions 대신 GCP에서 “컨테이너를 매일 1번 실행”하는 방식입니다.

### 1) 사전 준비

- GCP 프로젝트 생성
- `gcloud` 설치/로그인

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com
```

### 2) Secret 등록 (권장: `ENV_B64` 하나로)

로컬 `.env`를 base64로 인코딩해서 Secret Manager에 저장합니다.

```bash
ENV_B64="$(base64 < .env | tr -d '\n')"
printf '%s' "$ENV_B64" | gcloud secrets create market-rader-env-b64 --data-file=- || \
  printf '%s' "$ENV_B64" | gcloud secrets versions add market-rader-env-b64 --data-file=-

# Cloud Run Job 런타임(기본 Compute SA)이 Secret을 읽을 수 있게 권한 부여
PROJECT_NUMBER="$(gcloud projects describe "$(gcloud config get-value project)" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding market-rader-env-b64 \
  --member "serviceAccount:${RUNTIME_SA}" \
  --role "roles/secretmanager.secretAccessor"
```

### 3) Artifact Registry + 이미지 빌드/푸시

```bash
REGION=asia-northeast3
REPO=market-rader
IMAGE="${REGION}-docker.pkg.dev/$(gcloud config get-value project)/${REPO}/app:latest"

gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION" || true
# (권장) Cloud Run 호환을 위해 linux/amd64로 빌드 후 푸시
gcloud auth configure-docker "${REGION}-docker.pkg.dev"
docker buildx build --platform linux/amd64 -t "$IMAGE" --push .
```

### 4) Cloud Run Job 생성/업데이트

```bash
JOB_SEND=market-rader
JOB_DRYRUN=market-rader-dryrun

gcloud run jobs create "$JOB_SEND" \
  --image "$IMAGE" \
  --region "$REGION" \
  --set-secrets ENV_B64=market-rader-env-b64:latest \
  --set-env-vars TZ=Asia/Seoul \
  --max-retries 0 \
  --task-timeout 3600 || \
gcloud run jobs update "$JOB_SEND" \
  --image "$IMAGE" \
  --region "$REGION" \
  --set-secrets ENV_B64=market-rader-env-b64:latest \
  --set-env-vars TZ=Asia/Seoul \
  --max-retries 0 \
  --task-timeout 3600

# (권장) 먼저 dry-run Job을 만들어서 API 호출만 테스트(메일 발송 없음)
gcloud run jobs create "$JOB_DRYRUN" \
  --image "$IMAGE" \
  --region "$REGION" \
  --set-secrets ENV_B64=market-rader-env-b64:latest \
  --set-env-vars TZ=Asia/Seoul \
  --args=--dry-run \
  --max-retries 0 \
  --task-timeout 3600 || \
gcloud run jobs update "$JOB_DRYRUN" \
  --image "$IMAGE" \
  --region "$REGION" \
  --set-secrets ENV_B64=market-rader-env-b64:latest \
  --set-env-vars TZ=Asia/Seoul \
  --args=--dry-run \
  --max-retries 0 \
  --task-timeout 3600
```

수동 실행:

```bash
gcloud run jobs run "$JOB_DRYRUN" --region "$REGION"
gcloud run jobs run "$JOB_SEND" --region "$REGION"
```

### 5) Cloud Scheduler로 매일 실행 (09:00 KST)

Cloud Scheduler가 Cloud Run Job 실행 API를 호출합니다.

```bash
PROJECT="$(gcloud config get-value project)"
SCHEDULER_SA="market-rader-scheduler@${PROJECT}.iam.gserviceaccount.com"

gcloud iam service-accounts create market-rader-scheduler || true
gcloud run jobs add-iam-policy-binding "$JOB_SEND" \
  --region "$REGION" \
  --member "serviceAccount:${SCHEDULER_SA}" \
  --role "roles/run.invoker"

gcloud scheduler jobs create http market-rader-daily \
  --location "$REGION" \
  --schedule "0 9 * * *" \
  --time-zone "Asia/Seoul" \
  --http-method POST \
  --uri "https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB_SEND}:run" \
  --oauth-service-account-email "${SCHEDULER_SA}" || \
gcloud scheduler jobs update http market-rader-daily \
  --location "$REGION" \
  --schedule "0 9 * * *" \
  --time-zone "Asia/Seoul" \
  --http-method POST \
  --uri "https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB_SEND}:run" \
  --oauth-service-account-email "${SCHEDULER_SA}"
```

참고:
- 실행 로그는 `Cloud Run > Jobs > Executions`에서 확인합니다.
- 중복 발송 방지용 `out/seen.json`은 Cloud Run Job 환경에선 기본적으로 영구 저장이 안 됩니다(필요하면 GCS로 저장하도록 확장 가능).

### (옵션) 스크립트로 한 번에 배포

```bash
scripts/gcp/deploy.sh
```
