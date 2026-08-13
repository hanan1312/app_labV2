from datetime import datetime
from zoneinfo import ZoneInfo

# The clinic/lab is physically in Egypt, so every timestamp shown anywhere in the app
# (tables, PDFs, receipts) should read as Egypt local time regardless of the server's own
# OS timezone or the viewing browser's clock/timezone. Using the IANA zone (rather than a
# hardcoded +2/+3 offset) means DST changes (Egypt reintroduced it in 2023) are handled
# automatically by the tz database instead of needing a manual seasonal fix here.
CAIRO_TZ = ZoneInfo('Africa/Cairo')


def now_cairo():
    """Current time as a naive datetime already shifted to Africa/Cairo local time. Naive
    (no tzinfo) so it behaves exactly like the naive-UTC datetimes already used throughout
    this codebase (e.g. datetime.utcnow()) for storage/formatting/string comparison — just
    with Cairo's offset baked in instead of UTC's."""
    return datetime.now(CAIRO_TZ).replace(tzinfo=None)


def utc_to_cairo(dt):
    """Converts a naive UTC datetime (anything set via datetime.utcnow() or SQLite's
    CURRENT_TIMESTAMP) to a naive Africa/Cairo local datetime, for display/serialization.
    None-safe — returns None unchanged so callers can keep their existing `if x else None`
    guards without a special case."""
    if dt is None:
        return None
    return dt.replace(tzinfo=ZoneInfo('UTC')).astimezone(CAIRO_TZ).replace(tzinfo=None)
