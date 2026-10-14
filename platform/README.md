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
| `DEMO_MODE` | `false` | `true` auto-activates new players, enables `POST /v1/demo/deposit` (play money) and keeps a week of pre-match CEMAC fixtures loaded, refreshed every 6 hours |
| `ALLOWED_ORIGINS` | none | Comma-separated origins allowed by CORS; unset sends no CORS headers |
| `TRUST_PROXY` | `false` | `true`, or comma-separated proxy addresses or CIDRs, so client IPs come from `X-Forwarded-For` |
| `MFA_KEY` | random | 32 bytes, base64, encrypting MFA secrets at rest; set it, or MFA enrolments are lost on restart |

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
  --set-env-vars DEMO_MODE=true,TRUST_PROXY=true,ALLOWED_ORIGINS=https://play.example.cm \
  --set-secrets DATABASE_URL=bp-database-url:latest,MFA_KEY=bp-mfa-key:latest \
  --allow-unauthenticated
```

With `--add-cloudsql-instances`, `DATABASE_URL` connects over the instance's Unix socket, for example
`postgres://bp:PASSWORD@/bp?host=/cloudsql/PROJECT:REGION:INSTANCE`. Keep it in Secret Manager, not in plain
environment variables. Each instance can open up to 20 connections per service schema, so size Cloud SQL
`max_connections` and Cloud Run max instances together.
