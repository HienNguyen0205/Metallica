"""The operator's location — only when they chose to share it.

Separate from get_client_metrics on purpose: its own capability
(client.location), kept at the precision the browser measured (with its
accuracy radius), and never written into long-term memory by `remember`.

    PYTHONPATH=. python tests/unit/test_client_location.py
"""

import asyncio

from pydantic import ValidationError

from friday.api.schemas import ClientContext, Query
from friday.memory import long_term as lt
from friday.tools import registry
from friday.tools.client import metrics as cm


def turn(ctx: dict, coro_fn):
    async def run():
        cm.CLIENT.set(ClientContext(**ctx).model_dump(exclude_none=True))
        return await coro_fn()

    return asyncio.run(run())


def test_location_keeps_the_browsers_precision() -> None:
    loc = ClientContext(location={"lat": 10.776889, "lon": 106.700806, "accuracy_m": 12.5}).location
    assert (loc.lat, loc.lon, loc.accuracy_m) == (10.776889, 106.700806, 12.5)
    # Float noise past ~10 cm is trimmed; no browser fix is finer than that.
    assert ClientContext(location={"lat": 10.1234567891, "lon": 0}).location.lat == 10.123457
    for bad in ({"lat": 91, "lon": 0}, {"lat": 0, "lon": 181}, {"lat": "x", "lon": 0}):
        try:
            ClientContext(location=bad)
        except ValidationError:
            continue
        raise AssertionError(f"accepted {bad}")
    # A bad location costs the readings, not the question (same rule as metrics).
    assert Query(query="hi", client={"location": {"lat": 999, "lon": 0}}).client is None


def test_location_tool_returns_it_and_metrics_tool_does_not() -> None:
    ctx = {"cpu_cores": 8, "timezone": "Asia/Saigon", "location": {"lat": 10.776889, "lon": 106.700806, "accuracy_m": 12.5}}
    loc = turn(ctx, lambda: cm.run_client_location({}))
    assert loc == {"lat": 10.776889, "lon": 106.700806, "accuracy_m": 12.5, "timezone": "Asia/Saigon"}, loc
    metrics = turn(ctx, lambda: cm.run_client_metrics({}))
    assert "location" not in metrics, "location has its own tool and capability"


def test_no_shared_location_is_said_plainly() -> None:
    out = turn({"cpu_cores": 8}, lambda: cm.run_client_location({}))
    assert "error" in out and "not shared" in out["error"]


def test_preview_is_a_globe_with_the_operator_marked() -> None:
    spec = cm.preview_client_location({"lat": 10.78, "lon": 106.7})
    assert spec["type"] == "globe"
    point = spec["data"]["points"][0]
    assert (point["lat"], point["lon"], point["label"]) == (10.78, 106.7, "YOU")


def test_remember_refuses_to_store_the_coordinates() -> None:
    orig = lt.store_configured
    lt.store_configured = lambda: True
    try:
        # Quoted in full or rounded, it is still the operator's position.
        for fact in ("The operator lives at 10.776889, 106.700806", "Home is near 10.78, 106.7", "lat 10.777"):
            out = turn(
                {"location": {"lat": 10.776889, "lon": 106.700806}},
                lambda: lt.run_remember({"fact": fact}),
            )
            assert "error" in out and "location" in out["error"], (fact, out)
    finally:
        lt.store_configured = orig


def test_a_near_whole_coordinate_does_not_block_every_number() -> None:
    # lat 10.0012 rounds to "10.00" at 2 decimals; stripped to a bare "10" it
    # refused any fact containing "10" ("deploys at 10am").
    orig = lt.store_configured
    lt.store_configured = lambda: True
    embed_orig, insert_orig = lt.embed, lt.store_insert

    async def fake_embed(texts):
        return [[1.0, 0.0] for _ in texts]

    lt.embed = fake_embed
    lt.store_insert = lambda fact, prov, emb, owner=None: {"id": 5, "fact": fact, "provenance": prov}
    try:
        ctx = {"location": {"lat": 10.0012, "lon": 106.7}}
        ok = turn(ctx, lambda: lt.run_remember({"fact": "Deploys happen at 10am on Fridays"}))
        assert "error" not in ok, ok
        refused = turn(ctx, lambda: lt.run_remember({"fact": "Home is at 10.001, 106.7"}))
        assert "error" in refused, refused
    finally:
        lt.store_configured, lt.embed, lt.store_insert = orig, embed_orig, insert_orig
        lt.clear()


def test_registered_with_its_own_capability() -> None:
    tool = registry.get("get_client_location")
    assert tool is not None and tool.risk == "low"
    assert tool.capabilities == ("client.location",)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
