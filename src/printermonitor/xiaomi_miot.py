"""Local MIoT client for Xiaomi Smart Plug 4.

Portions of this file are adapted from ``mini_miio.py`` in
https://github.com/al-one/hass-xiaomi-miot, used under the Apache License 2.0.
Changes include the synchronous request path and the Xiaomi Smart Plug 4
controls and energy-meter properties.

Only the public miIO packet format and the MIoT operations needed by this
application are implemented here.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import random
import socket
import struct
import time
from typing import Any

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


class XiaomiMiotError(RuntimeError):
    """The plug rejected a request or did not answer."""


def _key_iv(token: bytes) -> tuple[bytes, bytes]:
    key = hashlib.md5(token).digest()  # noqa: S324 - miIO protocol requirement
    return key, hashlib.md5(key + token).digest()  # noqa: S324


def _encrypt(payload: dict[str, Any], token: bytes) -> bytes:
    key, iv = _key_iv(token)
    raw = json.dumps(payload, separators=(",", ":")).encode() + b"\x00"
    padder = padding.PKCS7(128).padder()
    raw = padder.update(raw) + padder.finalize()
    encryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return encryptor.update(raw) + encryptor.finalize()


def _decrypt(raw: bytes, token: bytes) -> dict[str, Any]:
    key, iv = _key_iv(token)
    decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    padded = decryptor.update(raw) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    data = unpadder.update(padded) + unpadder.finalize()
    try:
        return json.loads(data.rstrip(b"\x00"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise XiaomiMiotError("小米插座返回了无法解析的数据，请检查 token") from exc


class XiaomiMiotPlug:
    """Small synchronous-protocol wrapper exposed through async methods."""

    PORT = 54321
    MODEL = "xiaomi.plug.04"
    SWITCH_ON = {"did": "switch:on", "siid": 2, "piid": 1}
    ENERGY_KWH = {"did": "power-consumption", "siid": 11, "piid": 1}
    POWER_W = {"did": "electric-power", "siid": 11, "piid": 2}
    ENERGY_STEP_KWH = 0.01

    def __init__(self, host: str, token: str, timeout: float = 4) -> None:
        try:
            self.token = bytes.fromhex(token.strip())
        except ValueError as exc:
            raise XiaomiMiotError("小米插座 token 必须是 32 位十六进制字符串") from exc
        if len(self.token) != 16:
            raise XiaomiMiotError("小米插座 token 必须是 32 位十六进制字符串")
        self.host = host
        self.timeout = timeout

    def _request_sync(self, method: str, params: Any) -> Any:
        hello = b"\x21\x31\x00\x20" + (b"\xff" * 28)
        last_error: Exception | None = None
        for _ in range(3):
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                    sock.settimeout(self.timeout)
                    sock.sendto(hello, (self.host, self.PORT))
                    try:
                        handshake, _ = sock.recvfrom(1024)
                    except TimeoutError as exc:
                        raise XiaomiMiotError(f"小米插座 {self.host} 握手无响应") from exc
                    if len(handshake) < 32 or handshake[:2] != b"!1":
                        raise XiaomiMiotError("小米插座握手失败")

                    device_id = int.from_bytes(handshake[8:12], "big")
                    clock_delta = time.time() - int.from_bytes(handshake[12:16], "big")
                    request_id = random.randrange(100_000_000, 1_000_000_000)
                    body = _encrypt(
                        {"id": request_id, "method": method, "params": params or []},
                        self.token,
                    )
                    header = struct.pack(
                        ">HHII I", 0x2131, 32 + len(body), 0, device_id,
                        int(time.time() - clock_delta),
                    )
                    checksum = hashlib.md5(header + self.token + body).digest()  # noqa: S324
                    sock.sendto(header + checksum + body, (self.host, self.PORT))
                    try:
                        response, _ = sock.recvfrom(10_240)
                    except TimeoutError as exc:
                        raise XiaomiMiotError(f"小米插座 {self.host} 命令无响应") from exc

                if len(response) < 32 or response[:2] != b"!1":
                    raise XiaomiMiotError("小米插座返回了无效数据")
                end = struct.unpack(">H", response[2:4])[0]
                encrypted = response[32:end]
                expected = hashlib.md5(response[:16] + self.token + encrypted).digest()  # noqa: S324
                if response[16:32] != expected:
                    raise XiaomiMiotError("小米插座 token 错误或校验失败")
                payload = _decrypt(encrypted, self.token)
                if payload.get("id") != request_id:
                    raise XiaomiMiotError("小米插座返回了不匹配的响应")
                if payload.get("error"):
                    raise XiaomiMiotError(str(payload["error"]))
                return payload.get("result")
            except (TimeoutError, OSError, XiaomiMiotError) as exc:
                last_error = exc

        if isinstance(last_error, XiaomiMiotError):
            raise last_error
        raise XiaomiMiotError(f"小米插座 {self.host} 无响应") from last_error

    async def state(self) -> bool:
        result = await asyncio.to_thread(self._request_sync, "get_properties", [self.SWITCH_ON])
        if not result or "value" not in result[0]:
            raise XiaomiMiotError("小米插座未返回开关状态")
        return bool(result[0]["value"])

    async def set_state(self, on: bool) -> None:
        result = await asyncio.to_thread(
            self._request_sync,
            "set_properties",
            [{**self.SWITCH_ON, "value": on}],
        )
        if result and result[0].get("code", 0) != 0:
            raise XiaomiMiotError(str(result))

    async def energy(self) -> dict[str, float | None]:
        """Read the plug's cumulative energy counter and instantaneous power."""
        result = await asyncio.to_thread(
            self._request_sync,
            "get_properties",
            [self.ENERGY_KWH, self.POWER_W],
        )
        values = {
            item.get("piid"): item.get("value")
            for item in (result or [])
            if isinstance(item, dict) and item.get("code", 0) == 0
        }
        try:
            raw_energy = float(values[1]) if values.get(1) is not None else None
            # xiaomi.plug.04 declares a 0.01 kWh step for this property.
            energy = raw_energy * self.ENERGY_STEP_KWH if raw_energy is not None else None
        except (TypeError, ValueError):
            energy = None
        try:
            power = float(values[2]) if values.get(2) is not None else None
        except (TypeError, ValueError):
            power = None
        if energy is None and power is None:
            raise XiaomiMiotError("小米插座未返回功耗数据")
        return {"energy_kwh": energy, "power_w": power}
