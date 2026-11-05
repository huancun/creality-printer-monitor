"""Readable error messages from the printer's raw state.

Code source: Creality Print's device manager (resources/web/deviceMgr,
`printerCode` / `errorJson` tables), extracted into creality_errors.json
(official English text + severity level). Common cases get Chinese titles
and practical advice; unknown cases get a generic Chinese explanation.

Like Creality Print, we look up `err.key` (the dictionary index) first, then
`errcode`. Filament runout and power loss are not reported as errors: they are
inferred from `materialStatus` and `repoPlrStatus`.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

# code -> (Chinese title, Chinese advice, category)
MESSAGES: dict[int, tuple[str, str, str]] = {
    # Filament
    116: ("耗材用尽", "装入新的耗材后继续打印。", "filament"),
    20010: ("耗材用尽", "装入新的耗材后继续打印。", "filament"),
    2839: ("耗材用尽", "料盘已空，请更换耗材后继续打印。", "filament"),
    30000: ("未装入耗材", "开始打印前请装入耗材。", "filament"),
    30010: ("料架为空", "请在料架上放置耗材。", "filament"),
    # Extrusion
    2845: ("挤出机可能堵塞", "检查喷嘴和耗材，然后重试。", "extrusion"),
    2789: ("挤出异常", "可能发生堵塞，请检查喷嘴和耗材送进是否正常。", "extrusion"),
    528: ("打印时未挤出耗材", "耗材停止送进：可能是堵塞、料盘缠绕或耗材断裂。", "extrusion"),
    2111: ("喷嘴温度过低，无法挤出", "请先加热喷嘴再进行挤出。", "extrusion"),
    # AI / camera
    500: ("AI 检测到打印缺陷", "请检查摄像头画面是否有拉丝或模型脱落。若一切正常可继续打印，否则请停止。", "ai"),
    101: ("检测到打印缺陷，任务已暂停", "请检查摄像头画面，然后继续或停止打印。", "ai"),
    206: ("AI 检测到打印缺陷", "请检查摄像头画面，然后继续或停止打印。", "ai"),
    503: ("首层打印异常", "清洁热床（可使用异丙醇），检查调平后重试。", "ai"),
    104: ("热床上有异物", "继续打印前请移除热床上的异物。", "ai"),
    117: ("检测到翘边", "清洁热床、提高热床温度或添加裙边。", "ai"),
    523: ("检测到翘边", "清洁热床、提高热床温度或添加裙边。", "ai"),
    509: ("摄像头已禁用", "请在打印机设置中重新启用摄像头。", "camera"),
    510: ("摄像头故障", "请重启打印机；若问题仍然存在，请检查摄像头连接线。", "camera"),
    529: ("摄像头故障", "请重启打印机；若问题仍然存在，请检查摄像头连接线。", "camera"),
    # Power loss
    115: ("打印中断（断电）", "可以从中断处继续打印，或取消任务。", "power"),
    # Heating
    4: ("未能加热", "请检查打印头和热床的连接。", "heating"),
    2564: ("喷嘴未能加热", "请检查打印头线缆并重启打印机。", "heating"),
    2565: ("热床未能加热", "请检查热床线缆并重启打印机。", "heating"),
    209: ("热床温度异常", "请等待热床冷却并检查热床线缆。", "heating"),
    2509: ("喷嘴热敏电阻未连接", "请检查喷嘴热敏电阻的连接器。", "heating"),
    2515: ("喷嘴热敏电阻短路", "请检查喷嘴热敏电阻线缆。", "heating"),
    2510: ("热床热敏电阻未连接", "请检查热床热敏电阻的连接器。", "heating"),
    2516: ("热床热敏电阻短路", "请检查热床热敏电阻线缆。", "heating"),
    # Axes
    2573: ("X 轴归零失败", "请确认 X 轴没有被阻挡，然后重新归零。", "axes"),
    2577: ("Y 轴归零失败", "请确认热床（Y 轴）没有被阻挡。", "axes"),
    2581: ("Z 轴归零失败", "请确认 Z 轴没有被阻挡。", "axes"),
    2588: ("Z 偏移超出范围", "请重新进行热床校准（调平）。", "axes"),
    800: ("轴移动错误", "请确认打印头或热床没有被阻挡。", "axes"),
    # Fans
    501: ("热端风扇转速过低", "请确认没有线缆或耗材阻挡热端风扇。", "fans"),
    502: ("主板风扇故障", "请检查打印机底部的风扇。", "fans"),
    526: ("模型冷却风扇故障", "请检查打印头上的模型冷却风扇。", "fans"),
    10: ("风扇异常", "请确认风扇可以自由转动。", "fans"),
    204: ("风扇异常", "请确认风扇可以自由转动。", "fans"),
    # File / storage
    7: ("文件坐标超出热床范围", "请为此打印机重新切片模型。", "file"),
    208: ("G-code 文件异常", "请重新切片并发送文件。", "file"),
    2571: ("G-code 文件损坏", "请重新发送文件。", "file"),
    508: ("存储空间即将用尽", "请删除打印机中的旧文件。", "file"),
}

LEVELS = {1: "warning", 2: "error", 3: "error"}


@lru_cache(maxsize=1)
def _table() -> dict[str, dict[str, Any]]:
    return json.loads((Path(__file__).parent / "creality_errors.json").read_text(encoding="utf-8"))


def _int(v: Any) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def describe(data: dict[str, Any]) -> dict[str, Any] | None:
    """Active error described for the UI, or None."""
    err = data.get("err")
    key = errcode = 0
    if isinstance(err, dict):
        key, errcode = _int(err.get("key")), _int(err.get("errcode"))
    else:
        errcode = _int(err)
    code = key or errcode
    if not code:
        # Situations the printer does not report as errors.
        if _int(data.get("materialStatus")) == 1:
            code = 2839
        elif _int(data.get("repoPlrStatus")) == 1:
            code = 115
        else:
            return None
    entry = _table().get(str(code), {})
    if code in MESSAGES:
        title, advice, category = MESSAGES[code]
    else:
        title = "未知错误"
        advice, category = "请查看打印机屏幕了解详情。", "other"
    return {
        "code": code,
        "title": title,
        "advice": advice,
        "category": category,
        "level": LEVELS.get(entry.get("level") or 0, "error"),
        "official": entry.get("en"),
        "resumable": code == 115,
    }
