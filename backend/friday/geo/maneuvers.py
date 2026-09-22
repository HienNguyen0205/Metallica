"""TomTom maneuver codes → Vietnamese (spec §6.2).

TomTom's guidance has no vi-VN, so directions ask for coded instructions and
the text is built here. The map's step list and get_directions' spoken steps
share it, so the operator hears exactly what they read.
"""

from typing import Any

VI: dict[str, str] = {
    "DEPART": "Xuất phát",
    "ARRIVE": "Đến nơi",
    "ARRIVE_LEFT": "Đến nơi, ở bên trái",
    "ARRIVE_RIGHT": "Đến nơi, ở bên phải",
    "STRAIGHT": "Đi thẳng",
    "KEEP_RIGHT": "Giữ bên phải",
    "BEAR_RIGHT": "Chếch sang phải",
    "TURN_RIGHT": "Rẽ phải",
    "SHARP_RIGHT": "Rẽ gắt sang phải",
    "KEEP_LEFT": "Giữ bên trái",
    "BEAR_LEFT": "Chếch sang trái",
    "TURN_LEFT": "Rẽ trái",
    "SHARP_LEFT": "Rẽ gắt sang trái",
    "MAKE_UTURN": "Quay đầu",
    "TRY_MAKE_UTURN": "Quay đầu khi có thể",
    "ENTER_MOTORWAY": "Vào đường cao tốc",
    "ENTER_FREEWAY": "Vào đường cao tốc",
    "ENTER_HIGHWAY": "Vào quốc lộ",
    "TAKE_EXIT": "Đi theo lối ra",
    "MOTORWAY_EXIT_LEFT": "Ra khỏi cao tốc ở bên trái",
    "MOTORWAY_EXIT_RIGHT": "Ra khỏi cao tốc ở bên phải",
    "TAKE_FERRY": "Lên phà",
    "ROUNDABOUT_CROSS": "Đi thẳng qua vòng xuyến",
    "ROUNDABOUT_RIGHT": "Vào vòng xuyến, rẽ phải",
    "ROUNDABOUT_LEFT": "Vào vòng xuyến, rẽ trái",
    "ROUNDABOUT_BACK": "Vào vòng xuyến, quay lại",
    "FOLLOW": "Đi theo",
    "SWITCH_PARALLEL_ROAD": "Chuyển sang đường song song",
    "SWITCH_MAIN_ROAD": "Chuyển sang đường chính",
    "ENTRANCE_RAMP": "Vào đường dẫn",
    "WAYPOINT_LEFT": "Đến điểm dừng, ở bên trái",
    "WAYPOINT_RIGHT": "Đến điểm dừng, ở bên phải",
    "WAYPOINT_REACHED": "Đến điểm dừng",
}

#: After these the street is the one you drive along ("trên"), not onto ("vào").
ALONG = {"DEPART", "STRAIGHT", "FOLLOW", "KEEP_LEFT", "KEEP_RIGHT"}


def vi_instruction(ins: dict[str, Any]) -> str:
    code = str(ins.get("maneuver", ""))
    text = VI.get(code, "Tiếp tục")
    exit_no = ins.get("roundaboutExitNumber")
    if code.startswith("ROUNDABOUT") and code != "ROUNDABOUT_CROSS" and exit_no:
        text = f"Vào vòng xuyến, đi lối ra thứ {exit_no}"
    if code.startswith(("ARRIVE", "WAYPOINT")):
        return text
    street = ins.get("street") or ", ".join(ins.get("roadNumbers") or [])
    if street:
        text = f"{text} {'trên' if code in ALONG else 'vào'} {street}"
    return text
