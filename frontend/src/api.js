export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = typeof body === "object" && body !== null
      ? body.detail || `请求失败（${response.status}）`
      : body || `请求失败（${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

// Normalize printer/slicer color metadata before it reaches a CSS style.
// Different firmware and slicer versions use #RRGGBB, RRGGBB, #RGB, or names.
export function normalizeColor(value) {
  const raw = String(value ?? "").trim().replace(/^[\"']|[\"']$/g, "");
  if (!raw) return null;
  const hex = raw.replace(/^#|^0x/i, "");
  // Creality firmware sometimes prefixes its 6-digit color with a zero
  // (for example #0ffffff).
  if (/^0[0-9a-f]{6}$/i.test(hex)) return `#${hex.slice(1)}`;
  // Creality slicer metadata uses ARGB (#AARRGGBB), while CSS uses RGBA
  // (#RRGGBBAA). Convert it so the alpha channel is preserved in previews.
  if (/^[0-9a-f]{8}$/i.test(hex)) return `#${hex.slice(2)}${hex.slice(0, 2)}`;
  if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return `#${hex.split("").map((digit) => digit + digit).join("")}`;
  }
  const named = {
    white: "#ffffff",
    black: "#000000",
    red: "#ff0000",
    green: "#008000",
    blue: "#0000ff",
    yellow: "#ffff00",
    orange: "#ffa500",
    purple: "#800080",
    gray: "#808080",
    grey: "#808080",
  };
  return named[raw.toLowerCase()] || null;
}

export function printerView(printer) {
  const data = printer.data || {};
  const progress = Number(data.printProgress ?? data.dProgress ?? 0);
  const materials = (data.boxsInfo?.materialBoxs || [])
    .flatMap((box) => (box.materials || []).map((material) => ({ box, material })));
  const loaded = materials.find(({ material, box }) => material.selected || box.type === 1);
  const filament = loaded?.material;
  const filamentColor = normalizeColor(filament?.color);
  const colors = ["#b9e572", "#78b8ff", "#e9ad67", "#c5a1ff"];
  const state = !printer.online
    ? "offline"
    : printer.state === "idle" || printer.state === "completed"
      ? "ready"
      : printer.state;

  const colorValues = list("filament_colour").length ? list("filament_colour") : list("filament_color");
  const profiles = list("filament_settings_id");
  const types = list("filament_type");
  const tools = [...text.matchAll(/^\s*T(\d+)\s*$/gim)].map((match) => `T${match[1]}`);
  const toolIds = [...new Set(tools)];
  const filamentIds = colorValues.length
    ? colorValues.map((_, index) => `T1${String.fromCharCode(65 + index)}`)
    : toolIds;

  return {
    id: printer.id,
    name: printer.name,
    model: `${printer.model || printer.model_code || "Creality"} · ${printer.host}`,
    state,
    file: data.printFileName || "等待打印任务",
    progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0,
    time: state === "printing" || state === "processing"
      ? formatDuration(data.printLeftTime)
      : state === "paused"
        ? "已暂停"
        : state === "offline"
          ? "离线"
          : "空闲",
    nozzle: temperature(data.nozzleTemp),
    bed: temperature(data.bedTemp0),
    color: filamentColor || colors[Number.parseInt(printer.id, 16) % colors.length],
    kind: String(printer.model_code || printer.model || "CREALITY").toUpperCase(),
    online: Boolean(printer.online),
    raw: printer,
    filament: filament
      ? { name: filament.type || filament.name || "耗材", color: filamentColor }
      : null,
  };
}

export function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "—";
  if (value <= 0) return "0 分钟";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes} 分钟`;
}

function temperature(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : "—";
}

export function formatDate(timestamp) {
  const date = new Date(Number(timestamp) * 1000);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return `${sameDay ? "今天" : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
}

// ---------- shared display helpers ----------
export const STATE_LABEL = {
  offline: "离线",
  idle: "就绪",
  ready: "就绪",
  printing: "打印中",
  paused: "已暂停",
  completed: "已完成",
  stopped: "已停止",
  error: "错误",
  processing: "准备中",
  self_test: "自检中",
};
export const BUSY_STATES = ["printing", "paused", "processing", "self_test"];
export const ACTIVE_STATES = [...BUSY_STATES, "completed"];

export const num = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

export const baseName = (path) => String(path || "").split("/").pop();

export const prettyName = (name) => baseName(name).replace(/\.gcode$/i, "").replace(/_/g, " ");

export const thumbUrl = (id, name) => `/api/printers/${id}/thumb?name=${encodeURIComponent(baseName(name))}`;

export const modelUrl = (printer) => `/models/${encodeURIComponent(printer.model_code || "unknown")}.webp`;

export const mediaUrl = (name) => `/api/history/media/${encodeURIComponent(name)}`;

/** All filaments the printer reports (CFS slots + external spool), with a CSS color. */
export function filamentList(data) {
  const boxes = data?.boxsInfo?.materialBoxs || [];
  const out = [];
  for (const box of boxes) {
    for (const material of box.materials || []) {
      if (material.state === 0 && box.type !== 1) continue; // empty CFS slot
      const color = normalizeColor(material.color);
      out.push({
        ...material,
        box: box.id,
        external: box.type === 1,
        color: color || "#888888",
      });
    }
  }
  return out;
}

export const degrees = (value) => {
  const n = num(value);
  return n === null ? "—" : `${Math.round(n)}°`;
};

export const formatMoney = (value) =>
  (Number(value) || 0).toLocaleString("zh-CN", { style: "currency", currency: "CNY" });

export const formatGrams = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(2)} kg` : `${Math.round(n)} g`;
};

export const formatHours = (seconds) => {
  const h = (Number(seconds) || 0) / 3600;
  return h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`;
};

/** Finish time from a "seconds from now" value: "14:30" today, "明天 09:00", or null. */
export function clockFrom(secondsFromNow) {
  const seconds = num(secondsFromNow);
  if (seconds === null || seconds <= 0) return null;
  const end = new Date(Date.now() + seconds * 1000);
  const hm = end.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return end.toDateString() === new Date().toDateString() ? hm : `明天 ${hm}`;
}

/** Filament / time comments from a G-code, for a cost estimate before sending. */
export function parseGcodeMeta(text) {
  const find = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  const g = find(/^;\s*(?:total )?filament used \[g\]\s*[=:]\s*([\d.]+)/mi);
  const t = find(/^;\s*estimated printing time(?: \(normal mode\))?\s*[=:]\s*([^\n]+)/mi);
  const list = (key) => {
    const match = text.match(new RegExp(`^;\\s*${key}\\s*[=:]\\s*([^\\n]+)`, "mi"));
    return match ? match[1].split(/[;,]/).map((item) => item.trim().replace(/^[\"']|[\"']$/g, "")).filter(Boolean) : [];
  };
  let secs = 0;
  for (const [, value, unit] of (t || "").matchAll(/(\d+)\s*([dhms])/g)) {
    secs += Number(value) * { d: 86400, h: 3600, m: 60, s: 1 }[unit];
  }
  return {
    filament_g: g ? Number(g) : null,
    est_time_s: secs || null,
    material: find(/^;\s*filament_type\s*[=:]\s*([^\n;]+)/mi),
    filaments: filamentIds.map((id, index) => ({
      id,
      profile: profiles[index] || null,
      type: types[index] || null,
      color: colorValues[index] || null,
    })),
    hasColorMetadata: colorValues.length > 0,
  };
}

/** Poll a server job (slice / send) until it finishes; resolves with the final job. */
export async function trackJob(id, onUpdate, intervalMs = 2000) {
  for (;;) {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    if (onUpdate) onUpdate(job);
    if (job.step === "done" || job.step === "error") return job;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Send one control command to a printer. */
export function sendCommand(printerId, params) {
  return api(`/api/printers/${printerId}/command`, {
    method: "POST",
    body: JSON.stringify({ params }),
  });
}
