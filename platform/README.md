# Betting platform, Release 1

Services built to the SRS in [`docs/srs/betting-platform-srs.md`](../docs/srs/betting-platform-srs.md).
Requirement IDs (for example `FR-WAL-003`) appear in code comments and test names so each test traces to the SRS.

## Layout

| Path | What it is |
| --- | --- |
| `packages/common` | Money (integer minor units), exact odds, bet-type maths, Postgres helpers, error format, and the service contracts in `src/ports.ts` |
| `services/<name>` | One service per bounded context. Each owns one Postgres schema and its own `migrations/*.sql` |

## Conventions

- Money is `bigint` minor units; odds are `bigint` scaled by 10,000. No floating point for either.
- Services talk to each other only through the interfaces in `packages/common/src/ports.ts`. Tests use fakes of the other services.
- Every money movement goes through the wallet ledger (`Ledger.post`) with an idempotency key.
- Errors are `AppError` and are returned as RFC 9457 problem details.
- Each service exposes its domain as a library (`src/index.ts`) and HTTP routes with Fastify (`src/http.ts`).

## Run locally

```sh
docker compose up -d          # PostgreSQL 16 on localhost:5432
npm install
npm run build -w @bp/common
npm test                      # uses DATABASE_URL, default postgres://postgres@localhost:5432/postgres
```

## Player API gateway

`services/gateway` runs all six services in one Node process against one database (a schema each, migrated on
start) and serves only the player-facing routes the web site needs; staff, trading, settlement and internal
routes return 404. `GET /healthz` is the health check and `GET /v1/config` tells the site whether demo mode is on.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | (required) | PostgreSQL connection string |
| `PORT` | `8080` | HTTP port |
| `DEMO_MODE` | `false` | `true` auto-activates new players, enables `POST /v1/demo/deposit` (play money) and keeps a week of pre-match CEMAC fixtures loaded, refreshed every 6 hours. Refused when `NODE_ENV=production` (the Docker image sets it); run a demo with `NODE_ENV=staging` |
| `ALLOWED_ORIGINS` | none | Comma-separated origins allowed by CORS; unset sends no CORS headers |
| `TRUST_PROXY` | `false` | `true`, or comma-separated proxy addresses or CIDRs, so client IPs come from `X-Forwarded-For` |
| `MFA_KEY` | random | 32 bytes, base64, encrypting MFA secrets at rest. Required when `NODE_ENV=production`; elsewhere a random key means MFA enrolments are lost on restart. The ops service must use the same key |

Locally:

```sh
docker compose up -d
npm install && npm run build
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres DEMO_MODE=true \
  ALLOWED_ORIGINS=http://localhost:3000 npm start -w @bp/gateway
curl localhost:8080/v1/config
```

On Cloud Run with Cloud SQL for PostgreSQL 16 (build from `platform/`):

```sh
IMAGE="$REGION-docker.pkg.dev/$PROJECT/bp/gateway"
docker build -f Dockerfile.gateway -t "$IMAGE" . && docker push "$IMAGE"
gcloud run deploy bp-gateway --image "$IMAGE" --region "$REGION" \
  --add-cloudsql-instances "$PROJECT:$REGION:$INSTANCE" \
  --set-env-vars TRUST_PROXY=true,ALLOWED_ORIGINS=https://play.example.cm \
  --set-secrets DATABASE_URL=bp-database-url:latest,MFA_KEY=bp-mfa-key:latest \
  --allow-unauthenticated
```

With `--add-cloudsql-instances`, `DATABASE_URL` connects over the instance's Unix socket, for example
`postgres://bp:PASSWORD@/bp?host=/cloudsql/PROJECT:REGION:INSTANCE`. Keep it in Secret Manager, not in plain
environment variables. Each instance can open up to 20 connections per service schema, so size Cloud SQL
`max_connections` and Cloud Run max instances together.

## Ops service (internal)

`services/gateway/dist/ops-main.js`, from the same image, is the internal service that moves the platform on.
It must never be public. It serves:

- **Staff routes** of identity (`/v1/staff/...`: account state, KYC, MFA reset), catalogue (`/v1/trading/...`,
  including `markets/:id/void`), responsible gambling (`/v1/rg/...`) and settlement (`/v1/settlement/...`:
  results, manual settle and void with approve and reject, manual review resolution).
- **Feed intake**: `POST /v1/feed/events` takes raw BetsAPI payloads (each call is also a heartbeat),
  `POST /v1/feed/heartbeat`, and `POST /v1/feed/results`, which confirms results, settles their bets and
  settles their markets. A poller outside the platform calls these; it is not part of this repo yet.
- **Timed jobs**, each under a Postgres advisory lock so it runs on one instance at a time: stale-feed
  suspension (1 s), pre-match close (10 s), PENDING bet recovery (30 s), settling OPEN bets whose results
  arrived first (60 s), settling markets (60 s) and expiring unapproved manual actions (5 min).

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | (required) | The same database as the gateway |
| `STAFF_TOKENS` | (required) | JSON array of `{ "tokenSha256": "<hex>", "staffId": "...", "roles": ["trader" \| "compliance" \| "finance" \| "feed"] }`. Only token hashes are stored. Keep it in Secret Manager |
| `MFA_KEY` | (required) | The gateway's key, so staff MFA resets work |
| `RESULT_SOURCES` | `2` | `1` lets the primary result feed confirm alone (one feed contract); `2` waits for primary and secondary to agree |

```sh
gcloud run deploy bp-ops --image "$IMAGE" --region "$REGION" \
  --command node --args services/gateway/dist/ops-main.js \
  --add-cloudsql-instances "$PROJECT:$REGION:$INSTANCE" \
  --ingress internal --no-allow-unauthenticated --min-instances 1 --no-cpu-throttling \
  --set-env-vars RESULT_SOURCES=1 \
  --set-secrets DATABASE_URL=bp-database-url:latest,MFA_KEY=bp-mfa-key:latest,STAFF_TOKENS=bp-staff-tokens:latest
```

Staff tokens are a stopgap until staff sign in through SSO; rotate them by replacing the secret.
