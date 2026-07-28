-- =============================================================================
-- Interactive Tables Live Poll Demo — Setup
-- Run as ACCOUNTADMIN in a standard warehouse session
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Session context
-- ---------------------------------------------------------------------------
USE ROLE ACCOUNTADMIN;

-- ---------------------------------------------------------------------------
-- 1. Database
-- ---------------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS DEMO_PREDICTIONS_DB;
USE DATABASE DEMO_PREDICTIONS_DB;
USE SCHEMA PUBLIC;

-- ---------------------------------------------------------------------------
-- 2. Standard Warehouse (must exist before interactive tables are created)
--    Also used for: DDL sessions, speed comparison, dim table writes
-- ---------------------------------------------------------------------------
CREATE WAREHOUSE IF NOT EXISTS DEMO_STD_WH
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND   = 60
    AUTO_RESUME    = TRUE
    COMMENT        = 'Standard Warehouse — DDL, speed comparison, fallback';

USE WAREHOUSE DEMO_STD_WH;

-- ---------------------------------------------------------------------------
-- 3. Interactive Tables
--    NOTE: CREATE INTERACTIVE TABLE must run on a standard warehouse session.
--    The WAREHOUSE parameter does NOT belong in CREATE INTERACTIVE TABLE for
--    static tables or Snowpipe Streaming targets — table↔warehouse association
--    happens in the CREATE/ALTER INTERACTIVE WAREHOUSE statement below.
--    WAREHOUSE is only used in dynamic (TARGET_LAG) tables to specify which
--    standard warehouse performs the refresh.
-- ---------------------------------------------------------------------------

-- Static: question definitions (refreshed via INSERT OVERWRITE by the admin)
CREATE INTERACTIVE TABLE IF NOT EXISTS dim_questions (
    question_id          VARCHAR(36)   NOT NULL,
    question_text        VARCHAR(500)  NOT NULL,
    context_text         VARCHAR(1000),
    category             VARCHAR(64),
    is_active            BOOLEAN       DEFAULT FALSE,
    allow_multiple_votes BOOLEAN       DEFAULT FALSE,
    require_email        BOOLEAN       DEFAULT FALSE,
    created_at           TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
) CLUSTER BY (is_active, question_id);

-- Static: answer options per question (refreshed via INSERT OVERWRITE)
CREATE INTERACTIVE TABLE IF NOT EXISTS dim_answer_options (
    option_id     VARCHAR(36)  NOT NULL,
    question_id   VARCHAR(36)  NOT NULL,
    option_text   VARCHAR(200) NOT NULL,
    display_order INT          NOT NULL
);

-- Streaming target: written to directly via Snowpipe Streaming SDK (~500ms latency)
CREATE INTERACTIVE TABLE IF NOT EXISTS fact_predictions (
    prediction_id VARCHAR(36)   NOT NULL,
    question_id   VARCHAR(36)   NOT NULL,
    option_id     VARCHAR(36)   NOT NULL,
    predicted_at       TIMESTAMP_NTZ NOT NULL,  -- client button-press time (browser clock)
    server_received_at TIMESTAMP_NTZ,           -- Worker server clock when POST was handled
    session_id         VARCHAR(36)   NOT NULL,
    platform           VARCHAR(32)
)
CLUSTER BY (predicted_at, question_id);

-- Voter metadata: geo (from Cloudflare) + device (from UA). One row per session per question.
-- Written via Snowpipe Streaming only on the first vote from each session.
CREATE INTERACTIVE TABLE IF NOT EXISTS dim_voters (
    session_id    VARCHAR(36)   NOT NULL,   -- FK → fact_predictions.session_id
    question_id   VARCHAR(36)   NOT NULL,
    voter_email   VARCHAR(255),              -- populated when require_email is enabled
    -- Geo (Cloudflare edge — zero user friction)
    country       VARCHAR(2),               -- ISO 2-letter: 'US', 'GB'
    region        VARCHAR(100),             -- 'California', 'Bavaria'
    city          VARCHAR(100),             -- 'San Francisco'
    latitude      FLOAT,
    longitude     FLOAT,
    timezone      VARCHAR(64),              -- 'America/Los_Angeles'
    -- Device (UA parsing + Accept-Language header)
    device_type   VARCHAR(20),              -- 'mobile' | 'tablet' | 'desktop'
    os            VARCHAR(50),              -- 'iOS' | 'Android' | 'Windows' | 'macOS'
    browser       VARCHAR(50),              -- 'Chrome' | 'Safari' | 'Firefox' | 'Edge'
    language      VARCHAR(20),              -- 'en-US', 'fr-FR'
    voted_at      TIMESTAMP_NTZ
)
CLUSTER BY (question_id, country);

-- ---------------------------------------------------------------------------
-- 4. Interactive Warehouse — associate all three tables at creation time
--    Tables are queried by this warehouse; association tells the warehouse
--    to pre-load index metadata and SSD cache for these tables.
--    Created in SUSPENDED state — must RESUME before queries work.
-- ---------------------------------------------------------------------------
CREATE INTERACTIVE WAREHOUSE IF NOT EXISTS DEMO_IWT_WH
    TABLES (
        DEMO_PREDICTIONS_DB.PUBLIC.dim_questions,
        DEMO_PREDICTIONS_DB.PUBLIC.dim_answer_options,
        DEMO_PREDICTIONS_DB.PUBLIC.fact_predictions,
        DEMO_PREDICTIONS_DB.PUBLIC.dim_voters
    )
    WAREHOUSE_SIZE = 'XSMALL'
    COMMENT        = 'Interactive Warehouse for the live poll demo';

-- Must resume after creation (interactive warehouses start SUSPENDED)
ALTER WAREHOUSE DEMO_IWT_WH RESUME IF SUSPENDED;

-- Set DEMO_STD_WH as fallback: any query that exceeds the 5-second interactive
-- timeout is transparently retried on the standard warehouse instead of failing.
-- This handles the speed-comparison query and any ad-hoc queries without time filters.
ALTER WAREHOUSE DEMO_IWT_WH SET FALLBACK_WAREHOUSE = DEMO_STD_WH;

-- ---------------------------------------------------------------------------
-- 5. Image repository (for the SPCS container image)
-- ---------------------------------------------------------------------------
CREATE IMAGE REPOSITORY IF NOT EXISTS DEMO_PREDICTIONS_DB.PUBLIC.DEMO_IMG_REPO;

-- Show the registry URL — you will need this for docker push
SHOW IMAGE REPOSITORIES IN SCHEMA DEMO_PREDICTIONS_DB.PUBLIC;

-- ---------------------------------------------------------------------------
-- 6. Compute pool (SPCS)
-- ---------------------------------------------------------------------------
CREATE COMPUTE POOL IF NOT EXISTS DEMO_CPU_POOL
    MIN_NODES     = 1
    MAX_NODES     = 1
    INSTANCE_FAMILY = CPU_X64_XS
    AUTO_RESUME   = TRUE
    AUTO_SUSPEND_SECS = 3600
    COMMENT       = 'Compute pool for the live poll SPCS service';

-- ---------------------------------------------------------------------------
-- 7. Service user and role (minimum privilege)
-- ---------------------------------------------------------------------------
CREATE ROLE IF NOT EXISTS DEMO_SERVICE_ROLE;

-- Grant usage on database/schema
GRANT USAGE ON DATABASE DEMO_PREDICTIONS_DB TO ROLE DEMO_SERVICE_ROLE;
GRANT USAGE ON SCHEMA DEMO_PREDICTIONS_DB.PUBLIC TO ROLE DEMO_SERVICE_ROLE;

-- Grant on warehouses
GRANT USAGE ON WAREHOUSE DEMO_IWT_WH TO ROLE DEMO_SERVICE_ROLE;
GRANT USAGE ON WAREHOUSE DEMO_STD_WH TO ROLE DEMO_SERVICE_ROLE;

-- Grant on interactive tables
GRANT SELECT, INSERT ON TABLE DEMO_PREDICTIONS_DB.PUBLIC.dim_questions       TO ROLE DEMO_SERVICE_ROLE;
GRANT SELECT, INSERT ON TABLE DEMO_PREDICTIONS_DB.PUBLIC.dim_answer_options  TO ROLE DEMO_SERVICE_ROLE;
GRANT SELECT, INSERT ON TABLE DEMO_PREDICTIONS_DB.PUBLIC.fact_predictions    TO ROLE DEMO_SERVICE_ROLE;
GRANT SELECT, INSERT ON TABLE DEMO_PREDICTIONS_DB.PUBLIC.dim_voters          TO ROLE DEMO_SERVICE_ROLE;

-- Grant CREATE INTERACTIVE TABLE (needed for INSERT OVERWRITE on dim tables)
GRANT CREATE TABLE ON SCHEMA DEMO_PREDICTIONS_DB.PUBLIC TO ROLE DEMO_SERVICE_ROLE;

-- Grant Snowpipe Streaming
GRANT CREATE PIPE ON SCHEMA DEMO_PREDICTIONS_DB.PUBLIC TO ROLE DEMO_SERVICE_ROLE;

-- Service user
CREATE USER IF NOT EXISTS DEMO_SERVICE_USER
    DEFAULT_ROLE      = DEMO_SERVICE_ROLE
    DEFAULT_WAREHOUSE = DEMO_STD_WH
    COMMENT           = 'Service account for the live poll SPCS container';

GRANT ROLE DEMO_SERVICE_ROLE TO USER DEMO_SERVICE_USER;

-- Grant DEMO_SERVICE_ROLE to the user running this setup script.
-- The SPCS workload-identity token represents this user, so it needs the role
-- to be able to switch into it when connecting back to Snowflake.
BEGIN
  LET usr VARCHAR := CURRENT_USER();
  EXECUTE IMMEDIATE 'GRANT ROLE DEMO_SERVICE_ROLE TO USER IDENTIFIER(''' || :usr || ''')';
END;

-- ---------------------------------------------------------------------------
-- Network policy for DEMO_SERVICE_USER — allows Cloudflare Worker egress IPs
-- to reach the Snowpipe Streaming ingest endpoint and Snowflake SQL API.
-- A user-level policy overrides the account VPN policy for this service account.
-- Cloudflare's IP ranges are stable; check https://www.cloudflare.com/ips-v4
-- if you need to update them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE NETWORK POLICY DEMO_CF_WORKER_POLICY
    ALLOWED_IP_LIST = (
        '173.245.48.0/20',
        '103.21.244.0/22',
        '103.22.200.0/22',
        '103.31.4.0/22',
        '141.101.64.0/18',
        '108.162.192.0/18',
        '190.93.240.0/20',
        '188.114.96.0/20',
        '197.234.240.0/22',
        '198.41.128.0/17',
        '162.158.0.0/15',
        '104.16.0.0/13',
        '104.24.0.0/14',
        '172.64.0.0/13',
        '131.0.72.0/22'
    )
    COMMENT = 'Allows Cloudflare Worker IPs to reach Snowpipe ingest + SQL API (https://www.cloudflare.com/ips-v4)';

ALTER USER DEMO_SERVICE_USER SET NETWORK_POLICY = DEMO_CF_WORKER_POLICY;


-- ---------------------------------------------------------------------------
-- 8. RSA key pair — PASTE YOUR PUBLIC KEY BELOW
--    Generate with:
--      openssl genrsa -out rsa_key.p8 2048
--      openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
-- ---------------------------------------------------------------------------
-- ALTER USER DEMO_SERVICE_USER SET RSA_PUBLIC_KEY='<paste contents of rsa_key.pub without header/footer>';

-- ---------------------------------------------------------------------------
-- 9. Snowflake Secret (stores the RSA private key PEM for SPCS injection)
--    Replace the placeholder with the actual PEM content of rsa_key.p8
-- ---------------------------------------------------------------------------
CREATE SECRET IF NOT EXISTS DEMO_PREDICTIONS_DB.PUBLIC.DEMO_PREDICT_SECRET
    TYPE         = GENERIC_STRING
    SECRET_STRING = '<paste_rsa_private_key_pem_here>'
    COMMENT      = 'RSA private key for DEMO_SERVICE_USER — used by SPCS container';

GRANT READ ON SECRET DEMO_PREDICTIONS_DB.PUBLIC.DEMO_PREDICT_SECRET TO ROLE DEMO_SERVICE_ROLE;

-- ---------------------------------------------------------------------------
-- 10. External Access Integration (allows Snowpipe Streaming SDK outbound calls)
-- ---------------------------------------------------------------------------
CREATE NETWORK RULE IF NOT EXISTS DEMO_PREDICTIONS_DB.PUBLIC.DEMO_SNOWPIPE_RULE
    TYPE  = HOST_PORT
    MODE  = EGRESS
    VALUE_LIST = ('*.snowflakecomputing.com:443');

CREATE EXTERNAL ACCESS INTEGRATION IF NOT EXISTS DEMO_EAI
    ALLOWED_NETWORK_RULES = (DEMO_PREDICTIONS_DB.PUBLIC.DEMO_SNOWPIPE_RULE)
    ENABLED               = TRUE
    COMMENT               = 'Allows Snowpipe Streaming SDK outbound from SPCS';

GRANT USAGE ON INTEGRATION DEMO_EAI TO ROLE DEMO_SERVICE_ROLE;

-- ---------------------------------------------------------------------------
-- 11. Verify everything is in place
-- ---------------------------------------------------------------------------
SHOW INTERACTIVE TABLES IN SCHEMA DEMO_PREDICTIONS_DB.PUBLIC;
SHOW IMAGE REPOSITORIES IN SCHEMA DEMO_PREDICTIONS_DB.PUBLIC;
SHOW COMPUTE POOLS LIKE 'DEMO_CPU_POOL';

SELECT 'Setup complete. Next: build + push Docker image, then CREATE SERVICE.' AS status;
ca