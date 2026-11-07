import { useEffect, useMemo, useState } from "react";
import { api, mediaUrl, num, prettyName, formatDate, formatDuration, formatGrams, formatHours, formatMoney } from "../api.js";

const STATUS_LABEL = { completed: "已完成", running: "进行中", failed: "失败", stopped: "已停止" };
const STATUS_PILL = {
  completed: "bg-lime/10 text-lime",
  running: "bg-sky-300/10 text-sky-300",
  failed: "bg-red-400/10 text-red-300",
  stopped: "bg-white/[.05] text-[#9298a5]",
};

const rowCost = (row) => (num(row.cost_filament) ?? 0) + (num(row.cost_energy) ?? 0);

function HistoryRow({ row, isAdmin, onDelete, onView, showPrinter }) {
  const cost = rowCost(row);
  const hasImage = Boolean(row.photo || row.thumb);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel px-3 py-3">
      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-line bg-ink">
        {row.thumb && <img src={mediaUrl(row.thumb)} alt="" loading="lazy" className="h-full w-full object-cover" />}
        {row.photo && (
          <img
            src={mediaUrl(row.photo)}
            alt="最终打印照片"
            loading="lazy"
            title="在新标签打开最终照片"
            onClick={() => window.open(mediaUrl(row.photo), "_blank")}
            className="absolute inset-0 h-full w-full cursor-pointer object-cover ring-1 ring-inset ring-black/40"
          />
        )}
        {!hasImage && <div className="grid h-full place-items-center text-xs text-[#4b525e]">▤</div>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-[#e0e2e8]">{prettyName(row.file) || "未命名任务"}</div>
        <div className="mt-1 truncate text-[10px] text-muted">
          {showPrinter ? `${row.printer_name || row.printer_id} · ` : ""}
          {formatDate(row.started_at)}
          {row.duration_s ? ` · ${formatDuration(row.duration_s)}` : ""}
        </div>
        {row.filament_breakdown?.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[#9ba1ad]" title="完工用量按各耗材的切片预估占比分摊">
            {row.filament_breakdown.map((filament, index) => {
              const label = filament.profile || filament.type || `耗材 ${index + 1}`;
              const grams = row.status === "running" ? filament.estimated_g : filament.grams;
              return (
                <span key={`${label}-${index}`} className="inline-flex min-w-0 items-center gap-1">
                  {/^#[0-9a-f]{6}$/i.test(filament.color || "") && <i className="h-2 w-2 shrink-0 rounded-full border border-white/20" style={{ backgroundColor: filament.color }} />}
                  <span className="max-w-[150px] truncate">{label}</span>
                  <span className="shrink-0">{formatGrams(grams)}</span>
                </span>
              );
            })}
          </div>
        )}
        {row.error_title && <div className="mt-1 truncate text-[10px] text-red-300">{row.error_title}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <button
          onClick={() => onView(row)}
          className="rounded-lg border border-line px-2 py-1.5 text-[10px] text-[#c2c6ce] transition hover:bg-white/[.06]"
        >详情</button>
        <span className={`rounded-full px-2.5 py-1 text-[10px] ${STATUS_PILL[row.status] || "bg-white/[.05] text-[#9298a5]"}`}>
          {STATUS_LABEL[row.status] || row.status}
          {row.status !== "completed" && row.progress ? ` ${row.progress} %` : ""}
        </span>
        <span className="hidden w-32 text-right text-[10px] text-[#8f96a3] sm:block">
          {row.status === "running" ? "" : `${formatGrams(row.filament_g)} · ${formatMoney(cost)}`}
        </span>
        {isAdmin && (
          <button
            onClick={() => onDelete(row)}
            aria-label="从历史记录中删除"
            title="从历史记录中删除"
            className="rounded-lg border border-line px-2 py-1.5 text-[10px] text-[#aeb4c0] transition hover:bg-white/[.06]"
          >
            🗑
          </button>
        )}
      </div>
    </div>
  );
}

function MetricChart({ rows, metric }) {
  const months = useMemo(() => {
    const now = new Date();
    const keys = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      keys.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: d.toLocaleDateString("zh-CN", { month: "short" }), value: 0 });
    }
    const byKey = new Map(keys.map((m) => [m.key, m]));
    for (const row of rows) {
      const d = new Date(row.started_at * 1000);
      const entry = byKey.get(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      if (!entry) continue;
      entry.value +=
        metric === "cost"
          ? rowCost(row)
          : metric === "hours"
            ? (num(row.duration_s) ?? 0) / 3600
            : metric === "grams"
              ? num(row.filament_g) ?? 0
              : 1;
    }
    return keys;
  }, [rows, metric]);

  const max = Math.max(...months.map((m) => m.value), 0);
  const format = (v) =>
    metric === "cost"
      ? formatMoney(v)
      : metric === "hours"
        ? `${v.toFixed(1)} 小时`
        : metric === "grams"
          ? formatGrams(v)
          : `${v} 次`;

  return (
    <div>
      <div className="relative h-[160px]">
        <div className="absolute inset-0 flex flex-col justify-between">
          {[0, 1, 2, 3].map((line) => (
            <div key={line} className="border-t border-dashed border-white/[.07]" />
          ))}
        </div>
        {max > 0 ? (
          <div className="absolute inset-0 flex items-end gap-[3px]">
            {months.map((month, index) => {
              const height = month.value ? Math.max(4, (month.value / max) * 100) : 0;
              return (
                <div
                  key={month.key}
                  title={`${month.label} · ${format(month.value)}`}
                  className={`min-w-0 flex-1 rounded-t-[2px] ${index === months.length - 1 ? "bg-lime" : "bg-[#4b586c]"}`}
                  style={{ height: `${height}%`, opacity: month.value ? (index === months.length - 1 ? 1 : 0.62) : 0.2 }}
                />
              );
            })}
          </div>
        ) : (
          <div className="absolute inset-0 grid place-items-center text-xs text-muted">暂无数据</div>
        )}
      </div>
      <div className="mt-2 flex justify-between text-[9px] text-[#727987]">
        {months.map((month) => (
          <span key={month.key}>{month.label}</span>
        ))}
      </div>
    </div>
  );
}

export default function HistoryPage({ printers, isAdmin, notify }) {
  const [rows, setRows] = useState(null);
  const [stats, setStats] = useState({ months: [], printers: [] });
  const [printerId, setPrinterId] = useState("");
  const [status, setStatus] = useState("");
  const [metric, setMetric] = useState("hours");
  const [loadError, setLoadError] = useState("");
  const [selectedPrint, setSelectedPrint] = useState(null);

  const load = async () => {
    setLoadError("");
    try {
      const [historyRows, summary] = await Promise.all([api("/api/history?limit=500"), api("/api/stats")]);
      setRows(historyRows);
      setStats(summary);
    } catch (error) {
      setLoadError(error.message);
      setRows([]);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(
    () => (rows || []).filter((row) => (!printerId || row.printer_id === printerId) && (!status || row.status === status)),
    [rows, printerId, status],
  );
  const done = useMemo(() => filtered.filter((row) => row.status !== "running"), [filtered]);
  const okCount = done.filter((row) => row.status === "completed").length;
  const monthKey = new Date().toISOString().slice(0, 7);
  const monthRows = done.filter((row) => new Date(row.started_at * 1000).toISOString().slice(0, 7) === monthKey);
  const sum = (list, pick) => list.reduce((total, row) => total + (num(pick(row)) ?? 0), 0);

  const tiles = [
    ["打印次数", String(done.length), `本月 ${monthRows.length} 次`],
    ["成功率", done.length ? `${Math.round((okCount / done.length) * 100)} %` : "—", `${okCount} / ${done.length} 次成功`],
    ["打印时长", formatHours(sum(done, (row) => row.duration_s)), `本月 ${formatHours(sum(monthRows, (row) => row.duration_s))}`],
    ["耗材用量", formatGrams(sum(done, (row) => row.filament_g)), `本月 ${formatGrams(sum(monthRows, (row) => row.filament_g))}`],
    ["费用", formatMoney(sum(done, rowCost)), `本月 ${formatMoney(sum(monthRows, rowCost))} · 耗材 + 电费`],
  ];

  const perPrinter = useMemo(() => {
    const map = new Map();
    for (const row of done) {
      const entry = map.get(row.printer_id) || {
        name: row.printer_name || printers.find((p) => p.id === row.printer_id)?.name || row.printer_id,
        n: 0,
        ok: 0,
        s: 0,
        g: 0,
        c: 0,
      };
      entry.n += 1;
      entry.ok += row.status === "completed" ? 1 : 0;
      entry.s += num(row.duration_s) ?? 0;
      entry.g += num(row.filament_g) ?? 0;
      entry.c += rowCost(row);
      map.set(row.printer_id, entry);
    }
    return [...map.values()];
  }, [done, printers]);

  const printerOptions = useMemo(() => {
    const names = new Map(printers.map((p) => [p.id, p.name]));
    for (const row of rows || []) if (!names.has(row.printer_id)) names.set(row.printer_id, row.printer_name || row.printer_id);
    return [...names.entries()];
  }, [printers, rows]);

  const removeRow = async (row) => {
    if (!window.confirm("确定从历史记录中删除这次打印吗？")) return;
    try {
      await api(`/api/history/${row.id}`, { method: "DELETE" });
      setRows((current) => (current || []).filter((r) => r.id !== row.id));
      notify("记录已删除");
      api("/api/stats").then(setStats).catch(() => {});
    } catch (error) {
      notify(error.message);
    }
  };

  const selectedFilaments = selectedPrint?.filament_breakdown || [];
  const estimatedTotal = selectedFilaments.reduce((total, item) => total + (num(item.estimated_g) ?? 0), 0);
  const actualTotal = num(selectedPrint?.filament_g);

  return (
    <div>
      <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[.2em] text-lime"><span className="h-px w-5 bg-lime" />Print history</div>
          <h1 className="mt-3 text-[26px] font-semibold tracking-[-.04em] text-white sm:text-[30px]">打印历史</h1>
          <p className="mt-2 text-xs text-[#888e9c]">多种耗材的完工用量按切片预估占比分摊；配置名可在设置中单独定价。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={printerId}
            onChange={(event) => setPrinterId(event.target.value)}
            className="rounded-lg border border-line bg-panel px-3 py-2 text-xs text-white outline-none focus:border-lime"
          >
            <option value="">所有打印机</option>
            {printerOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name || id}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="rounded-lg border border-line bg-panel px-3 py-2 text-xs text-white outline-none focus:border-lime"
          >
            <option value="">全部状态</option>
            <option value="completed">已完成</option>
            <option value="running">进行中</option>
            <option value="failed">失败</option>
            <option value="stopped">已停止</option>
          </select>
        </div>
      </section>

      {loadError && (
        <div role="alert" className="mt-5 rounded-xl border border-red-400/25 bg-red-400/[.06] px-4 py-3 text-xs text-red-200">
          加载失败：{loadError}
          <button className="ml-2 underline" onClick={load}>重试</button>
        </div>
      )}

      <section className="mt-6 grid grid-cols-2 gap-3 xl:grid-cols-5">
        {tiles.map(([label, value, sub]) => (
          <div key={label} className="rounded-2xl border border-line bg-panel p-4">
            <span className="text-[11px] text-[#9298a5]">{label}</span>
            <b className="mt-2 block text-[22px] font-semibold tracking-[-.03em] text-white">{value}</b>
            <small className="mt-1 block truncate text-[10px] text-[#707784]">{sub}</small>
          </div>
        ))}
      </section>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-2xl border border-line bg-panel p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[13px] font-semibold text-white">月度趋势</h2>
              <p className="mt-1 text-[10px] text-muted">最近 12 个月 · 当前筛选条件下</p>
            </div>
            <div className="flex overflow-hidden rounded-lg border border-line">
              {[
                ["hours", "时长"],
                ["count", "次数"],
                ["grams", "耗材"],
                ["cost", "费用"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setMetric(value)}
                  className={`px-3 py-1.5 text-[10px] transition ${metric === value ? "bg-[#1c222b] text-lime" : "text-[#9298a5] hover:bg-white/[.04]"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4">
            <MetricChart rows={done} metric={metric} />
          </div>
        </section>

        <section className="rounded-2xl border border-line bg-panel p-4 sm:p-5">
          <h2 className="text-[13px] font-semibold text-white">按打印机统计</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-[11px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-[#6f7683]">
                  <th className="pb-2 font-medium">打印机</th>
                  <th className="pb-2 text-right font-medium">次数</th>
                  <th className="pb-2 text-right font-medium">成功率</th>
                  <th className="pb-2 text-right font-medium">时长</th>
                  <th className="pb-2 text-right font-medium">耗材</th>
                  <th className="pb-2 text-right font-medium">费用</th>
                </tr>
              </thead>
              <tbody>
                {perPrinter.length ? (
                  perPrinter.map((entry) => (
                    <tr key={entry.name} className="border-t border-line text-[#c8ccd4]">
                      <td className="max-w-[120px] truncate py-2.5">{entry.name}</td>
                      <td className="py-2.5 text-right">{entry.n}</td>
                      <td className="py-2.5 text-right">{Math.round((entry.ok / entry.n) * 100)} %</td>
                      <td className="py-2.5 text-right">{formatHours(entry.s)}</td>
                      <td className="py-2.5 text-right">{formatGrams(entry.g)}</td>
                      <td className="py-2.5 text-right">{formatMoney(entry.c)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="py-4 text-center text-muted">
                      {rows === null ? "正在加载…" : "暂无打印记录。"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-white">记录 <span className="ml-1 text-xs font-normal text-muted">{filtered.length} 条</span></h2>
          <button onClick={load} className="rounded-lg border border-line px-3 py-1.5 text-[10px] text-[#c2c6ce] transition hover:bg-white/[.04]">刷新</button>
        </div>
        {rows === null && !loadError ? (
          <div className="rounded-2xl border border-line bg-panel p-8 text-center text-xs text-muted">正在读取打印历史…</div>
        ) : filtered.length ? (
          <div className="space-y-2">
            {filtered.map((row) => (
              <HistoryRow key={row.id} row={row} isAdmin={isAdmin} onDelete={removeRow} onView={setSelectedPrint} showPrinter={!printerId} />
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-line bg-panel p-8 text-center">
            <p className="text-sm text-white">没有匹配的记录</p>
            <p className="mt-2 text-xs text-muted">历史记录会自动生成：应用跟踪的每次打印都会显示在这里，包括时长、费用和完成照片。</p>
          </div>
        )}
      </section>

      {selectedPrint && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={() => setSelectedPrint(null)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-detail-title"
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-[#11141a] p-5 shadow-2xl sm:p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 id="history-detail-title" className="truncate text-base font-semibold text-white">{prettyName(selectedPrint.file) || "打印详情"}</h2>
                <p className="mt-1 text-[11px] text-muted">{formatDate(selectedPrint.started_at)}{selectedPrint.duration_s ? ` · ${formatDuration(selectedPrint.duration_s)}` : ""}</p>
              </div>
              <button onClick={() => setSelectedPrint(null)} aria-label="关闭详情" className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:bg-white/[.05]">✕</button>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-line bg-panel p-3"><div className="text-[10px] text-muted">总耗材</div><div className="mt-1 text-sm font-semibold text-white">{formatGrams(selectedPrint.filament_g)}</div></div>
              <div className="rounded-xl border border-line bg-panel p-3"><div className="text-[10px] text-muted">耗材费用</div><div className="mt-1 text-sm font-semibold text-white">{formatMoney(selectedPrint.cost_filament)}</div></div>
              <div className="col-span-2 rounded-xl border border-line bg-panel p-3 sm:col-span-1"><div className="text-[10px] text-muted">总费用（含电费）</div><div className="mt-1 text-sm font-semibold text-white">{formatMoney(rowCost(selectedPrint))}</div></div>
            </div>

            {selectedFilaments.length ? (
              <>
                <h3 className="mt-6 text-xs font-semibold text-white">耗材明细</h3>
                <div className="mt-2 overflow-x-auto rounded-xl border border-line">
                  <table className="w-full min-w-[560px] text-left text-[11px]">
                    <thead className="bg-panel text-[10px] text-muted">
                      <tr>
                        <th className="px-3 py-2 font-medium">耗材配置</th>
                        <th className="px-3 py-2 text-right font-medium">切片预估</th>
                        <th className="px-3 py-2 text-right font-medium">预估占比</th>
                        <th className="px-3 py-2 text-right font-medium">分摊用量</th>
                        <th className="px-3 py-2 text-right font-medium">单价/kg</th>
                        <th className="px-3 py-2 text-right font-medium">费用</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedFilaments.map((item, index) => {
                        const estimate = num(item.estimated_g) ?? 0;
                        return (
                          <tr key={`${item.profile || item.type}-${index}`} className="border-t border-line text-[#c8ccd4]">
                            <td className="max-w-[210px] truncate px-3 py-2.5">
                              <span className="inline-flex items-center gap-2">
                                {/^#[0-9a-f]{6}$/i.test(item.color || "") && <i className="h-2.5 w-2.5 shrink-0 rounded-full border border-white/20" style={{ backgroundColor: item.color }} />}
                                <span className="truncate">{item.profile || item.type || `耗材 ${index + 1}`}</span>
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-right">{formatGrams(estimate)}</td>
                            <td className="px-3 py-2.5 text-right">{estimatedTotal ? `${(estimate / estimatedTotal * 100).toFixed(1)}%` : "—"}</td>
                            <td className="px-3 py-2.5 text-right">{formatGrams(item.grams)}</td>
                            <td className="px-3 py-2.5 text-right">{item.price_kg == null ? "—" : formatMoney(item.price_kg)}</td>
                            <td className="px-3 py-2.5 text-right">{item.cost == null ? "—" : formatMoney(item.cost)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-muted">分摊用量按切片预估占比计算{actualTotal == null ? "；打印机总用量尚不可用" : "，逐耗材数值为估算"}。</p>
              </>
            ) : (
              <p className="mt-6 rounded-xl border border-line bg-panel p-4 text-xs leading-relaxed text-muted">这条历史记录没有保存 G-code 的逐耗材信息，无法显示各耗材占比、单价和费用。新打印任务读取到切片信息后会显示明细。</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
