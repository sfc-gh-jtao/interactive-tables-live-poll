"""
Environment-based configuration for the SPCS container.
Authentication: SPCS workload-identity OAuth token (enableCustomCredentials: true).
No RSA keys needed — the Cloudflare Worker handles Snowpipe Streaming with its own secrets.
"""
import os
from pathlib import Path


def _require(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        raise RuntimeError(f"Required environment variable '{name}' is not set")
    return val


SNOWFLAKE_ACCOUNT  = _require("SNOWFLAKE_ACCOUNT")
SNOWFLAKE_DATABASE = os.environ.get("SNOWFLAKE_DATABASE", "DEMO_PREDICTIONS_DB")
SNOWFLAKE_SCHEMA   = os.environ.get("SNOWFLAKE_SCHEMA", "PUBLIC")
SNOWFLAKE_ROLE     = os.environ.get("SNOWFLAKE_ROLE", "ACCOUNTADMIN")

# SPCS injects SNOWFLAKE_HOST (internal Snowflake endpoint) — bypasses account network policy.
SNOWFLAKE_HOST = os.environ.get(
    "SNOWFLAKE_HOST",
    f"{SNOWFLAKE_ACCOUNT}.snowflakecomputing.com",
)

# SPCS OAuth token from enableCustomCredentials: true — rotated automatically.
SPCS_TOKEN_PATH = os.environ.get("SPCS_TOKEN_PATH", "/snowflake/session/token")


def get_spcs_token() -> str:
    return Path(SPCS_TOKEN_PATH).read_text().strip()


ADMIN_TOKEN  = _require("ADMIN_TOKEN")
CACHE_TTL_MS = int(os.environ.get("CACHE_TTL_MS", "500"))

# URL to the Cloudflare Worker vote page — used by the dashboard QR code.
PUBLIC_VOTE_URL = os.environ.get("PUBLIC_VOTE_URL", "")
