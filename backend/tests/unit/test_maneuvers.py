"""TomTom maneuver codes → Vietnamese instructions.

    PYTHONPATH=. python tests/unit/test_maneuvers.py
"""

from friday.geo.maneuvers import VI, vi_instruction

# The full list from TomTom's guidance-instructions docs.
CODES = (
    "ARRIVE ARRIVE_LEFT ARRIVE_RIGHT DEPART STRAIGHT KEEP_RIGHT BEAR_RIGHT TURN_RIGHT "
    "SHARP_RIGHT KEEP_LEFT BEAR_LEFT TURN_LEFT SHARP_LEFT MAKE_UTURN ENTER_MOTORWAY "
    "ENTER_FREEWAY ENTER_HIGHWAY TAKE_EXIT MOTORWAY_EXIT_LEFT MOTORWAY_EXIT_RIGHT TAKE_FERRY "
    "ROUNDABOUT_CROSS ROUNDABOUT_RIGHT ROUNDABOUT_LEFT ROUNDABOUT_BACK TRY_MAKE_UTURN FOLLOW "
    "SWITCH_PARALLEL_ROAD SWITCH_MAIN_ROAD ENTRANCE_RAMP WAYPOINT_LEFT WAYPOINT_RIGHT WAYPOINT_REACHED"
).split()


def test_every_code_has_vietnamese_text() -> None:
    assert len(CODES) == 33
    assert set(VI) == set(CODES), set(CODES) ^ set(VI)


def test_turns_name_the_street_they_turn_onto() -> None:
    assert vi_instruction({"maneuver": "TURN_RIGHT", "street": "Hùng Vương"}) == "Rẽ phải vào Hùng Vương"
    assert vi_instruction({"maneuver": "DEPART", "street": "Đinh Tiên Hoàng"}) == "Xuất phát trên Đinh Tiên Hoàng"
    assert vi_instruction({"maneuver": "TURN_LEFT", "roadNumbers": ["QL1A"]}) == "Rẽ trái vào QL1A"
    assert vi_instruction({"maneuver": "TURN_LEFT"}) == "Rẽ trái"


def test_roundabouts_say_which_exit() -> None:
    assert vi_instruction({"maneuver": "ROUNDABOUT_RIGHT", "roundaboutExitNumber": 2}) == "Vào vòng xuyến, đi lối ra thứ 2"
    assert vi_instruction({"maneuver": "ROUNDABOUT_CROSS", "roundaboutExitNumber": 2}) == "Đi thẳng qua vòng xuyến"


def test_arrivals_ignore_the_street_and_unknown_codes_fall_back() -> None:
    assert vi_instruction({"maneuver": "ARRIVE_RIGHT", "street": "Hùng Vương"}) == "Đến nơi, ở bên phải"
    assert vi_instruction({"maneuver": "SOMETHING_NEW"}) == "Tiếp tục"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
