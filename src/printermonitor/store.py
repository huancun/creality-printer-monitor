"""App data: print history, settings, maintenance, users and sessions (SQLite)."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any

from .paths import DATA_DIR


DEFAULT_SETTINGS: dict[str, Any] = {
    # Price per kg and density (g/cm³) per filament type.
    "filaments": {
        "PLA": {"price_kg": 20.0, "density": 1.24},
        "PETG": {"price_kg": 22.0, "density": 1.27},
        "ABS": {"price_kg": 22.0, "density": 1.04},
        "ASA": {"price_kg": 25.0, "density": 1.07},
        "TPU": {"price_kg": 30.0, "density": 1.21},
        "PLA-CF": {"price_kg": 30.0, "density": 1.30},
        "PETG-CF": {"price_kg": 32.0, "density": 1.30},
    },
    "default_filament": "PLA",
    # Electricity: average power draw of a printer while printing.
    "energy": {"price_kwh": 0.25, "power_w": 150},
    # Maintenance, in print hours.
    "maintenance": [
        {"id": "bed", "name": "清洁热床（异丙醇）", "hours": 20},
        {"id": "lube", "name": "润滑轴和杆", "hours": 100},
        {"id": "belts", "name": "检查皮带张力", "hours": 200},
        {"id": "fans", "name": "清理风扇灰尘", "hours": 300},
        {"id": "nozzle", "name": "更换喷嘴", "hours": 500},
    ],
    # Smart plugs, by printer id:
    # {"type": "shelly2"|"shelly1"|"tasmota"|"xiaomi_miot", "host": "192.168.1.50", "token": "…", "auto_off": true, "off_below": 50, "delay_min": 0}
    "plugs": {},
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS prints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id TEXT NOT NULL,
    printer_name TEXT,
    print_key TEXT,
    file TEXT,
    status TEXT NOT NULL,          -- running | completed | stopped | failed
    started_at REAL,
    ended_at REAL,
    duration_s INTEGER,
    progress INTEGER,
    est_time_s INTEGER,
    est_filament_g REAL,
    filament_g REAL,
    material TEXT,
    color TEXT,
    filament_breakdown TEXT,
    cost_filament REAL,
    cost_energy REAL,
    energy_start_kwh REAL,
    energy_kwh REAL,
    error_code INTEGER,
    error_title TEXT,
    thumb TEXT,
    photo TEXT
);
CREATE INDEX IF NOT EXISTS prints_printer ON prints(printer_id, started_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS maintenance (
    printer_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    done_hours REAL NOT NULL,
    done_at REAL NOT NULL,
    PRIMARY KEY (printer_id, task_id)
);
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    pw_hash TEXT NOT NULL,               -- pbkdf2_sha256$iterations$salt$hash
    role TEXT NOT NULL,                  -- admin | user
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    expires_at REAL NOT NULL,
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);
"""

PBKDF2_ITERATIONS = 200_000


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt_hex, hash_hex = stored.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iters))
        return secrets.compare_digest(dk.hex(), hash_hex)
    except (ValueError, TypeError):
        return False


class Store:
    def __init__(self, path: Path | None = None):
        self.dir = DATA_DIR
        self.media = self.dir / "history"
        self.media.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path or self.dir / "printermonitor.db", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(SCHEMA)
        columns = {row["name"] for row in self.db.execute("PRAGMA table_info(prints)")}
        if "filament_breakdown" not in columns:
            self.db.execute("ALTER TABLE prints ADD COLUMN filament_breakdown TEXT")
        if "energy_start_kwh" not in columns:
            self.db.execute("ALTER TABLE prints ADD COLUMN energy_start_kwh REAL")
        if "energy_kwh" not in columns:
            self.db.execute("ALTER TABLE prints ADD COLUMN energy_kwh REAL")
        self.db.commit()

    # ---------- settings ----------
    def settings(self) -> dict[str, Any]:
        out = copy.deepcopy(DEFAULT_SETTINGS)
        for row in self.db.execute("SELECT key, value FROM settings"):
            out[row["key"]] = json.loads(row["value"])
        return out

    def update_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        for key, value in patch.items():
            if key not in DEFAULT_SETTINGS:
                raise ValueError(f"unknown setting: {key}")
            self.db.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value, ensure_ascii=False)),
            )
        self.db.commit()
        return self.settings()

    # ---------- history ----------
    def insert_print(self, **fields: Any) -> int:
        cols = ", ".join(fields)
        marks = ", ".join("?" for _ in fields)
        cur = self.db.execute(f"INSERT INTO prints ({cols}) VALUES ({marks})", tuple(fields.values()))
        self.db.commit()
        return int(cur.lastrowid)

    def update_print(self, pid: int, **fields: Any) -> None:
        if not fields:
            return
        if "filament_breakdown" in fields and fields["filament_breakdown"] is not None:
            fields["filament_breakdown"] = json.dumps(fields["filament_breakdown"], ensure_ascii=False)
        sets = ", ".join(f"{k} = ?" for k in fields)
        self.db.execute(f"UPDATE prints SET {sets} WHERE id = ?", (*fields.values(), pid))
        self.db.commit()

    def get_print(self, pid: int) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM prints WHERE id = ?", (pid,)).fetchone()
        return self._print_dict(row) if row else None

    @staticmethod
    def _print_dict(row: sqlite3.Row) -> dict[str, Any]:
        record = dict(row)
        try:
            record["filament_breakdown"] = json.loads(record["filament_breakdown"] or "null")
        except (TypeError, ValueError):
            record["filament_breakdown"] = None
        return record

    def running_print(self, printer_id: str) -> dict[str, Any] | None:
        row = self.db.execute(
            "SELECT * FROM prints WHERE printer_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1", (printer_id,)
        ).fetchone()
        return dict(row) if row else None

    def prints(self, printer_id: str | None = None, limit: int = 200, offset: int = 0) -> list[dict[str, Any]]:
        q, args = "SELECT * FROM prints", []
        if printer_id:
            q += " WHERE printer_id = ?"
            args.append(printer_id)
        q += " ORDER BY started_at DESC LIMIT ? OFFSET ?"
        args += [limit, offset]
        return [self._print_dict(r) for r in self.db.execute(q, args)]

    def delete_print(self, pid: int) -> None:
        row = self.get_print(pid)
        if not row:
            return
        for f in (row.get("thumb"), row.get("photo")):
            if f:
                (self.media / f).unlink(missing_ok=True)
        self.db.execute("DELETE FROM prints WHERE id = ?", (pid,))
        self.db.commit()

    def stats(self, months: int = 12) -> dict[str, Any]:
        """Totals per month (last 12) and overall, for finished prints whether successful or not."""
        rows = [dict(r) for r in self.db.execute(
            """SELECT strftime('%Y-%m', started_at, 'unixepoch', 'localtime') AS month,
                      COUNT(*) AS prints,
                      SUM(status = 'completed') AS completed,
                      SUM(status IN ('failed', 'stopped')) AS failed,
                      COALESCE(SUM(duration_s), 0) AS seconds,
                      COALESCE(SUM(filament_g), 0) AS grams,
                      COALESCE(SUM(cost_filament), 0) + COALESCE(SUM(cost_energy), 0) AS cost
               FROM prints WHERE status != 'running'
               GROUP BY month ORDER BY month DESC LIMIT ?""",
            (months,),
        )]
        per_printer = [dict(r) for r in self.db.execute(
            """SELECT printer_id, MAX(printer_name) AS printer_name, COUNT(*) AS prints,
                      SUM(status = 'completed') AS completed,
                      COALESCE(SUM(duration_s), 0) AS seconds,
                      COALESCE(SUM(filament_g), 0) AS grams,
                      COALESCE(SUM(cost_filament), 0) + COALESCE(SUM(cost_energy), 0) AS cost
               FROM prints WHERE status != 'running' GROUP BY printer_id"""
        )]
        return {"months": rows[::-1], "printers": per_printer}

    # ---------- maintenance ----------
    def print_hours(self, printer_id: str) -> float:
        row = self.db.execute(
            "SELECT COALESCE(SUM(duration_s), 0) FROM prints WHERE printer_id = ?", (printer_id,)
        ).fetchone()
        return row[0] / 3600

    def maintenance(self, printer_id: str) -> list[dict[str, Any]]:
        hours = self.print_hours(printer_id)
        done = {
            r["task_id"]: dict(r)
            for r in self.db.execute("SELECT * FROM maintenance WHERE printer_id = ?", (printer_id,))
        }
        out = []
        for task in self.settings()["maintenance"]:
            d = done.get(task["id"])
            since = hours - (d["done_hours"] if d else 0)
            out.append({
                **task,
                "since_hours": round(since, 1),
                "due": since >= task["hours"],
                "done_at": d["done_at"] if d else None,
            })
        return out

    def mark_done(self, printer_id: str, task_id: str) -> None:
        self.db.execute(
            "INSERT INTO maintenance(printer_id, task_id, done_hours, done_at) VALUES(?, ?, ?, ?) "
            "ON CONFLICT(printer_id, task_id) DO UPDATE SET done_hours = excluded.done_hours, done_at = excluded.done_at",
            (printer_id, task_id, self.print_hours(printer_id), time.time()),
        )
        self.db.commit()

    # ---------- users ----------
    def count_users(self) -> int:
        return int(self.db.execute("SELECT COUNT(*) FROM users").fetchone()[0])

    def admin_count(self) -> int:
        return int(self.db.execute("SELECT COUNT(*) FROM users WHERE role = 'admin'").fetchone()[0])

    def list_users(self) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT username, role, created_at FROM users ORDER BY created_at").fetchall()
        return [dict(r) for r in rows]

    def get_user(self, username: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        return dict(row) if row else None

    def create_user(self, username: str, password: str, role: str) -> None:
        self.db.execute(
            "INSERT INTO users(username, pw_hash, role, created_at) VALUES(?, ?, ?, ?)",
            (username, hash_password(password), role, time.time()),
        )
        self.db.commit()

    def verify_user(self, username: str, password: str) -> str | None:
        """Role of the user, or None if the credentials are wrong."""
        user = self.get_user(username)
        if not user or not verify_password(password, user["pw_hash"]):
            return None
        return user["role"]

    def set_password(self, username: str, password: str) -> None:
        self.db.execute("UPDATE users SET pw_hash = ? WHERE username = ?", (hash_password(password), username))
        self.db.commit()

    def set_role(self, username: str, role: str) -> None:
        self.db.execute("UPDATE users SET role = ? WHERE username = ?", (role, username))
        self.db.commit()

    def delete_user(self, username: str) -> None:
        self.delete_sessions(username)
        self.db.execute("DELETE FROM users WHERE username = ?", (username,))
        self.db.commit()

    # ---------- sessions ----------
    def create_session(self, username: str, ttl: float = 30 * 86400) -> str:
        token = secrets.token_urlsafe(32)
        self.db.execute("DELETE FROM sessions WHERE expires_at < ?", (time.time(),))
        self.db.execute(
            "INSERT INTO sessions(token, username, expires_at) VALUES(?, ?, ?)",
            (token, username, time.time() + ttl),
        )
        self.db.commit()
        return token

    def get_session(self, token: str) -> dict[str, Any] | None:
        row = self.db.execute(
            "SELECT u.username, u.role FROM sessions s JOIN users u ON u.username = s.username "
            "WHERE s.token = ? AND s.expires_at > ?",
            (token, time.time()),
        ).fetchone()
        return dict(row) if row else None

    def delete_session(self, token: str) -> None:
        self.db.execute("DELETE FROM sessions WHERE token = ?", (token,))
        self.db.commit()

    def delete_sessions(self, username: str) -> None:
        self.db.execute("DELETE FROM sessions WHERE username = ?", (username,))
        self.db.commit()
