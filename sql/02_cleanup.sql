-- =============================================================================
-- Interactive Tables Live Poll Demo — Teardown
-- Run as ACCOUNTADMIN after the demo
-- NOTE: Interactive Warehouse bills minimum 1 hour from creation.
--       Run this immediately after you finish to avoid extra charges.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE DATABASE DEMO_PREDICTIONS_DB;
USE SCHEMA PUBLIC;
USE WAREHOUSE DEMO_STD_WH;

-- 1. Drop the SPCS service first (stops billing for compute pool)
DROP SERVICE IF EXISTS DEMO_PREDICTIONS_DB.PUBLIC.DEMO_SERVICE;

-- 2. Drop compute pool
DROP COMPUTE POOL IF EXISTS DEMO_CPU_POOL;

-- 3. Drop external access integration + network rule
DROP INTEGRATION  IF EXISTS DEMO_EAI;
DROP NETWORK RULE IF EXISTS DEMO_PREDICTIONS_DB.PUBLIC.DEMO_SNOWPIPE_RULE;

-- 4. Drop secret
DROP SECRET IF EXISTS DEMO_PREDICTIONS_DB.PUBLIC.DEMO_PREDICT_SECRET;

-- 5. Drop image repository (images inside are also removed)
DROP IMAGE REPOSITORY IF EXISTS DEMO_PREDICTIONS_DB.PUBLIC.DEMO_IMG_REPO;

-- 6. Revoke grants on service role before dropping
REVOKE ROLE DEMO_SERVICE_ROLE FROM USER DEMO_SERVICE_USER;

-- 7. Drop service user
DROP USER IF EXISTS DEMO_SERVICE_USER;

-- 8. Drop service role
DROP ROLE IF EXISTS DEMO_SERVICE_ROLE;

-- 9. Drop warehouses
USE WAREHOUSE DEMO_STD_WH;  -- switch away before dropping
DROP WAREHOUSE IF EXISTS DEMO_IWT_WH;

-- 10. Drop database (cascades: drops all tables, schemas, pipes)
DROP DATABASE IF EXISTS DEMO_PREDICTIONS_DB;

-- 11. Drop the standard warehouse last (we were using it for the session)
DROP WAREHOUSE IF EXISTS DEMO_STD_WH;

SELECT 'Teardown complete. All demo objects removed.' AS status;
