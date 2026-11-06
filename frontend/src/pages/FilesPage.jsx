import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  parseGcodeMeta,
  trackJob,
  STATE_LABEL,
  BUSY_STATES,
  formatDuration,
  formatMoney,
  modelUrl,
  filamentList,
} from "../api.js";
import { loadViewer } from "../viewerLoader.js";
import { FilesCard } from "./PrinterDetail.jsx";

const MODEL_EXTS = ["stl", "3mf", "obj", "step", "stp"];
const extOf = (name) => String(name).split(".").pop().toLowerCase();
const SEND_STEP = { queued: "排队中", uploading: "上传中…", starting: "启动中…", done: "完成", error: "失败" };
const SLICE_STEP = { queued: "排队中", slicing: "切片中…", done: "切片完成", error: "失败" };

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

function SendCard({ printers, isAdmin, notify, onNavigate }) {
  const [file, setFile] = useState(null);
  const [ext, setExt] = useState("");
  const [meta, setMeta] = useState(null);
  const [info, setInfo] = useState(null);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState(false);
  const [slicing, setSlicing] = useState(false);
  const [sliceJob, setSliceJob] = useState(null);
  const [token, setToken] = useState(null);
  const [slicer, setSlicer] = useState(null);
  const [model, setModel] = useState("");
  const [catalog, setCatalog] = useState(null);
  const [process, setProcess] = useState("");
  const [filamentChoice, setFilamentChoice] = useState("");
  const [targets, setTargets] = useState(() => {
    const free = printers.filter((p) => p.online && !BUSY_STATES.includes(p.state));
    return new Set(free.length === 1 ? [free[0].id] : []);
  });
  const [start, setStart] = useState(false);
  const [sendJob, setSendJob] = useState(null);
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [prices, setPrices] = useState(null);

  const viewerBoxRef = useRef(null);
  const viewerRef = useRef(null);
  const catalogsRef = useRef(new Map());

  const models = useMemo(() => {
    const list = [...new Set(printers.map((p) => p.raw.model || p.model?.split(" · ")[0]).filter(Boolean))];
    return list.length ? list : ["Creality Hi"];
  }, [printers]);

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

  // default machine model: the model of the first selected printer
  useEffect(() => {
    if (model || !printers.length) return;
    const first = printers.find((p) => targets.has(p.id)) || printers[0];
    setModel(first.raw.model || first.model?.split(" · ")[0] || "Creality Hi");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printers]);

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

  const fillCatalog = async (modelName) => {
    let st = catalogsRef.current.get(modelName);
    if (!st) {
      try {
        st = await api(`/api/slicer?model=${encodeURIComponent(modelName)}`);
      } catch (error) {
        notify(error.message);
        return;
      }
      if (st.available) catalogsRef.current.set(modelName, st);
    }
    setSlicer(st);
    const c = st.catalog;
    if (!st.available || !c?.machine) {
      setCatalog(null);
      return;
    }
    setCatalog(c);

    const recall = (key) => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    };
    const rememberedProcess = recall("pm.process");
    setProcess(
      (rememberedProcess && c.processes.includes(rememberedProcess) ? rememberedProcess : null) ||
        c.processes.find((p) => p.startsWith("0.20mm Standard")) ||
        c.processes[0] ||
        "",
    );
    // default filament: the one loaded in the first selected printer, otherwise last used / PLA
    const selectedPrinter = printers.find((p) => targets.has(p.id)) || printers[0];
    const loaded = filamentList(selectedPrinter?.raw.data || {})[0];
    const guess =
      loaded && c.filaments.find((f) => f.toUpperCase().startsWith(`CREALITY GENERIC ${String(loaded.type).toUpperCase()} `));
    const rememberedFilament = recall("pm.filament");
    setFilamentChoice(
      (guess && c.filaments.includes(guess) ? guess : null) ||
        (rememberedFilament && c.filaments.includes(rememberedFilament) ? rememberedFilament : null) ||
        c.filaments.find((f) => f.startsWith("Creality Generic PLA @")) ||
        c.filaments[0] ||
        "",
    );
  };

  const handleFile = async (picked) => {
    if (!picked) return;
    const extension = extOf(picked.name);
    if (extension !== "gcode" && !MODEL_EXTS.includes(extension)) {
      notify("支持的格式：.stl、.3mf、.obj、.step、.gcode");
      return;
    }
    setFile(picked);
    setExt(extension);
    setMeta(null);
    setInfo(null);
    setNote("");
    setPreview(false);
    setToken(null);
    setSliceJob(null);
    setSendJob(null);
    try {
      if (extension === "gcode") {
        const viewer = await ensureViewer();
        await viewer.loadGcode(picked);
        const text =
          (await picked.slice(Math.max(0, picked.size - 300_000)).text()) + (await picked.slice(0, 65_536).text());
        setMeta(parseGcodeMeta(text));
        setInfo(viewer.info);
        setPreview(true);
      } else if (extension === "stl") {
        const viewer = await ensureViewer();
        await viewer.loadSTL(picked);
        setInfo(viewer.info);
        setPreview(true);
        fillCatalog(models.includes(model) ? model : models[0] || "Creality Hi");
      } else {
        setNote(`.${extension} 文件切片前无法预览；完成切片后即可查看。`);
        fillCatalog(models.includes(model) ? model : models[0] || "Creality Hi");
      }
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
    setNote("");
    setPreview(false);
    setToken(null);
    setSliceJob(null);
    setSendJob(null);
  };

  const slice = async () => {
    if (!file) return;
    setSlicing(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("machine", catalog?.machine || "");
      fd.append("process", process);
      fd.append("filament", filamentChoice);
      // Thumbnails are rendered here: OrcaSlicer's headless slicing doesn't produce any.
      if (viewerRef.current && ext === "stl") {
        try {
          fd.append("thumb300", await withTimeout(viewerRef.current.snapshot(300), 5000));
          fd.append("thumb96", await withTimeout(viewerRef.current.snapshot(96), 5000));
        } catch {
          /* slice without thumbnails */
        }
      }
      const started = await api("/api/slice", { method: "POST", body: fd });
      setSliceJob(started);
      const job = await trackJob(started.id, (update) => setSliceJob({ ...update }));
      if (job.step === "error") {
        notify(job.error || "切片失败");
      } else {
        setToken(job.token);
        setMeta(job.meta || {});
        notify("切片完成 ✓");
        try {
          const viewer = await ensureViewer();
          await viewer.loadGcode(`/api/sliced/${job.token}`);
          setInfo(viewer.info);
          setPreview(true);
          setNote("");
        } catch (error) {
          notify(`预览失败：${error.message}`);
        }
      }
    } catch (error) {
      notify(error.message);
    } finally {
      setSlicing(false);
      setSliceJob(null);
    }
  };

  const ready = Boolean(token || (file && ext === "gcode"));
  const targetIds = [...targets];
  const sendButtonLabel = !ready
    ? file
      ? "请先切片"
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
    if (token) fd.append("token", token);
    else fd.append("file", file);
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

  const slicerMissing = file && ext && ext !== "gcode" && slicer && (!slicer.available || !catalog?.machine);

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
      {/* preview / drop zone */}
      <div className="rounded-2xl border border-line bg-panel p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[13px] font-semibold text-white">发送文件 / 模型切片</h2>
            <p className="mt-1 text-[10px] text-muted">.gcode 直接发送；.stl/.3mf/.obj/.step 需先切片。</p>
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
                accept=".gcode,.stl,.3mf,.obj,.step,.stp"
                className="hidden"
                onChange={(event) => {
                  handleFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <span>
                <span className="block text-sm text-[#d5d8df]">将 .stl、.3mf 或 .gcode 文件拖到此处</span>
                <span className="mt-1.5 block text-xs text-muted">或点击选择文件</span>
              </span>
            </label>
          )}
          {/* 3D preview host — managed imperatively by PMViewer */}
          <div ref={viewerBoxRef} className={preview ? "h-[300px] overflow-hidden rounded-xl" : "hidden"} />
          {file && !preview && (
            <div className="grid min-h-[300px] place-items-center p-6 text-center text-xs text-muted">
              {note || "准备中…"}
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

        {slicerMissing && (
          <div className="mt-3 rounded-xl border border-amber-300/30 bg-amber-300/[.07] px-4 py-3 text-xs text-amber-100">
            {slicer.available === false ? (
              <>
                尚未安装 OrcaSlicer。{isAdmin && (
                  <button onClick={() => onNavigate("设置")} className="mx-1 underline">
                    {slicer.can_install === false ? "查看设置" : "前往设置安装"}
                  </button>
                )}
                或直接发送 .gcode 文件。
              </>
            ) : (
              <>没有适用于“{model}”的 OrcaSlicer 配置文件。</>
            )}
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
            disabled={!ready || !targetIds.length || sending || slicing}
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

        {/* slicing */}
        <section className="rounded-2xl border border-line bg-panel p-4">
          <h3 className="text-[13px] font-semibold text-white">切片设置</h3>
          {file && ext !== "gcode" ? (
            <div className="mt-3 space-y-3">
              <label className="block text-[10px] uppercase tracking-wider text-[#6f7683]">
                打印机型号
                <select
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value);
                    fillCatalog(event.target.value);
                  }}
                  className="mt-1.5 w-full rounded-lg border border-line bg-ink px-3 py-2 text-xs text-white outline-none focus:border-lime"
                >
                  {models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
              <label className="block text-[10px] uppercase tracking-wider text-[#6f7683]">
                质量
                <select
                  value={process}
                  disabled={!catalog}
                  onChange={(event) => {
                    setProcess(event.target.value);
                    try {
                      window.localStorage.setItem("pm.process", event.target.value);
                    } catch { /* storage unavailable */ }
                  }}
                  className="mt-1.5 w-full rounded-lg border border-line bg-ink px-3 py-2 text-xs text-white outline-none focus:border-lime disabled:opacity-50"
                >
                  {(catalog?.processes || []).map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label className="block text-[10px] uppercase tracking-wider text-[#6f7683]">
                耗材
                <select
                  value={filamentChoice}
                  disabled={!catalog}
                  onChange={(event) => {
                    setFilamentChoice(event.target.value);
                    try {
                      window.localStorage.setItem("pm.filament", event.target.value);
                    } catch { /* storage unavailable */ }
                  }}
                  className="mt-1.5 w-full rounded-lg border border-line bg-ink px-3 py-2 text-xs text-white outline-none focus:border-lime disabled:opacity-50"
                >
                  {(catalog?.filaments || []).map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
              <button
                onClick={slice}
                disabled={slicing || !catalog || !process || !filamentChoice}
                className="w-full rounded-xl border border-lime/40 bg-lime/10 px-4 py-2.5 text-xs font-semibold text-lime transition hover:bg-lime/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {slicing ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="h-3 w-3 animate-spin rounded-full border border-lime border-t-transparent" />
                    {sliceJob ? SLICE_STEP[sliceJob.step] || sliceJob.step : "正在切片…"}
                  </span>
                ) : token ? (
                  "重新切片"
                ) : (
                  "开始切片"
                )}
              </button>
              <p className="text-[10px] leading-relaxed text-muted">
                切片在服务器上由 OrcaSlicer 完成，结果仅用于预览和发送，不会复制到打印机的硬盘。
              </p>
            </div>
          ) : (
            <p className="mt-3 text-xs leading-relaxed text-muted">
              {file ? "G-code 文件无需切片，可直接发送。" : "选择 .stl、.3mf 等模型文件后可配置切片参数。"}
            </p>
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

export default function FilesPage({ printers, isAdmin, notify, onNavigate }) {
  const [tab, setTab] = useState("send");
  return (
    <div>
      <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[.2em] text-lime"><span className="h-px w-5 bg-lime" />Files &amp; slicing</div>
          <h1 className="mt-3 text-[26px] font-semibold tracking-[-.04em] text-white sm:text-[30px]">文件库</h1>
          <p className="mt-2 text-xs text-[#888e9c]">切片 3D 模型并发送到打印机，或管理打印机本地文件。</p>
        </div>
        <div className="flex overflow-hidden rounded-xl border border-line bg-panel">
          {[
            ["send", "发送 / 切片"],
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
          <SendCard printers={printers} isAdmin={isAdmin} notify={notify} onNavigate={onNavigate} />
        ) : (
          <BrowseSection printers={printers} isAdmin={isAdmin} notify={notify} />
        )}
      </div>
    </div>
  );
}
