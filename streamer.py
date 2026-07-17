"""
Snowpipe Streaming wrapper using RSA key pair authentication.
Matches the arcade lab pattern: RSA key → JWT → direct write to Interactive Table.
The SQL connector (main.py) uses SPCS token auth separately.
Package: snowpipe-streaming>=1.6.2
"""
import logging
import uuid
from datetime import datetime, timezone

from snowflake.ingest.streaming import StreamingIngestClient
import config

logger = logging.getLogger(__name__)

_client: StreamingIngestClient | None = None
_channel = None
_offset_token: int = 0


def init() -> None:
    """Initialize the streaming client and open a channel. Call once at startup."""
    global _client, _channel, _offset_token

    _client = StreamingIngestClient(
        client_name=f"DEMO_POLL_CLIENT_{uuid.uuid4().hex[:8].upper()}",
        db_name=config.SNOWFLAKE_DATABASE,
        schema_name=config.SNOWFLAKE_SCHEMA,
        pipe_name="FACT_PREDICTIONS-STREAMING",
        properties={
            # RSA key auth as DEMO_SERVICE_USER.
            # DEMO_SERVICE_USER has a user-level network policy allowing the SPCS
            # pod subnet (10.18.88.0/24), which overrides the account VPN policy.
            # External account URL — goes to the ingest endpoint directly.
            "account":     config.SNOWFLAKE_ACCOUNT,
            "user":        config.SNOWFLAKE_USER,
            "private_key": config.SNOWFLAKE_PRIVATE_KEY_PEM,
            "url":         f"https://{config.SNOWFLAKE_ACCOUNT}.snowflakecomputing.com",
            "role":        config.SNOWFLAKE_ROLE,
        },
    )

    channel_name = f"DEMO_POLL_CH_{uuid.uuid4().hex[:8].upper()}"
    _channel, _ = _client.open_channel(channel_name)
    logger.info("Snowpipe Streaming channel opened: %s", channel_name)


def is_ready() -> bool:
    """Return True if the streaming channel is open and ready to accept rows."""
    return _channel is not None


def append(row: dict) -> None:
    """Write one prediction row to the streaming channel."""
    global _offset_token
    if _channel is None:
        raise RuntimeError("Streamer not initialized — call init() first")

    if isinstance(row.get("predicted_at"), str):
        row["predicted_at"] = datetime.fromisoformat(row["predicted_at"])

    _channel.append_row(row, str(_offset_token))
    _offset_token += 1


def close() -> None:
    global _client, _channel
    try:
        if _channel:
            _channel.close()
        if _client:
            _client.close()
    except Exception as exc:
        logger.warning("Error closing streamer: %s", exc)
    finally:
        _channel = None
        _client = None
