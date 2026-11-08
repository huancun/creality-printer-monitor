from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import secrets
import shutil
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import discovery, plugs
from .camera import BOUNDARY, CameraRelay
from .go2rtc import go2rtc
from .history import Tracker
from .printer import Printer, derive_state, safe_gcode_name
from .paths import CONFIG, MCP_TOKEN
from .store import Store
from . import mcp_server
from mcp.server.transport_security import TransportSecuritySettings

log = logging.getLogger("printermonitor")

# Built React frontend (frontend/dist), overridable for deployments that build
# the UI elsewhere. Falls back to <repo>/frontend/dist in a source checkout.
# The 3D viewer, printer model images and vendored three.js live in
# frontend/public/ and are copied into dist/ by the Vite build.
FRONTEND = Path(os.environ.get("PM_FRONTEND_DIST") or Path(__file__).resolve().parents[2] / "frontend" / "dist")
PASSWORD = os.environ.get("PM_PASSWORD", "")  # machine password (MCP, scripts): admin rights

printers: dict[str, Printer] = {}
cameras: dict[str, CameraRelay] = {}
clients: set[WebSocket] = set()
jobs: dict[str, dict[str, Any]] = {}
thumbs: dict[str, bytes | None] = {}  # thumbnail cache (printer URL -> PNG, None = missing)


# ---------- broadcast to browsers ----------
def _broadcast(msg: dict[str, Any]) -> None:
    text = json.dumps(msg, default=str)
    for ws in list(clients):
        asyncio.create_task(_safe_send(ws, text))


async def _safe_send(ws: WebSocket, text: str) -> None:
    try:
        await ws.send_text(text)
    except Exception:
        clients.discard(ws)


store: Store | None = None
tracker: Tracker | None = None
autooff: plugs.AutoOff | None = None
_maint_cache: dict[str, tuple[float, int]] = {}


def maintenance_due(pid: str) -> int:
    """Number of maintenance tasks due (cached for one minute)."""
    t, n = _maint_cache.get(pid, (0.0, 0))
    if store and time.monotonic() - t > 60:
        n = sum(1 for task in store.maintenance(pid) if task["due"])
        _maint_cache[pid] = (time.monotonic(), n)
    return n


def snapshot(p: Printer) -> dict[str, Any]:
    snap = p.snapshot()
    cam = cameras.get(p.id)
    snap["camera_status"] = cam.info() if cam else {"status": "idle", "error": None, "retry_at": None}
    snap["maintenance_due"] = maintenance_due(p.id)
    snap["plug_pending"] = autooff.pending.get(p.id) if autooff else None
    return snap


saved_ids: dict[str, tuple] = {}


def on_printer_update(p: Printer) -> None:
    if (p.model or p.mac) and saved_ids.get(p.id) != (p.model, p.mac):
        saved_ids[p.id] = (p.model, p.mac)
        save_config()
    if tracker:
        try:
            tracker.update(p)
        except Exception:
            log.exception("history: %s", p.name)
    _broadcast({"type": "printer", "printer": snapshot(p)})


def get_camera(p: Printer) -> CameraRelay:
    if p.id not in cameras:
        cameras[p.id] = CameraRelay(p, on_change=lambda: on_printer_update(p))
    return cameras[p.id]


def set_job(job_id: str, **fields: Any) -> None:
    jobs[job_id].update(fields)
    _broadcast({"type": "job", "job": jobs[job_id]})


# ---------- configuration ----------
def load_config() -> list[dict[str, str]]:
    if CONFIG.exists():
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    return []


def save_config() -> None:
    # The model is used to show the right picture even when the printer is off; the MAC,
    # to find it again if the router gives it another IP address.
    data = [
        {"id": p.id, "name": p.name, "host": p.host, **({"model": p.model} if p.model else {}), **({"mac": p.mac} if p.mac else {})}
        for p in printers.values()
    ]
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def add_printer(pid: str, name: str, host: str, model: str | None = None, mac: str | None = None) -> Printer:
    p = Printer(pid, name, host, on_printer_update)
    p.model, p.mac = model, mac
    printers[pid] = p
    p.start()
    return p


def get_printer(pid: str) -> Printer:
    if pid not in printers:
        raise HTTPException(404, "未知打印机")
    return printers[pid]


async def take_photo(p: Printer) -> bytes | None:
    """Camera photo (end of print)."""
    if p.camera_mode() == "webrtc":
        return await get_camera(p).snapshot(timeout=20)
    async with httpx.AsyncClient(timeout=8) as c:
        r = await c.get(p.snapshot_url())
        return r.content if r.status_code == 200 else None


def on_print_finished(p: Printer, record: dict[str, Any]) -> None:
    _maint_cache.pop(p.id, None)
    _broadcast({"type": "history", "printer": p.id, "status": record.get("status")})
    if record.get("status") == "completed" and autooff:
        autooff.schedule(p.id)


def printer_temp_state(pid: str) -> tuple[str, float | None]:
    p = printers.get(pid)
    if not p:
        return "offline", None
    try:
        nozzle = float(p.data.get("nozzleTemp"))
    except (TypeError, ValueError):
        nozzle = None
    return derive_state(p.data, p.online), nozzle


# ---------- MCP server (Claude) on /mcp/ ----------
def _mcp_allowed_hosts() -> list[str]:
    """Host names we accept requests for (protection against DNS rebinding)."""
    import socket

    hosts = {"localhost", "127.0.0.1", socket.gethostname()}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            hosts.add(info[4][0])
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("192.0.2.1", 9))
            hosts.add(sock.getsockname()[0])
    except OSError:
        pass
    hosts |= {h.strip() for h in os.environ.get("PM_MCP_HOSTS", "").split(",") if h.strip()}
    return sorted(f"{h}:*" for h in hosts) + sorted(hosts)


mcp = mcp_server.build(mcp_server.Client(f"http://127.0.0.1:{os.environ.get('PM_PORT', '8010')}"))
mcp_http = mcp.streamable_http_app(
    streamable_http_path="/",
    transport_security=TransportSecuritySettings(allowed_hosts=_mcp_allowed_hosts(), allowed_origins=[]),
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global store, tracker, autooff
    async with mcp.session_manager.run():
        async with _lifespan_inner():
            yield


@asynccontextmanager
async def _lifespan_inner():
    global store, tracker, autooff
    store = Store()
    _init_internal_token()
    tracker = Tracker(store, photo=take_photo, on_finish=on_print_finished)
    autooff = plugs.AutoOff(store.settings, printer_temp_state)
    config = load_config()
    for c in config:
        add_printer(c["id"], c["name"], c["host"], c.get("model"), c.get("mac"))
    if not config and not CONFIG.exists():
        asyncio.create_task(first_run_discovery())
    relocator = asyncio.create_task(relocate_loop())
    yield
    relocator.cancel()
    await asyncio.gather(*(c.close() for c in cameras.values()))
    await go2rtc.stop()
    await asyncio.gather(*(p.stop() for p in printers.values()))


app = FastAPI(title="Printer Monitor", lifespan=lifespan)


# ---------- login: session cookie for the browser, Basic/token for machines ----------
SESSION_COOKIE = "pm_session"
SESSION_TTL = 30 * 86400  # seconds
INTERNAL_TOKEN = ""  # machine token used by the MCP servers (see _init_internal_token)

# Reachable without a session: the login page and its API.
PUBLIC_PATHS = {
    "/login", "/setup", "/favicon.ico",
    "/api/auth/login", "/api/auth/setup", "/api/auth/need-setup",
}

# What a regular (read-only) user may GET: monitoring, jobs, temperature, recent
# prints. Everything else in the API — settings, discovery, users… — is admin-only.
_USER_GET_OK = (
    r"^/api/printers(?:/|$)",  # list, camera, snapshot, thumb, temps, files
    r"^/api/history(?:/|$)",   # recent prints and their media
    r"^/api/stats$",
    r"^/api/jobs/",
    r"^/api/auth/me$",
)


def _user_get_allowed(path: str) -> bool:
    if re.search(r"/(?:plug|maintenance)(?:/|$)", path):
        return False  # smart plugs and maintenance are admin features
    return any(re.match(p, path) for p in _USER_GET_OK)


def _init_internal_token() -> None:
    """Stable machine token stored next to the database, so the MCP servers (stdio
    and in-process) can call the API without a browser session."""
    global INTERNAL_TOKEN
    token = ""
    try:
        if MCP_TOKEN.exists():
            token = MCP_TOKEN.read_text(encoding="utf-8").strip()
        if not token:
            token = secrets.token_urlsafe(32)
            MCP_TOKEN.parent.mkdir(parents=True, exist_ok=True)
            MCP_TOKEN.write_text(token, encoding="utf-8")
            try:
                MCP_TOKEN.chmod(0o600)
            except OSError:
                pass
    except OSError as e:
        log.warning("cannot write %s (%s): the stdio MCP server will need PM_PASSWORD", MCP_TOKEN, e)
    INTERNAL_TOKEN = token or secrets.token_urlsafe(32)


# Failed logins: "ip|username" -> recent failure timestamps (brute-force protection).
_login_fails: dict[str, list[float]] = {}


def _fail_key(request: Request | WebSocket, username: str) -> str:
    host = request.client.host if request.client else "?"
    return f"{host}|{username.strip().lower()}"


def _throttled(key: str, limit: int = 8, window: float = 900) -> bool:
    now = time.time()
    hits = [t for t in _login_fails.get(key, []) if now - t < window]
    _login_fails[key] = hits
    return len(hits) >= limit


def _record_fail(key: str) -> None:
    _login_fails.setdefault(key, []).append(time.time())


def _identify(request: Request | WebSocket) -> dict[str, Any] | None:
    """Who is calling: session cookie (browser), Basic auth (PM_PASSWORD machine
    password or a database user) or the internal MCP token. None = not signed in."""
    token = request.cookies.get(SESSION_COOKIE)
    if token and store:
        user = store.get_session(token)
        if user:
            return user
    header = request.headers.get("authorization", "")
    if header.startswith("Basic "):
        try:
            name, _, pw = base64.b64decode(header[6:]).decode("utf-8", "replace").partition(":")
        except Exception:
            name, pw = "", ""
        if PASSWORD and secrets.compare_digest(pw, PASSWORD):
            return {"username": name or "api", "role": "admin"}
        if store and name:
            key = _fail_key(request, name)
            if not _throttled(key):
                role = store.verify_user(name, pw)
                if role:
                    _login_fails.pop(key, None)
                    return {"username": name, "role": role}
                _record_fail(key)
    if INTERNAL_TOKEN and secrets.compare_digest(request.headers.get("x-pm-token", ""), INTERNAL_TOKEN):
        return {"username": "mcp", "role": "admin"}
    return None


@app.middleware("http")
async def mcp_no_slash(request: Request, call_next):
    """`/mcp` and `/mcp/`: some clients (including `claude mcp add`) strip the trailing slash,
    and not all of them follow a redirect on a POST."""
    if request.scope["path"] == "/mcp":
        request.scope["path"] = "/mcp/"
        request.scope["raw_path"] = b"/mcp/"
    return await call_next(request)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    # Frontend static assets (bundles, 3D viewer, model images, vendored three.js)
    # are public so the login page can load without a session.
    if path in PUBLIC_PATHS or path.startswith(("/assets/", "/models/", "/vendor/")) or path in ("/viewer.js", "/viewer.css"):
        return await call_next(request)
    if path == "/mcp" or path.startswith("/mcp/"):
        # The MCP transport is restricted to allowed hosts (TransportSecurity); the tool
        # calls it makes back into the API authenticate with the internal token.
        return await call_next(request)
    ident = _identify(request)
    if ident is None:
        if request.method in ("GET", "HEAD") and not path.startswith("/api/"):
            return RedirectResponse("/login", 303)
        # Only challenge machines that actually sent credentials (browsers get the login page).
        headers = {"WWW-Authenticate": 'Basic realm="printermonitor"'} if request.headers.get("authorization") else {}
        return JSONResponse({"detail": "未登录或会话已过期"}, status_code=401, headers=headers)
    if ident["role"] != "admin":
        if request.method in ("GET", "HEAD"):
            if path.startswith("/api/") and not _user_get_allowed(path):
                return JSONResponse({"detail": "此功能仅管理员可用"}, status_code=403)
        elif not path.startswith("/api/auth/"):
            return JSONResponse({"detail": "普通用户为只读账户，无法执行此操作"}, status_code=403)
    request.state.user = ident
    return await call_next(request)


# ---------- login / account API ----------
class LoginIn(BaseModel):
    username: str
    password: str


class SetupIn(BaseModel):
    username: str
    password: str


def _clean_username(name: str) -> str:
    name = name.strip()
    if not re.fullmatch(r"[\w.\-]{2,32}", name):
        raise HTTPException(400, "用户名需为 2–32 个字符（中英文、数字、. - _）")
    return name


def _check_password(pw: str) -> None:
    if len(pw) < 6:
        raise HTTPException(400, "密码至少 6 位")


def _login_response(request: Request, username: str, role: str) -> JSONResponse:
    resp = JSONResponse({"username": username, "role": role})
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https"
    resp.set_cookie(SESSION_COOKIE, store.create_session(username), max_age=SESSION_TTL,
                    path="/", httponly=True, samesite="lax", secure=secure)
    return resp


def _spa_page() -> FileResponse:
    """The React single-page app: /login and /setup are rendered by the frontend itself."""
    index = FRONTEND / "index.html"
    if not index.exists():
        raise HTTPException(503, "前端未构建：请在 frontend/ 目录运行 npm install && npm run build")
    return FileResponse(index)


@app.get("/login")
@app.get("/setup")
async def page_login():
    """The login page switches itself to "create the first admin" when there is no user yet."""
    return _spa_page()


@app.get("/api/auth/need-setup")
async def api_need_setup():
    return {"setup": store.count_users() == 0}


@app.post("/api/auth/login")
async def api_login(body: LoginIn, request: Request):
    username = body.username.strip()
    key = _fail_key(request, username)
    if _throttled(key):
        raise HTTPException(429, "尝试次数过多，请 15 分钟后再试")
    role = store.verify_user(username, body.password) if username else None
    if not role:
        _record_fail(key)
        raise HTTPException(401, "用户名或密码错误")
    _login_fails.pop(key, None)
    log.info("login: %s (%s)", username, role)
    return _login_response(request, username, role)


@app.post("/api/auth/setup")
async def api_setup(body: SetupIn, request: Request):
    """First run: create the admin account, then sign in."""
    if store.count_users():
        raise HTTPException(409, "管理员已创建，请直接登录")
    username = _clean_username(body.username)
    _check_password(body.password)
    store.create_user(username, body.password, "admin")
    log.info("first admin created: %s", username)
    return _login_response(request, username, "admin")


@app.get("/api/auth/me")
async def api_me(request: Request):
    ident = _identify(request)
    if not ident:
        raise HTTPException(401, "未登录")
    return ident


@app.post("/api/auth/logout")
async def api_logout(request: Request):
    if token := request.cookies.get(SESSION_COOKIE):
        store.delete_session(token)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


# ---------- user management (admin) ----------
class UserIn(BaseModel):
    username: str
    password: str
    role: str = "user"


class UserPatch(BaseModel):
    password: str | None = None
    role: str | None = None


@app.get("/api/users")
async def api_users():
    return store.list_users()


@app.post("/api/users")
async def api_user_create(body: UserIn):
    if body.role not in ("admin", "user"):
        raise HTTPException(400, "角色无效")
    username = _clean_username(body.username)
    _check_password(body.password)
    if store.get_user(username):
        raise HTTPException(409, "用户名已存在")
    store.create_user(username, body.password, body.role)
    log.info("user created: %s (%s)", username, body.role)
    return {"ok": True}


@app.patch("/api/users/{username}")
async def api_user_update(username: str, body: UserPatch):
    user = store.get_user(username)
    if not user:
        raise HTTPException(404, "用户不存在")
    if body.role is None and not body.password:
        raise HTTPException(400, "没有要修改的内容")
    if body.role is not None:
        if body.role not in ("admin", "user"):
            raise HTTPException(400, "角色无效")
        if user["role"] == "admin" and body.role != "admin" and store.admin_count() <= 1:
            raise HTTPException(400, "至少保留一名管理员")
        store.set_role(username, body.role)
    if body.password:
        _check_password(body.password)
        store.set_password(username, body.password)
        store.delete_sessions(username)  # the user has to sign in again
    return {"ok": True}


@app.delete("/api/users/{username}")
async def api_user_delete(username: str):
    user = store.get_user(username)
    if not user:
        raise HTTPException(404, "用户不存在")
    if user["role"] == "admin" and store.admin_count() <= 1:
        raise HTTPException(400, "至少保留一名管理员")
    store.delete_user(username)
    log.info("user deleted: %s", username)
    return {"ok": True}


# ---------- API ----------
class PrinterIn(BaseModel):
    name: str
    host: str


class PrinterEdit(BaseModel):
    name: str | None = None
    host: str | None = None


class CommandIn(BaseModel):
    params: dict[str, Any]


class FileIn(BaseModel):
    name: str


@app.get("/api/printers")
async def api_printers():
    return [snapshot(p) for p in printers.values()]


@app.post("/api/printers")
async def api_add_printer(body: PrinterIn):
    host = body.host.strip().removeprefix("http://").rstrip("/")
    if not host:
        raise HTTPException(400, "缺少 IP 地址")
    p = add_printer(uuid.uuid4().hex[:8], body.name.strip() or host, host)
    save_config()
    on_printer_update(p)
    return snapshot(p)


@app.patch("/api/printers/{pid}")
async def api_edit_printer(pid: str, body: PrinterEdit):
    p = get_printer(pid)
    if body.name is not None and body.name.strip():
        p.name = body.name.strip()
    if body.host is not None:
        host = body.host.strip().removeprefix("http://").rstrip("/")
        if not host:
            raise HTTPException(400, "缺少 IP 地址")
        if host != p.host:
            if cam := cameras.pop(pid, None):
                await cam.close()
            p.set_host(host)
    save_config()
    on_printer_update(p)
    return snapshot(p)


@app.get("/api/discover")
async def api_discover():
    """Creality printers found on the network, with the matching printer from the list."""
    found = await discovery.scan()
    by_mac = {p.mac: p for p in printers.values() if p.mac}
    by_host = {p.host: p for p in printers.values()}
    for f in found:
        known = by_mac.get(f["mac"]) or by_host.get(f["host"])
        f["known_id"] = known.id if known else None
        f["known_name"] = known.name if known else None
    return found


async def first_run_discovery() -> None:
    """First launch: add every Creality printer found on the local network."""
    try:
        found = await discovery.scan()
    except Exception as e:
        log.warning("network scan failed: %s", e)
        found = []
    for f in found:
        if any(p.host == f["host"] or (f["mac"] and p.mac == f["mac"]) for p in printers.values()):
            continue
        name = f["model_name"] or "Creality"
        if f["mac"]:
            name += f" {f['mac'][-4:]}"
        p = add_printer(uuid.uuid4().hex[:8], name, f["host"], f["model"], f["mac"])
        on_printer_update(p)
    save_config()  # also written when empty, so the scan only runs once
    log.info("first launch: %d printer(s) added", len(found))


RELOCATE_EVERY = 120  # s


async def relocate_loop() -> None:
    """An offline printer whose MAC we know may simply be at another address."""
    while True:
        await asyncio.sleep(RELOCATE_EVERY)
        lost = {p.mac: p for p in printers.values() if not p.online and p.mac}
        if not lost:
            continue
        try:
            found = await discovery.scan()
        except Exception as e:
            log.warning("network scan failed: %s", e)
            continue
        for f in found:
            p = lost.get(f["mac"])
            if p and f["host"] != p.host:
                log.info("%s changed address: %s -> %s", p.name, p.host, f["host"])
                if cam := cameras.pop(p.id, None):
                    await cam.close()
                p.set_host(f["host"])
                save_config()
                on_printer_update(p)


@app.delete("/api/printers/{pid}")
async def api_remove_printer(pid: str):
    p = get_printer(pid)
    await p.stop()
    if cam := cameras.pop(pid, None):
        await cam.close()
    await go2rtc.remove_stream(pid)
    del printers[pid]
    save_config()
    _broadcast({"type": "removed", "id": pid})
    return {"ok": True}


@app.post("/api/printers/{pid}/command")
async def api_command(pid: str, body: CommandIn):
    try:
        await get_printer(pid).set(body.params)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    return {"ok": True}


@app.get("/api/printers/{pid}/files")
async def api_files(pid: str):
    try:
        files = await get_printer(pid).list_files()
    except (RuntimeError, asyncio.TimeoutError) as e:
        raise HTTPException(503, f"无法获取文件列表：{e or '请求超时'}")
    keep = ("name", "file_size", "create_time", "timeCost", "consumables", "material", "floorHeight")
    files = [{k: f.get(k) for k in keep} for f in files]
    return sorted(files, key=lambda f: f.get("create_time") or 0, reverse=True)


@app.post("/api/printers/{pid}/print")
async def api_print(pid: str, body: FileIn):
    try:
        await get_printer(pid).print_file(body.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    return {"ok": True}


@app.post("/api/printers/{pid}/delete")
async def api_delete(pid: str, body: FileIn):
    try:
        await get_printer(pid).delete_file(body.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    return {"ok": True}


@app.get("/api/printers/{pid}/camera")
async def api_camera(pid: str, request: Request):
    """Camera MJPEG stream, served by this server alone (also works remotely)."""
    p = get_printer(pid)
    if p.camera_mode() == "webrtc":
        cam = get_camera(p)
        return StreamingResponse(
            cam.stream(),
            media_type=f"multipart/x-mixed-replace; boundary={BOUNDARY}",
            headers={"Cache-Control": "no-store"},
        )
    client = httpx.AsyncClient(timeout=httpx.Timeout(10, read=30))
    try:
        upstream = await client.send(client.build_request("GET", p.camera_url()), stream=True)
    except httpx.HTTPError:
        await client.aclose()
        raise HTTPException(502, "摄像头无法连接")

    async def body():
        try:
            async for chunk in upstream.aiter_raw():
                if await request.is_disconnected():
                    break
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        body(),
        media_type=upstream.headers.get("content-type", "multipart/x-mixed-replace"),
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/printers/{pid}/snapshot")
async def api_snapshot(pid: str):
    """A single frame: for the grid thumbnails (no long-lived connection)."""
    p = get_printer(pid)
    if p.camera_mode() == "webrtc":
        jpeg = await get_camera(p).snapshot()
    else:
        try:
            async with httpx.AsyncClient(timeout=8) as c:
                r = await c.get(p.snapshot_url())
                r.raise_for_status()
                jpeg = r.content
        except httpx.HTTPError:
            jpeg = None
    if not jpeg:
        raise HTTPException(503, "摄像头不可用")
    return Response(jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.post("/api/printers/{pid}/camera/reset")
async def api_camera_reset(pid: str):
    p = get_printer(pid)
    if p.camera_mode() == "webrtc":
        try:
            await get_camera(p).reset()
        except RuntimeError as e:
            raise HTTPException(429, str(e))
    on_printer_update(p)
    return {"ok": True}


@app.post("/api/printers/{pid}/reboot")
async def api_reboot(pid: str):
    p = get_printer(pid)
    try:
        await p.reboot()
    except ValueError as e:
        raise HTTPException(409, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    if cam := cameras.get(pid):
        await cam.close()  # the printer is restarting: no point keeping the session
    return {"ok": True}


@app.get("/api/printers/{pid}/thumb")
async def api_thumb(pid: str, name: str):
    """G-code thumbnail, relayed from the printer and cached."""
    p = get_printer(pid)
    try:
        url = p.thumbnail_url(name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if url not in thumbs:
        try:
            async with httpx.AsyncClient(timeout=6) as c:
                r = await c.get(url)
            png = r.content if r.status_code == 200 and r.content[:4] == b"\x89PNG" else None
        except httpx.HTTPError:
            raise HTTPException(502, "无法连接打印机")
        if len(thumbs) > 500:
            thumbs.clear()
        thumbs[url] = png
    if not thumbs[url]:
        raise HTTPException(404, "没有可用的缩略图")
    return Response(thumbs[url], media_type="image/png", headers={"Cache-Control": "max-age=3600"})


@app.get("/api/jobs/{job_id}")
async def api_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "未知任务")
    return jobs[job_id]


@app.get("/api/printers/{pid}/temps")
async def api_temps(pid: str):
    """Temperature history (last 30 minutes, one sample every 5 s)."""
    return [list(t) for t in get_printer(pid).temps]


# ---------- history, statistics ----------
@app.get("/api/history")
async def api_history(printer: str | None = None, limit: int = 100, offset: int = 0):
    return store.prints(printer, min(limit, 500), offset)


@app.delete("/api/history/{rec_id}")
async def api_history_delete(rec_id: int):
    store.delete_print(rec_id)
    return {"ok": True}


@app.get("/api/history/media/{name}")
async def api_history_media(name: str):
    if not re.fullmatch(r"\d+_(thumb\.png|photo\.jpg)", name) or not (store.media / name).exists():
        raise HTTPException(404, "未找到")
    return FileResponse(store.media / name, headers={"Cache-Control": "max-age=86400"})


@app.get("/api/stats")
async def api_stats():
    return store.stats()


# ---------- settings ----------
@app.get("/api/settings")
async def api_settings():
    return {**store.settings(), "plug_types": plugs.TYPES}


@app.patch("/api/settings")
async def api_settings_update(patch: dict[str, Any]):
    try:
        settings = store.update_settings(patch)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if {"filaments", "energy", "default_filament"} & patch.keys():
        tracker.recompute_costs()
    _maint_cache.clear()
    return {**settings, "plug_types": plugs.TYPES}


# ---------- maintenance ----------
@app.get("/api/printers/{pid}/maintenance")
async def api_maintenance(pid: str):
    get_printer(pid)
    return {"hours": round(store.print_hours(pid), 1), "tasks": store.maintenance(pid)}


@app.post("/api/printers/{pid}/maintenance/{task_id}")
async def api_maintenance_done(pid: str, task_id: str):
    p = get_printer(pid)
    store.mark_done(pid, task_id)
    _maint_cache.pop(pid, None)
    on_printer_update(p)
    return {"hours": round(store.print_hours(pid), 1), "tasks": store.maintenance(pid)}


# ---------- smart plug ----------
class PlugIn(BaseModel):
    on: bool


@app.get("/api/printers/{pid}/plug")
async def api_plug(pid: str):
    get_printer(pid)
    cfg = store.settings()["plugs"].get(pid)
    if not cfg or not cfg.get("host"):
        return {"configured": False}
    try:
        on = await plugs.get_state(cfg)
    except Exception as e:
        return {"configured": True, "reachable": False, "error": str(e) or type(e).__name__, **cfg}
    return {"configured": True, "reachable": True, "on": on, "pending": autooff.pending.get(pid), **cfg}


@app.post("/api/printers/{pid}/plug")
async def api_plug_set(pid: str, body: PlugIn):
    p = get_printer(pid)
    cfg = store.settings()["plugs"].get(pid)
    if not cfg or not cfg.get("host"):
        raise HTTPException(400, "此打印机尚未配置智能插座")
    if not body.on and derive_state(p.data, p.online) in plugs.BUSY:
        raise HTTPException(409, "打印正在进行中，无法关闭智能插座")
    autooff.cancel(pid)
    try:
        await plugs.set_state(cfg, body.on)
    except Exception as e:
        raise HTTPException(502, f"无法连接智能插座：{e}")
    return {"ok": True}


# ---------- send G-code (one or more printers) ----------
@app.post("/api/send")
async def api_send(
    printers_ids: str = Form(..., alias="printers"),
    start: bool = Form(False),
    color_mapping: str | None = Form(None),
    file: UploadFile | None = File(None),
):
    """Send an uploaded G-code file to one or more printers."""
    targets = [get_printer(pid) for pid in dict.fromkeys(x for x in printers_ids.split(",") if x)]
    if not targets:
        raise HTTPException(400, "请至少选择一台打印机。")
    if file is None:
        raise HTTPException(400, "请选择 .gcode 文件")
    name = Path(file.filename or "file.gcode").name
    if Path(name).suffix.lower() != ".gcode":
        raise HTTPException(400, "仅支持上传 .gcode 文件")
    mapping = []
    if color_mapping:
        try:
            mapping = json.loads(color_mapping)
        except json.JSONDecodeError as e:
            raise HTTPException(400, "耗材颜色映射格式无效") from e
        if not isinstance(mapping, list) or any(not isinstance(item, dict) for item in mapping):
            raise HTTPException(400, "耗材颜色映射格式无效")
    try:
        name = safe_gcode_name(name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if start:
        busy = [p.name for p in targets if derive_state(p.data, p.online) in plugs.BUSY or not p.online]
        if busy:
            raise HTTPException(409, f"以下打印机当前不可用：{', '.join(busy)}")
    workdir = Path(tempfile.mkdtemp(prefix="pm-send-"))
    src = workdir / "upload.gcode"
    try:
        with src.open("wb") as fh:
            shutil.copyfileobj(file.file, fh)
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        raise
    job_id = uuid.uuid4().hex[:10]
    jobs[job_id] = {
        "id": job_id, "kind": "send", "file": name, "step": "uploading", "error": None, "start": start,
        "color_mapping": mapping,
        "targets": {p.id: {"name": p.name, "step": "queued", "error": None} for p in targets},
        "printer": targets[0].id if len(targets) == 1 else None,
    }
    asyncio.create_task(_send_job(job_id, targets, src, name, start, workdir))
    return jobs[job_id]


async def _send_one(job_id: str, p: Printer, src: Path, name: str, start: bool, mapping: list[dict[str, Any]]) -> None:
    t = jobs[job_id]["targets"][p.id]
    try:
        t["step"] = "uploading"
        set_job(job_id)
        await p.upload(src, name)
        if mapping:
            await p.color_match(name, mapping)
        if start:
            t["step"] = "starting"
            set_job(job_id)
            await asyncio.sleep(1)  # let the printer index the file
            if not p.files:
                try:
                    await p.list_files()  # to find the exact G-code folder
                except Exception:
                    pass
                await (p.multi_color_print(name) if mapping else p.print_file(name))
        t["step"] = "done"
    except Exception as e:
        log.exception("upload %s -> %s", name, p.name)
        t["step"], t["error"] = "error", str(e) or type(e).__name__


async def _send_job(job_id: str, targets: list[Printer], src: Path, name: str, start: bool, workdir: Path) -> None:
    try:
        mapping = jobs[job_id].get("color_mapping") or []
        await asyncio.gather(*(_send_one(job_id, p, src, name, start, mapping) for p in targets))
        errors_ = [f"{t['name']}: {t['error']}" for t in jobs[job_id]["targets"].values() if t["error"]]
        set_job(job_id, step="error" if errors_ else "done", gcode=name, error="\n".join(errors_) or None)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


@app.post("/api/printers/{pid}/upload")
async def api_upload(pid: str, file: UploadFile = File(...), start: bool = Form(False)):
    """Upload a .gcode from a printer's view (shortcut for /api/send)."""
    return await api_send(printers_ids=pid, start=start, file=file)


@app.websocket("/api/ws")
async def ws_endpoint(ws: WebSocket):
    if _identify(ws) is None:
        # Browsers resend the session cookie on the same-origin WebSocket.
        await ws.close(code=4401)
        return
    await ws.accept()
    clients.add(ws)
    await ws.send_text(json.dumps({"type": "init", "printers": [snapshot(p) for p in printers.values()]}, default=str))
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)


@app.get("/")
async def index():
    return _spa_page()


app.mount("/mcp", mcp_http)
# Everything else in dist/ (assets/, models/, viewer.js, vendor/, …) — registered
# last so the API routes above always win.
app.mount("/", StaticFiles(directory=FRONTEND, check_dir=False), name="frontend")
