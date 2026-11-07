"""STL/3MF -> G-code slicing with Creality Print's command line.

Creality Print's recent releases contain the K3 multi-nozzle and multi-colour
profiles. Profiles come from its system profiles; nothing needs to be exported
by hand.

System profiles only store their differences from a parent (`inherits`), and
the command line does NOT resolve that inheritance (density 0, wrong
temperatures…): so we "flatten" them before passing them on.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import platform
import re
import shutil
import sys
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

import httpx

from .paths import DATA_DIR

CREALITY_DIR = DATA_DIR / "creality-print"
VENDOR = "Creality"
CREALITY_RELEASES_API = "https://api.github.com/repos/CrealityOfficial/CrealityPrint/releases/latest"

# Firmware model codes can also be passed directly by callers that have not
# gone through Printer.snapshot().  Creality Print profile names vary slightly
# between releases, so machine_name() matches their normalized form below.
MODEL_ALIASES = {
    "F039": "K3",
}

install_state: dict[str, Any] = {"step": None, "progress": 0, "error": None}


# ---------- installation ----------
def find_creality_binary() -> str | None:
    if env := os.environ.get("CREALITY_PRINT"):
        return env if Path(env).exists() or shutil.which(env) else None
    for b in ("creality-print", "CrealityPrint", "crealityprint", "Creality Print"):
        if p := shutil.which(b):
            return p
    for p in (
        CREALITY_DIR / "squashfs-root" / "AppRun",
        CREALITY_DIR / "CrealityPrint",
        CREALITY_DIR / "CrealityPrint.AppImage",
        Path("/usr/bin/CrealityPrint"),
        Path("/opt/CrealityPrint/CrealityPrint"),
        Path("/Applications/Creality Print.app/Contents/MacOS/Creality Print"),
        Path(os.environ.get("ProgramFiles", r"C:\\Program Files")) / "Creality Print" / "CrealityPrint.exe",
    ):
        if p.exists():
            return str(p)
    return None


def find_binary() -> str | None:
    return find_creality_binary()


def can_install() -> bool:
    """The automatic installer targets the official Linux x86-64 AppImage."""
    return sys.platform.startswith("linux") and platform.machine().lower() in ("x86_64", "amd64")


def profiles_dir() -> Path | None:
    candidates = [
        CREALITY_DIR / "squashfs-root" / "resources" / "profiles",
        CREALITY_DIR / "resources" / "profiles",
        Path("/usr/share/CrealityPrint/resources/profiles"),
        Path("/usr/share/creality-print/resources/profiles"),
        Path("/opt/CrealityPrint/resources/profiles"),
    ]
    if b := find_binary():
        exe = Path(b).resolve()
        candidates[:0] = [
            exe.parent / "resources" / "profiles",
            exe.parent.parent / "resources" / "profiles",
            exe.parent.parent / "Resources" / "profiles",  # macOS .app bundle
        ]
    return next((c for c in candidates if (c / VENDOR).is_dir()), None)


async def install(on_change: Callable[[], None] = lambda: None) -> None:
    if install_state["step"] in ("download", "extract"):
        return
    if not can_install():
        install_state.update(step="error", progress=0, error="自动安装 Creality Print 仅支持 Linux x86-64：请手动安装并将 CREALITY_PRINT 指向其可执行文件")
        on_change()
        return
    await _install_creality(on_change)


async def _install_creality(on_change: Callable[[], None]) -> None:
    """Install the latest official Creality Print Linux AppImage."""
    install_state.update(step="download", progress=0, error=None)
    on_change()
    CREALITY_DIR.mkdir(parents=True, exist_ok=True)
    image: Path | None = None
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(30, read=120), headers={"Accept": "application/vnd.github+json"}) as client:
            release = (await client.get(CREALITY_RELEASES_API)).raise_for_status()
            data = release.json()
            tag = str(data.get("tag_name") or "").strip()
            if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
                raise RuntimeError("GitHub latest release has an invalid tag")
            version = tag[1:]
            assets = data.get("assets") or []
            asset = next(
                (
                    item for item in assets
                    if re.fullmatch(
                        rf"CrealityPrint-V{re.escape(version)}(?:\.\d+)?-x86_64-Release\.AppImage",
                        str(item.get("name") or ""),
                    )
                ),
                None,
            )
            if not asset or not asset.get("browser_download_url"):
                raise RuntimeError(f"latest release {tag} has no Linux x86_64 AppImage")
            image = CREALITY_DIR / str(asset["name"])
            checksum_asset = next(
                (
                    item for item in assets
                    if str(item.get("name") or "").lower() in {
                        f"{image.name}.sha256".lower(),
                        "sha256sums.txt",
                        "checksums.txt",
                    }
                ),
                None,
            )
            checksum_text = None
            if checksum_asset and checksum_asset.get("browser_download_url"):
                checksum_text = (await client.get(checksum_asset["browser_download_url"])).text
            h = hashlib.sha256()
            async with client.stream("GET", asset["browser_download_url"]) as response:
                response.raise_for_status()
                total = int(response.headers.get("content-length") or 0)
                done, last = 0, -1
                with image.open("wb") as fh:
                    async for chunk in response.aiter_bytes(1 << 20):
                        fh.write(chunk)
                        h.update(chunk)
                        done += len(chunk)
                        pct = int(done * 100 / total) if total else 0
                        if pct != last:
                            install_state["progress"], last = pct, pct
                            on_change()
            if checksum_text:
                expected = next(
                    (
                        match.group(1).lower()
                        for line in checksum_text.splitlines()
                        if image.name in line
                        for match in [re.search(r"\b([0-9a-fA-F]{64})\b", line)]
                        if match
                    ),
                    None,
                )
                if expected and h.hexdigest().lower() != expected:
                    raise RuntimeError("invalid checksum: file rejected")
        install_state.update(step="extract", progress=100)
        on_change()
        image.chmod(0o755)
        shutil.rmtree(CREALITY_DIR / "squashfs-root", ignore_errors=True)
        proc = await asyncio.create_subprocess_exec(
            str(image), "--appimage-extract", cwd=CREALITY_DIR,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0 or not (CREALITY_DIR / "squashfs-root" / "AppRun").exists():
            raise RuntimeError(f"extraction failed: {err.decode(errors='replace')[-300:]}")
        _index.cache_clear()
        install_state.update(step="done")
    except Exception as e:
        install_state.update(step="error", error=str(e) or type(e).__name__)
    finally:
        if image:
            image.unlink(missing_ok=True)
        on_change()


# ---------- profiles ----------
@lru_cache(maxsize=1)
def _index() -> dict[tuple[str, str], Path]:
    """Map each Creality Print profile name to its JSON file."""
    root = profiles_dir()
    idx: dict[tuple[str, str], Path] = {}
    if not root:
        return idx
    for d in (root / "OrcaFilamentLibrary", root / VENDOR):  # Some Creality Print releases retain this directory name.
        for f in d.rglob("*.json"):
            try:
                j = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            if isinstance(j, dict) and "name" in j and "type" in j:
                idx[(j["type"], j["name"])] = f
    return idx


def flatten(kind: str, name: str) -> dict[str, Any]:
    """Full profile: start from the root ancestor, each child overrides its parent's keys."""
    idx = _index()
    if (kind, name) not in idx:
        raise ValueError(f"profile not found: {name}")
    leaf = json.loads(idx[(kind, name)].read_text(encoding="utf-8"))
    chain, cur = [leaf], leaf
    while parent := cur.get("inherits"):
        if (kind, parent) not in idx:
            raise ValueError(f"parent profile not found: {parent}")
        cur = json.loads(idx[(kind, parent)].read_text(encoding="utf-8"))
        chain.append(cur)
    merged: dict[str, Any] = {}
    for p in reversed(chain):
        merged.update(p)
    merged.pop("inherits", None)
    for k in ("name", "from", "instantiation", "setting_id"):
        if k in leaf:
            merged[k] = leaf[k]
    return merged


def machine_name(model: str | None, nozzle: str = "0.4") -> str | None:
    """Resolve a Creality Print machine profile for a printer model."""
    if not model:
        return None

    model = MODEL_ALIASES.get(model.upper(), model).strip()
    idx = _index()

    # Creality Print uses both plain and parenthesized nozzle names.  Keep the
    # exact lookup first because it is deterministic and handles the common
    # profile names without inspecting unrelated profiles.
    candidates = []
    for prefix in ("", "Creality "):
        candidates.extend((
            f"{prefix}{model} {nozzle} nozzle",
            f"{prefix}{model} ({nozzle} nozzle)",
        ))
    for candidate in candidates:
        if ("machine", candidate) in idx:
            return candidate

    def compact(value: str) -> str:
        return re.sub(r"[^a-z0-9.]", "", value.lower())

    def words(value: str) -> str:
        return re.sub(r"[^a-z0-9.]+", " ", value.lower()).strip()

    model_words = words(model)
    nozzle_key = compact(nozzle)
    for kind, name in idx:
        if kind != "machine":
            continue
        key = words(name)
        # Accept release-specific punctuation/prefix differences, but require
        # both the complete model token and the requested nozzle size.  This
        # prevents K3 from accidentally selecting K3 Pro or another nozzle.
        if re.search(rf"(?:^| ){re.escape(model_words)}(?: |$)", key) and re.search(
            rf"(?:^| ){re.escape(nozzle_key)} nozzle(?: |$)", key
        ):
            return name
    return None


def catalog(model: str | None) -> dict[str, Any]:
    """Process (quality) and filament profiles compatible with this model (0.4 nozzle)."""
    machine = machine_name(model)
    if not machine:
        return {"machine": None, "processes": [], "filaments": []}
    processes, filaments = [], []
    for (kind, name), path in _index().items():
        if kind not in ("process", "filament"):
            continue
        try:
            j = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        # Only "final" profiles that declare this machine model.
        if j.get("instantiation") != "true" or machine not in (j.get("compatible_printers") or []):
            continue
        (processes if kind == "process" else filaments).append(name)

    def layer(n: str) -> float:
        try:
            return float(n.split("mm")[0])
        except ValueError:
            return 9.0

    processes.sort(key=layer)
    filaments.sort(key=lambda n: (not n.startswith(("Creality Generic", "Generic")), n))
    return {"machine": machine, "processes": processes, "filaments": filaments}


def status() -> dict[str, Any]:
    binary = find_binary()
    return {"backend": "creality", "available": binary is not None, "binary": binary, "can_install": can_install(), "install": install_state}


# ---------- slicing ----------
def inject_thumbnails(gcode: Path, pngs: list[bytes]) -> None:
    """Creality Print's CLI cannot render thumbnails headless: insert the ones rendered
    by the browser, in the format Klipper/Creality expect."""
    import struct

    blocks = []
    for png in pngs:
        w, h = struct.unpack(">II", png[16:24])  # IHDR header
        b64 = base64.b64encode(png).decode()
        lines = [b64[i:i + 78] for i in range(0, len(b64), 78)]
        blocks.append(
            f"; thumbnail begin {w}x{h} {len(b64)}\n" + "".join(f"; {l}\n" for l in lines) + "; thumbnail end\n;\n"
        )
    text = gcode.read_text(encoding="utf-8", errors="replace")
    marker = "; HEADER_BLOCK_END\n"
    i = text.find(marker)
    i = i + len(marker) if i >= 0 else 0
    gcode.write_text(text[:i] + "\n" + "".join(blocks) + text[i:], encoding="utf-8")


async def slice_model(model_file: Path, machine: str, process: str, filament: str, workdir: Path) -> Path:
    binary = find_binary()
    if not binary:
        raise RuntimeError("Creality Print is not installed: install it in Settings, or upload a .gcode.")
    paths = {}
    for kind, name in (("machine", machine), ("process", process), ("filament", filament)):
        p = workdir / f"{kind}.json"
        p.write_text(json.dumps(flatten(kind, name)), encoding="utf-8")
        paths[kind] = p
    outdir = workdir / "out"
    outdir.mkdir()
    env = {k: v for k, v in os.environ.items() if k not in ("DISPLAY", "WAYLAND_DISPLAY")}
    # Creality Print uses underscores in these documented CLI options.
    args = [
        "--slice", "0", "--outputdir", str(outdir),
        "--load_settings", f"{paths['machine']};{paths['process']}",
        "--load_filaments", str(paths["filament"]), str(model_file),
    ]
    proc = await asyncio.create_subprocess_exec(
        binary, *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        env=env, cwd=workdir,
    )
    await asyncio.wait_for(proc.wait(), timeout=900)
    result = {}
    with_result = outdir / "result.json"
    if with_result.exists():
        result = json.loads(with_result.read_text(encoding="utf-8"))
    gcodes = sorted(outdir.glob("*.gcode"))
    if not gcodes or result.get("return_code", 0) != 0:
        msg = result.get("error_string") or f"code {proc.returncode}"
        if "empty" in msg or "fully inside" in msg:
            msg = "the model doesn't fit on the bed (or it is empty)"
        raise RuntimeError(f"slicing failed: {msg}")
    return gcodes[0]


def new_workdir() -> Path:
    return Path(tempfile.mkdtemp(prefix="pm-slice-"))
