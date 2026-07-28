# Interactive Tables Live Poll Demo

A live audience polling demo that streams votes from phones into Snowflake Interactive Tables via Snowpipe Streaming, with sub-second dashboard updates, a warehouse speed comparison, and a real-time audience geo/device map.

## Architecture

```
Phone (QR scan)
  → Cloudflare Worker (public HTTPS, no Snowflake auth)
      → Snowpipe Streaming REST API
          → fact_predictions  (Interactive Table — votes)
          → dim_voters        (Interactive Table — geo + device metadata)

Presenter laptop
  → /dashboard  — live bar chart + pipeline latency + warehouse comparison + audience map
  → /admin      — create questions, set allow-multiple-votes toggle

Dashboard polls SPCS (/api/results, /api/voters) every 1-2s
SPCS queries DEMO_IWT_WH (sub-second Interactive Warehouse)
```

**Four Interactive Tables, all in `DEMO_IWT_WH`:**

| Table | Type | Written by |
|-------|------|-----------|
| `dim_questions` | Static (INSERT OVERWRITE) | SPCS admin API |
| `dim_answer_options` | Static (INSERT OVERWRITE) | SPCS admin API |
| `fact_predictions` | Streaming | Cloudflare Worker |
| `dim_voters` | Streaming | Cloudflare Worker (first vote per session) |

## Pages

| Page | URL | Who uses it |
|------|-----|-------------|
| Dashboard | `https://<spcs-ingress>/dashboard` | Presenter on laptop/projector |
| Admin | `https://<spcs-ingress>/admin` | Presenter — create questions |
| Vote | `https://demo-predictions-worker.<subdomain>.workers.dev` | Audience — scan QR code |

## Prerequisites

- Snowflake account in an [Interactive Tables supported region](https://docs.snowflake.com/en/user-guide/interactive#region-availability)
- SPCS enabled (`SHOW PARAMETERS LIKE 'ENABLE_ACCOUNT_LEVEL_COMPUTE_POOL' IN ACCOUNT`)
- Docker installed (linux/amd64 builds required for SPCS)
- `snow` CLI installed (`pip install snowflake-cli`)
- Cloudflare account (Workers free tier is sufficient)
- `wrangler` CLI (`npm install` in `cloudflare-worker/`)

## Deployment

### 1. Snowflake Setup

Run `sql/01_setup.sql` as `ACCOUNTADMIN` in a Snowsight worksheet.

**Important**: After setup, run the dim_voters block separately since it must come after the Interactive Warehouse is created:

```sql
CREATE INTERACTIVE TABLE IF NOT EXISTS DEMO_PREDICTIONS_DB.PUBLIC.dim_voters (
    session_id VARCHAR(36) NOT NULL, question_id VARCHAR(36) NOT NULL,
    voter_email VARCHAR(255),
    country VARCHAR(2), region VARCHAR(100), city VARCHAR(100),
    latitude FLOAT, longitude FLOAT, timezone VARCHAR(64),
    device_type VARCHAR(20), os VARCHAR(50), browser VARCHAR(50),
    language VARCHAR(20), voted_at TIMESTAMP_NTZ
) CLUSTER BY (question_id, country);

ALTER WAREHOUSE DEMO_IWT_WH ADD TABLES (DEMO_PREDICTIONS_DB.PUBLIC.dim_voters);
GRANT SELECT, INSERT ON TABLE DEMO_PREDICTIONS_DB.PUBLIC.dim_voters TO ROLE DEMO_SERVICE_ROLE;
```

### 2. Cloudflare Worker

```bash
cd cloudflare-worker
npm install
```

Set secrets (run each command and paste value when prompted):
```bash
npx wrangler secret put SNOWFLAKE_ACCOUNT      # e.g. sfsenorthamerica-demo98
npx wrangler secret put SNOWFLAKE_USER          # DEMO_SERVICE_USER
npx wrangler secret put SNOWFLAKE_PRIVATE_KEY   # contents of rsa_key_pkcs8.p8
npx wrangler secret put SNOWFLAKE_DATABASE      # DEMO_PREDICTIONS_DB
npx wrangler secret put SNOWFLAKE_SCHEMA        # PUBLIC
npx wrangler secret put SNOWFLAKE_ROLE          # DEMO_SERVICE_ROLE
```

> **Note**: The RSA private key must be in PKCS#8 format. Convert with:
> `openssl pkcs8 -topk8 -nocrypt -in rsa_key.p8 -out rsa_key_pkcs8.p8`

Deploy:
```bash
npx wrangler deploy
```

Copy the Worker URL (e.g. `https://demo-predictions-worker.jtaosandbox.workers.dev`) and update `PUBLIC_VOTE_URL` in `snowflake.yml`.

### 3. Build and Push the Docker Image

```bash
# Must be on VPN for SE demo accounts
docker build --platform linux/amd64 -t demo-predictions .

# Tag for registry (get exact URL from SHOW IMAGE REPOSITORIES)
docker tag demo-predictions <registry-url>/demo_predictions_db/public/demo_img_repo/predictions-api:latest

# Authenticate (key-pair auth required — not PAT)
snow spcs image-registry login --connection <your-connection>

docker push <registry-url>/demo_predictions_db/public/demo_img_repo/predictions-api:latest
```

> **Registry auth gotcha**: PAT-based snow connections fail for `image-registry login`.
> Use a key-pair (`SNOWFLAKE_JWT`) or username/password connection.
> Always verify the exact repository name with `SHOW IMAGE REPOSITORIES IN SCHEMA DEMO_PREDICTIONS_DB.PUBLIC` before tagging.

### 4. Deploy the SPCS Service

```sql
USE ROLE ACCOUNTADMIN;

CREATE SERVICE DEMO_PREDICTIONS_DB.PUBLIC.DEMO_SERVICE
  IN COMPUTE POOL DEMO_CPU_POOL
  FROM SPECIFICATION $$
spec:
  containers:
    - name: predictions-api
      image: /demo_predictions_db/public/demo_img_repo/predictions-api:latest
      env:
        SNOWFLAKE_ACCOUNT: "<org>-<account>"
        SNOWFLAKE_DATABASE: "DEMO_PREDICTIONS_DB"
        SNOWFLAKE_SCHEMA: "PUBLIC"
        SNOWFLAKE_ROLE: "ACCOUNTADMIN"
        PUBLIC_VOTE_URL: "https://demo-predictions-worker.<subdomain>.workers.dev"
      resources:
        requests: { cpu: "0.5", memory: 512M }
        limits:   { cpu: "1",   memory: 1G   }
  endpoints:
    - name: api
      port: 8080
      public: true
  networkPolicyConfig:
    allowInternetEgress: true
capabilities:
  securityContext:
    enableCustomCredentials: true
$$
  EXTERNAL_ACCESS_INTEGRATIONS = (DEMO_EAI)
  MIN_INSTANCES = 1 MAX_INSTANCES = 1 AUTO_RESUME = TRUE;

GRANT SERVICE ROLE DEMO_PREDICTIONS_DB.PUBLIC.DEMO_SERVICE!ALL_ENDPOINTS_USAGE TO ROLE PUBLIC;

-- Monitor startup
SELECT SYSTEM$GET_SERVICE_STATUS('DEMO_PREDICTIONS_DB.PUBLIC.DEMO_SERVICE');
```

## Demo Flow

1. Open `/dashboard` on your projector screen
2. Open `/admin` in a separate tab — no password needed (gated by Snowflake SSO)
3. Create a question with 2–6 options; optionally enable:
   - **Allow multiple votes** — audience can vote repeatedly
   - **Require email** — captures email before showing vote options
4. The dashboard updates: QR code appears, bar chart ready
5. Audience scans QR code → votes on their phones
6. Watch the bar chart update sub-second as votes arrive
7. Point out **Pipeline Latency**: milliseconds from button press → Snowflake → dashboard
8. Click **Compare Interactive vs Standard** — same query, two warehouses
9. Switch to **Audience** tab — live world map with voter locations + device breakdown
10. Interactive: ~10ms. Standard: ~250ms. That's the story.
11. To reset for a fresh run without changing the question, click **Reset Session** in Admin

## Local Development

Use the mock dev server to iterate on `dashboard.html` without any Docker build:

```bash
python3 dev-server.py
# Open http://localhost:8080/dashboard
# Edit dashboard.html and Cmd+Shift+R to see changes instantly
```

## Features

- **Multiple votes mode**: Admin toggle per question — when enabled, audience can vote repeatedly; vote page shows a brief toast and resets instead of navigating away
- **Require email**: Admin toggle per question — when enabled, audience must enter their email before voting options are shown; stored in `dim_voters.voter_email`
- **Session reset**: Admin "Reset Session" button clears the vote window start time so a new question session starts fresh without redeploying
- **Pipeline latency**: Measures button-press → Worker receipt → Snowflake table visible → dashboard read. Uses `fact_predictions.server_received_at` (Worker server clock) minus `CURRENT_TIMESTAMP` at query time for accuracy. Snapshots on the first new vote detected per poll cycle.
- **Audience tab**: Live Leaflet map with voter lat/lng from Cloudflare geo, US state borders, country outlines (all vendored — no external tile CDN). Resets automatically when a new question is activated. Device breakdown below.
- **Warehouse comparison**: Same 3-table JOIN run on Interactive vs Standard warehouse side-by-side

## Cleanup

```sql
-- Run sql/02_cleanup.sql as ACCOUNTADMIN immediately after the demo
```

> Tear down promptly — the Interactive Warehouse and compute pool continue to accrue credits until suspended or dropped.
>
> **Important**: SPCS compute pool auto-suspend only triggers when no services are running on it — it does NOT auto-suspend based on HTTP inactivity. You must explicitly suspend the service before the pool will idle down:
> ```sql
> ALTER SERVICE DEMO_PREDICTIONS_DB.PUBLIC.DEMO_PREDICTIONS_SERVICE SUSPEND;
> ALTER COMPUTE POOL DEMO_CPU_POOL SUSPEND;
> ALTER WAREHOUSE DEMO_IWT_WH SUSPEND;
> ```

### Interactive Warehouse suspend/resume strategy

Suspending `DEMO_IWT_WH` between events saves 0.6 credits/hr, but there are two billing nuances to understand:

1. **Each resume starts a new 1-hour minimum billing period** — even if you're already mid-period. Frequent suspend/resume cycles cost *more* than leaving it running continuously for a session.
2. **Cache warmup on resume** — an XS interactive warehouse warms at ~300–400 MB/s. For the demo tables (small dataset), warmup completes in seconds, but the first few queries after a resume will be slower.

**Recommended pattern:**

| Scenario | Action |
|---|---|
| Between demo sessions (same day, <2 hr gap) | Leave running — 1-hr minimum makes suspend/resume more expensive |
| Overnight / multi-day gap | Suspend — saves ~14 credits/day |
| Morning of a demo | `ALTER WAREHOUSE DEMO_IWT_WH RESUME` 5–10 min before presenting |
| Demo cancelled / postponed | Suspend immediately |

```sql
-- Before demo: resume ~5 minutes early to allow cache warmup
ALTER WAREHOUSE DEMO_IWT_WH RESUME;

-- After demo (if done for the day):
ALTER WAREHOUSE DEMO_IWT_WH SUSPEND;
```

## Cost Estimate

Credit rates from [Snowflake Service Consumption Table](https://www.snowflake.com/legal-files/CreditConsumptionTable.pdf) (effective July 14, 2026):

| Resource | Config | Rate |
|---|---|---|
| `DEMO_IWT_WH` | XSmall Interactive Warehouse | **0.6 credits/hr** (40% cheaper than standard) |
| `DEMO_CPU_POOL` | `CPU_X64_XS`, 1 node (SPCS) | **0.06 credits/node/hr** |
| `DEMO_STD_WH` | XSmall Standard Warehouse (fallback) | **1.0 credits/hr** |
| Snowpipe Streaming | Per GB ingested | negligible at demo volumes |

### Key billing notes

- **Interactive Warehouse minimum billable period is 1 hour** (standard warehouses are 1 minute). Every resume starts a new 1-hour minimum.
- **Interactive Warehouse minimum `AUTO_SUSPEND` is 24 hours** — it won't auto-suspend during a day-long demo session.
- **SPCS compute pool** auto-suspends after 1 hour of inactivity (`AUTO_SUSPEND_SECS = 3600`).
- **`DEMO_STD_WH`** auto-suspends after 60 seconds of inactivity — cost is proportional to audience activity.

### 24-hour running cost

| Component | Active hours | Credits |
|---|---|---|
| `DEMO_IWT_WH` (always-on) | 24 | **14.4** |
| `DEMO_CPU_POOL` SPCS (1 node) | 24 | **1.44** |
| `DEMO_STD_WH` (used during votes) | 4–12 | **4–12** |
| Snowpipe Streaming | — | **~0.05** |
| **Total** | | **~20–28 credits** |

At $3/credit (standard platform rate): **~$60–84 / 24 hours**

For a typical 1–2 hour demo session:
- Suspend `DEMO_IWT_WH` immediately after: costs ~1–2 credits for the IWT (1hr minimum per resume)
- SPCS pool: 0.06–0.12 credits
- Total for a single session: **~2–5 credits (~$6–15)**

> The 24-hour running cost applies only if you leave everything up all day. Suspending the IWT overnight reduces the IWT cost to 0 between sessions — the dominant saving.

## File Reference

```
demo-predictions/
├── main.py                FastAPI — results, voters, config, compare APIs
├── config.py              SPCS OAuth token config
├── dev-server.py          Local mock server for dashboard development
├── static/
│   ├── admin.html         Create questions, allow-multiple-votes toggle
│   ├── dashboard.html     Presenter screen (bar chart + map + comparison)
│   ├── qrcode.min.js      Vendored QR code library
│   ├── leaflet.min.js     Vendored Leaflet map library
│   ├── leaflet.min.css    Vendored Leaflet styles
│   ├── world.geojson      Simplified world country borders (110m)
│   └── us-states.geojson  US state borders overlay
├── cloudflare-worker/
│   └── src/index.js       Worker: vote page, Snowpipe Streaming, geo metadata
├── sql/
│   ├── 01_setup.sql       Full Snowflake provisioning
│   └── 02_cleanup.sql     Full teardown
├── Dockerfile
├── snowflake.yml          SPCS service spec
├── requirements.txt
└── README.md
```

## Security Notes

- No admin token — admin page is protected by Snowflake SSO (SPCS public endpoint requires Snowflake login)
- Vote page is public (Cloudflare Worker) — no Snowflake auth required for audience
- Rate limiting: 15 requests/minute per IP in the Worker
- One vote per browser session per question (unless allow-multiple-votes enabled)
- Geo data (country, city, lat/lng) captured server-side from Cloudflare edge — no browser location permission requested
- Session IDs are browser-generated UUIDs — no PII collected
