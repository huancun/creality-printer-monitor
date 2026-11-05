"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const printers = new Map();
let current = null; // id of the printer open in the detail view
let slicer = { available: false, profiles: [] };
let files = [];
const jobs = new Map();

// signed-in user, filled in by boot() from /api/auth/me
let ME = { username: null, role: "user" };
const isAdmin = () => ME.role === "admin";

const STATE_LABEL = {
  offline: "离线", idle: "就绪", printing: "打印中", paused: "已暂停",
  completed: "已完成", stopped: "已停止", error: "错误", processing: "准备中",
  self_test: "自检中",
};
const STEP_LABEL = {
  queued: "排队中", slicing: "切片中…", uploading: "上传中…",
  starting: "启动中…", done: "已发送", error: "失败",
};
const BUSY = new Set(["printing", "paused", "processing", "self_test"]);
const ACTIVE = new Set([...BUSY, "completed"]);

// ---------- utilities ----------
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const deg = (v) => { const n = num(v); return n === null ? "—" : `${Math.round(n)}°`; };
const dur = (s) => {
  s = num(s);
  if (s === null || s < 0) return "—";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} 小时 ${String(m).padStart(2, "0")} 分钟` : `${m} 分钟`;
};
const clock = (secondsFromNow) => {
  const s = num(secondsFromNow);
  if (s === null || s <= 0) return null;
  const end = new Date(Date.now() + s * 1000);
  const sameDay = end.toDateString() === new Date().toDateString();
  const hm = end.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? hm : `明天 ${hm}`;
};
const progress = (d) => Math.max(0, Math.min(100, num(d.printProgress ?? d.dProgress) ?? 0));
const baseName = (path) => String(path || "").split("/").pop();
const prettyName = (name) => baseName(name).replace(/\.gcode$/i, "").replace(/_/g, " ");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const thumbUrl = (id, name) => `/api/printers/${id}/thumb?name=${encodeURIComponent(baseName(name))}`;
const modelUrl = (p) => `/static/models/${encodeURIComponent(p.model_code || "unknown")}.webp`;
// Creality colors: "#0ffff00" -> keep the last 6 hex digits.
const color = (c) => { const m = String(c || "").match(/([0-9a-f]{6})$/i); return m ? `#${m[1]}` : "#888"; };

function filaments(d) {
  const boxes = d.boxsInfo?.materialBoxs || [];
  const out = [];
  for (const box of boxes) {
    for (const m of box.materials || []) {
      if (m.state === 0 && box.type !== 1) continue; // empty CFS slot
      out.push({ ...m, box: box.id, external: box.type === 1, color: color(m.color) });
    }
  }
  return out;
}

function toast(msg, isError = false) {
  const t = document.createElement("div");
  t.className = "toast" + (isError ? " error" : "");
  t.textContent = msg;
  $("#toasts").append(t);
  setTimeout(() => t.remove(), isError ? 7000 : 3500);
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401) {
    location.href = "/login";
    throw new Error("未登录");
  }
  if (!r.ok) throw new Error(body.detail || `错误 ${r.status}`);
  return body;
}

async function command(params, okMsg, id = current) {
  try {
    await api(`/api/printers/${id}/command`, { method: "POST", body: JSON.stringify({ params }) });
    if (okMsg) toast(okMsg);
  } catch (e) { toast(e.message, true); }
}
const gcode = (cmd, okMsg) => command({ gcodeCmd: cmd }, okMsg);

// ---------- camera ----------
// Browsers allow only 6 concurrent connections to the same server, and an MJPEG stream
// holds one permanently: the grid shows refreshed snapshots and only the detail view
// opens a continuous stream. Otherwise clicks would stay pending.
const SNAPSHOT_MS = 2000;

function setCam(cam, p, live = false) {
  const img = $("img", cam);
  const want = p.online ? `/api/printers/${p.id}/${live ? "camera" : "snapshot"}` : "";
  if (img.dataset.src === want) return; // don't restart on every update
  img.dataset.src = want;
  clearTimeout(img._timer);
  if (!want) { img.removeAttribute("src"); cam.classList.add("off"); return; }
  img.onload = () => {
    cam.classList.remove("off");
    if (!live) img._timer = setTimeout(() => img.dataset.src === want && (img.src = want + "?t=" + Date.now()), SNAPSHOT_MS);
  };
  img.onerror = () => {
    cam.classList.add("off");
    img._timer = setTimeout(() => img.dataset.src === want && (img.src = want + "?t=" + Date.now()), 5000);
  };
  img.src = want + "?t=" + Date.now();
}

function stopCam(cam) {
  const img = $("img", cam);
  clearTimeout(img._timer);
  img.onload = img.onerror = null;
  img.removeAttribute("src"); // closes the stream connection
  img.dataset.src = "";
}

function camElements(id) {
  const els = [];
  const card = $(`.pcard[data-id="${id}"] .cam`);
  if (card) els.push(card);
  if (current === id) els.push($("#d-cam").parentElement);
  return els;
}

// Depending on the browser, an MJPEG stream doesn't always fire "load".
setInterval(() => {
  for (const img of $$(".cam img")) {
    if (img.dataset.src && img.naturalWidth > 0) img.parentElement.classList.remove("off");
  }
}, 1000);

function setThumb(img, id, name) {
  const want = name ? thumbUrl(id, name) : "";
  if (img.dataset.src === want) return;
  img.dataset.src = want;
  img.onerror = () => img.removeAttribute("src");
  if (want) img.src = want; else img.removeAttribute("src");
}

// ---------- summary & grid ----------
function renderSummary() {
  const list = [...printers.values()];
  const count = (f) => list.filter(f).length;
  const chips = [
    [count((p) => p.state === "printing" || p.state === "processing"), "打印中"],
    [count((p) => p.state === "paused"), "已暂停"],
    [count((p) => p.state === "idle" || p.state === "completed"), "就绪"],
    [count((p) => p.state === "error" || p.error), "需要处理"],
    [count((p) => !p.online), "离线"],
  ].filter(([n]) => n);
  $("#summary").innerHTML = chips.map(([n, label]) => `<span class="chip"><b>${n}</b> ${label}</span>`).join("");
}

function cardHTML(p) {
  return `
    <article class="pcard" data-id="${esc(p.id)}" tabindex="0">
      <div class="media">
        <div class="cam off"><img alt=""><span class="cam-off"></span></div>
        <img class="model" alt="" src="${modelUrl(p)}" onerror="this.remove()">
        <span class="pill"></span>
        <div class="bar"><div></div></div>
      </div>
      <div class="pcard-body">
        <div class="pcard-head"><h2></h2><span class="sub"></span></div>
        <div class="perr" hidden></div>
        <div class="pjob"></div>
        <div class="pfoot"></div>
      </div>
    </article>`;
}

function renderCard(p) {
  let el = $(`.pcard[data-id="${CSS.escape(p.id)}"]`);
  if (!el) {
    $("#grid .empty")?.remove();
    $("#grid").insertAdjacentHTML("beforeend", cardHTML(p));
    el = $(`.pcard[data-id="${CSS.escape(p.id)}"]`);
    el.addEventListener("click", () => openDetail(p.id));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(p.id); } });
  }
  const d = p.data || {};
  el.dataset.state = p.state;
  $("h2", el).textContent = p.name;
  $(".sub", el).textContent = p.model || p.host;
  const pill = $(".pill", el);
  pill.textContent = STATE_LABEL[p.state] || p.state;
  pill.dataset.state = p.state;
  const active = ACTIVE.has(p.state);
  $(".media .bar > div", el).style.width = (active ? progress(d) : 0) + "%";

  const perr = $(".perr", el);
  perr.hidden = !p.error;
  if (p.error) {
    perr.className = "perr " + (p.error.level === "warning" ? "warning" : "");
    perr.textContent = p.error.title;
  }

  const job = $(".pjob", el);
  if (active && d.printFileName) {
    const eta = clock(d.printLeftTime);
    const key = d.printFileName + "|" + p.id;
    if (job.dataset.key !== key) {
      job.dataset.key = key;
      job.innerHTML = `<div class="thumb"><img alt=""></div><div class="info"><div class="fname"></div><div class="meta"></div></div><div class="pct"></div>`;
      setThumb($(".thumb img", job), p.id, d.printFileName);
    }
    $(".fname", job).textContent = prettyName(d.printFileName);
    $(".meta", job).textContent = p.state === "completed" ? "已完成"
      : [eta && `预计完成 ${eta}`, d.TotalLayer && `图层 ${d.layer ?? 0}/${d.TotalLayer}`].filter(Boolean).join(" · ");
    $(".pct", job).innerHTML = `${Math.round(progress(d))}<small>%</small>`;
  } else {
    job.dataset.key = "";
    job.innerHTML = `<div class="info"><div class="meta">${p.online ? "当前没有打印任务" : "无法连接打印机 — " + esc(p.host)}</div></div>`;
  }

  const fil = filaments(d)[0];
  $(".pfoot", el).innerHTML = p.online ? `
    <span class="chip"><span class="tag-noz">喷嘴</span> ${deg(d.nozzleTemp)}${num(d.targetNozzleTemp) ? ` / ${deg(d.targetNozzleTemp)}` : ""}</span>
    <span class="chip"><span class="tag-bed">热床</span> ${deg(d.bedTemp0)}${num(d.targetBedTemp0) ? ` / ${deg(d.targetBedTemp0)}` : ""}</span>
    ${fil ? `<span class="chip"><span class="swatch" style="background:${fil.color}"></span>${esc(fil.type || fil.name)}</span>` : ""}` : "";
  $(".pfoot", el).insertAdjacentHTML("beforeend",
    (p.maintenance_due ? `<span class="chip warn" title="有维护项目到期">🔧 维护提醒 (${p.maintenance_due})</span>` : "") +
    (p.plug_pending ? `<span class="chip" title="${esc(p.plug_pending)}">⏻ 已安排断电</span>` : ""));
  if (view === "printers") setCam($(".cam", el), p);
}

function renderEmpty() {
  if (printers.size) { $("#grid .empty")?.remove(); return; }
  const hint = isAdmin() ? "点击“+ 添加打印机”，输入打印机屏幕上显示的 IP 地址。" : "暂无打印机，请联系管理员添加。";
  $("#grid").innerHTML = `<div class="empty"><h2>尚未添加打印机</h2><p>${hint}</p></div>`;
}

// ---------- navigation ----------
const VIEWS = ["printers", "history", "wall", "settings"];
let view = "printers";

function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  const target = VIEWS.includes(h) && (h !== "settings" || isAdmin()) ? h : "printers";
  if (target !== view || !route.done) showView(target);
  route.done = true;
  if (printers.has(h) && current !== h) openDetail(h);
  else if (!printers.has(h) && current) closeDetail(false);
}

function showView(name) {
  view = name;
  $$(".view, .wall").forEach((el) => (el.hidden = el.dataset.view !== name));
  $$(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
  document.body.classList.toggle("walling", name === "wall");
  // the printer grid keeps its snapshots only while it is visible
  for (const p of printers.values()) {
    const cam = $(`.pcard[data-id="${CSS.escape(p.id)}"] .cam`);
    if (!cam) continue;
    if (name === "printers") setCam(cam, p); else stopCam(cam);
  }
  window.dispatchEvent(new CustomEvent("pm:view", { detail: name }));
}
window.addEventListener("hashchange", route);

// ---------- detail view ----------
function openDetail(id) {
  current = id;
  files = [];
  if (location.hash !== "#" + id) history.replaceState(null, "", "#" + id);
  $("#detail").hidden = false;
  document.body.classList.add("noscroll");
  $("#files-search").value = "";
  renderDetail();
  loadFiles();
  loadTemps();
  renderJobs();
  loadMaintenance();
  loadPlug();
  loadRecent();
  $("#d-close").focus();
}

function closeDetail(updateHash = true) {
  current = null;
  if (updateHash) history.replaceState(null, "", view === "printers" ? location.pathname : "#" + view);
  $("#detail").hidden = true;
  document.body.classList.remove("noscroll");
  stopCam($("#d-cam").parentElement);
}

function renderAlert(p) {
  const e = p.error;
  const box = $("#d-alert");
  box.hidden = !e;
  if (!e) return;
  box.className = "alert " + (e.level === "warning" ? "warning" : "");
  $("#d-alert-title").textContent = e.title;
  $("#d-alert-advice").textContent = e.advice;
  $("#d-alert-code").textContent = `错误代码 ${e.code}`;
  const actions = [];
  if (isAdmin()) {
    if (e.resumable) {
      actions.push(`<button class="btn primary sm" data-act="plr-resume">恢复打印</button>`);
      actions.push(`<button class="btn ghost sm" data-act="plr-cancel">取消</button>`);
    } else if (p.state === "paused") {
      actions.push(`<button class="btn primary sm" data-act="resume">继续打印</button>`);
      actions.push(`<button class="btn danger sm" data-act="stop">停止</button>`);
    }
    if (!e.resumable) actions.push(`<button class="btn ghost sm" data-act="clear">忽略提醒</button>`);
  }
  $("#d-alert-actions").innerHTML = actions.join("");
}

function renderDetail() {
  const p = printers.get(current);
  if (!p) return closeDetail();
  const d = p.data || {};
  $("#detail .panel").dataset.state = p.state;
  $("#d-name").textContent = p.name;
  $("#d-host").textContent = p.host;
  $("#d-model").textContent = p.model || "未知型号";
  const mi = $("#d-model-img");
  if (mi.dataset.src !== modelUrl(p)) { mi.dataset.src = modelUrl(p); mi.hidden = false; mi.onerror = () => (mi.hidden = true); mi.src = modelUrl(p); }
  const pill = $("#d-state");
  pill.textContent = STATE_LABEL[p.state] || p.state;
  pill.dataset.state = p.state;
  renderAlert(p);
  setCam($("#d-cam").parentElement, p, true);
  renderCamStatus(p);

  // Current job
  const active = ACTIVE.has(p.state) && d.printFileName;
  const pct = active ? progress(d) : 0;
  $("#d-file").textContent = active ? prettyName(d.printFileName) : (p.online ? "当前没有打印任务" : "打印机离线");
  setThumb($("#d-thumb"), p.id, active ? d.printFileName : "");
  const eta = active && p.state !== "completed" ? clock(d.printLeftTime) : null;
  $("#d-eta").innerHTML = p.state === "completed" ? "打印已完成"
    : eta ? `预计完成时间：<b>${eta}</b> · 剩余 ${dur(d.printLeftTime)}` : "";
  $("#d-pct").textContent = active ? Math.round(pct) : "—";
  $("#d-ring-fg").style.strokeDashoffset = 326.7 * (1 - pct / 100);
  $("#d-layer").textContent = active && d.TotalLayer ? `${d.layer ?? 0} / ${d.TotalLayer}` : "—";
  $("#d-elapsed").textContent = active ? dur(d.printJobTime) : "—";
  $("#d-left").textContent = active ? dur(d.printLeftTime) : "—";
  $("#d-speed").textContent = active && num(d.realTimeSpeed) !== null ? `${Math.round(num(d.realTimeSpeed))} mm/s` : "—";
  $("#d-flow").textContent = active && num(d.realTimeFlow) !== null ? `${num(d.realTimeFlow).toFixed(1)} mm³/s` : "—";
  const used = num(d.usedMaterialLength);
  $("#d-used").textContent = active && used ? (used >= 1000 ? `${(used / 1000).toFixed(2)} m` : `${Math.round(used)} mm`) : "—";

  const pause = $("#d-pause");
  pause.textContent = p.state === "paused" ? "继续打印" : "暂停";
  pause.disabled = !["printing", "paused"].includes(p.state);
  $("#d-stop").disabled = !BUSY.has(p.state);
  $("#d-light").setAttribute("aria-pressed", String(String(d.lightSw) === "1"));
  $("#d-light").disabled = !p.online;

  // Temperatures
  $("#d-noz").textContent = deg(d.nozzleTemp);
  $("#d-bed").textContent = deg(d.bedTemp0);
  $("#d-noz-t").textContent = num(d.targetNozzleTemp) ? `目标 ${deg(d.targetNozzleTemp)}` : "关闭";
  $("#d-bed-t").textContent = num(d.targetBedTemp0) ? `目标 ${deg(d.targetBedTemp0)}` : "关闭";

  // Filament
  const fils = filaments(d);
  $("#d-filament").innerHTML = fils.length ? fils.map((f) => `
    <div class="fil">
      <span class="spool" style="background:${f.color}"></span>
      <span class="txt"><b>${esc(f.name || f.type || "耗材")}</b><span>${esc([f.type, f.vendor, f.external ? "外置料盘" : `CFS ${f.box}·${f.id + 1}`].filter(Boolean).join(" · "))}${f.minTemp ? ` · ${f.minTemp}–${f.maxTemp} °C` : ""}</span></span>
      ${num(f.percent) !== null ? `<span class="gauge"><span class="bar"><div style="width:${num(f.percent)}%"></div></span></span>` : ""}
    </div>`).join("") : `<span class="muted">${p.online ? "暂无耗材信息" : "—"}</span>`;

  for (const [i, field] of [[0, "modelFanPct"], [1, "caseFanPct"], [2, "auxiliaryFanPct"]]) {
    const r = $(`input[data-fan="${i}"]`);
    if (document.activeElement !== r && d[field] !== undefined) r.value = num(d[field]) ?? 0;
    r.nextElementSibling.textContent = d[field] !== undefined ? `${num(d[field]) ?? 0} %` : "—";
  }
  const sp = $("#speed");
  if (document.activeElement !== sp && d.curFeedratePct !== undefined) sp.value = num(d.curFeedratePct) ?? 100;
  $("#speed-out").textContent = d.curFeedratePct !== undefined ? `${num(d.curFeedratePct)} %` : "—";

  $("#pos").textContent = d.curPosition ? String(d.curPosition).replace(/:/g, " ") : "";
  const moving = BUSY.has(p.state);
  $$("[data-jog],[data-home]").forEach((x) => (x.disabled = moving || !p.online));
  $("#jog-note").hidden = !moving;
  $("#d-reboot").disabled = !p.online || moving;
}

// ---------- maintenance, plug, recent prints ----------
async function loadMaintenance() {
  if (!isAdmin()) return; // maintenance is an admin feature
  const id = current;
  try {
    const m = await api(`/api/printers/${id}/maintenance`);
    if (id === current) renderMaintenance(m);
  } catch { $("#d-maint").innerHTML = `<span class="muted">—</span>`; }
}

function renderMaintenance(m) {
  $("#d-hours").textContent = `已累计打印 ${m.hours.toLocaleString("zh-CN")} 小时`;
  $("#d-maint").innerHTML = m.tasks.map((t) => {
    const pct = Math.min(100, (t.since_hours / t.hours) * 100);
    return `<div class="mtask ${t.due ? "due" : ""}">
      <div class="mtop"><span>${esc(t.name)}</span>
        <button class="btn sm ${t.due ? "primary" : "ghost"}" data-done="${esc(t.id)}" title="标记为已完成">完成</button></div>
      <div class="bar"><div style="width:${pct}%"></div></div>
      <small class="muted">${t.due ? "已到期" : `${Math.max(0, Math.round(t.hours - t.since_hours))} 小时后`} · ${Math.round(t.since_hours)} / ${t.hours} 小时${t.done_at ? ` · 完成于 ${new Date(t.done_at * 1000).toLocaleDateString("zh-CN")}` : ""}</small>
    </div>`;
  }).join("");
}
$("#d-maint").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-done]");
  if (!b) return;
  try { renderMaintenance(await api(`/api/printers/${current}/maintenance/${b.dataset.done}`, { method: "POST" })); toast("已记录维护 ✓"); }
  catch (err) { toast(err.message, true); }
});

async function loadPlug() {
  if (!isAdmin()) return; // smart plugs are an admin feature
  const id = current;
  let plug;
  try { plug = await api(`/api/printers/${id}/plug`); } catch { plug = { configured: false }; }
  if (id !== current) return;
  $("#d-plug-card").hidden = !plug.configured;
  if (!plug.configured) return;
  const st = $("#d-plug-state");
  st.textContent = !plug.reachable ? "无法连接" : plug.on ? "已开启" : "已关闭";
  st.dataset.state = !plug.reachable ? "error" : plug.on ? "idle" : "offline";
  $("#d-plug-msg").textContent = plug.pending || (plug.auto_off ? `打印结束且喷嘴温度低于 ${plug.off_below || 50} °C 后自动断电。` : "自动断电已关闭（可在设置中启用）。");
}
setInterval(() => { if (current && !$("#d-plug-card").hidden) loadPlug(); }, 15000);
$("#d-plug-on").onclick = () => setPlug(true);
$("#d-plug-off").onclick = () => {
  if (confirm("确定要关闭打印机电源吗？")) setPlug(false);
};
async function setPlug(on) {
  try { await api(`/api/printers/${current}/plug`, { method: "POST", body: JSON.stringify({ on }) }); toast(on ? "插座已开启" : "插座已关闭"); }
  catch (e) { toast(e.message, true); }
  setTimeout(loadPlug, 800);
}

async function loadRecent() {
  const id = current;
  try {
    const rows = await api(`/api/history?printer=${encodeURIComponent(id)}&limit=5`);
    if (id !== current) return;
    $("#d-history").innerHTML = rows.length && window.histRow ? rows.map((r) => window.histRow(r, true)).join("")
      : `<p class="muted small">Prints will appear here starting with the next one.</p>`;
  } catch { /* ignore */ }
}

function renderCamStatus(p) {
  const c = p.camera_status || {};
  let text;
  if (!p.online) text = "打印机离线";
  else if (p.camera === "mjpeg") text = "摄像头";
  else if (c.status === "live") text = "摄像头直播中";
  else if (c.status === "connecting") text = "正在连接摄像头…";
  else if (c.status === "error") {
    const wait = c.retry_at ? Math.max(0, Math.round(c.retry_at - Date.now() / 1000)) : 0;
    text = "摄像头不可用" + (wait ? ` — ${wait} 秒后重试` : "");
  } else text = "摄像头空闲";
  $("#cam-status").textContent = text;
  $("#cam-status").title = c.error || "";
  $("#cam-dot").className = "dot" + (c.status === "live" || p.camera === "mjpeg" ? " ok" : c.status === "connecting" ? " wait" : "");
}
setInterval(() => { const p = current && printers.get(current); if (p) renderCamStatus(p); }, 1000);

// ---------- temperature chart ----------
async function loadTemps() {
  if (!current) return;
  const id = current;
  try {
    const rows = await api(`/api/printers/${id}/temps`);
    if (id === current) drawChart(rows);
  } catch { /* printer unreachable: keep the last chart */ }
}
setInterval(loadTemps, 10000);

function drawChart(rows) {
  const svg = $("#chart");
  const W = 600, H = 160, now = Date.now() / 1000, span = 1800;
  if (rows.length < 2) { svg.innerHTML = ""; $("#chart-labels").innerHTML = `<em>温度记录将在几分钟后显示…</em>`; return; }
  const vals = rows.flatMap((r) => r.slice(1).filter((v) => v !== null));
  const top = Math.max(60, Math.ceil((Math.max(...vals) + 10) / 50) * 50);
  const x = (t) => Math.max(0, W - ((now - t) / span) * W);
  const y = (v) => H - (v / top) * (H - 8) - 4;
  const path = (i) => rows.filter((r) => r[i] !== null).map((r, k) => `${k ? "L" : "M"}${x(r[0]).toFixed(1)},${y(r[i]).toFixed(1)}`).join("");
  const area = (i) => { const p = path(i); const pts = rows.filter((r) => r[i] !== null); return p ? `${p}L${x(pts.at(-1)[0]).toFixed(1)},${H}L${x(pts[0][0]).toFixed(1)},${H}Z` : ""; };
  const levels = [0.25, 0.5, 0.75].map((f) => Math.round(top * f));
  const grid = levels.map((v) => `<line class="grid-line" x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>`).join("");
  // Axis labels in HTML: the SVG is stretched, text inside it would be distorted.
  $("#chart-labels").innerHTML = levels.map((v) => `<span style="top:${(y(v) / H) * 100}%">${v}°</span>`).join("");
  svg.innerHTML = `
    <defs>
      <linearGradient id="g-noz" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--noz)" stop-opacity=".25"/><stop offset="1" stop-color="var(--noz)" stop-opacity="0"/></linearGradient>
      <linearGradient id="g-bed" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--bed)" stop-opacity=".2"/><stop offset="1" stop-color="var(--bed)" stop-opacity="0"/></linearGradient>
    </defs>
    ${grid}
    <path class="area-bed" d="${area(3)}"/><path class="area-noz" d="${area(1)}"/>
    <path class="line target noz" d="${path(2)}"/><path class="line target bed" d="${path(4)}"/>
    <path class="line bed" d="${path(3)}"/><path class="line noz" d="${path(1)}"/>`;
}

// ---------- files ----------
async function loadFiles() {
  const box = $("#files");
  box.innerHTML = `<div class="note">正在加载…</div>`;
  const id = current;
  try {
    const list = await api(`/api/printers/${id}/files`);
    if (id !== current) return;
    files = list;
    renderFiles();
  } catch (e) {
    box.innerHTML = `<div class="note">${esc(e.message)}</div>`;
  }
}

function renderFiles() {
  const q = $("#files-search").value.trim().toLowerCase();
  const list = files.filter((f) => !q || f.name.toLowerCase().includes(q));
  const box = $("#files");
  if (!files.length) { box.innerHTML = `<div class="note">打印机上没有文件。</div>`; return; }
  if (!list.length) { box.innerHTML = `<div class="note">没有匹配的文件。</div>`; return; }
  const busy = BUSY.has(printers.get(current)?.state);
  const actions = isAdmin() ? `
        <div class="factions">
          <button class="btn sm primary" data-print="${esc(f.name)}" ${busy ? "disabled title='打印任务进行中'" : ""}>打印</button>
          <button class="btn sm ghost" data-del="${esc(f.name)}" title="删除" aria-label="删除 ${esc(f.name)}">🗑</button>
        </div>` : "";
  box.innerHTML = list.map((f) => `
    <div class="fcard">
      <div class="fthumb"><img loading="lazy" alt="" src="${thumbUrl(current, f.name)}" onerror="this.remove()"></div>
      <div class="fbody">
        <div class="fname" title="${esc(f.name)}">${esc(prettyName(f.name))}</div>
        <div class="fmeta">${[f.timeCost && "⏱ " + dur(f.timeCost), f.material && esc(String(f.material).split(";")[0]), f.consumables && `${(f.consumables / 1000).toFixed(1)} m`].filter(Boolean).join(" · ")}</div>${actions}
      </div>
    </div>`).join("");
}

function renderJobs() {
  const list = [...jobs.values()].filter((j) => j.printer === current).slice(-4).reverse();
  $("#jobs").innerHTML = list.map((j) => `
    <div class="jobrow" data-step="${esc(j.step)}">
      ${["done", "error"].includes(j.step) ? "" : `<span class="spinner"></span>`}
      <span class="fname">${esc(j.file)}</span>
      <span class="step">${STEP_LABEL[j.step] || esc(j.step)}</span>
      ${j.error ? `<pre>${esc(j.error)}</pre>` : ""}
    </div>`).join("");
}

function renderSlicer() {
  $("#drop-slice").textContent = " · .stl / .3mf：发送前可切片并预览 3D 模型";
}

async function uploadFile(file) {
  if (!current || !isAdmin()) return;
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext !== "gcode") {
    // 3D model: slicing + preview in the send dialog
    if (window.openSend) window.openSend(file, [current]);
    return;
  }
  const fd = new FormData();
  fd.append("file", file);
  fd.append("start", $("#up-start").checked ? "true" : "false");
  try {
    const job = await api(`/api/printers/${current}/upload`, { method: "POST", body: fd });
    jobs.set(job.id, job);
    renderJobs();
  } catch (e) { toast(e.message, true); }
}

// ---------- WebSocket to the server ----------
function setLink(ok) {
  $("#link").classList.toggle("ok", ok);
  $(".link-label").textContent = ok ? "已连接" : "正在重连…";
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
  ws.onopen = () => setLink(true);
  ws.onclose = (e) => {
    if (e.code === 4401) { location.href = "/login"; return; } // session expired
    setLink(false); setTimeout(connect, 2000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "init") {
      printers.clear();
      $("#grid").innerHTML = "";
      msg.printers.forEach((p) => { printers.set(p.id, p); renderCard(p); });
      renderEmpty();
      route.done = false;
      route();
    } else if (msg.type === "printer") {
      const prev = printers.get(msg.printer.id);
      printers.set(msg.printer.id, msg.printer);
      renderCard(msg.printer);
      renderEmpty();
      notifyChange(prev, msg.printer);
    } else if (msg.type === "removed") {
      printers.delete(msg.id);
      $(`.pcard[data-id="${CSS.escape(msg.id)}"]`)?.remove();
      renderEmpty();
      if (current === msg.id) closeDetail();
    } else if (msg.type === "history") {
      if (current === msg.printer) { loadRecent(); loadMaintenance(); }
      window.dispatchEvent(new CustomEvent("pm:history"));
    } else if (msg.type === "slicer") {
      window.dispatchEvent(new CustomEvent("pm:slicer", { detail: msg.install }));
    } else if (msg.type === "job") {
      jobs.set(msg.job.id, msg.job);
      window.dispatchEvent(new CustomEvent("pm:job", { detail: msg.job }));
      if (msg.job.kind === "send") {
        if (msg.job.printer === current) renderJobs();
        if (msg.job.step === "done") {
          toast(`${msg.job.gcode} 已发送 ✓`);
          if (current && msg.job.targets?.[current]) loadFiles();
        }
        if (msg.job.step === "error") toast("发送失败：" + msg.job.error.split("\n")[0], true);
      }
    }
    renderSummary();
    if (current && (msg.type === "init" || msg.printer?.id === current)) renderDetail();
  };
}

// Short message when a print finishes or a problem appears.
function notifyChange(prev, p) {
  if (!prev) return;
  if (p.error && p.error.code !== prev.error?.code) toast(`${p.name}: ${p.error.title}`, true);
  else if (p.state === "completed" && prev.state !== "completed") toast(`${p.name}：打印已完成 ✓`);
}

// ---------- events ----------
$("#logout-btn").onclick = async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* already signed out */ }
  location.href = "/login";
};
$("#d-close").onclick = () => closeDetail();
$("#detail").addEventListener("click", (e) => { if (e.target.id === "detail") closeDetail(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && current && !$("dialog[open]")) closeDetail(); });

$("#d-pause").onclick = () => {
  const paused = printers.get(current)?.state === "paused";
  command({ pause: paused ? 0 : 1 }, paused ? "已请求继续打印" : "已请求暂停");
};
$("#d-stop").onclick = () => {
  if (confirm("确定停止当前打印吗？停止后无法继续。")) command({ stop: 1 }, "已请求停止");
};
$("#d-light").onclick = () => {
  const on = String(printers.get(current)?.data?.lightSw) === "1";
  command({ lightSw: on ? 0 : 1 });
};
$("#d-alert-actions").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "resume") command({ pause: 0 }, "已请求继续打印");
  else if (act === "stop") { if (confirm("确定停止打印吗？")) command({ stop: 1 }, "已请求停止"); }
  else if (act === "clear") command({ cleanErr: 1 }, "提醒已清除");
  else if (act === "plr-resume") command({ repoPlrStatus: 1 }, "正在恢复中断的打印…");
  else if (act === "plr-cancel") { if (confirm("确定放弃中断的打印任务吗？")) command({ repoPlrStatus: 0 }, "已放弃打印任务"); }
});
$("#d-remove").onclick = async () => {
  const p = printers.get(current);
  if (!confirm(`确定从列表中移除“${p.name}”吗？`)) return;
  try { await api(`/api/printers/${current}`, { method: "DELETE" }); } catch (e) { toast(e.message, true); }
};
$("#cam-reset").onclick = async () => {
  const id = current;
  try {
    await api(`/api/printers/${id}/camera/reset`, { method: "POST" });
    for (const cam of camElements(id)) { stopCam(cam); setCam(cam, printers.get(id), cam === $("#d-cam").parentElement); }
    toast("摄像头已重置，正在重新连接…");
  } catch (e) { toast(e.message, true); }
};
$("#d-reboot").onclick = async () => {
  const p = printers.get(current);
  if (!confirm(`确定重启“${p.name}”吗？打印机将暂时离线约一分钟。`)) return;
  try {
    await api(`/api/printers/${current}/reboot`, { method: "POST" });
    toast("已请求重启。");
  } catch (e) { toast(e.message, true); }
};

function setTemps(noz, bed) {
  const params = {};
  if (noz !== null) params.nozzleTempControl = noz;
  if (bed !== null) params.bedTempControl = { num: 0, val: bed };
  if (Object.keys(params).length) command(params, "目标温度已发送");
}
$("#t-apply").onclick = () => { setTemps(num($("#t-noz").value), num($("#t-bed").value)); $("#t-noz").value = $("#t-bed").value = ""; };
$$("[data-preset]").forEach((b) => (b.onclick = () => { const [n, p] = b.dataset.preset.split(",").map(Number); setTemps(n, p); }));

$$("input[data-fan]").forEach((r) => {
  r.oninput = () => (r.nextElementSibling.textContent = r.value + " %");
  r.onchange = () => gcode(`M106 P${r.dataset.fan} S${Math.round((255 * r.value) / 100)}`);
});
$("#speed").oninput = (e) => ($("#speed-out").textContent = e.target.value + " %");
$("#speed").onchange = (e) => command({ setFeedratePct: Number(e.target.value) });

$$("[data-jog]").forEach((b) => (b.onclick = () => {
  const [axis, dir] = b.dataset.jog.split(",");
  const step = Number($('input[name="step"]:checked').value) * Number(dir);
  gcode(`G91\nG1 ${axis}${step} F${axis === "Z" ? 600 : 6000}\nG90`);
}));
$$("[data-home]").forEach((b) => (b.onclick = () => command({ autohome: b.dataset.home }, "正在归零…")));

$("#gcode-form").onsubmit = (e) => {
  e.preventDefault();
  const v = $("#gcode").value.trim();
  if (!v) return;
  gcode(v, "已发送：" + v);
  $("#gcode").value = "";
};

$("#files-refresh").onclick = loadFiles;
$("#files-search").oninput = renderFiles;
$("#files").addEventListener("click", async (e) => {
  const pr = e.target.closest("[data-print]");
  const del = e.target.closest("[data-del]");
  try {
    if (pr) {
      if (!confirm(`开始打印 ${pr.dataset.print} 吗？`)) return;
      await api(`/api/printers/${current}/print`, { method: "POST", body: JSON.stringify({ name: pr.dataset.print }) });
      toast("已开始打印");
    } else if (del) {
      if (!confirm(`从打印机中删除 ${del.dataset.del} 吗？`)) return;
      await api(`/api/printers/${current}/delete`, { method: "POST", body: JSON.stringify({ name: del.dataset.del }) });
      setTimeout(loadFiles, 800);
    }
  } catch (err) { toast(err.message, true); }
});

const drop = $("#drop");
$("#file-input").onchange = (e) => { [...e.target.files].forEach(uploadFile); e.target.value = ""; };
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("hover"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("hover"); }));
drop.addEventListener("drop", (e) => [...e.dataTransfer.files].forEach(uploadFile));

$("#add-btn").onclick = () => { $("#discover-list").innerHTML = ""; $("#add-dlg").showModal(); };
$("#add-dlg").addEventListener("close", async () => {
  const dlg = $("#add-dlg"), form = $("#add-form");
  if (dlg.returnValue === "ok") {
    const data = Object.fromEntries(new FormData(form));
    if (data.host.trim()) {
      try { await api("/api/printers", { method: "POST", body: JSON.stringify(data) }); }
      catch (e) { toast(e.message, true); }
    }
  }
  form.reset();
});

$("#discover-btn").onclick = async () => {
  const btn = $("#discover-btn"), list = $("#discover-list");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> 正在扫描网络…`;
  list.innerHTML = "";
  try {
    const found = await api("/api/discover");
    list.innerHTML = found.length ? found.map((f) => `
      <div class="disc">
        <img src="/static/models/${encodeURIComponent(f.model || "x")}.webp" alt="" onerror="this.style.visibility='hidden'">
        <span class="txt"><b>${esc(f.model_name || "创想打印机")}</b><span>${esc(f.host)}${f.mac ? " · " + esc(f.mac.slice(-4)) : ""}</span></span>
        ${f.known_id ? `<span class="muted small">已添加${f.known_name ? "（" + esc(f.known_name) + "）" : ""}</span>`
          : `<button type="button" class="btn sm primary" data-add="${esc(f.host)}" data-name="${esc((f.model_name || "Creality") + (f.mac ? " " + f.mac.slice(-4) : ""))}">添加</button>`}
      </div>`).join("") : `<p class="muted small">No Creality printer found. Make sure it is powered on and connected to the same network.</p>`;
  } catch (e) { list.innerHTML = `<p class="muted small">${esc(e.message)}</p>`; }
  btn.disabled = false;
  btn.textContent = "重新扫描";
};
$("#discover-list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-add]");
  if (!b) return;
  b.disabled = true;
  try {
    await api("/api/printers", { method: "POST", body: JSON.stringify({ name: b.dataset.name, host: b.dataset.add }) });
    b.outerHTML = `<span class="muted small">added ✓</span>`;
  } catch (err) { toast(err.message, true); b.disabled = false; }
});

$("#d-edit").onclick = () => {
  const p = printers.get(current), form = $("#edit-form");
  form.name.value = p.name;
  form.host.value = p.host;
  $("#edit-mac").textContent = p.mac ? `MAC 地址 ${p.mac}：如果路由器更改了打印机 IP，应用会自动重新发现它。` : "";
  $("#edit-dlg").showModal();
};
$("#edit-dlg").addEventListener("close", async () => {
  if ($("#edit-dlg").returnValue !== "ok" || !current) return;
  const data = Object.fromEntries(new FormData($("#edit-form")));
  try {
    await api(`/api/printers/${current}`, { method: "PATCH", body: JSON.stringify(data) });
    stopCam($("#d-cam").parentElement);
    toast("打印机信息已更新");
  } catch (e) { toast(e.message, true); }
});

// keep finish times accurate even without new messages
setInterval(() => { for (const p of printers.values()) renderCard(p); if (current) renderDetail(); }, 30000);

// ---------- start: who am I, then connect ----------
function applyRole() {
  if (isAdmin()) return;
  $$(`[data-admin]`).forEach((el) => (el.hidden = true));
}

async function boot() {
  try {
    ME = await api("/api/auth/me");
  } catch {
    return; // api() already redirected to /login
  }
  document.body.dataset.role = ME.role;
  const who = $("#who");
  who.textContent = `${ME.username} · ${isAdmin() ? "管理员" : "普通用户"}`;
  who.hidden = false;
  applyRole();
  if (isAdmin()) {
    api("/api/slicer").then((s) => { slicer = s; renderSlicer(); }).catch(renderSlicer);
  }
  connect();
}
boot();
