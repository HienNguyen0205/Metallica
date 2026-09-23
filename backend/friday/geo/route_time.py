"""Departure / arrival times for routes (spec 2026-09-23 §4).

One place for both callers: /geo/route is strict (the browser always sends
an offset, so a naive time is a bug), the agent tool assumes the operator's
offset (models write "08:00"). Offsets, not tz names: Windows has no tz
database without tzdata — same reason as tools/system/clock.py.
"""

from datetime import datetime, timedelta, timezone

#: Vietnam, when the operator's browser sent no offset.
DEFAULT_OFFSET_MIN = 7 * 60
#: Clock skew between browser, server and TomTom.
PAST_SLACK = timedelta(minutes=5)
HORIZON = timedelta(days=365)


class RouteTimeError(ValueError):
    """A time the router cannot use; the message says why, for the user."""


def parse_time(value: str, assume_offset_min: int | None = None) -> datetime:
    try:
        dt = datetime.fromisoformat(value.strip())
    except (ValueError, AttributeError) as err:
        raise RouteTimeError(f"'{value}' is not an ISO 8601 time") from err
    if dt.tzinfo is None:
        if assume_offset_min is None:
            raise RouteTimeError(f"'{value}' has no UTC offset")
        dt = dt.replace(tzinfo=timezone(timedelta(minutes=assume_offset_min)))
    return dt


def route_times(
    depart_at: str | None,
    arrive_at: str | None,
    *,
    assume_offset_min: int | None = None,
    now: datetime | None = None,
) -> tuple[str | None, str | None]:
    if depart_at and arrive_at:
        raise RouteTimeError("give a departure time or an arrival time, not both")
    now = now or datetime.now(timezone.utc)
    out: list[str | None] = []
    for value in (depart_at, arrive_at):
        if not value:
            out.append(None)
            continue
        dt = parse_time(value, assume_offset_min)
        if dt < now - PAST_SLACK:
            raise RouteTimeError(f"{dt.isoformat(timespec='minutes')} is in the past")
        if dt > now + HORIZON:
            raise RouteTimeError(f"{dt.isoformat(timespec='minutes')} is more than a year ahead")
        out.append(dt.isoformat(timespec="seconds"))
    return out[0], out[1]
