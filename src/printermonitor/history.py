"""Print history: the Hi doesn't keep one, so the app keeps it itself.

Every printer is tracked on each update: a print that starts creates a
"running" row, and its end closes it (completed, stopped, failed) with the
duration, filament, cost, thumbnail and a camera photo.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import quote

import httpx

from . import printer as printer_mod
from .printer import HTTP_PORT, Printer, derive_state, relevant_error
from .store import Store

log = logging.getLogger(__name__)

ACTIVE = {"printing", "paused", "processing", "self_test"}
SAVE_EVERY = 60  # s: duration/progress of running prints saved to the database
STALE_ACTIVE_WINDOW = 45  # s: ignore a late active report after a print has ended
FILAMENT_DIAMETER = 1.75


def parse_gcode_meta(text: str) -> dict[str, Any]:
    """Slicer info from Creality Print comments."""
    meta: dict[str, Any] = {}

    values: dict[str, str] = {}
    for line in text.splitlines():
        match = re.match(r"^;\s*([^=]+?)\s*[=:]\s*(.*?)\s*$", line)
        if match:
            values[match.group(1).strip().lower()] = match.group(2).strip()

    def split_list(key: str, separator: str = ";") -> list[str]:
        raw = values.get(key, "")
        return [part.strip().strip('"') for part in raw.split(separator)] if raw else []

    def parse_numbers(raw: str | None) -> list[float]:
        if not raw:
            return []
        out = []
        for item in raw.split(","):
            try:
                out.append(float(item.strip()))
            except ValueError:
                return []
        return out

    usage = parse_numbers(values.get("filament used [g]"))
    names = split_list("filament_settings_id")
    types = split_list("filament_type")
    colors = split_list("filament_colour") or split_list("filament_color")
    filaments = []
    for index, grams in enumerate(usage):
        filaments.append({
            "profile": names[index] if index < len(names) else "",
            "type": types[index] if index < len(types) else "",
            "color": colors[index] if index < len(colors) else "",
            "estimated_g": grams,
        })
    if filaments:
        meta["filaments"] = filaments

    total = parse_numbers(values.get("total filament used [g]"))
    if total:
        meta["filament_g"] = total[0]
    elif usage:
        meta["filament_g"] = sum(usage)

    if types:
        meta["material"] = types[0]
    if colors:
        meta["color"] = colors[0]
    if t := values.get("estimated printing time (normal mode)") or values.get("estimated printing time"):
        meta["est_time_s"] = parse_duration(t)
    return meta


def parse_duration(s: str) -> int | None:
    total = 0
    for value, unit in re.findall(r"(\d+)\s*([dhms])", s):
        total += int(value) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[unit]
    return total or None


def grams_from_length(mm: float, density: float) -> float:
    r = FILAMENT_DIAMETER / 2
    return mm * math.pi * r * r * density / 1000  # mm³ -> cm³ -> g


def material_family(material: str | None, known: dict[str, Any], default: str) -> str:
    """"Hyper PLA", "Generic PETG"… -> PLA / PETG (key of the price table)."""
    if not material:
        return default
    up = material.upper()
    for key in sorted(known, key=len, reverse=True):
        if key.upper() in up:
            return key
    return default


def filament_price_key(filament: dict[str, Any], known: dict[str, Any], default: str) -> str:
    """Match the filament name without slicer's printer/nozzle suffix."""
    def normalize(value: Any) -> str:
        return " ".join(str(value or "").split("@", 1)[0].split()).casefold()

    profile = normalize(filament.get("profile"))
    for key in known:
        if normalize(key) == profile and profile:
            return key
    material = filament.get("type")
    return material_family(material, known, default) if material else default


def allocate_filament_usage(
    filaments: list[dict[str, Any]], actual_total_g: float | None, settings: dict[str, Any]
) -> list[dict[str, Any]]:
    estimates = [max(0.0, float(item.get("estimated_g") or 0)) for item in filaments]
    estimate_total = sum(estimates)
    known = settings["filaments"]
    out = []
    for item, estimated_g in zip(filaments, estimates):
        price_key = filament_price_key(item, known, settings["default_filament"])
        price_kg = float(known.get(price_key, {}).get("price_kg", 0))
        grams = (
            actual_total_g * estimated_g / estimate_total
            if actual_total_g is not None and estimate_total
            else estimated_g if actual_total_g is None else 0.0
        )
        out.append({
            **item,
            "estimated_g": round(estimated_g, 2),
            "grams": round(grams, 2) if grams is not None else None,
            "price_key": price_key,
            "price_kg": price_kg,
            "cost": round(grams * price_kg / 1000, 3) if grams is not None else None,
        })
    return out


class Tracker:
    def __init__(
        self,
        store: Store,
        photo: Callable[[Printer], Awaitable[bytes | None]],
        on_finish: Callable[[Printer, dict[str, Any]], None] = lambda p, r: None,
    ):
        self.store = store
        self.photo = photo
        self.on_finish = on_finish
        self._open: dict[str, int] = {}  # printer id -> id of the running row
        self._last_save: dict[str, float] = {}
        self._last: dict[str, dict[str, Any]] = {}  # last values seen during the print
        self._closed: dict[str, dict[str, Any]] = {}  # last closed print, for stale telemetry

    # ---------- tracking ----------
    def update(self, p: Printer) -> None:
        if not p.online:
            return  # offline: conclude nothing, the print may still be running
        d = p.data
        state = derive_state(d, True)
        key = self._key(d)
        rec_id = self._open.get(p.id)
        if rec_id is None and (rec := self.store.running_print(p.id)):
            rec_id = self._open[p.id] = rec["id"]  # resume after an app restart

        if state in ACTIVE and key:
            if rec_id is not None and self.store.get_print(rec_id)["print_key"] != key:
                rec = self.store.get_print(rec_id) or {}
                if self._same_run_with_new_key(p, rec):
                    # Some slicer/printer combinations refresh printStartTime or printId
                    # while the same print is still running. Do not split that print.
                    self.store.update_print(rec_id, print_key=key)
                else:
                    self._close(p, rec_id, "failed")  # another print replaced the previous one
                    rec_id = None
            if rec_id is None:
                if not self._is_stale_active(p):
                    self._start(p, key)
            else:
                self._remember(p)
                self._save_progress(p, rec_id)
        elif rec_id is not None:
            self._remember(p)  # the final message often carries the final duration and filament
            if state == "completed":
                self._close(p, rec_id, "completed")
            elif state == "stopped":
                self._close(p, rec_id, "stopped")
            elif state in ("idle", "error"):
                self._close(p, rec_id, "failed")

    @staticmethod
    def _key(d: dict[str, Any]) -> str | None:
        name = d.get("printFileName")
        if not name:
            return None
        return f"{name}|{d.get('printId') or d.get('printStartTime') or ''}"

    def _same_run_with_new_key(self, p: Printer, rec: dict[str, Any]) -> bool:
        """Keep one history row when only the firmware task id changed."""
        file = Path(str(p.data.get("printFileName") or "")).name
        if not file or file != rec.get("file"):
            return False
        try:
            job_time = float(p.data.get("printJobTime") or 0)
            previous = float(self._last.get(p.id, {}).get("printJobTime") or 0)
            progress = float(p.data.get("printProgress") or 0)
            previous_progress = float(self._last.get(p.id, {}).get("printProgress") or 0)
        except (TypeError, ValueError):
            return False
        # A running print should not jump backwards materially just because its
        # printStartTime/printId was refreshed by the printer.
        return job_time >= max(0, previous - 10) and progress >= max(0, previous_progress - 10)

    def _is_stale_active(self, p: Printer) -> bool:
        """Ignore a delayed active packet belonging to the just-finished print."""
        closed = self._closed.get(p.id)
        if not closed or time.monotonic() - closed["closed_at"] > STALE_ACTIVE_WINDOW:
            return False
        file = Path(str(p.data.get("printFileName") or "")).name
        if file != closed.get("file"):
            return False
        try:
            job_time = float(p.data.get("printJobTime") or 0)
            progress = float(p.data.get("printProgress") or 0)
        except (TypeError, ValueError):
            return True
        # A new job must visibly reset its counters. Otherwise this is most
        # likely a late/replayed status packet from the completed job.
        return job_time >= max(0, closed["duration"] - 10) or progress >= 95

    def _remember(self, p: Printer) -> None:
        d = p.data
        last = self._last.setdefault(p.id, {})
        for k in ("printJobTime", "printProgress", "usedMaterialLength"):
            try:
                v = float(d.get(k))
                if v > 0:
                    last[k] = v
            except (TypeError, ValueError):
                pass
        if err := relevant_error(d, "paused"):
            last["error"] = err

    def _start(self, p: Printer, key: str) -> None:
        d = p.data
        job = float(d.get("printJobTime") or 0)
        file = Path(str(d.get("printFileName"))).name
        fil = self._loaded_filament(p)
        rec_id = self.store.insert_print(
            printer_id=p.id, printer_name=p.name, print_key=key, file=file, status="running",
            started_at=time.time() - job, progress=int(float(d.get("printProgress") or 0)),
            material=fil.get("type"), color=fil.get("color"),
        )
        self._open[p.id] = rec_id
        self._last[p.id] = {}
        self._remember(p)
        log.info("%s: print of %s recorded (#%d)", p.name, file, rec_id)
        asyncio.ensure_future(self._enrich(p, rec_id, file))

    def _save_progress(self, p: Printer, rec_id: int) -> None:
        now = time.monotonic()
        if now - self._last_save.get(p.id, 0) < SAVE_EVERY:
            return
        self._last_save[p.id] = now
        last = self._last.get(p.id, {})
        self.store.update_print(
            rec_id, duration_s=int(last.get("printJobTime", 0)), progress=int(last.get("printProgress", 0))
        )

    def _close(self, p: Printer, rec_id: int, status: str) -> None:
        self._open.pop(p.id, None)
        last = self._last.pop(p.id, {})
        rec = self.store.get_print(rec_id) or {}
        now = time.time()
        duration = int(last.get("printJobTime") or (now - (rec.get("started_at") or now)))
        progress = 100 if status == "completed" else int(last.get("printProgress", rec.get("progress") or 0))
        settings = self.store.settings()
        family = material_family(rec.get("material"), settings["filaments"], settings["default_filament"])
        density = settings["filaments"].get(family, {}).get("density", 1.24)
        grams = None
        if last.get("usedMaterialLength"):
            grams = grams_from_length(last["usedMaterialLength"], density)
        elif rec.get("est_filament_g"):
            grams = rec["est_filament_g"] * progress / 100
        breakdown = rec.get("filament_breakdown")
        if breakdown:
            breakdown = allocate_filament_usage(breakdown, grams, settings)
        fields: dict[str, Any] = {
            "status": status, "ended_at": now, "duration_s": duration, "progress": progress,
            "filament_g": round(grams, 2) if grams else None,
        }
        if breakdown:
            fields["filament_breakdown"] = breakdown
        fields.update(self._costs(fields, family, settings, breakdown))
        if status != "completed" and (err := last.get("error")):
            fields["error_code"], fields["error_title"] = err["code"], err["title"]
        self.store.update_print(rec_id, **fields)
        self._closed[p.id] = {
            "file": rec.get("file"),
            "closed_at": time.monotonic(),
            "duration": duration,
            "progress": progress,
        }
        log.info("%s: print #%d %s (%d s)", p.name, rec_id, status, duration)
        asyncio.ensure_future(self._final_photo(p, rec_id))
        self.on_finish(p, {**rec, **fields})

    @staticmethod
    def _costs(
        fields: dict[str, Any], family: str, settings: dict[str, Any],
        breakdown: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        energy = settings["energy"]
        filament_cost = (
            sum(float(item.get("cost") or 0) for item in breakdown)
            if breakdown
            else (fields.get("filament_g") or 0) * settings["filaments"].get(family, {}).get("price_kg", 0) / 1000
        )
        return {
            "cost_filament": round(filament_cost, 3),
            "cost_energy": round(fields["duration_s"] / 3600 * energy["power_w"] / 1000 * energy["price_kwh"], 3),
        }

    def recompute_costs(self) -> None:
        """After a price change: recompute the whole history."""
        settings = self.store.settings()
        for rec in self.store.prints(limit=100000):
            if rec["status"] == "running" or rec["duration_s"] is None:
                continue
            family = material_family(rec.get("material"), settings["filaments"], settings["default_filament"])
            breakdown = rec.get("filament_breakdown")
            if breakdown:
                breakdown = allocate_filament_usage(breakdown, rec.get("filament_g"), settings)
                self.store.update_print(rec["id"], filament_breakdown=breakdown)
            self.store.update_print(rec["id"], **self._costs(rec, family, settings, breakdown))

    # ---------- enrichment (network) ----------
    @staticmethod
    def _loaded_filament(p: Printer) -> dict[str, Any]:
        for box in (p.data.get("boxsInfo") or {}).get("materialBoxs", []):
            for m in box.get("materials", []):
                if m.get("selected") or box.get("type") == 1:
                    color = re.search(r"([0-9a-fA-F]{6})$", str(m.get("color") or ""))
                    return {"type": m.get("type"), "color": f"#{color.group(1)}" if color else None}
        return {}

    async def _enrich(self, p: Printer, rec_id: int, file: str) -> None:
        """Slicer estimates (start and end of the file) and thumbnail."""
        base = f"http://{p.host}:{HTTP_PORT}/downloads"
        fields: dict[str, Any] = {}
        try:
            async with httpx.AsyncClient(timeout=30) as c:
                text = await self._gcode_ends(c, p, file)
                meta = parse_gcode_meta(text)
                if meta.get("filament_g"):
                    fields["est_filament_g"] = meta["filament_g"]
                if meta.get("filaments"):
                    fields["filament_breakdown"] = meta["filaments"]
                if meta.get("est_time_s"):
                    fields["est_time_s"] = meta["est_time_s"]
                rec = self.store.get_print(rec_id) or {}
                if not rec.get("material") and meta.get("material"):
                    fields["material"] = meta["material"]
                if not rec.get("color") and meta.get("color"):
                    fields["color"] = meta["color"]
                r = await c.get(f"{base}/humbnail/{quote(Path(file).stem)}.png")
                if r.status_code == 200 and r.content[:4] == b"\x89PNG":
                    name = f"{rec_id}_thumb.png"
                    (self.store.media / name).write_bytes(r.content)
                    fields["thumb"] = name
        except Exception as e:
            log.warning("%s: info for file %s unavailable: %s", p.name, file, e)
        self.store.update_print(rec_id, **fields)
        if fields.get("filament_breakdown"):
            rec = self.store.get_print(rec_id) or {}
            if rec.get("status") != "running":
                settings = self.store.settings()
                breakdown = allocate_filament_usage(fields["filament_breakdown"], rec.get("filament_g"), settings)
                family = material_family(rec.get("material"), settings["filaments"], settings["default_filament"])
                costs = self._costs({**rec, **fields}, family, settings, breakdown)
                self.store.update_print(rec_id, filament_breakdown=breakdown, **costs)

    @staticmethod
    async def _gcode_ends(c: httpx.AsyncClient, p: Printer, file: str) -> str:
        """Start + end of the G-code (where slicers put their estimates).
        Moonraker supports range requests; the printer's web server doesn't."""
        url = f"http://{p.host}:{printer_mod.MOONRAKER_PORT}/server/files/gcodes/{quote(file)}"
        parts = []
        try:
            for rng in ("bytes=0-65535", "bytes=-131072"):
                r = await c.get(url, headers={"Range": rng})
                if r.status_code != 206:
                    raise httpx.HTTPError("no range request support")
                parts.append(r.text)
            return "\n".join(parts)
        except httpx.HTTPError:
            r = await c.get(f"http://{p.host}:{HTTP_PORT}/downloads/gcode/{quote(file)}")
            r.raise_for_status()
            return r.text[:65536] + "\n" + r.text[-131072:]

    async def _final_photo(self, p: Printer, rec_id: int) -> None:
        try:
            jpeg = await self.photo(p)
        except Exception as e:
            log.warning("%s: could not take the final photo: %s", p.name, e)
            return
        if jpeg:
            name = f"{rec_id}_photo.jpg"
            (self.store.media / name).write_bytes(jpeg)
            self.store.update_print(rec_id, photo=name)
