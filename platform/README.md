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
