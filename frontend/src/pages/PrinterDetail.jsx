import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  sendCommand,
  STATE_LABEL,
  BUSY_STATES,
  ACTIVE_STATES,
  num,
  prettyName,
  thumbUrl,
  modelUrl,
  degrees,
  formatDuration,
  formatDate,
  clockFrom,
  filamentList,
} from "../api.js";

// printerView() normalizes idle/completed to "ready"; the raw snapshot keeps them apart.
const rawState = (printer) => printer.raw.state;
const jobBusy = (state) => BUSY_STATES.includes(state);

const PILL_STYLE = {
  printing: "bg-lime/10 text-lime",
  completed: "bg-lime/10 text-lime",
  processing: "bg-sky-300/10 text-sky-300",
  idle: "bg-sky-300/10 text-sky-300",
  paused: "bg-amber-300/10 text-amber-300",
  self_test: "bg-amber-300/10 text-amber-300",
  error: "bg-red-400/10 text-red-300",
  offline: "bg-white/[.05] text-[#9298a5]",
  stopped: "bg-white/[.05] text-[#9298a5]",
};

function Card({ title, extra, children, className = "" }) {
  return (
    <section className={`rounded-2xl border border-line bg-[#0e1117] p-4 sm:p-5 ${className}`}>
      {(title || extra) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="text-[13px] font-semibold text-white">{title}</h3>
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}

function Ring({ value, size = 64, color = "#c5f36b" }) {
  const r = 17;
  const circumference = 2 * Math.PI * r;
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg className="absolute inset-0 -rotate-90" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r={r} fill="none" stroke="#2b3038" strokeWidth="3.5" />
        <circle
          cx="22"
          cy="22"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - value / 100)}
        />
      </svg>
      <div className="text-center text-white">
        <div className="text-xl font-bold leading-none">{Math.round(value)}</div>
        <div className="mt-1 text-[9px] leading-none text-[#9298a5]">%</div>
      </div>
    </div>
  );
}

// ---------- camera ----------
function Camera({ printer, onReset, isAdmin }) {
  const [broken, setBroken] = useState(false);
  const [, forceTick] = useState(0);
  const status = printer.raw.camera_status || {};
  useEffect(() => {
    setBroken(false);
  }, [printer.id, printer.online]);
  useEffect(() => {
    if (status.status !== "error") return undefined;
    const timer = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [status.status]);

  let text;
  if (!printer.online) text = "打印机离线";
  else if (printer.raw.camera === "mjpeg") text = "摄像头";
  else if (status.status === "live") text = "摄像头直播中";
  else if (status.status === "connecting") text = "正在连接摄像头…";
  else if (status.status === "error") {
    const wait = status.retry_at ? Math.max(0, Math.round(status.retry_at - Date.now() / 1000)) : 0;
    text = `摄像头不可用${wait ? ` — ${wait} 秒后重试` : ""}`;
  } else text = "摄像头空闲";

  const live = printer.online && !broken;
  return (
    <Card
      title="实时画面"
      extra={
        <div className="flex items-center gap-3">
          <span title={status.error || ""} className="flex items-center gap-1.5 text-[10px] text-[#9ba1ad]">
            <i className={`h-1.5 w-1.5 rounded-full ${live && (status.status === "live" || printer.raw.camera === "mjpeg") ? "bg-lime" : status.status === "connecting" ? "animate-pulse bg-amber-300" : printer.online ? "bg-sky-300" : "bg-[#656b76]"}`} />
            {text}
          </span>
          {isAdmin && printer.online && (
            <button
              onClick={onReset}
              className="rounded-lg border border-line px-2.5 py-1 text-[10px] text-[#c2c6ce] transition hover:bg-white/[.04]"
            >
              重置摄像头
            </button>
          )}
        </div>
      }
    >
      <div className="relative aspect-video overflow-hidden rounded-xl bg-black">
        {live ? (
          <img
            src={`/api/printers/${printer.id}/camera`}
            alt="打印机摄像头画面"
            className="h-full w-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          <div className="grid h-full place-items-center px-4 text-center text-xs text-muted">
            {printer.online ? "摄像头连接失败，可尝试重置" : "打印机离线，无法查看画面"}
          </div>
        )}
        <span className="absolute bottom-2 left-2 rounded-md bg-black/50 px-2 py-1 text-[9px] tracking-wide text-white/60">
          {printer.name}
        </span>
      </div>
    </Card>
  );
}

// ---------- temperature history chart ----------
function TemperatureCard({ printer, isAdmin, notify }) {
  const { id: printerId } = printer;
  const data = printer.raw.data || {};
  const [rows, setRows] = useState([]);
  const [nozzleInput, setNozzleInput] = useState("");
  const [bedInput, setBedInput] = useState("");
  const [controlTarget, setControlTarget] = useState(null);
  const [controlNozzleId, setControlNozzleId] = useState("");
  const nozzles = Array.isArray(data.nozzleState?.nozzles)
    ? data.nozzleState.nozzles.filter((nozzle) => nozzle && nozzle.id !== undefined)
    : [];
  const selectedNozzleId = nozzles.some((nozzle) => String(nozzle.id) === controlNozzleId)
    ? controlNozzleId
    : String(nozzles.find((nozzle) => String(nozzle.id) === String(data.nozzleState?.selected))?.id ?? nozzles[0]?.id ?? "");
  const selectedNozzle = nozzles.find((nozzle) => String(nozzle.id) === selectedNozzleId);
  const readouts = nozzles.length
    ? nozzles.map((nozzle) => ({
      id: nozzle.id,
      current: nozzle.temperature,
      target: nozzle.targetTemp,
    }))
    : [{ id: null, current: data.nozzleTemp, target: data.targetNozzleTemp }];

  useEffect(() => {
    setNozzleInput("");
    setBedInput("");
    setControlTarget(null);
    setControlNozzleId("");
  }, [printerId]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api(`/api/printers/${printerId}/temps`)
        .then((data) => {
          if (alive) setRows(data);
        })
        .catch(() => {
          /* printer unreachable: keep the last chart */
        });
    load();
    const timer = window.setInterval(load, 10000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [printerId]);

  const chart = useMemo(() => {
    const W = 600;
    const H = 160;
    const now = Date.now() / 1000;
    const span = 1800;
    if (rows.length < 2) return null;
    const vals = rows.flatMap((row) => row.slice(1).filter(Number.isFinite));
    if (!vals.length) return null;
    const top = Math.max(60, Math.ceil((Math.max(...vals) + 10) / 50) * 50);
    const x = (t) => Math.max(0, W - ((now - t) / span) * W);
    const y = (v) => H - (v / top) * (H - 8) - 4;
    const path = (i) =>
      rows
        .filter((row) => Number.isFinite(row[i]))
        .map((row, k) => `${k ? "L" : "M"}${x(row[0]).toFixed(1)},${y(row[i]).toFixed(1)}`)
        .join("");
    const area = (i) => {
      const p = path(i);
      const pts = rows.filter((row) => Number.isFinite(row[i]));
      return p ? `${p}L${x(pts.at(-1)[0]).toFixed(1)},${H}L${x(pts[0][0]).toFixed(1)},${H}Z` : "";
    };
    const levels = [0.25, 0.5, 0.75].map((f) => Math.round(top * f));
    const nozzleCount = Math.max(1, ...rows.map((row) => 1 + Math.floor(Math.max(0, row.length - 5) / 2)));
    const nozzleColors = ["#78b8ff", "#b9e572", "#c5a1ff", "#fb7185"];
    const nozzles = Array.from({ length: nozzleCount }, (_, index) => {
      const currentIndex = index === 0 ? 1 : 5 + (index - 1) * 2;
      return {
        color: nozzleColors[index % nozzleColors.length],
        current: path(currentIndex),
        target: path(currentIndex + 1),
      };
    });
    return {
      grid: levels.map((v) => <line key={v} x1="0" x2={W} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,.07)" strokeDasharray="4 4" />),
      labels: levels.map((v) => ({ v, top: (y(v) / H) * 100 })),
      areaBed: area(3),
      areaNoz: area(1),
      targetBed: path(4),
      bed: path(3),
      nozzles,
    };
  }, [rows]);

  const setTemps = async (nozzle, bed) => {
    const params = {};
    if (nozzle !== null) {
      if (nozzles.length > 1) {
        if (!selectedNozzle) {
          notify("请选择要调温的喷嘴");
          return;
        }
        params.setNozzleTemp = { id: Number(selectedNozzle.id), temp: nozzle };
      } else {
        params.nozzleTempControl = nozzle;
      }
    }
    if (bed !== null) params.bedTempControl = { num: 0, val: bed };
    if (!Object.keys(params).length) return;
    try {
      await sendCommand(printerId, params);
      notify("目标温度已发送");
    } catch (error) {
      notify(error.message);
    }
  };

  const openControls = (target, nozzleId = "") => {
    if (isAdmin) {
      setControlTarget(target);
      setControlNozzleId(nozzleId === null ? "" : String(nozzleId));
    }
  };

  const toggleControls = (event, target, nozzleId = "") => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openControls(target, nozzleId);
    }
  };

  return (
    <>
      <Card title="温度" extra={<span className="text-[10px] text-muted">{isAdmin ? "点击温度调节" : "最近30分钟 · 每 5 秒采样"}</span>}>
      <div
        role={isAdmin ? "button" : undefined}
        tabIndex={isAdmin ? 0 : undefined}
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5"
      >
        {readouts.map((nozzle, index) => {
          const current = num(nozzle.current);
          const target = num(nozzle.target);
          return (
            <div
              key={nozzle.id ?? "nozzle"}
              role={isAdmin ? "button" : undefined}
              tabIndex={isAdmin ? 0 : undefined}
              onClick={() => openControls("nozzle", nozzle.id)}
              onKeyDown={(event) => toggleControls(event, "nozzle", nozzle.id)}
              className={`min-w-0 rounded-xl border border-line bg-ink/60 px-3 py-2.5 ${isAdmin ? "cursor-pointer outline-none hover:border-lime/60 focus-visible:ring-1 focus-visible:ring-lime" : ""}`}
            >
              <div className="truncate text-[10px] text-muted">{nozzle.id === null ? "喷嘴" : `喷嘴 ${nozzle.id}`}</div>
              <div className="mt-1 text-base font-semibold tabular-nums text-white">{degrees(current)}</div>
              <div className="mt-0.5 truncate text-[10px] text-muted">
                {target !== null && target > 0 ? `目标 ${degrees(target)}` : "加热关闭"}
              </div>
            </div>
          );
        })}
        <div
          role={isAdmin ? "button" : undefined}
          tabIndex={isAdmin ? 0 : undefined}
          onClick={() => openControls("bed")}
          onKeyDown={(event) => toggleControls(event, "bed")}
          className={`min-w-0 rounded-xl border border-line bg-ink/60 px-3 py-2.5 ${isAdmin ? "cursor-pointer outline-none hover:border-lime/60 focus-visible:ring-1 focus-visible:ring-lime" : ""}`}
        >
          <div className="text-[10px] text-muted">热床</div>
          <div className="mt-1 text-base font-semibold tabular-nums text-white">{degrees(data.bedTemp0)}</div>
          <div className="mt-0.5 truncate text-[10px] text-muted">
            {num(data.targetBedTemp0) > 0 ? `目标 ${degrees(data.targetBedTemp0)}` : "加热关闭"}
          </div>
        </div>
      </div>

      <div className="mt-4">
        {chart ? (
          <div className="relative">
            <svg viewBox="0 0 600 160" preserveAspectRatio="none" className="h-[160px] w-full">
              <defs>
                <linearGradient id="g-noz" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={chart.nozzles[0].color} stopOpacity=".25" />
                  <stop offset="1" stopColor={chart.nozzles[0].color} stopOpacity="0" />
                </linearGradient>
                <linearGradient id="g-bed" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#e9ad67" stopOpacity=".2" />
                  <stop offset="1" stopColor="#e9ad67" stopOpacity="0" />
                </linearGradient>
              </defs>
              {chart.grid}
              <path d={chart.areaBed} fill="url(#g-bed)" />
              <path d={chart.areaNoz} fill="url(#g-noz)" />
              <path d={chart.targetBed} fill="none" stroke="#e9ad67" strokeOpacity=".45" strokeWidth="1.5" strokeDasharray="4 4" />
              <path d={chart.bed} fill="none" stroke="#e9ad67" strokeWidth="2" />
              {chart.nozzles.map((nozzle, index) => (
                <g key={index}>
                  <path d={nozzle.target} fill="none" stroke={nozzle.color} strokeOpacity=".45" strokeWidth="1.5" strokeDasharray="4 4" />
                  <path d={nozzle.current} fill="none" stroke={nozzle.color} strokeWidth="2" />
                </g>
              ))}
            </svg>
            <div className="pointer-events-none absolute inset-0">
              {chart.labels.map(({ v, top: position }) => (
                <span key={v} className="absolute left-1 -translate-y-1/2 text-[9px] text-[#6f7683]" style={{ top: `${position}%` }}>
                  {v}°
                </span>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] text-[#9ba1ad]">
              {chart.nozzles.map((nozzle, index) => (
                <span key={index} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <i className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: nozzle.color }} />
                  {chart.nozzles.length > 1 ? `喷嘴 ${index + 1}` : "喷嘴"}
                </span>
              ))}
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <i className="inline-block h-1.5 w-1.5 rounded-full bg-[#e9ad67]" />热床
              </span>
              <span className="text-muted">虚线为设定温度</span>
            </div>
          </div>
        ) : (
          <p className="py-6 text-center text-xs text-muted">温度记录将在打印几分钟后显示…</p>
        )}
      </div>

      </Card>

      {isAdmin && controlTarget && (
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => setControlTarget(null)}>
        <div className="w-full max-w-md rounded-2xl border border-line bg-panel p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-white">调节{controlTarget === "nozzle" ? "喷嘴" : "热床"}温度</h3>
              <p className="mt-1 text-[10px] text-muted">{printer.name}</p>
            </div>
            <button type="button" onClick={() => setControlTarget(null)} aria-label="关闭温度调节" className="text-lg text-muted hover:text-white">✕</button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {controlTarget === "nozzle" && <label className="flex items-center gap-2 text-[11px] text-muted">
              喷嘴 °C
              <input
                type="number"
                min="0"
                max="320"
                placeholder="不修改"
                value={nozzleInput}
                onChange={(event) => setNozzleInput(event.target.value)}
                className="w-24 rounded-lg border border-line bg-ink px-3 py-2 text-xs text-white outline-none focus:border-lime"
              />
            </label>}
            {controlTarget === "bed" && <label className="flex items-center gap-2 text-[11px] text-muted">
              热床 °C
              <input
                type="number"
                min="0"
                max="120"
                placeholder="不修改"
                value={bedInput}
                onChange={(event) => setBedInput(event.target.value)}
                className="w-24 rounded-lg border border-line bg-ink px-3 py-2 text-xs text-white outline-none focus:border-lime"
              />
            </label>}
            <button
              onClick={() => {
                void setTemps(
                  controlTarget === "nozzle" && nozzleInput !== "" ? num(nozzleInput) : null,
                  controlTarget === "bed" && bedInput !== "" ? num(bedInput) : null,
                );
                setNozzleInput("");
                setBedInput("");
                setControlTarget(null);
              }}
              className="rounded-lg bg-lime px-3 py-2 text-xs font-semibold text-ink"
            >
              发送
            </button>
          </div>
        </div>
      </div>
      )}
    </>
  );
}

// ---------- filament ----------
function FilamentCard({ printer }) {
  const list = filamentList(printer.raw.data || {});
  return (
    <Card title="耗材">
      {list.length ? (
        <div className="space-y-3">
          {list.map((f, index) => (
            <div key={`${f.box}-${f.id ?? index}`} className="flex items-center gap-3">
              <span className="h-8 w-8 shrink-0 rounded-lg border border-white/10" style={{ background: f.color }} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-[#e1e4ea]">{f.name || f.type || "耗材"}</div>
                <div className="mt-0.5 truncate text-[10px] text-muted">
                  {[f.type, f.vendor, f.external ? "外置料盘" : `CFS ${f.box}·${(f.id ?? 0) + 1}`].filter(Boolean).join(" · ")}
                  {f.minTemp ? ` · ${f.minTemp}–${f.maxTemp} °C` : ""}
                </div>
              </div>
              {num(f.percent) !== null && (
                <div className="w-16 shrink-0">
                  <div className="h-1.5 rounded-full bg-white/[.07]">
                    <div className="h-1.5 rounded-full" style={{ width: `${Math.max(0, Math.min(100, num(f.percent)))}%`, background: f.color }} />
                  </div>
                  <div className="mt-1 text-right text-[9px] text-muted">{Math.round(num(f.percent))}%</div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted">{printer.online ? "暂无耗材信息" : "—"}</p>
      )}
    </Card>
  );
}

// ---------- maintenance (admin) ----------
function MaintenanceCard({ printerId, notify }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    api(`/api/printers/${printerId}/maintenance`)
      .then((m) => {
        if (alive) setData(m);
      })
      .catch(() => {
        if (alive) setData(null);
      });
    return () => {
      alive = false;
    };
  }, [printerId]);

  const markDone = async (taskId) => {
    try {
      setData(await api(`/api/printers/${printerId}/maintenance/${taskId}`, { method: "POST" }));
      notify("已记录维护 ✓");
    } catch (error) {
      notify(error.message);
    }
  };

  if (!data) return <Card title="维护提醒"><p className="text-xs text-muted">—</p></Card>;
  return (
    <Card title="维护提醒" extra={<span className="text-[10px] text-muted">累计 {data.hours.toLocaleString("zh-CN")} 小时</span>}>
      <div className="space-y-4">
        {data.tasks.map((task) => {
          const pct = Math.min(100, (task.since_hours / task.hours) * 100);
          return (
            <div key={task.id}>
              <div className="flex items-center justify-between gap-2">
                <span className={`text-xs ${task.due ? "text-amber-300" : "text-[#d5d8df]"}`}>{task.name}</span>
                <button
                  onClick={() => markDone(task.id)}
                  className={`rounded-lg px-2 py-1 text-[10px] transition ${task.due ? "bg-lime text-ink" : "border border-line text-[#aeb4c0] hover:bg-white/[.05]"}`}
                >
                  完成
                </button>
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-white/[.07]">
                <div className={`h-1.5 rounded-full ${task.due ? "bg-amber-300" : "bg-[#4b586c]"}`} style={{ width: `${pct}%` }} />
              </div>
              <small className="mt-1 block text-[9px] text-muted">
                {task.due ? "已到期" : `${Math.max(0, Math.round(task.hours - task.since_hours))} 小时后`} · {Math.round(task.since_hours)} / {task.hours} 小时
                {task.done_at ? ` · 完成于 ${new Date(task.done_at * 1000).toLocaleDateString("zh-CN")}` : ""}
              </small>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------- smart plug (admin) ----------
function PlugCard({ printerId, notify }) {
  const [plug, setPlug] = useState(null);

  const load = async () => {
    try {
      setPlug(await api(`/api/printers/${printerId}/plug`));
    } catch {
      setPlug({ configured: false });
    }
  };

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printerId]);

  if (!plug || !plug.configured) return null;

  const set = async (on) => {
    try {
      await api(`/api/printers/${printerId}/plug`, { method: "POST", body: JSON.stringify({ on }) });
      notify(on ? "插座已开启" : "插座已关闭");
    } catch (error) {
      notify(error.message);
    }
    window.setTimeout(load, 800);
  };

  const stateLabel = !plug.reachable ? "无法连接" : plug.on ? "已开启" : "已关闭";
  return (
    <Card
      title="智能插座"
      extra={
        <span className={`rounded-full px-2.5 py-1 text-[10px] ${!plug.reachable ? "bg-red-400/10 text-red-300" : plug.on ? "bg-lime/10 text-lime" : "bg-white/[.05] text-[#9298a5]"}`}>
          {stateLabel}
        </span>
      }
    >
      <p className="text-[10px] leading-relaxed text-muted">
        {plug.pending ||
          (plug.auto_off
            ? `打印结束且所有喷嘴温度低于 ${plug.off_below || 50} °C 后自动断电${plug.delay_min ? `，延迟 ${plug.delay_min} 分钟` : ""}。`
            : "自动断电已关闭（可在设置中启用）。")}
      </p>
      <div className="mt-3 flex gap-2">
        <button onClick={() => set(true)} className="rounded-lg bg-lime px-3 py-1.5 text-[11px] font-semibold text-ink">开启电源</button>
        <button
          onClick={() => {
            if (window.confirm("确定要关闭打印机电源吗？")) set(false);
          }}
          className="rounded-lg border border-line px-3 py-1.5 text-[11px] text-[#c2c6ce] transition hover:bg-white/[.04]"
        >
          关闭电源
        </button>
      </div>
    </Card>
  );
}

// ---------- recent prints ----------
function RecentCard({ printerId, printerName }) {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    let alive = true;
    api(`/api/history?printer=${encodeURIComponent(printerId)}&limit=5`)
      .then((data) => {
        if (alive) setRows(data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [printerId]);

  const label = { completed: "已完成", running: "进行中", failed: "失败", stopped: "已停止" };
  return (
    <Card title="最近打印" extra={<span className="text-[10px] text-muted">{printerName}</span>}>
      {rows.length ? (
        <div className="space-y-3">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-ink">
                {row.thumb ? <img src={`/api/history/media/${encodeURIComponent(row.thumb)}`} alt="" loading="lazy" className="h-full w-full object-cover" /> : <span className="text-xs text-[#6f7683]">▤</span>}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-medium text-[#e0e2e8]">{prettyName(row.file) || "未命名任务"}</div>
                <div className="mt-0.5 text-[9px] text-muted">{formatDate(row.started_at)}{row.duration_s ? ` · ${formatDuration(row.duration_s)}` : ""}</div>
              </div>
              <span className={`shrink-0 text-[9px] ${row.status === "running" ? "text-lime" : row.status === "failed" ? "text-red-300" : "text-[#8f96a3]"}`}>
                {row.status === "running" ? `${row.progress || 0}%` : label[row.status] || row.status}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted">该打印机还没有打印记录。</p>
      )}
    </Card>
  );
}

// ---------- files on the printer ----------
export function FilesCard({ printer, isAdmin, notify }) {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const [startAfter, setStartAfter] = useState(true);
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const load = async () => {
    setError("");
    setFiles(null);
    try {
      setFiles(await api(`/api/printers/${printer.id}/files`));
    } catch (loadError) {
      setError(loadError.message);
      setFiles([]);
    }
  };

  useEffect(() => {
    setFiles(null);
    setSearch("");
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printer.id]);

  const upload = async (fileList) => {
    if (!isAdmin || !fileList?.length) return;
    for (const file of fileList) {
      if (!file.name.toLowerCase().endsWith(".gcode")) {
        notify("仅支持上传 .gcode 文件；请先在切片软件中导出 G-code");
        continue;
      }
      const body = new FormData();
      body.set("file", file);
      body.set("start", String(startAfter));
      setUploading(true);
      try {
        await api(`/api/printers/${printer.id}/upload`, { method: "POST", body });
        notify(startAfter ? "已上传并开始打印" : "文件已上传");
        window.setTimeout(load, 1200);
      } catch (uploadError) {
        notify(uploadError.message);
      } finally {
        setUploading(false);
      }
    }
  };

  const busy = BUSY_STATES.includes(printer.state);
  const list = (files || []).filter((f) => !search || String(f.name).toLowerCase().includes(search.toLowerCase()));

  return (
    <Card
      title="打印机上的文件"
      extra={
        <button onClick={load} className="rounded-lg border border-line px-2.5 py-1 text-[10px] text-[#c2c6ce] transition hover:bg-white/[.04]">
          刷新
        </button>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索文件…"
          className="w-full rounded-lg border border-line bg-ink px-3 py-2 text-xs text-white outline-none focus:border-lime"
        />
      </div>

      {isAdmin && (
        <label
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            upload(event.dataTransfer.files);
          }}
          className={`mb-3 block cursor-pointer rounded-xl border border-dashed px-4 py-4 text-center transition ${dragOver ? "border-lime bg-lime/[.06]" : "border-[#333a46] bg-white/[.02] hover:border-[#46505e]"}`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".gcode"
            multiple
            className="hidden"
            onChange={(event) => {
              upload(event.target.files);
              event.target.value = "";
            }}
          />
          <span className="block text-xs text-[#c2c6ce]">{uploading ? "上传中…" : "将 .gcode 文件拖到此处，或点击上传"}</span>
          <span className="mt-1 block text-[10px] text-muted">文件保存在打印机本地存储</span>
        </label>
      )}

      {isAdmin && (
        <label className="mb-3 flex items-center gap-2 text-[11px] text-[#b8bdc7]">
          <input type="checkbox" checked={startAfter} onChange={(event) => setStartAfter(event.target.checked)} />
          上传后立即开始打印
        </label>
      )}

      {files === null && !error && <p className="py-3 text-center text-xs text-muted">正在加载文件…</p>}
      {error && <p className="py-3 text-center text-xs text-red-300">{error}</p>}
      {files !== null && !error && !files.length && (
        <p className="py-3 text-center text-xs text-muted">打印机上没有文件。</p>
      )}
      {files !== null && list.length > 0 && (
        <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
          {list.map((file) => (
            <div key={file.name} className="flex items-center gap-3 rounded-xl border border-line bg-ink px-3 py-2">
              <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-black/40">
                <img
                  src={thumbUrl(printer.id, file.name)}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                  onError={(event) => {
                    event.currentTarget.style.visibility = "hidden";
                  }}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-medium text-[#e0e2e8]" title={file.name}>{prettyName(file.name)}</div>
                <div className="mt-0.5 truncate text-[9px] text-muted">
                  {[
                    file.timeCost ? `⏱ ${formatDuration(file.timeCost)}` : "",
                    file.material ? String(file.material).split(";")[0] : "",
                    file.consumables ? `${(file.consumables / 1000).toFixed(1)} m` : "",
                    file.file_size ? `${(file.file_size / 1048576).toFixed(1)} MB` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              {isAdmin && (
                <div className="flex shrink-0 gap-1.5">
                  <button
                    disabled={busy}
                    onClick={async () => {
                      if (!window.confirm(`开始打印 ${prettyName(file.name)} 吗？`)) return;
                      try {
                        await api(`/api/printers/${printer.id}/print`, { method: "POST", body: JSON.stringify({ name: file.name }) });
                        notify("已开始打印");
                      } catch (printError) {
                        notify(printError.message);
                      }
                    }}
                    className="rounded-lg bg-lime px-2.5 py-1 text-[10px] font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-40"
                    title={busy ? "打印任务进行中" : ""}
                  >
                    打印
                  </button>
                  <button
                    onClick={async () => {
                      if (!window.confirm(`从打印机中删除 ${prettyName(file.name)} 吗？`)) return;
                      try {
                        await api(`/api/printers/${printer.id}/delete`, { method: "POST", body: JSON.stringify({ name: file.name }) });
                        notify("文件已删除");
                        window.setTimeout(load, 800);
                      } catch (deleteError) {
                        notify(deleteError.message);
                      }
                    }}
                    className="rounded-lg border border-line px-2 py-1 text-[10px] text-[#aeb4c0] transition hover:bg-white/[.06]"
                    aria-label={`删除 ${file.name}`}
                  >
                    🗑
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {files !== null && files.length > 0 && list.length === 0 && (
        <p className="py-2 text-center text-xs text-muted">没有匹配的文件。</p>
      )}
    </Card>
  );
}

// ---------- main detail view ----------
export default function PrinterDetail({ printer, isAdmin, notify, onClose }) {
  const p = printer.raw;
  const d = p.data || {};
  const [editOpen, setEditOpen] = useState(false);
  const [step, setStep] = useState(10);
  const [consoleInput, setConsoleInput] = useState("");
  const [fanLocal, setFanLocal] = useState([null, null, null]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = async (params, okMsg) => {
    try {
      await sendCommand(printer.id, params);
      if (okMsg) notify(okMsg);
    } catch (error) {
      notify(error.message);
    }
  };
  const gcode = (cmd, okMsg) => send({ gcodeCmd: cmd }, okMsg);

  const error = p.error;
  const raw = rawState(printer);
  const live = jobBusy(raw);
  const active = Boolean(d.printFileName) && (live || raw === "completed");
  const pct = active ? Math.max(0, Math.min(100, num(d.printProgress ?? d.dProgress) ?? 0)) : 0;
  const eta = active && live ? clockFrom(d.printLeftTime) : null;
  const used = num(d.usedMaterialLength);
  const moving = BUSY_STATES.includes(printer.state);
  const lightOn = ["1", "true", "on"].includes(String(d.lightSw).toLowerCase());
  const commitFan = (index) => {
    const value = fanLocal[index];
    if (value === null || value === undefined) return;
    gcode(`M106 P${index} S${Math.round((255 * value) / 100)}`);
    setFanLocal((current) => current.map((v, i) => (i === index ? null : v)));
  };

  const fanData = [d.modelFanPct, d.caseFanPct, d.auxiliaryFanPct];
  const fanLabels = ["模型风扇", "腔体风扇", "侧面风扇"];
  const feedrate = num(d.curFeedratePct);

  const alertActions = [];
  if (isAdmin && error) {
    if (error.resumable) {
      alertActions.push(
        { label: "恢复打印", primary: true, run: () => send({ repoPlrStatus: 1 }, "正在恢复中断的打印…") },
        {
          label: "取消",
          run: () => {
            if (window.confirm("确定放弃中断的打印任务吗？")) send({ repoPlrStatus: 0 }, "已放弃打印任务");
          },
        },
      );
    } else if (printer.state === "paused") {
      alertActions.push(
        { label: "继续打印", primary: true, run: () => send({ pause: 0 }, "已请求继续打印") },
        {
          label: "停止",
          danger: true,
          run: () => {
            if (window.confirm("确定停止打印吗？")) send({ stop: 1 }, "已请求停止");
          },
        },
      );
    }
    if (!error.resumable) {
      alertActions.push({ label: "忽略提醒", run: () => send({ cleanErr: 1 }, "提醒已清除") });
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/75 p-3 sm:p-6" onClick={onClose} role="presentation">
      <div
        className="mx-auto w-full max-w-6xl rounded-2xl border border-line bg-panel shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${printer.name} 详情`}
      >
        {/* header */}
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-4 sm:px-5">
          <img src={modelUrl(p)} alt="" className="h-11 w-11 shrink-0 rounded-xl bg-ink object-contain p-1" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold text-white">{printer.name}</h2>
              <span className={`rounded-full px-2.5 py-1 text-[10px] ${error ? "bg-red-400/10 text-red-300" : PILL_STYLE[printer.state] || "bg-white/[.05] text-[#9298a5]"}`}>
                {error ? error.title : STATE_LABEL[printer.state] || printer.state}
              </span>
              {printer.raw.maintenance_due > 0 && isAdmin && (
                <span className="rounded-full bg-amber-300/10 px-2.5 py-1 text-[10px] text-amber-300">🔧 维护提醒 ({printer.raw.maintenance_due})</span>
              )}
              {printer.raw.plug_pending && (
                <span className="rounded-full bg-white/[.05] px-2.5 py-1 text-[10px] text-[#c2c6ce]">⏻ {printer.raw.plug_pending}</span>
              )}
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted">
              {p.model || "未知型号"} · {p.host}
              {p.mac ? ` · MAC …${p.mac.slice(-4)}` : ""}
            </p>
          </div>
          {isAdmin && (
            <div className="flex items-center gap-2">
              <button onClick={() => setEditOpen(true)} className="rounded-lg border border-line px-3 py-1.5 text-[11px] text-[#c2c6ce] transition hover:bg-white/[.04]">编辑</button>
              <button
                onClick={async () => {
                  if (!window.confirm(`确定重启“${printer.name}”吗？打印机将暂时离线约一分钟。`)) return;
                  try {
                    await api(`/api/printers/${printer.id}/reboot`, { method: "POST" });
                    notify("已请求重启。");
                  } catch (rebootError) {
                    notify(rebootError.message);
                  }
                }}
                disabled={!printer.online || moving}
                className="rounded-lg border border-line px-3 py-1.5 text-[11px] text-[#c2c6ce] transition hover:bg-white/[.04] disabled:cursor-not-allowed disabled:opacity-40"
              >
                重启
              </button>
              <button
                onClick={async () => {
                  if (!window.confirm(`确定从列表中移除“${printer.name}”吗？`)) return;
                  try {
                    await api(`/api/printers/${printer.id}`, { method: "DELETE" });
                    onClose();
                  } catch (removeError) {
                    notify(removeError.message);
                  }
                }}
                className="rounded-lg border border-red-400/30 px-3 py-1.5 text-[11px] text-red-300 transition hover:bg-red-400/10"
              >
                移除
              </button>
            </div>
          )}
          <button onClick={onClose} aria-label="关闭详情" className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted transition hover:text-white">✕</button>
        </div>

        {/* alert */}
        {error && (
          <div className={`m-4 rounded-xl border px-4 py-3 sm:m-5 ${error.level === "warning" ? "border-amber-300/30 bg-amber-300/[.07]" : "border-red-400/30 bg-red-400/[.07]"}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={`text-sm font-semibold ${error.level === "warning" ? "text-amber-300" : "text-red-300"}`}>{error.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-[#c8ccd4]">{error.advice}</p>
                <p className="mt-1 text-[10px] text-muted">错误代码 {error.code}</p>
              </div>
              {alertActions.length > 0 && (
                <div className="flex shrink-0 gap-2">
                  {alertActions.map((action) => (
                    <button
                      key={action.label}
                      onClick={action.run}
                      className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold transition ${
                        action.primary
                          ? "bg-lime text-ink"
                          : action.danger
                            ? "border border-red-400/40 text-red-300 hover:bg-red-400/10"
                            : "border border-line text-[#c2c6ce] hover:bg-white/[.04]"
                      }`}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_330px]">
          {/* left column */}
          <div className="min-w-0 space-y-4">
            <Camera
              printer={printer}
              isAdmin={isAdmin}
              onReset={async () => {
                try {
                  await api(`/api/printers/${printer.id}/camera/reset`, { method: "POST" });
                  notify("摄像头已重置，正在重新连接…");
                } catch (resetError) {
                  notify(resetError.message);
                }
              }}
            />

            {/* print job and controls */}
            <Card>
              <div className="flex flex-wrap items-center gap-4">
                <div className="grid h-[84px] w-[84px] shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-ink">
                  {active ? (
                    <img src={thumbUrl(printer.id, d.printFileName)} alt="" className="h-full w-full object-cover" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />
                  ) : (
                    <span className="text-xl text-[#4b525e]">▤</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 text-[11px] text-muted">打印任务</div>
                  <div className="truncate text-sm font-medium text-white">{active ? prettyName(d.printFileName) : p.online ? "当前没有打印任务" : "打印机离线"}</div>
                  <div className="mt-1 text-[11px] text-muted">
                    {raw === "completed"
                      ? "打印已完成"
                      : eta
                        ? `预计完成 ${eta} · 剩余 ${formatDuration(d.printLeftTime)}`
                        : active
                          ? "任务进行中"
                          : p.online
                            ? "等待新的打印任务"
                            : `无法连接 ${p.host}`}
                  </div>
                </div>
                <Ring value={pct} size={88} color={printer.color} />
              </div>
              <div className="mt-4 grid grid-cols-3 overflow-hidden rounded-xl border border-line">
                {[
                  ["图层", active && d.TotalLayer ? `${d.layer ?? 0} / ${d.TotalLayer}` : "—"],
                  ["已用时", active ? formatDuration(d.printJobTime) : "—"],
                  ["剩余时间", active ? formatDuration(d.printLeftTime) : "—"],
                  ["速度", active && num(d.realTimeSpeed) !== null ? `${Math.round(num(d.realTimeSpeed))} mm/s` : "—"],
                  ["流量", active && num(d.realTimeFlow) !== null ? `${num(d.realTimeFlow).toFixed(1)} mm³/s` : "—"],
                  ["耗材用量", active && used ? (used >= 1000 ? `${(used / 1000).toFixed(2)} m` : `${Math.round(used)} mm`) : "—"],
                ].map(([label, value], index) => (
                  <div key={label} className={`min-w-0 px-3 py-2.5 ${index < 3 ? "border-b border-line" : ""} ${index % 3 !== 2 ? "border-r border-line" : ""}`}>
                    <div className="text-[10px] text-muted">{label}</div>
                    <div className="mt-1 truncate text-sm font-semibold text-[#daddE4]">{value}</div>
                  </div>
                ))}
              </div>
              {isAdmin && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    disabled={!["printing", "paused"].includes(printer.state)}
                    onClick={() => {
                      const paused = printer.state === "paused";
                      send({ pause: paused ? 0 : 1 }, paused ? "已请求继续打印" : "已请求暂停");
                    }}
                    className="rounded-lg border border-line bg-[#171b23] px-4 py-2 text-xs font-medium text-[#e1e4ea] transition hover:bg-white/[.04] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {printer.state === "paused" ? "继续打印" : "暂停"}
                  </button>
                  <button
                    disabled={!moving}
                    onClick={() => {
                      if (window.confirm("确定停止当前打印吗？停止后无法继续。")) send({ stop: 1 }, "已请求停止");
                    }}
                    className="rounded-lg border border-red-400/40 px-4 py-2 text-xs text-red-300 transition hover:bg-red-400/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    停止
                  </button>
                  <button
                    type="button"
                    disabled={!p.online}
                    onClick={() => send({ lightSw: lightOn ? 0 : 1 }, "照明切换指令已发送")}
                    aria-pressed={lightOn}
                    className={`ml-auto rounded-lg border px-4 py-2 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${lightOn ? "border-amber-300/50 bg-amber-300/10 text-amber-300" : "border-line text-[#c2c6ce] hover:bg-white/[.04]"}`}
                  >
                    <span className={`mr-2 inline-block h-2 w-2 rounded-full ${lightOn ? "bg-amber-400" : "bg-[#656b76]"}`} />
                    照明
                  </button>
                </div>
              )}
            </Card>

            <TemperatureCard printer={printer} isAdmin={isAdmin} notify={notify} />
            <FilesCard printer={printer} isAdmin={isAdmin} notify={notify} />
          </div>

          {/* right column */}
          <aside className="min-w-0 space-y-4">
            <FilamentCard printer={printer} />
            {isAdmin && (
              <>
                <Card title="风扇与速度">
                  <div className="space-y-3">
                    {fanLabels.map((label, index) => {
                      const value = fanLocal[index] ?? num(fanData[index]) ?? 0;
                      return (
                        <label key={label} className="flex items-center gap-3 text-xs text-[#b8bdc7]">
                          <span className="w-16 shrink-0">{label}</span>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step="5"
                            value={value}
                            disabled={fanData[index] === undefined}
                            onChange={(event) => {
                              const v = Number(event.target.value);
                              setFanLocal((current) => current.map((old, i) => (i === index ? v : old)));
                            }}
                            onPointerUp={() => commitFan(index)}
                            onKeyUp={() => commitFan(index)}
                            className="min-w-0 flex-1 accent-[#c5f36b]"
                          />
                          <output className="w-10 shrink-0 text-right text-[11px] text-white">{fanData[index] === undefined ? "—" : `${value}%`}</output>
                        </label>
                      );
                    })}
                    <label className="flex items-center gap-3 text-xs text-[#b8bdc7]">
                      <span className="w-16 shrink-0">打印速度</span>
                      <SpeedSlider value={feedrate} onCommit={(v) => send({ setFeedratePct: v }, "速度已更新")} />
                      <output className="w-10 shrink-0 text-right text-[11px] text-white">{d.curFeedratePct === undefined ? "—" : `${feedrate ?? 100}%`}</output>
                    </label>
                  </div>
                </Card>

                <Card title="移动" extra={<span className="font-mono text-[9px] text-muted">{d.curPosition ? String(d.curPosition).replace(/:/g, " ") : ""}</span>}>
                  <div className="flex w-full overflow-hidden rounded-lg border border-line">
                    {[0.1, 1, 10, 50].map((value) => (
                      <button
                        key={value}
                        onClick={() => setStep(value)}
                        className={`flex-1 px-2 py-2 text-[10px] ${step === value ? "bg-[#1c222b] text-lime" : "text-[#9298a5] hover:bg-white/[.04]"}`}
                      >
                        {value === 50 ? "50 mm" : value}
                      </button>
                    ))}
                  </div>
                  <div className="mt-4 grid grid-cols-[1fr_auto] items-center justify-items-center gap-3">
                    <div className="grid w-full max-w-[190px] grid-cols-3 gap-2">
                      <span />
                      <JogButton label="Y+" axis="Y" dir={1} step={step} onJog={gcode} disabled={!p.online || moving} />
                      <span />
                      <JogButton label="X−" axis="X" dir={-1} step={step} onJog={gcode} disabled={!p.online || moving} />
                      <HomeButton label="⌂" title="X/Y 轴归零" value="X Y" onHome={send} disabled={!p.online || moving} />
                      <JogButton label="X+" axis="X" dir={1} step={step} onJog={gcode} disabled={!p.online || moving} />
                      <span />
                      <JogButton label="Y−" axis="Y" dir={-1} step={step} onJog={gcode} disabled={!p.online || moving} />
                      <span />
                    </div>
                    <div className="grid gap-2">
                      <JogButton label="Z+" axis="Z" dir={1} step={step} onJog={gcode} disabled={!p.online || moving} />
                      <HomeButton label="⌂" title="Z 轴归零" value="Z" onHome={send} disabled={!p.online || moving} />
                      <JogButton label="Z−" axis="Z" dir={-1} step={step} onJog={gcode} disabled={!p.online || moving} />
                    </div>
                  </div>
                  <button
                    onClick={() => send({ autohome: "X Y Z" }, "正在归零…")}
                    disabled={!p.online || moving}
                    className="mt-3 w-full rounded-lg border border-line px-3 py-2 text-[11px] text-[#c2c6ce] transition hover:bg-white/[.04] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    全部归零 (G28)
                  </button>
                  {moving && <p className="mt-2 text-[10px] text-amber-300">打印任务进行中，轴移动已禁用。</p>}
                </Card>
              </>
            )}
            {isAdmin && <MaintenanceCard printerId={printer.id} notify={notify} />}
            {isAdmin && <PlugCard printerId={printer.id} notify={notify} />}
            <RecentCard printerId={printer.id} printerName={printer.name} />
            {isAdmin && (
              <Card title="G-code 控制台">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const value = consoleInput.trim();
                    if (!value) return;
                    gcode(value, `已发送：${value}`);
                    setConsoleInput("");
                  }}
                  className="flex gap-2"
                >
                  <input
                    value={consoleInput}
                    onChange={(event) => setConsoleInput(event.target.value)}
                    placeholder="例如：M104 S200"
                    autoComplete="off"
                    spellCheck="false"
                    className="w-full rounded-lg border border-line bg-ink px-3 py-2 font-mono text-xs text-white outline-none focus:border-lime"
                  />
                  <button className="shrink-0 rounded-lg bg-lime px-4 py-2 text-xs font-semibold text-ink">发送</button>
                </form>
              </Card>
            )}
          </aside>
        </div>
      </div>

      {editOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={() => setEditOpen(false)}>
          <form
            onClick={(event) => event.stopPropagation()}
            onSubmit={async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              try {
                await api(`/api/printers/${printer.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({ name: form.get("name"), host: form.get("host") }),
                });
                setEditOpen(false);
                notify("打印机信息已更新");
              } catch (editError) {
                notify(editError.message);
              }
            }}
            className="w-full max-w-sm rounded-2xl border border-line bg-panel p-6"
          >
            <div className="mb-5 flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">编辑打印机</h3>
              <button type="button" onClick={() => setEditOpen(false)} aria-label="关闭" className="text-muted">✕</button>
            </div>
            <label className="mb-4 block text-xs text-[#b8bdc7]">
              名称
              <input name="name" defaultValue={p.name} required className="mt-2 w-full rounded-lg border border-line bg-ink px-3 py-2.5 text-sm text-white outline-none focus:border-lime" />
            </label>
            <label className="mb-3 block text-xs text-[#b8bdc7]">
              IP 地址
              <input name="host" defaultValue={p.host} required className="mt-2 w-full rounded-lg border border-line bg-ink px-3 py-2.5 text-sm text-white outline-none focus:border-lime" />
            </label>
            {p.mac && <p className="mb-4 text-[10px] leading-relaxed text-muted">MAC 地址 {p.mac}：如果路由器更改了打印机 IP，应用会自动重新发现它。</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditOpen(false)} className="rounded-lg border border-line px-4 py-2 text-xs text-[#b8bdc7]">取消</button>
              <button className="rounded-lg bg-lime px-4 py-2 text-xs font-semibold text-ink">保存</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function SpeedSlider({ value, onCommit }) {
  const [local, setLocal] = useState(value ?? 100);
  useEffect(() => {
    setLocal(value ?? 100);
  }, [value]);
  return (
    <input
      type="range"
      min="50"
      max="200"
      step="10"
      value={local}
      onChange={(event) => setLocal(Number(event.target.value))}
      onPointerUp={() => onCommit(local)}
      onKeyUp={() => onCommit(local)}
      className="flex-1 accent-[#c5f36b]"
    />
  );
}

function JogButton({ label, axis, dir, step, onJog, disabled }) {
  return (
    <button
      disabled={disabled}
      onClick={() => {
        const offset = step * dir;
        onJog(`G91\nG1 ${axis}${offset} F${axis === "Z" ? 600 : 6000}\nG90`, "已发送移动指令");
      }}
      className="rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-[#c2c6ce] transition hover:bg-white/[.05] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function HomeButton({ label, title, value, onHome, disabled }) {
  return (
    <button
      disabled={disabled}
      title={title}
      onClick={() => onHome({ autohome: value }, "正在归零…")}
      className="rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-[#c2c6ce] transition hover:bg-white/[.05] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}
