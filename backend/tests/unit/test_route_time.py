"""Departure/arrival times for routes.

    PYTHONPATH=. python tests/unit/test_route_time.py
"""

from datetime import datetime, timedelta, timezone

from friday.geo.route_time import RouteTimeError, parse_time, route_times

NOW = datetime(2026, 9, 23, 1, 0, tzinfo=timezone.utc)  # 08:00 in Hà Nội


def raises(fn, text):
    try:
        fn()
    except RouteTimeError as err:
        assert text in str(err), (text, str(err))
        return
    raise AssertionError(f"expected RouteTimeError containing {text!r}")


def test_offsets_are_kept_or_assumed() -> None:
    assert parse_time("2026-09-24T08:00:00+07:00").utcoffset() == timedelta(hours=7)
    assert parse_time("2026-09-24T01:00:00Z").utcoffset() == timedelta(0)
    assert parse_time("2026-09-24T08:00", assume_offset_min=420).isoformat() == "2026-09-24T08:00:00+07:00"
    raises(lambda: parse_time("2026-09-24T08:00"), "no UTC offset")
    raises(lambda: parse_time("tomorrow at 8"), "not an ISO 8601 time")


def test_route_times_normalize_and_exclude_each_other() -> None:
    assert route_times(None, None, now=NOW) == (None, None)
    assert route_times("2026-09-24T08:00", None, assume_offset_min=420, now=NOW) == ("2026-09-24T08:00:00+07:00", None)
    assert route_times(None, "2026-09-23T09:30:00+07:00", now=NOW) == (None, "2026-09-23T09:30:00+07:00")
    raises(lambda: route_times("2026-09-24T08:00Z", "2026-09-24T09:00Z", now=NOW), "not both")


def test_window() -> None:
    # 4 minutes ago is fine (clock skew), 6 minutes ago is not
    assert route_times("2026-09-23T07:56:00+07:00", None, now=NOW)[0] == "2026-09-23T07:56:00+07:00"
    raises(lambda: route_times("2026-09-23T07:54:00+07:00", None, now=NOW), "in the past")
    raises(lambda: route_times(None, "2027-10-01T08:00:00+07:00", now=NOW), "more than a year ahead")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
