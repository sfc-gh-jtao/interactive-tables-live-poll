# Cloudflare Worker — Public Vote Page

Serves a truly public (no Snowflake auth required) vote page and writes votes directly to Snowflake's Interactive Table via Snowpipe Streaming REST API.

## Prerequisites

- Cloudflare account (free tier works)
- Node.js 18+
- The RSA key pair generated during Snowflake setup (`rsa_key.p8`)
- `01_setup.sql` already run (creates `DEMO_SERVICE_USER` with the Cloudflare network policy)

## Deploy

```bash
cd cloudflare-worker
npm install

# Authenticate to Cloudflare (one-time)
npx wrangler login

# Set secrets (paste values when prompted)
npx wrangler secret put SNOWFLAKE_ACCOUNT     # e.g. sfsenorthamerica-demo98
npx wrangler secret put SNOWFLAKE_USER        # DEMO_SERVICE_USER
npx wrangler secret put SNOWFLAKE_DATABASE    # DEMO_PREDICTIONS_DB
npx wrangler secret put SNOWFLAKE_SCHEMA      # PUBLIC
npx wrangler secret put SNOWFLAKE_ROLE        # DEMO_SERVICE_ROLE

# For SNOWFLAKE_PRIVATE_KEY: paste the full contents of rsa_key.p8
# including the -----BEGIN and -----END lines
npx wrangler secret put SNOWFLAKE_PRIVATE_KEY

# Deploy
npx wrangler deploy
```

The deploy output will show your Worker URL, e.g.:
```
https://demo-predictions-worker.<your-subdomain>.workers.dev
```

## After Deploying

1. Copy the Worker URL
2. Update the SPCS service spec — set `PUBLIC_VOTE_URL` to the Worker URL
3. Recreate the SPCS service (DROP + CREATE SERVICE)
4. Open the dashboard: the QR code will now point to the Worker URL

## Worker Endpoints

| Endpoint | Description |
|---|---|
| `GET /` or `GET /vote` | Public vote page HTML |
| `GET /api/question` | Returns active question + options |
| `POST /api/vote` | Accepts a vote, writes via Snowpipe Streaming |

## Development

```bash
# Local dev (uses local secrets from .dev.vars file)
npx wrangler dev
```

Create `.dev.vars` for local testing:
```
SNOWFLAKE_ACCOUNT=sfsenorthamerica-demo98
SNOWFLAKE_USER=DEMO_SERVICE_USER
SNOWFLAKE_PRIVATE_KEY=<paste rsa_key.p8 contents>
SNOWFLAKE_DATABASE=DEMO_PREDICTIONS_DB
SNOWFLAKE_SCHEMA=PUBLIC
SNOWFLAKE_ROLE=DEMO_SERVICE_ROLE
```

## Network Policy

`01_setup.sql` creates `DEMO_CF_WORKER_POLICY` with Cloudflare's published IP ranges and applies it to `DEMO_SERVICE_USER`. This lets the Worker reach Snowflake's Snowpipe ingest endpoint and SQL API.

If Cloudflare's IPs ever change, update `DEMO_CF_WORKER_POLICY` in Snowsight:
```sql
ALTER NETWORK POLICY DEMO_CF_WORKER_POLICY
SET ALLOWED_IP_LIST = (...new IPs...);
```
Check current IPs at: https://www.cloudflare.com/ips-v4
