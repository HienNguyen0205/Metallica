"""The 429 message must name the limit that actually refused the call.

Bodies below are copied from real Gemini 429s.

    PYTHONPATH=. python tests/unit/test_quota_detail.py
"""

from friday.api.routes import quota_detail


class Err(Exception):
    def __init__(self, body):
        self.body = body


PER_MINUTE = [
    {
        "error": {
            "code": 429,
            "message": "You exceeded your current quota...",
            "status": "RESOURCE_EXHAUSTED",
            "details": [
                {"@type": "type.googleapis.com/google.rpc.Help", "links": []},
                {
                    "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                    "violations": [
                        {
                            "quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                            "quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
                            "quotaValue": "15",
                        }
                    ],
                },
                {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "12s"},
            ],
        }
    }
]


def test_per_minute_says_so_and_gives_the_wait():
    detail = quota_detail(Err(PER_MINUTE))
    assert "requests-per-minute" in detail, detail
    assert "retry in 12s" in detail, detail
    # The old wording sent people to the billing page for a wall that clears
    # in twelve seconds. It must not come back.
    assert "over quota" not in detail, detail


def test_per_day_is_named_differently():
    body = [{"error": {"details": [
        {"@type": ".../QuotaFailure", "violations": [
            {"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}
        ]},
    ]}}]
    detail = quota_detail(Err(body))
    assert "daily quota" in detail, detail


def test_unknown_providers_add_nothing_rather_than_guess():
    # Any provider that is not Gemini's shim: no body, a string body, a dict
    # with nothing in it. The caller still gets the bare "rate limit reached".
    for body in (None, "429 Too Many Requests", {}, [], [{"error": {}}]):
        assert quota_detail(Err(body)) == "", repr(body)


def test_retry_alone_still_reaches_the_user():
    body = {"error": {"details": [{"@type": ".../RetryInfo", "retryDelay": "30s"}]}}
    assert quota_detail(Err(body)) == "; retry in 30s"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all quota-detail tests passed")
