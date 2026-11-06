import { useEffect, useRef, useState } from "react";
import { STATE_LABEL, modelUrl, num, prettyName, thumbUrl, degrees, formatDuration, clockFrom, filamentList } from "../api.js";
import PrinterDetail from "./PrinterDetail.jsx";

const CARD_PILL = {
  printing: "bg-lime/10 text-lime",
  completed: "bg-lime/10 text-lime",
  processing: "bg-sky-300/10 text-sky-300",
  idle: "bg-sky-300/10 text-sky-300",
  ready: "bg-sky-300/10 text-sky-300",
  paused: "bg-amber-300/10 text-amber-300",
  self_test: "bg-amber-300/10 text-amber-300",
  error: "bg-red-400/10 text-red-300",
  offline: "bg-white/[.05] text-[#9298a5]",
  stopped: "bg-white/[.05] text-[#9298a5]",
};

/** Camera snapshot that reloads itself (one connection at a time, like the classic UI). */
function Snapshot({ printer }) {
  const [src, setSrc] = useState("");
  const timerRef = useRef(null);

  const schedule = (delay) => {
    window.clearTimeout(timerRef.current);
    if (!printer.online) return;
    timerRef.current = window.setTimeout(
      () => setSrc(`/api/printers/${printer.id}/snapshot?t=${Date.now()}`),
      delay,
    );
  };

  useEffect(() => {
    window.clearTimeout(timerRef.current);
    setSrc(printer.online ? `/api/printers/${printer.id}/snapshot?t=${Date.now()}` : "");
    return () => window.clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printer.id, printer.online]);

  if (!src) return null;
  return (
    <img
      src={src}
      alt={`${printer.name} 摄像头画面`}
      className="absolute inset-0 h-full w-full object-cover"
      onLoad={() => schedule(2000)}
      onError={() => schedule(5000)}
    />
  );
}

function PrinterGridCard({ printer, onOpen }) {
  const d = printer.raw.data || {};
  const raw = printer.raw.state;
  const active = Boolean(d.printFileName) && ["printing", "paused", "processing", "self_test", "completed"].includes(raw);
  const pct = active ? Math.max(0, Math.min(100, num(d.printProgress ?? d.dProgress) ?? 0)) : 0;
  const eta = active && ["printing", "processing"].includes(raw) ? clockFrom(d.printLeftTime) : null;
  const filament = filamentList(d)[0];
  const error = printer.raw.error;

  return (
    <button
      onClick={() => onOpen(printer.id)}
      className="overflow-hidden rounded-2xl border border-line bg-panel text-left transition hover:border-[#3a414e]"
    >
      <div className="relative h-[164px] overflow-hidden bg-[linear-gradient(145deg,#191d25,#11141a)]">
        {printer.online && <Snapshot printer={printer} />}
        {!printer.online && (
          <div className="absolute inset-0 grid place-items-center">
            <img src={modelUrl(printer.raw)} alt="" className="max-h-[120px] opacity-40" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30" />
        <span className={`absolute left-3 top-3 rounded-full px-2.5 py-1 text-[10px] backdrop-blur ${error ? "bg-red-500/20 text-red-200" : CARD_PILL[printer.state] || "bg-black/40 text-white"}`}>
          {error ? error.title : STATE_LABEL[printer.state] || printer.state}
        </span>
        <div className="absolute inset-x-3 bottom-3">
          <div className="truncate text-xs font-medium text-white drop-shadow">
            {active
              ? raw === "completed"
                ? `已完成 · ${prettyName(d.printFileName)}`
                : prettyName(d.printFileName)
              : printer.online
                ? "可用 · 等待任务"
                : `无法连接 ${printer.raw.host}`}
          </div>
          <div className="mt-1.5 h-1 rounded-full bg-white/20">
            <div className="h-1 rounded-full" style={{ width: `${active ? pct : 0}%`, background: printer.color }} />
          </div>
        </div>
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-[15px] font-semibold text-white">{printer.name}</h3>
              <i className={`h-1.5 w-1.5 shrink-0 rounded-full ${error ? "bg-red-300" : printer.state === "printing" ? "bg-lime" : printer.state === "paused" ? "bg-amber-300" : printer.online ? "bg-sky-300" : "bg-[#656b76]"}`} />
            </div>
            <p className="mt-1 truncate text-[11px] text-muted">{printer.model}</p>
          </div>
          {active && <span className="shrink-0 text-sm font-semibold" style={{ color: printer.color }}>{Math.round(pct)}%</span>}
        </div>
        <div className="mt-4 flex items-center justify-between gap-2 text-[10px] text-muted">
          <span className="truncate">
            {active ? (raw === "completed" ? "打印完成" : eta ? `预计完成 ${eta}` : "任务进行中") : "喷嘴 / 热床"}
          </span>
          <span className="flex shrink-0 gap-3">
            <span>喷嘴 <b className="ml-1 font-medium text-[#d7d9df]">{degrees(d.nozzleTemp)}</b></span>
            <span>热床 <b className="ml-1 font-medium text-[#d7d9df]">{degrees(d.bedTemp0)}</b></span>
          </span>
        </div>
        {(filament || printer.raw.maintenance_due > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            {filament && (
              <span className="flex items-center gap-1.5 rounded-full bg-white/[.04] px-2 py-1 text-[9px] text-[#c2c6ce]">
                <i className="h-2.5 w-2.5 rounded-full" style={{ background: filament.color }} />
                {filament.type || filament.name || "耗材"}
              </span>
            )}
            {printer.raw.maintenance_due > 0 && (
              <span className="rounded-full bg-amber-300/10 px-2 py-1 text-[9px] text-amber-300">🔧 维护 ({printer.raw.maintenance_due})</span>
            )}
            {active && raw !== "completed" && d.printLeftTime ? <span className="ml-auto text-[9px] text-muted">剩余 {formatDuration(d.printLeftTime)}</span> : null}
          </div>
        )}
      </div>
    </button>
  );
}

export default function PrintersPage({ printers, isAdmin, notify, onAdd }) {
  const [selectedId, setSelectedId] = useState(null);
  const selected = printers.find((printer) => printer.id === selectedId) || null;

  const count = (predicate) => printers.filter(predicate).length;
  const chips = [
    [count((p) => ["printing", "processing", "self_test"].includes(p.raw.state)), "打印中"],
    [count((p) => p.raw.state === "paused"), "已暂停"],
    [count((p) => p.raw.state === "idle" || p.raw.state === "completed"), "就绪"],
    [count((p) => p.raw.state === "error" || p.raw.error), "需要处理"],
    [count((p) => !p.online), "离线"],
  ].filter(([n]) => n);

  return (
    <div>
      <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[.2em] text-lime"><span className="h-px w-5 bg-lime" />Devices</div>
          <h1 className="mt-3 text-[26px] font-semibold tracking-[-.04em] text-white sm:text-[30px]">打印机</h1>
          <p className="mt-2 text-xs text-[#888e9c]">点击设备卡片查看摄像头、控制和文件。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {chips.map(([n, label]) => (
            <span key={label} className="rounded-full border border-line bg-panel px-3 py-1.5 text-[11px] text-[#c2c6ce]">
              <b className="mr-1 font-semibold text-white">{n}</b>
              {label}
            </span>
          ))}
          {isAdmin && (
            <button onClick={onAdd} className="rounded-lg bg-lime px-3.5 py-2 text-[11px] font-semibold text-ink transition hover:bg-[#d5ff80]">
              ＋ 添加打印机
            </button>
          )}
        </div>
      </section>

      <div className="mt-6 grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {printers.length ? (
          printers.map((printer) => <PrinterGridCard key={printer.id} printer={printer} onOpen={setSelectedId} />)
        ) : (
          <div className="col-span-full rounded-2xl border border-line bg-panel p-10 text-center">
            <p className="text-sm text-white">还没有添加打印机</p>
            <p className="mt-2 text-xs text-muted">{isAdmin ? "使用“添加打印机”录入 IP 地址，或扫描局域网自动发现。" : "请联系管理员添加打印机。"}</p>
          </div>
        )}
      </div>

      {selected && (
        <PrinterDetail
          printer={selected}
          isAdmin={isAdmin}
          notify={notify}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
