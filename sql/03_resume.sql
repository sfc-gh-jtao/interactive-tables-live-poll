-- =============================================================================
-- Interactive Tables Live Poll Demo — Session Resume
-- Run as ACCOUNTADMIN ~5-10 minutes before each event to allow cache warmup.
-- Prerequisites: 01_setup.sql has been run and the Docker image is deployed.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE DATABASE DEMO_PREDICTIONS_DB;
USE SCHEMA PUBLIC;

-- ---------------------------------------------------------------------------
-- 1. Resume Interactive Warehouse
--    Allow 5-10 minutes for cache warmup (XS warms at ~300-400 MB/s).
--    First queries after resume will be slower until cache is hot.
-- ---------------------------------------------------------------------------
ALTER WAREHOUSE DEMO_IWT_WH RESUME IF SUSPENDED;

-- Verify it's running
SELECT 'DEMO_IWT_WH state: ' || state AS status
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
UNION ALL
SELECT 'DEMO_IWT_WH resumed.' AS status;

SHOW WAREHOUSES LIKE 'DEMO_IWT_WH';

-- ---------------------------------------------------------------------------
-- 2. Resume Standard Warehouse (fallback + Worker SQL API)
-- ---------------------------------------------------------------------------
ALTER WAREHOUSE DEMO_STD_WH RESUME IF SUSPENDED;

-- ---------------------------------------------------------------------------
-- 3. Resume SPCS Compute Pool
-- ---------------------------------------------------------------------------
ALTER COMPUTE POOL DEMO_CPU_POOL RESUME IF SUSPENDED;

-- ---------------------------------------------------------------------------
-- 4. Resume SPCS Service
--    The service restarts the FastAPI container. Allow ~30s for it to come up.
-- ---------------------------------------------------------------------------
ALTER SERVICE DEMO_PREDICTIONS_DB.PUBLIC.DEMO_PREDICTIONS_SERVICE RESUME IF SUSPENDED;

-- Monitor service startup (run repeatedly until status = READY)
SELECT SYSTEM$GET_SERVICE_STATUS('DEMO_PREDICTIONS_DB.PUBLIC.DEMO_PREDICTIONS_SERVICE');

-- ---------------------------------------------------------------------------
-- 5. Verify Interactive Tables are still attached to the warehouse
-- ---------------------------------------------------------------------------
SHOW INTERACTIVE TABLES IN SCHEMA DEMO_PREDICTIONS_DB.PUBLIC;

-- ---------------------------------------------------------------------------
-- 6. Quick smoke test — confirm dashboard query path works
-- ---------------------------------------------------------------------------
USE WAREHOUSE DEMO_IWT_WH;

SELECT
    a.option_text,
    COUNT(p.prediction_id) AS vote_count
FROM DEMO_PREDICTIONS_DB.PUBLIC.dim_answer_options a
LEFT JOIN DEMO_PREDICTIONS_DB.PUBLIC.fact_predictions p
       ON a.option_id = p.option_id
WHERE a.question_id IN (
    SELECT question_id FROM DEMO_PREDICTIONS_DB.PUBLIC.dim_questions WHERE is_active = TRUE
)
GROUP BY a.option_text
ORDER BY vote_count DESC;

-- ---------------------------------------------------------------------------
-- Done — ready to demo.
-- Open /admin to create a question, then share the QR code with your audience.
-- ---------------------------------------------------------------------------
SELECT 'Demo environment ready. Navigate to /admin to create a question.' AS status;
