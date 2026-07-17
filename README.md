# Interactive Tables Live Poll Demo

A self-contained demo that streams audience votes from phones directly into Snowflake Interactive Tables via Snowpipe Streaming, with sub-second dashboard updates and a live warehouse speed comparison.

## Architecture

```
Phone (/vote)  →  SPCS container (public HTTPS)  →  Snowpipe Streaming  →  fact_predictions (Interactive Table)
                        ↓ also serves
Laptop (/dashboard)                             →  3-table JOIN on DEMO_IWT_WH  (sub-second)
Laptop (/admin)   →  INSERT OVERWRITE           →  dim_questions, dim_answer_options (static Interactive Tables)
```

**Three interactive tables, all in `DEMO_IWT_WH`:**
- `dim_questions` — static, holds the active question
- `dim_answer_options` — static, holds 2–6 answer options per question
- `fact_predictions` — streaming, one row per vote, `CLUSTER BY (predicted_at, question_id)`

## Prerequisites

- Snowflake account in an [Interactive Tables supported region](https://docs.snowflake.com/en/user-guide/interactive#region-availability)
- SPCS enabled (`SHOW PARAMETERS LIKE 'ENABLE_ACCOUNT_LEVEL_COMPUTE_POOL' IN ACCOUNT`)
- Docker installed
- `snow` CLI installed (`pip install snowflake-cli`)

## Deployment Steps

### 1. Generate RSA key pair

```bash
openssl genrsa -out rsa_key.p8 2048
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
```

Keep `rsa_key.p8` private — it never leaves your machine except to be pasted into the Snowflake Secret.

### 2. Run the setup SQL

1. Open Snowsight and sign in as `ACCOUNTADMIN`
2. Open a new SQL worksheet
3. Paste the contents of `sql/01_setup.sql`
4. **Before running**: find the two placeholder lines near the bottom:
   - `ALTER USER DEMO_SERVICE_USER SET RSA_PUBLIC_KEY='...'` — paste the public key content (without `-----BEGIN/END PUBLIC KEY-----` headers)
   - `SECRET_STRING = '<paste_rsa_private_key_pem_here>'` — paste the full private key PEM (including headers)
5. Run all statements

Note the image repository URL printed by `SHOW IMAGE REPOSITORIES` — you need it for the next step.

### 3. Build and push the Docker image

```bash
# Get your registry URL from the setup SQL output, or run:
# SELECT SYSTEM$REGISTRY_URL()  -- in Snowsight

REGISTRY_URL="<org>-<account>.registry.snowflakecomputing.com"

docker build -t predictions-api .

docker tag predictions-api ${REGISTRY_URL}/demo_predictions_db/public/demo_img_repo/predictions-api:latest

# Authenticate to the registry
docker login ${REGISTRY_URL} -u <your_snowflake_user>

docker push ${REGISTRY_URL}/demo_predictions_db/public/demo_img_repo/predictions-api:latest
```

### 4. Edit snowflake.yml

Open `snowflake.yml` and replace:
- `<ORG>-<ACCOUNT>` with your org-account identifier (run `SELECT CURRENT_ORGANIZATION_NAME() || '-' || CURRENT_ACCOUNT_NAME()` in Snowsight)
- `<choose-a-token>` with any secret string you'll use as the admin password

### 5. Deploy the SPCS service

In Snowsight (as ACCOUNTADMIN or a role with SPCS privileges):

```sql
USE ROLE ACCOUNTADMIN;
USE DATABASE DEMO_PREDICTIONS_DB;
USE SCHEMA PUBLIC;

CREATE SERVICE DEMO_SERVICE
  IN COMPUTE POOL DEMO_CPU_POOL
  FROM SPECIFICATION $$
<paste full contents of snowflake.yml here>
$$
EXTERNAL_ACCESS_INTEGRATIONS = (DEMO_EAI)
COMMENT = 'Interactive Tables Live Poll Demo';
```

Wait ~2 minutes for the service to start:
```sql
SELECT SYSTEM$GET_SERVICE_STATUS('DEMO_PREDICTIONS_DB.PUBLIC.DEMO_SERVICE');
```

### 6. Get the public URL

```sql
SHOW ENDPOINTS IN SERVICE DEMO_PREDICTIONS_DB.PUBLIC.DEMO_SERVICE;
```

Copy the `ingress_url` value. This is the base URL for all three pages.

### 7. You're ready

| Page | URL | Who uses it |
|---|---|---|
| Dashboard | `https://<ingress_url>/dashboard` | Presenter — open on laptop/projector |
| Vote | `https://<ingress_url>/vote` | Audience — scan QR code from dashboard |
| Admin | `https://<ingress_url>/admin` | Presenter — create and activate questions |

## Demo Flow

1. Open `/dashboard` on your projector screen
2. Open `/admin` in a separate tab — enter your `ADMIN_TOKEN`
3. Create a question with 2–4 answer options and click **Activate Question**
4. The dashboard updates immediately — the QR code is ready
5. Audience scans QR code with their phones and votes
6. Watch the bar chart update sub-second as votes arrive
7. Point out the **Freshness** metric: milliseconds since last vote hit Snowflake
8. Click **Compare Interactive vs Standard** — same 3-table JOIN, both warehouses
9. Interactive: ~100ms. Standard: ~3–5 seconds. That's the story.

## Cleanup

Run `sql/02_cleanup.sql` as `ACCOUNTADMIN` immediately after the demo.

> **Important**: The Interactive Warehouse bills a minimum of 1 hour from creation, then per-second after that. The compute pool also incurs charges while running. Tear down promptly.

## File Reference

```
demo-predictions/
├── main.py               FastAPI app — all endpoints, rate limiting, dedup
├── streamer.py           Snowpipe Streaming SDK wrapper
├── config.py             Environment-based config
├── static/
│   ├── admin.html        Admin: create + activate questions (bearer token protected)
│   ├── vote.html         Mobile voting page (dynamic multi-choice)
│   ├── dashboard.html    Presenter dashboard (bar chart + speed comparison)
│   └── qrcode.min.js     Vendored QR code library (no CDN)
├── sql/
│   ├── 01_setup.sql      Full Snowflake provisioning
│   └── 02_cleanup.sql    Full teardown
├── Dockerfile
├── snowflake.yml         SPCS service spec
├── requirements.txt
└── README.md
```

## Security Notes

- The RSA private key is stored in a Snowflake Secret and injected at runtime by SPCS — it is never in the Docker image or on disk after deployment
- The admin token is only required for `POST /api/question` — voting endpoints are unauthenticated by design (audience should not need accounts)
- Rate limiting: 10 requests/minute per IP; one vote per browser session per question
- No PII is collected: session IDs are browser-generated UUIDs, no names or accounts required
- CORS is restricted to same-origin by FastAPI defaults
