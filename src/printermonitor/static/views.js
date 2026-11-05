"use strict";
// "History", "Settings" and "Wall" views. Uses the utilities from app.js.

const STATUS_LABEL = { completed: "已完成", failed: "失败", stopped: "已停止", running: "进行中" };
const STATUS_STATE = { completed: "completed", failed: "error", stopped: "stopped", running: "printing" };
const euro = (v) => (num(v) ?? 0).toLocaleString("zh-CN", { style: "currency", currency: "EUR" });
const grams = (g) => { g = num(g); return g === null ? "—" : g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${Math.round(g)} g`; };
const hours = (s) => { const h = (num(s) ?? 0) / 3600; return h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`; };
const day = (t) => new Date(t * 1000).toLocaleString("zh-CN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const media = (name) => `/api/history/media/${encodeURIComponent(name)}`;

// ---------- a history row (also used in the printer detail view) ----------
window.histRow = function histRow(r, compact = false) {
  const cost = (num(r.cost_filament) ?? 0) + (num(r.cost_energy) ?? 0);
  const img = r.photo || r.thumb;
  return `<div class="hrow" data-id="${r.id}">
    <div class="hthumb">${r.thumb ? `<img src="${media(r.thumb)}" alt="" loading="lazy">` : ""}${r.photo && !compact ? `<img class="hphoto" src="${media(r.photo)}" alt="最终照片" loading="lazy">` : ""}${!img ? `<span class="thumb-ph"></span>` : ""}</div>
    <div class="hmain">
      <div class="hname">${esc(prettyName(r.file))}</div>
      <div class="hmeta">${compact ? "" : esc(r.printer_name || r.printer_id) + " · "}${day(r.started_at)}${r.duration_s ? " · " + dur(r.duration_s) : ""}</div>
      ${r.error_title ? `<div class="herr">${esc(r.error_title)}</div>` : ""}
    </div>
    <div class="hnums">
      <span class="pill" data-state="${STATUS_STATE[r.status] || ""}">${STATUS_LABEL[r.status] || esc(r.status)}${r.status !== "completed" && r.progress ? ` ${r.progress} %` : ""}</span>
      <span class="hcost">${r.status === "running" ? "" : `${grams(r.filament_g)} · ${euro(cost)}`}</span>
    </div>
    ${!compact && isAdmin() ? `<button class="btn sm ghost icon" data-del-hist="${r.id}" title="从历史记录中删除" aria-label="删除">🗑</button>` : ""}
  </div>`;
};

// ---------- history & statistics ----------
let histRows = [];
let stats = null;

async function loadHistory() {
  try {
    [histRows, stats] = await Promise.all([api("/api/history?limit=500"), api("/api/stats")]);
  } catch (e) { toast(e.message, true); return; }
  const sel = $("#h-printer"), keep = sel.value;
  const names = new Map(histRows.map((r) => [r.printer_id, r.printer_name]));
  for (const p of printers.values()) names.set(p.id, p.name);
  sel.innerHTML = `<option value="">所有打印机</option>` + [...names].map(([id, n]) => `<option value="${esc(id)}">${esc(n || id)}</option>`).join("");
  sel.value = keep;
  renderHistory();
}

function renderHistory() {
  const pid = $("#h-printer").value, status = $("#h-status").value;
  const rows = histRows.filter((r) => (!pid || r.printer_id === pid) && (!status || r.status === status));
  const done = rows.filter((r) => r.status !== "running");
  const ok = done.filter((r) => r.status === "completed").length;
  const month = new Date().toISOString().slice(0, 7);
  const monthRows = done.filter((r) => new Date(r.started_at * 1000).toISOString().slice(0, 7) === month);
  const sum = (list, f) => list.reduce((a, r) => a + (num(f(r)) ?? 0), 0);
  const cost = (r) => (num(r.cost_filament) ?? 0) + (num(r.cost_energy) ?? 0);
  $("#h-tiles").innerHTML = [
    ["打印次数", done.length, `本月 ${monthRows.length} 次`],
    ["成功率", done.length ? `${Math.round((ok / done.length) * 100)} %` : "—", `${ok} / ${done.length} 次成功`],
    ["打印时长", hours(sum(done, (r) => r.duration_s)), `本月 ${hours(sum(monthRows, (r) => r.duration_s))}`],
    ["耗材用量", grams(sum(done, (r) => r.filament_g)), `本月 ${grams(sum(monthRows, (r) => r.filament_g))}`],
    ["费用", euro(sum(done, cost)), `本月 ${euro(sum(monthRows, cost))} · 耗材 + 电费`],
  ].map(([label, value, sub]) => `<div class="tile"><span class="label">${label}</span><b>${value}</b><small>${esc(sub)}</small></div>`).join("");

  renderMonthly(done);

  const per = new Map();
  for (const r of done) {
    const a = per.get(r.printer_id) || { name: r.printer_name || r.printer_id, n: 0, ok: 0, s: 0, g: 0, c: 0 };
    a.n++; a.ok += r.status === "completed"; a.s += num(r.duration_s) ?? 0; a.g += num(r.filament_g) ?? 0; a.c += cost(r);
    per.set(r.printer_id, a);
  }
  $("#h-printers").innerHTML = `<thead><tr><th>打印机</th><th>打印次数</th><th>成功率</th><th>时长</th><th>耗材</th><th>费用</th></tr></thead><tbody>` +
    ([...per.values()].map((a) => `<tr><td>${esc(a.name)}</td><td>${a.n}</td><td>${Math.round((a.ok / a.n) * 100)} %</td><td>${hours(a.s)}</td><td>${grams(a.g)}</td><td>${euro(a.c)}</td></tr>`).join("")
      || `<tr><td colspan="6" class="muted">暂无打印记录。</td></tr>`) + "</tbody>";

  $("#h-list").innerHTML = rows.length ? rows.map((r) => window.histRow(r)).join("")
    : `<p class="muted">历史记录会自动生成。应用跟踪的每次打印都会显示在这里，包括时长、费用和完成照片。</p>`;
}

// Monthly bars: one metric at a time (never two scales), tooltip on hover.
function renderMonthly(done) {
  const metric = $('input[name="metric"]:checked').value;
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: d.toLocaleDateString("zh-CN", { month: "short" }), v: 0 });
  }
  const byKey = new Map(months.map((m) => [m.key, m]));
  for (const r of done) {
    const d = new Date(r.started_at * 1000);
    const m = byKey.get(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    if (!m) continue;
    m.v += metric === "cost" ? (num(r.cost_filament) ?? 0) + (num(r.cost_energy) ?? 0)
      : metric === "hours" ? (num(r.duration_s) ?? 0) / 3600
      : metric === "grams" ? num(r.filament_g) ?? 0 : 1;
  }
  const fmt = (v) => metric === "cost" ? euro(v) : metric === "hours" ? `${v.toFixed(1)} 小时` : metric === "grams" ? grams(v) : `${v} 次`;
  const max = Math.max(...months.map((m) => m.v), 0);
  const box = $("#h-chart");
  if (!max) { box.innerHTML = `<p class="muted">暂无数据。</p>`; return; }
  box.innerHTML = `<div class="bars-plot">${months.map((m) => `
    <div class="bar-col" tabindex="0" data-tip="${esc(m.label)}: ${esc(fmt(m.v))}">
      <div class="bar-val">${m.v ? esc(fmt(m.v)) : ""}</div>
      <div class="bar-fill" style="height:${(m.v / max) * 100}%"></div>
    </div>`).join("")}</div>
    <div class="bars-axis">${months.map((m) => `<span>${esc(m.label)}</span>`).join("")}</div>
    <div class="tip" hidden></div>`;
}

$("#h-chart").addEventListener("pointermove", (e) => {
  const col = e.target.closest(".bar-col"), tip = $("#h-chart .tip");
  if (!tip) return;
  if (!col) { tip.hidden = true; return; }
  tip.hidden = false;
  tip.textContent = col.dataset.tip;
  const r = $("#h-chart").getBoundingClientRect(), c = col.getBoundingClientRect();
  tip.style.left = `${c.left - r.left + c.width / 2}px`;
  tip.style.top = `${c.top - r.top}px`;
});
$("#h-chart").addEventListener("pointerleave", () => { const t = $("#h-chart .tip"); if (t) t.hidden = true; });
$("#h-printer").onchange = renderHistory;
$("#h-status").onchange = renderHistory;
$("#h-metric").onchange = renderHistory;
$("#h-list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-del-hist]");
  if (b) {
    if (!confirm("确定从历史记录中删除这次打印吗？")) return;
    try { await api(`/api/history/${b.dataset.delHist}`, { method: "DELETE" }); loadHistory(); } catch (err) { toast(err.message, true); }
    return;
  }
  const photo = e.target.closest(".hphoto");
  if (photo) window.open(photo.src, "_blank");
});

// ---------- settings ----------
let settings = null;
let dirty = false;
const markDirty = () => { dirty = true; $("#s-dirty").textContent = "有未保存的更改"; };

async function loadSettings() {
  try { settings = await api("/api/settings"); } catch (e) { toast(e.message, true); return; }
  dirty = false;
  $("#s-dirty").textContent = "";
  renderSettings();
  renderSlicerSettings();
  loadUsers();
}

function renderSettings() {
  const f = settings.filaments;
  $("#s-filaments").innerHTML = `<thead><tr><th>类型</th><th>价格 (€/kg)</th><th>密度 (g/cm³)</th><th></th></tr></thead><tbody>` +
    Object.entries(f).map(([k, v]) => `<tr data-fil="${esc(k)}">
      <td><input value="${esc(k)}" data-k="type" aria-label="类型"></td>
      <td><input type="number" step="0.5" min="0" value="${v.price_kg}" data-k="price_kg" aria-label="每千克价格"></td>
      <td><input type="number" step="0.01" min="0.5" value="${v.density}" data-k="density" aria-label="密度"></td>
      <td><button class="btn sm ghost icon" data-del-fil aria-label="删除">✕</button></td></tr>`).join("") + "</tbody>";
  $("#s-fil-default").innerHTML = Object.keys(f).map((k) => `<option ${k === settings.default_filament ? "selected" : ""}>${esc(k)}</option>`).join("");
  $("#s-kwh").value = settings.energy.price_kwh;
  $("#s-watts").value = settings.energy.power_w;
  $("#s-maint").innerHTML = settings.maintenance.map((t) => `<div class="mrow" data-id="${esc(t.id)}">
      <input value="${esc(t.name)}" data-k="name" aria-label="项目">
      <label class="inline"><input type="number" min="1" step="1" value="${t.hours}" data-k="hours" aria-label="间隔"> 小时</label>
      <button class="btn sm ghost icon" data-del-maint aria-label="删除">✕</button></div>`).join("");
  const types = settings.plug_types;
  $("#s-plugs").innerHTML = [...printers.values()].map((p) => {
    const c = settings.plugs[p.id] || {};
    return `<div class="plug-row" data-pid="${esc(p.id)}">
      <b>${esc(p.name)}</b>
      <select data-k="type"><option value="">不使用插座</option>${Object.entries(types).map(([k, n]) => `<option value="${k}" ${c.type === k ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
      <input data-k="host" placeholder="插座 IP 地址" value="${esc(c.host || "")}">
      <label class="check"><input type="checkbox" data-k="auto_off" ${c.auto_off ? "checked" : ""}> 打印结束后关闭</label>
      <label class="inline">低于 <input type="number" data-k="off_below" min="30" max="120" value="${c.off_below ?? 50}"> °C</label>
      <label class="inline">延迟 <input type="number" data-k="delay_min" min="0" max="240" value="${c.delay_min ?? 0}"> 分钟</label>
    </div>`;
  }).join("") || `<p class="muted">请先添加打印机。</p>`;
}

function collectSettings() {
  const filaments = {};
  for (const tr of $$("#s-filaments tbody tr")) {
    const type = $('[data-k="type"]', tr).value.trim().toUpperCase();
    if (type) filaments[type] = { price_kg: num($('[data-k="price_kg"]', tr).value) ?? 0, density: num($('[data-k="density"]', tr).value) ?? 1.24 };
  }
  const maintenance = $$("#s-maint .mrow").map((r) => ({
    id: r.dataset.id, name: $('[data-k="name"]', r).value.trim() || "维护项目", hours: Math.max(1, num($('[data-k="hours"]', r).value) ?? 100),
  }));
  const plugsCfg = {};
  for (const r of $$("#s-plugs .plug-row")) {
    const type = $('[data-k="type"]', r).value;
    if (!type) continue;
    plugsCfg[r.dataset.pid] = {
      type, host: $('[data-k="host"]', r).value.trim(), auto_off: $('[data-k="auto_off"]', r).checked,
      off_below: num($('[data-k="off_below"]', r).value) ?? 50, delay_min: num($('[data-k="delay_min"]', r).value) ?? 0,
    };
  }
  const def = $("#s-fil-default").value;
  return {
    filaments, maintenance, plugs: plugsCfg,
    default_filament: filaments[def] ? def : Object.keys(filaments)[0] || "PLA",
    energy: { price_kwh: num($("#s-kwh").value) ?? 0, power_w: num($("#s-watts").value) ?? 0 },
  };
}

// The user management card works on its own (changes apply immediately), so it
// must not mark the rest of the settings as unsaved.
const inUsersCard = (e) => !!e.target.closest("[data-immediate]");
$("#view-settings").addEventListener("input", (e) => { if (!inUsersCard(e)) markDirty(); });
$("#view-settings").addEventListener("change", (e) => { if (!inUsersCard(e)) markDirty(); });
$("#view-settings").addEventListener("click", (e) => {
  if (e.target.closest("[data-del-fil]")) { e.target.closest("tr").remove(); markDirty(); }
  if (e.target.closest("[data-del-maint]")) { e.target.closest(".mrow").remove(); markDirty(); }
});
$("#s-fil-add").onclick = () => {
  $("#s-filaments tbody").insertAdjacentHTML("beforeend", `<tr><td><input data-k="type" placeholder="例如：PLA-SILK"></td><td><input type="number" step="0.5" min="0" value="20" data-k="price_kg"></td><td><input type="number" step="0.01" value="1.24" data-k="density"></td><td><button class="btn sm ghost icon" data-del-fil aria-label="删除">✕</button></td></tr>`);
  markDirty();
};
$("#s-maint-add").onclick = () => {
  $("#s-maint").insertAdjacentHTML("beforeend", `<div class="mrow" data-id="t${Date.now().toString(36)}"><input data-k="name" placeholder="例如：检查 PTFE 管"><label class="inline"><input type="number" min="1" value="100" data-k="hours"> 小时</label><button class="btn sm ghost icon" data-del-maint aria-label="删除">✕</button></div>`);
  markDirty();
};
$("#s-save").onclick = async () => {
  try {
    settings = await api("/api/settings", { method: "PATCH", body: JSON.stringify(collectSettings()) });
    dirty = false;
    $("#s-dirty").textContent = "";
    renderSettings();
    toast("设置已保存 ✓（历史费用已重新计算）");
  } catch (e) { toast(e.message, true); }
};
window.addEventListener("beforeunload", (e) => { if (dirty) e.preventDefault(); });

// ---------- user management (admin) — every change applies immediately ----------
let users = [];

async function loadUsers() {
  try { users = await api("/api/users"); } catch { return; }
  renderUsers();
}

function renderUsers() {
  $("#s-users").innerHTML = `<thead><tr><th>用户名</th><th>角色</th><th>创建时间</th><th></th></tr></thead><tbody>` +
    (users.map((u) => `<tr data-user="${esc(u.username)}">
      <td>${esc(u.username)}${u.username === ME.username ? `<span class="muted small"> （当前）</span>` : ""}</td>
      <td><select data-role aria-label="${esc(u.username)} 的角色">
        <option value="user" ${u.role === "user" ? "selected" : ""}>普通用户</option>
        <option value="admin" ${u.role === "admin" ? "selected" : ""}>管理员</option>
      </select></td>
      <td class="muted">${new Date(u.created_at * 1000).toLocaleDateString("zh-CN")}</td>
      <td><div class="row end" style="margin:0">
        <button class="btn sm ghost" data-reset-pw>改密码</button>
        ${u.username === ME.username ? "" : `<button class="btn sm danger" data-del-user>删除</button>`}
      </div></td></tr>`).join("") || `<tr><td colspan="4" class="muted">暂无用户。</td></tr>`) + "</tbody>";
}

$("#s-users").addEventListener("change", async (e) => {
  const sel = e.target.closest("[data-role]");
  if (!sel) return;
  const name = sel.closest("tr").dataset.user;
  try {
    await api(`/api/users/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ role: sel.value }) });
    toast("角色已更新");
    if (name === ME.username) location.reload(); // our own permissions changed: rebuild the page
  } catch (err) {
    toast(err.message, true);
    loadUsers(); // put the old value back
  }
});

$("#s-users").addEventListener("click", async (e) => {
  const tr = e.target.closest("tr[data-user]");
  if (!tr) return;
  const name = tr.dataset.user;
  if (e.target.closest("[data-reset-pw]")) {
    const pw = prompt(`为 ${name} 设置新密码（至少 6 位）`);
    if (!pw) return;
    try {
      await api(`/api/users/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ password: pw }) });
      if (name === ME.username) {
        toast("密码已修改，请重新登录");
        setTimeout(() => (location.href = "/login"), 900); // all of our sessions were closed
      } else {
        toast("密码已修改");
      }
    } catch (err) { toast(err.message, true); }
    return;
  }
  if (e.target.closest("[data-del-user]")) {
    if (!confirm(`确定删除用户 ${name} 吗？其所有登录会话将立即失效。`)) return;
    try {
      await api(`/api/users/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast("用户已删除");
      loadUsers();
    } catch (err) { toast(err.message, true); }
  }
});

$("#s-user-add").onclick = async () => {
  const username = $("#s-new-user").value.trim();
  const password = $("#s-new-pass").value;
  const role = $("#s-new-role").value;
  if (!username || !password) { toast("请输入用户名和密码", true); return; }
  try {
    await api("/api/users", { method: "POST", body: JSON.stringify({ username, password, role }) });
    $("#s-new-user").value = "";
    $("#s-new-pass").value = "";
    toast(`用户 ${username} 已创建 ✓`);
    loadUsers();
  } catch (e) { toast(e.message, true); }
};

async function renderSlicerSettings(install) {
  let st;
  try { st = await api("/api/slicer"); } catch { return; }
  const inst = install || st.install || {};
  const box = $("#s-slicer");
  if (inst.step === "download" || inst.step === "extract") {
    box.innerHTML = `<p>${inst.step === "download" ? `正在下载 OrcaSlicer… ${inst.progress} %` : "正在解压…"}</p><div class="bar"><div style="width:${inst.progress}%"></div></div>`;
    return;
  }
  if (st.available) {
    const c = st.catalog || {};
    box.innerHTML = `<p><span class="dot ok"></span> OrcaSlicer 已安装。</p>
      <p class="muted small">${c.machine ? `${esc(c.machine)} 配置：${c.processes.length} 个质量预设，${c.filaments.length} 种耗材。` : "未找到 Creality Hi 配置文件。"}</p>`;
  } else if (st.can_install === false) {
    box.innerHTML = `<p class="muted">如需在应用中直接切片 .stl / .3mf 文件，请从 <a href="https://orcaslicer.com" target="_blank" rel="noopener">orcaslicer.com</a> 安装 OrcaSlicer（或将环境变量 <code>ORCA_SLICER</code> 指向其可执行文件），然后重启应用。</p>`;
  } else {
    box.innerHTML = `<p class="muted">如需在应用中直接切片 .stl / .3mf 文件，请安装 OrcaSlicer ${"v2.4.2"}（官方版本，下载约 150 MB，安装后约 380 MB，已校验哈希值）。其中包含 Creality（Hi、K1、K2 等）配置文件。</p>
      ${inst.step === "error" ? `<p class="perr">${esc(inst.error)}</p>` : ""}
      <button class="btn primary" id="s-slicer-install">安装 OrcaSlicer</button>`;
    $("#s-slicer-install").onclick = async () => {
      try { await api("/api/slicer/install", { method: "POST" }); renderSlicerSettings({ step: "download", progress: 0 }); } catch (e) { toast(e.message, true); }
    };
  }
}
window.addEventListener("pm:slicer", (e) => { if (view === "settings") renderSlicerSettings(e.detail); });

// ---------- wall mode ----------
let wallTimer = null;
let wakeLock = null;
const ORDER = { error: 0, paused: 1, printing: 2, processing: 2, self_test: 2, completed: 3, idle: 4, stopped: 4, offline: 5 };

function renderWall() {
  const list = [...printers.values()].sort((a, b) => {
    const o = (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || (a.error ? -1 : 0) - (b.error ? -1 : 0);
    if (o) return o;
    return (num(a.data?.printLeftTime) ?? 1e9) - (num(b.data?.printLeftTime) ?? 1e9);
  });
  const grid = $("#wall-grid");
  grid.style.setProperty("--cols", Math.min(4, Math.ceil(Math.sqrt(list.length || 1))));
  // keep existing elements so images aren't reloaded
  const seen = new Set();
  for (const p of list) {
    seen.add(p.id);
    let el = $(`.wcard[data-id="${CSS.escape(p.id)}"]`, grid);
    if (!el) {
      el = document.createElement("div");
      el.className = "wcard";
      el.dataset.id = p.id;
      el.innerHTML = `<img alt=""><div class="wover"><div class="wtop"><span class="pill"></span><b class="wname"></b></div><div class="wbottom"><div class="wfile"></div><div class="wnums"></div><div class="bar"><div></div></div></div></div>`;
      el.onclick = () => { location.hash = p.id; };
    }
    grid.append(el); // order
    const d = p.data || {};
    const active = ACTIVE.has(p.state) && d.printFileName;
    el.dataset.state = p.state;
    $(".pill", el).textContent = p.error ? p.error.title : STATE_LABEL[p.state] || p.state;
    $(".pill", el).dataset.state = p.error ? "error" : p.state;
    $(".wname", el).textContent = p.name;
    $(".wfile", el).textContent = active ? prettyName(d.printFileName) : p.online ? "可用" : "离线";
    const eta = active && p.state !== "completed" ? clock(d.printLeftTime) : null;
    $(".wnums", el).innerHTML = active ? `<b>${Math.round(progress(d))} %</b>${eta ? ` · 预计完成 ${eta} · 剩余 ${dur(d.printLeftTime)}` : ""}` : "";
    $(".bar > div", el).style.width = (active ? progress(d) : 0) + "%";
  }
  for (const el of $$(".wcard", grid)) if (!seen.has(el.dataset.id)) el.remove();

  const free = list.filter((p) => p.online && ["idle", "completed"].includes(p.state));
  const next = list.filter((p) => p.state === "printing" && num(p.data?.printLeftTime)).sort((a, b) => a.data.printLeftTime - b.data.printLeftTime)[0];
  $("#wall-next").innerHTML = free.length ? `<b>${free.length}</b> 台打印机可用`
    : next ? `下一台可用打印机：<b>${esc(next.name)}</b>，约 ${dur(next.data.printLeftTime)} 后` : "";
}

function refreshWallImages() {
  for (const el of $$("#wall-grid .wcard")) {
    const p = printers.get(el.dataset.id);
    const img = $("img", el);
    if (!p?.online) { img.removeAttribute("src"); img.style.visibility = "hidden"; continue; }
    if (img.dataset.loading) continue;
    const next = new Image();
    img.dataset.loading = "1";
    next.onload = () => { img.src = next.src; img.style.visibility = ""; delete img.dataset.loading; };
    next.onerror = () => { delete img.dataset.loading; };
    next.src = `/api/printers/${p.id}/snapshot?t=${Date.now()}`;
  }
}

async function enterWall() {
  renderWall();
  refreshWallImages();
  clearInterval(wallTimer);
  wallTimer =   setInterval(() => { renderWall(); refreshWallImages(); $("#wall-clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); }, 2500);
  $("#wall-clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* screen wake lock not supported */ }
}

function leaveWall() {
  clearInterval(wallTimer);
  wakeLock?.release?.();
  wakeLock = null;
  if (document.fullscreenElement) document.exitFullscreen?.();
}

$("#wall-full").onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $("#view-wall").requestFullscreen?.());

// ---------- wiring ----------
window.addEventListener("pm:view", (e) => {
  if (e.detail === "history") loadHistory();
  if (e.detail === "settings") loadSettings();
  if (e.detail === "wall") enterWall(); else leaveWall();
});
window.addEventListener("pm:history", () => { if (view === "history") loadHistory(); });
if (view !== "printers") window.dispatchEvent(new CustomEvent("pm:view", { detail: view }));
