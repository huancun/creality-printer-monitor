import { useEffect, useRef, useState } from "react";
import {
  api,
  parseGcodeMeta,
  filamentList,
  normalizeColor,
  trackJob,
  STATE_LABEL,
  BUSY_STATES,
  formatDuration,
  formatMoney,
  modelUrl,
} from "../api.js";
import { loadViewer } from "../viewerLoader.js";
import { FilesCard } from "./PrinterDetail.jsx";

const extOf = (name) => String(name).split(".").pop().toLowerCase();
const SEND_STEP = { queued: "排队中", uploading: "上传中…", starting: "启动中…", done: "完成", error: "失败" };

function SendCard({ printers, notify }) {
  const [file, setFile] = useState(null);
  const [ext, setExt] = useState("");
  const [meta, setMeta] = useState(null);
  const [info, setInfo] = useState(null);
  const [preview, setPreview] = useState(false);
  const [targets, setTargets] = useState(() => {
    const free = printers.filter((p) => p.online && !BUSY_STATES.includes(p.state));
    return new Set(free.length === 1 ? [free[0].id] : []);
  });
  const [start, setStart] = useState(false);
  const [sendJob, setSendJob] = useState(null);
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [prices, setPrices] = useState(null);
  const [colorMapping, setColorMapping] = useState([]);

  const viewerBoxRef = useRef(null);
  const viewerRef = useRef(null);

  // one-time: prices for the cost estimate (settings are admin-only)
  useEffect(() => {
    api("/api/settings")
      .then((settings) => setPrices(settings.filaments || {}))
      .catch(() => {});
    return () => {
      viewerRef.current?.dispose?.();
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // when "start printing" is checked, busy/offline targets get unselected
  useEffect(() => {
    if (!start) return;
    setTargets((current) => {
      const next = new Set([...current].filter((id) => {
        const p = printers.find((printer) => printer.id === id);
        return p && p.online && !BUSY_STATES.includes(p.state);
      }));
      return next.size === current.size ? current : next;
    });
  }, [start, printers]);

  const ensureViewer = async () => {
    const PMViewer = await loadViewer();
    viewerRef.current?.dispose?.();
    const box = viewerBoxRef.current;
    box.innerHTML = "";
    const viewer = new PMViewer(box, {});
    viewerRef.current = viewer;
    return viewer;
  };

  const handleFile = async (picked) => {
    if (!picked) return;
    const extension = extOf(picked.name);
    if (extension !== "gcode") {
      notify("仅支持 .gcode 文件");
      return;
    }
    setFile(picked);
    setExt(extension);
    setMeta(null);
    setInfo(null);
    setColorMapping([]);
    setPreview(false);
    setSendJob(null);
    try {
      const viewer = await ensureViewer();
      await viewer.loadGcode(picked);
      const text =
        (await picked.slice(Math.max(0, picked.size - 300_000)).text()) + (await picked.slice(0, 65_536).text());
      setMeta(parseGcodeMeta(text));
      setInfo(viewer.info);
      setPreview(true);
    } catch (error) {
      notify(`预览失败：${error.message}`);
    }
  };

  const resetFile = () => {
    viewerRef.current?.dispose?.();
    viewerRef.current = null;
    if (viewerBoxRef.current) viewerBoxRef.current.innerHTML = "";
    setFile(null);
    setExt("");
    setMeta(null);
    setInfo(null);
    setPreview(false);
    setSendJob(null);
    setColorMapping([]);
  };

  const ready = Boolean(file && ext === "gcode");
  const targetIds = [...targets];
  const selectedPrinter = printers.find((printer) => printer.id === targetIds[0]);
  const machineFilaments = selectedPrinter ? filamentList(selectedPrinter.raw.data || {}) : [];
  const sendButtonLabel = !ready
    ? file
      ? "正在读取 G-code…"
      : "请选择文件"
    : !targetIds.length
      ? "请选择打印机"
      : `${start ? "打印" : "发送"}到 ${targetIds.length} 台打印机`;

  const send = async () => {
    if (!ready || !targetIds.length || sending) return;
    if (
      start &&
      !window.confirm(
        `确定在以下打印机上开始打印吗：${targetIds.map((id) => printers.find((p) => p.id === id)?.name).join("、")}？\n请确保热床上没有物品。`,
      )
    ) {
      return;
    }
    const fd = new FormData();
    fd.append("printers", targetIds.join(","));
    fd.append("start", String(start));
    fd.append("file", file);
    const selectedColorMapping = colorMapping.filter(Boolean);
    if (selectedColorMapping.length) fd.append("color_mapping", JSON.stringify(selectedColorMapping));
    setSending(true);
    try {
      let job = await api("/api/send", { method: "POST", body: fd });
      setSendJob({ ...job });
      job = await trackJob(job.id, (update) => setSendJob({ ...update }));
      if (job.step === "done") notify(job.start ? "已开始打印 ✓" : "文件已发送 ✓");
      else notify(job.error || "发送失败", true);
    } catch (error) {
      notify(error.message, true);
    } finally {
      setSending(false);
    }
  };

  // cost estimate (same family matching as the classic UI)
  let estimate = null;
  if (meta?.filament_g && prices) {
    const family =
      Object.keys(prices)
        .sort((a, b) => b.length - a.length)
        .find((k) => (meta.material || "PLA").toUpperCase().includes(k)) || "PLA";
    const price = prices[family]?.price_kg;
    if (price) estimate = (meta.filament_g * price) / 1000;
  }

  const metaBits = file
    ? [
        file.name,
        meta?.est_time_s ? `⏱ ${formatDuration(meta.est_time_s)}` : "",
        meta?.filament_g ? `${meta.filament_g.toFixed(1)} 克${meta.material ? ` ${meta.material}` : ""}` : "",
        estimate !== null ? `耗材约 ${formatMoney(estimate)}` : "",
        info?.layers ? `${info.layers} 层` : "",
        info?.size ? `${info.size.x.toFixed(1)} × ${info.size.y.toFixed(1)} × ${info.size.z.toFixed(1)} mm` : "",
      ].filter(Boolean)
    : [];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
      {/* preview / drop zone */}
      <div className="rounded-2xl border border-line bg-panel p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[13px] font-semibold text-white">预览并发送 G-code</h2>
            <p className="mt-1 text-[10px] text-muted">选择已有的 .gcode 文件，预览后发送到打印机。</p>
          </div>
          {file && (
            <button onClick={resetFile} className="rounded-lg border border-line px-3 py-1.5 text-[10px] text-[#c2c6ce] transition hover:bg-white/[.04]">
              更换文件
            </button>
          )}
        </div>

        <div className="relative min-h-[300px] rounded-xl border border-line bg-ink">
          {!file && (
            <label
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                handleFile(event.dataTransfer.files?.[0]);
              }}
              className={`absolute inset-0 grid cursor-pointer place-items-center rounded-xl border-2 border-dashed text-center transition ${dragOver ? "border-lime bg-lime/[.05]" : "border-transparent"}`}
            >
              <input
                type="file"
                accept=".gcode"
                className="hidden"
                onChange={(event) => {
                  handleFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <span>
                <span className="block text-sm text-[#d5d8df]">将 .gcode 文件拖到此处</span>
                <span className="mt-1.5 block text-xs text-muted">或点击选择文件</span>
              </span>
            </label>
          )}
          {/* 3D preview host — managed imperatively by PMViewer */}
          <div ref={viewerBoxRef} className={preview ? "h-[300px] overflow-hidden rounded-xl" : "hidden"} />
          {file && !preview && (
            <div className="grid min-h-[300px] place-items-center p-6 text-center text-xs text-muted">
              准备预览…
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#b8bdc7]">
          {metaBits.length ? metaBits.map((bit, index) => (
            <span key={index} className={index === 0 ? "max-w-[240px] truncate font-medium text-white" : ""}>{bit}</span>
          )) : (
            <span className="text-muted">尚未选择文件</span>
          )}
          {info?.fitsBed === false && <span className="text-red-300">模型超出热床范围</span>}
        </div>

        {meta?.filaments?.length > 0 && machineFilaments.length > 0 && (
          <div className="mt-4 rounded-xl border border-line bg-panel/60 p-3">
            <div className="mb-2">
              <h3 className="text-xs font-semibold text-white">耗材颜色映射</h3>
              <p className="mt-1 text-[10px] text-muted">
                {meta.hasColorMetadata
                  ? `把切片配置映射到 ${selectedPrinter?.name || "打印机"} 的 CFS 槽位；发送并开始打印时会同步到机器。`
                  : "这个 G-code 没有保存颜色信息，只能识别工具编号，无法预览切片颜色。请在切片软件中设置颜色后重新切片。"}
              </p>
            </div>
            <div className="space-y-2">
              {meta.filaments.map((source, index) => {
                const mapped = colorMapping[index];
                const value = mapped ? `${mapped.boxId}:${mapped.materialId}` : "";
                return (
                  <label key={`${source.id}-${index}`} className="flex items-center gap-2 text-[10px] text-[#c8ccd4]">
                    <i className="h-2.5 w-2.5 shrink-0 rounded-full border border-white/30" style={{ backgroundColor: normalizeColor(source.color) || "#888" }} />
                    <span className="min-w-0 w-40 shrink-0 truncate" title={`${source.id} · ${source.color || "未知颜色"}`}>
                      {source.profile || source.id}
                      <small className="ml-1 text-[9px] text-muted">{source.id} · {source.color || "未知颜色"}</small>
                    </span>
                    <select
                      value={value}
                      disabled={!meta.hasColorMetadata}
                      onChange={(event) => {
                        const slot = machineFilaments.find((item) => `${item.box}:${item.id}` === event.target.value);
                        setColorMapping((current) => {
                          const next = [...current];
                          next[index] = slot ? { id: source.id, type: source.type || meta.material || "PLA", color: normalizeColor(source.color) || source.color, boxId: slot.box, materialId: slot.id } : null;
                          return next;
                        });
                      }}
                      className="min-w-0 flex-1 rounded-lg border border-line bg-ink px-2 py-1.5 text-[10px] text-white outline-none focus:border-lime"
                    >
                      <option value="">不映射（由机器自动匹配）</option>
                      {machineFilaments.map((slot) => (
                        <option key={`${slot.box}:${slot.id}`} value={`${slot.box}:${slot.id}`}>
                          CFS {slot.box}·{Number(slot.id) + 1} · {slot.name || slot.type || "耗材"} · {normalizeColor(slot.color) || "未知颜色"}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          </div>
        )}

      </div>

      {/* targets & actions */}
      <div className="space-y-4">
        <section className="rounded-2xl border border-line bg-panel p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-white">目标打印机</h3>
            <div className="flex gap-2 text-[10px]">
              <button
                onClick={() =>
                  setTargets(
                    new Set(printers.filter((p) => p.online && (!start || !BUSY_STATES.includes(p.state))).map((p) => p.id)),
                  )
                }
                className="text-lime hover:underline"
              >
                全选可用
              </button>
              <span className="text-[#3f4550]">|</span>
              <button onClick={() => setTargets(new Set())} className="text-[#9298a5] hover:underline">清空</button>
            </div>
          </div>

          <div className="max-h-[240px] space-y-2 overflow-y-auto pr-1">
            {printers.map((p) => {
              const busy = BUSY_STATES.includes(p.state);
              const disabled = !p.online || (start && busy);
              const why = !p.online
                ? "离线"
                : busy
                  ? `${STATE_LABEL[p.state] || p.state}${p.raw.data?.printLeftTime ? `，${formatDuration(p.raw.data.printLeftTime)} 后可用` : ""}`
                  : STATE_LABEL[p.state] || p.state;
              const checked = targets.has(p.id) && !disabled;
              return (
                <label
                  key={p.id}
                  className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition ${disabled ? "border-line bg-white/[.01] opacity-50" : "border-line bg-ink hover:border-[#3a414e]"} ${checked ? "!border-lime/50" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) =>
                      setTargets((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(p.id);
                        else next.delete(p.id);
                        return next;
                      })
                    }
                    className="accent-[#c5f36b]"
                  />
                  <img src={modelUrl(p.raw)} alt="" className="h-8 w-8 shrink-0 rounded-lg bg-panel object-contain p-0.5" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />
                  <span className="min-w-0">
                    <b className="block truncate text-xs font-medium text-white">{p.name}</b>
                    <small className="block truncate text-[10px] text-muted">{why}</small>
                  </span>
                </label>
              );
            })}
            {!printers.length && <p className="py-3 text-center text-xs text-muted">没有可用的打印机。</p>}
          </div>

          <label className="mt-3 flex items-center gap-2 text-xs text-[#b8bdc7]">
            <input type="checkbox" checked={start} onChange={(event) => setStart(event.target.checked)} className="accent-[#c5f36b]" />
            发送后立即开始打印
          </label>

          <button
            onClick={send}
            disabled={!ready || !targetIds.length || sending}
            className="mt-3 w-full rounded-xl bg-lime px-4 py-2.5 text-xs font-semibold text-ink transition hover:bg-[#d5ff80] disabled:cursor-not-allowed disabled:bg-[#333b2a] disabled:text-[#767c6c]"
          >
            {sending ? "发送中…" : sendButtonLabel}
          </button>

          {sendJob && (
            <div className="mt-3 space-y-2 border-t border-line pt-3">
              {Object.values(sendJob.targets || {}).map((target, index) => (
                <div key={index} className="flex items-center gap-2 text-[11px]">
                  {!["done", "error"].includes(target.step) && <span className="h-3 w-3 animate-spin rounded-full border border-lime border-t-transparent" />}
                  <span className="min-w-0 flex-1 truncate text-[#d5d8df]">{target.name}</span>
                  <span className={target.step === "error" ? "text-red-300" : target.step === "done" ? "text-lime" : "text-muted"}>
                    {SEND_STEP[target.step] || target.step}
                  </span>
                  {target.error && <span className="text-[9px] text-red-300">{target.error}</span>}
                </div>
              ))}
            </div>
          )}
        </section>

      </div>
    </div>
  );
}

function BrowseSection({ printers, isAdmin, notify }) {
  const [selectedId, setSelectedId] = useState(printers[0]?.id || "");
  const selected = printers.find((p) => p.id === selectedId) || printers[0] || null;
  return (
    <div className="rounded-2xl border border-line bg-panel p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold text-white">打印机上的文件</h2>
          <p className="mt-1 text-[10px] text-muted">浏览并直接打印已经存放在打印机本地的 G-code。</p>
        </div>
        <select
          value={selected?.id || ""}
          onChange={(event) => setSelectedId(event.target.value)}
          className="rounded-lg border border-line bg-ink px-3 py-2 text-xs text-white outline-none focus:border-lime"
        >
          {printers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      {selected ? (
        <FilesCard printer={selected} isAdmin={isAdmin} notify={notify} />
      ) : (
        <p className="py-6 text-center text-xs text-muted">还没有添加打印机。</p>
      )}
    </div>
  );
}

export default function FilesPage({ printers, isAdmin, notify }) {
  const [tab, setTab] = useState("send");
  return (
    <div>
      <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[.2em] text-lime"><span className="h-px w-5 bg-lime" />Files</div>
          <h1 className="mt-3 text-[26px] font-semibold tracking-[-.04em] text-white sm:text-[30px]">文件库</h1>
          <p className="mt-2 text-xs text-[#888e9c]">预览并发送 G-code 文件，或管理打印机本地文件。</p>
        </div>
        <div className="flex overflow-hidden rounded-xl border border-line bg-panel">
          {[
            ["send", "预览 / 发送 G-code"],
            ["browse", "打印机文件"],
          ].map(([value, label]) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              className={`px-4 py-2 text-xs transition ${tab === value ? "bg-lime text-ink" : "text-[#9298a5] hover:bg-white/[.04]"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <div className="mt-6">
        {tab === "send" ? (
          <SendCard printers={printers} notify={notify} />
        ) : (
          <BrowseSection printers={printers} isAdmin={isAdmin} notify={notify} />
        )}
      </div>
    </div>
  );
}
