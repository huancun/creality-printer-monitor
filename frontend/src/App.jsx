import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, formatDate, formatDuration, printerView, trackJob } from "./api.js";
import PrintersPage from "./pages/PrintersPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import FilesPage from "./pages/FilesPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";

const navItems = [
  { label: "总览" },
  { label: "打印机", count: "03" },
  { label: "打印历史" },
  { label: "文件库" },
];

function AuthScreen({ setup, onAuthenticated }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") || "").trim();
    const password = String(form.get("password") || "");
    if (setup && password !== form.get("password2")) {
      setError("两次输入的密码不一致");
      setBusy(false);
      return;
    }

    try {
      const user = await api(setup ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      onAuthenticated(user);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-5">
      <form onSubmit={submit} className="w-full max-w-[390px] rounded-2xl border border-line bg-panel p-7 shadow-2xl">
        <div className="mb-7 text-center">
          <div className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded-xl bg-lime text-lg font-black text-ink">C</div>
          <h1 className="text-lg font-semibold text-white">{setup ? "创建管理员账号" : "登录打印机监控"}</h1>
          <p className="mt-2 text-xs leading-relaxed text-muted">{setup ? "首次使用，请设置管理员用户名和密码。" : "使用现有 Creality Monitor 账号继续。"} </p>
        </div>
        <label className="mb-4 block text-xs text-[#b8bdc7]">用户名
          <input name="username" required autoComplete="username" autoCapitalize="none" className="mt-2 w-full rounded-lg border border-line bg-ink px-3 py-2.5 text-sm text-white outline-none focus:border-lime" />
        </label>
        <label className="mb-4 block text-xs text-[#b8bdc7]">密码
          <input name="password" type="password" required minLength={setup ? 6 : undefined} autoComplete={setup ? "new-password" : "current-password"} className="mt-2 w-full rounded-lg border border-line bg-ink px-3 py-2.5 text-sm text-white outline-none focus:border-lime" />
        </label>
        {setup && <label className="mb-4 block text-xs text-[#b8bdc7]">确认密码
          <input name="password2" type="password" required minLength={6} autoComplete="new-password" className="mt-2 w-full rounded-lg border border-line bg-ink px-3 py-2.5 text-sm text-white outline-none focus:border-lime" />
        </label>}
        {error && <p role="alert" className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300">{error}</p>}
        <button disabled={busy} className="w-full rounded-lg bg-lime px-4 py-2.5 text-sm font-semibold text-ink disabled:opacity-60">{busy ? "请稍候…" : setup ? "创建并登录" : "登录"}</button>
      </form>
    </main>
  );
}

function Icon({ children, className = "" }) {
  return <span aria-hidden="true" className={`inline-flex w-5 justify-center ${className}`}>{children}</span>;
}

function Sidebar({ active, onNavigate, printerCount, onlineCount, isAdmin }) {
  return (
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-[228px] flex-col border-r border-line bg-[#0c0e13]/90 px-4 py-6 lg:flex">
      <a href="#" className="mb-12 flex items-center gap-3 px-2">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-lime text-lg font-black text-ink">C</div>
        <div>
          <div className="text-sm font-semibold tracking-wide text-white">CREALITY</div>
          <div className="mt-0.5 text-[10px] tracking-[.2em] text-muted">PRINT MONITOR</div>
        </div>
      </a>
      <div className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[.18em] text-[#666c79]">工作空间</div>
      <nav className="space-y-1">
        {navItems.map((item) => (
          <button
            key={item.label}
            onClick={() => onNavigate(item.label)}
            className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] transition ${
              active === item.label ? "bg-[#1c222b] text-white" : "text-[#9298a5] hover:bg-white/[.04] hover:text-white"
            }`}
          >
            <span className="flex-1">{item.label}</span>
            {item.count && <span className="text-[10px] text-[#777d8a]">{String(printerCount).padStart(2, "0")}</span>}
          </button>
        ))}
      </nav>
      <div className="mb-3 mt-10 px-3 text-[10px] font-semibold uppercase tracking-[.18em] text-[#666c79]">管理</div>
      {isAdmin && <button onClick={() => onNavigate("设置")} className="flex items-center rounded-xl px-3 py-2.5 text-left text-[13px] text-[#9298a5] transition hover:bg-white/[.04] hover:text-white">
        设置
      </button>}
      <div className="mt-auto rounded-2xl border border-line bg-[#11141a] p-4">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted">系统状态</span>
          <span className={`flex items-center gap-1.5 text-[10px] ${onlineCount ? "text-lime" : "text-amber-300"}`}><i className={`h-1.5 w-1.5 rounded-full ${onlineCount ? "bg-lime" : "bg-amber-300"}`} />{onlineCount ? "运行正常" : "无在线设备"}</span>
        </div>
        <div className="mt-3 text-xs text-[#d9dce2]">{onlineCount} / {printerCount} 台设备在线</div>
      </div>
    </aside>
  );
}

function PrinterArt({ color, kind }) {
  return (
    <div className="relative flex h-[164px] items-center justify-center overflow-hidden bg-[radial-gradient(ellipse_at_50%_80%,rgba(255,255,255,.09),transparent_58%),linear-gradient(145deg,#191d25,#11141a)]">
      <div className="absolute inset-x-8 bottom-4 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
      <div className="absolute right-4 top-4 rounded-md border border-white/[.08] bg-black/20 px-2 py-1 text-[9px] tracking-[.14em] text-white/45">{kind}</div>
      <svg viewBox="0 0 220 145" className="h-[138px] w-[210px] drop-shadow-2xl" aria-label={`${kind} 3D 打印机示意图`}>
        <defs>
          <linearGradient id={`frame-${kind}`} x1="0" x2="1" y1="0" y2="1">
            <stop stopColor="#727986" />
            <stop offset="1" stopColor="#303640" />
          </linearGradient>
          <linearGradient id={`bed-${kind}`} x1="0" x2="1">
            <stop stopColor={color} stopOpacity=".12" />
            <stop offset="1" stopColor={color} stopOpacity=".38" />
          </linearGradient>
        </defs>
        <path d="M56 19h108l13 11v93H43V30l13-11Z" fill="#171b22" stroke={`url(#frame-${kind})`} strokeWidth="4" />
        <path d="M62 31h96v77H62z" fill="#11151b" stroke="#424955" strokeWidth="2" />
        <path d="M70 97h81l-13 12H57z" fill={`url(#bed-${kind})`} stroke={color} strokeOpacity=".55" />
        <path d="m88 97 14-22h20l13 22" fill="none" stroke={color} strokeWidth="4" strokeLinejoin="round" />
        <path d="M94 72h31" stroke="#a9b0bc" strokeWidth="4" strokeLinecap="round" />
        <rect x="107" y="58" width="13" height="15" rx="3" fill="#d2d6dc" />
        <path d="M52 30h120M65 36v62m90-62v62" stroke="#737b88" strokeOpacity=".6" strokeWidth="2" />
        <path d="M68 120h90" stroke="#89919c" strokeWidth="4" strokeLinecap="round" />
        <rect x="168" y="45" width="7" height="19" rx="2" fill={color} fillOpacity=".75" />
      </svg>
      <span className="absolute bottom-3 left-4 flex items-center gap-1.5 text-[9px] tracking-wide text-white/40"><i className="h-1.5 w-1.5 rounded-full bg-white/40" />设备示意图</span>
    </div>
  );
}

function ProgressRing({ value, color }) {
  const circumference = 2 * Math.PI * 17;
  return (
    <div className="relative grid h-11 w-11 shrink-0 place-items-center">
      <svg className="absolute inset-0 -rotate-90" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r="17" fill="none" stroke="#2b3038" strokeWidth="3" />
        <circle cx="22" cy="22" r="17" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - value / 100)} />
      </svg>
      <span className="text-[10px] font-semibold text-white">{value}%</span>
    </div>
  );
}

function PrinterCard({ printer, onAction, onOpen, isAdmin }) {
  const status = {
    printing: ["正在打印", "text-lime"],
    processing: ["准备中", "text-sky-300"],
    ready: ["待机就绪", "text-sky-300"],
    paused: ["已暂停", "text-amber-300"],
    offline: ["离线", "text-[#9298a5]"],
    error: ["错误", "text-red-300"],
    self_test: ["自检中", "text-amber-300"],
    stopped: ["已停止", "text-[#9298a5]"],
  }[printer.state] || [printer.state, "text-[#9298a5]"];
  const actionLabel = printer.state === "printing"
    ? "暂停打印"
    : printer.state === "paused"
      ? "恢复打印"
      : "设备详情";
  return (
    <article onClick={() => onOpen?.(printer)} className="cursor-pointer overflow-hidden rounded-2xl border border-line bg-panel transition hover:border-[#3a414e]">
      <PrinterArt color={printer.color} kind={printer.kind} />
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-[15px] font-semibold text-white">{printer.name}</h3>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${printer.state === "printing" ? "bg-lime" : printer.state === "paused" ? "bg-amber-300" : printer.online ? "bg-sky-300" : "bg-[#656b76]"}`} />
            </div>
            <p className="mt-1 text-[11px] text-muted">{printer.model}</p>
          </div>
          <span className={`shrink-0 rounded-full bg-white/[.04] px-2.5 py-1 text-[10px] ${status[1]}`}>{status[0]}</span>
        </div>
        <div className="mt-5 flex items-center gap-3">
          <ProgressRing value={printer.progress} color={printer.color} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-[#daddE4]">{printer.file}</div>
            <div className="mt-1.5 flex justify-between text-[10px] text-muted">
              <span>{printer.state === "printing" || printer.state === "processing" ? "预计剩余" : printer.state === "paused" ? "任务进度" : "打印队列"}</span>
              <span className="text-[#d5d8df]">{printer.time}</span>
            </div>
          </div>
        </div>
        <div className="mt-4 h-px bg-line" />
        <div className="mt-3 flex items-center justify-between">
          <div className="flex gap-4 text-[10px] text-muted">
            <span>喷嘴 <b className="ml-1 font-medium text-[#d7d9df]">{printer.nozzle === "—" ? "—" : `${printer.nozzle}°`}</b></span>
            <span>热床 <b className="ml-1 font-medium text-[#d7d9df]">{printer.bed === "—" ? "—" : `${printer.bed}°`}</b></span>
          </div>
          {isAdmin && ["printing", "paused"].includes(printer.state)
            ? <button disabled={!printer.online} onClick={(event) => { event.stopPropagation(); onAction(printer); }} className="rounded-lg px-2.5 py-1.5 text-[10px] text-[#aeb4c0] transition hover:bg-white/[.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-40">{actionLabel}</button>
            : <span className="text-[10px] text-[#747b88]">{printer.online ? "实时状态" : "离线"}</span>}
        </div>
      </div>
    </article>
  );
}

function ActivityChart({ months = [] }) {
  const entries = months.slice(-12);
  const max = Math.max(...entries.map((month) => Number(month.seconds) || 0), 0);
  const monthLabel = (key) => {
    const date = new Date(`${key}-01T00:00:00`);
    return Number.isNaN(date.getTime()) ? key : date.toLocaleDateString("zh-CN", { month: "short" });
  };
  return (
    <div className="mt-5">
      <div className="relative h-[144px]">
        <div className="absolute inset-0 flex flex-col justify-between">
          {[0, 1, 2, 3].map((line) => <div key={line} className="border-t border-dashed border-white/[.07]" />)}
        </div>
        {entries.length ? <div className="absolute inset-0 flex items-end gap-[3px]">
          {entries.map((month, index) => {
            const seconds = Number(month.seconds) || 0;
            const height = max ? Math.max(seconds ? 4 : 0, (seconds / max) * 100) : 0;
            return <div key={month.month} title={`${monthLabel(month.month)} · ${month.prints} 次 · ${formatDuration(seconds)}`} className={`min-w-0 flex-1 rounded-t-[2px] ${index === entries.length - 1 ? "bg-lime" : "bg-[#4b586c]"}`} style={{ height: `${height}%`, opacity: index === entries.length - 1 ? 1 : 0.62 }} />;
          })}
        </div> : <div className="absolute inset-0 grid place-items-center text-xs text-muted">暂无打印统计</div>}
      </div>
      <div className="mt-2 flex justify-between text-[9px] text-[#727987]">{entries.map((month) => <span key={month.month}>{monthLabel(month.month)}</span>)}</div>
    </div>
  );
}

function App() {
  const [active, setActive] = useState("总览");
  const [notice, setNotice] = useState("");
  const [mobileMenu, setMobileMenu] = useState(false);
  const [session, setSession] = useState({ checking: true, user: null, setup: false, error: "" });
  const [printers, setPrinters] = useState([]);
  const [history, setHistory] = useState([]);
  const [stats, setStats] = useState({ months: [], printers: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [connection, setConnection] = useState("connecting");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [startAfterUpload, setStartAfterUpload] = useState(true);
  const [selectedUploadPrinters, setSelectedUploadPrinters] = useState([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverResults, setDiscoverResults] = useState(null);
  const [selectedPrinterId, setSelectedPrinterId] = useState(null);
  const addFormRef = useRef(null);

  const notify = useCallback((message) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3800);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function checkSession() {
      try {
        const user = await api("/api/auth/me");
        if (!cancelled) setSession({ checking: false, user, setup: false, error: "" });
      } catch (error) {
        if (cancelled) return;
        if (error.status === 401) {
          try {
            const result = await api("/api/auth/need-setup");
            if (!cancelled) setSession({ checking: false, user: null, setup: result.setup, error: "" });
          } catch (setupError) {
            if (!cancelled) setSession({ checking: false, user: null, setup: false, error: setupError.message });
          }
        } else {
          setSession({ checking: false, user: null, setup: false, error: error.message });
        }
      }
    }
    checkSession();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!session.user) return undefined;
    let stopped = false;
    let reconnectTimer;
    let socket;

    const refreshHistory = async () => {
      const [rows, summary] = await Promise.all([
        api("/api/history?limit=20"),
        api("/api/stats"),
      ]);
      if (!stopped) {
        setHistory(rows);
        setStats(summary);
      }
    };

    const loadDashboard = async () => {
      setLoading(true);
      setLoadError("");
      try {
        const [printerRows, historyRows, summary] = await Promise.all([
          api("/api/printers"),
          api("/api/history?limit=20"),
          api("/api/stats"),
        ]);
        if (!stopped) {
          setPrinters(printerRows);
          setHistory(historyRows);
          setStats(summary);
          setLastUpdated(new Date());
          setLoading(false);
        }
      } catch (error) {
        if (!stopped) {
          if (error.status === 401) {
            setSession({ checking: false, user: null, setup: false, error: "" });
            return;
          }
          setLoadError(error.message);
          setLoading(false);
        }
      }
    };

    const connect = () => {
      if (stopped) return;
      setConnection("connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
      socket.onopen = () => setConnection("online");
      socket.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "init") {
          setPrinters(message.printers || []);
          setLastUpdated(new Date());
        } else if (message.type === "printer") {
          setPrinters((current) => {
            const next = current.filter((printer) => printer.id !== message.printer.id);
            next.push(message.printer);
            return next;
          });
          setLastUpdated(new Date());
        } else if (message.type === "removed") {
          setPrinters((current) => current.filter((printer) => printer.id !== message.id));
        } else if (message.type === "history") {
          refreshHistory().catch((error) => setLoadError(error.message));
        }
      };
      socket.onclose = (event) => {
        setConnection("offline");
        if (event.code === 4401) {
          setSession({ checking: false, user: null, setup: false, error: "" });
          return;
        }
        if (!stopped) reconnectTimer = window.setTimeout(connect, 3000);
      };
      socket.onerror = () => socket.close();
    };

    loadDashboard();
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [session.user]);

  const printerList = useMemo(() => printers.map(printerView), [printers]);
  const printerNames = useMemo(() => new Map(printers.map((printer) => [printer.id, printer.name])), [printers]);
  const todayRows = useMemo(() => {
    const today = new Date().toDateString();
    return history.filter((row) => new Date(Number(row.started_at) * 1000).toDateString() === today);
  }, [history]);
  const completedToday = todayRows.filter((row) => row.status === "completed").length;
  const runtimeToday = todayRows.reduce((total, row) => total + (Number(row.duration_s) || 0), 0);
  const printingCount = printerList.filter((printer) => ["printing", "processing"].includes(printer.state)).length;
  const onlineCount = printerList.filter((printer) => printer.online).length;
  const activeFilament = printerList.find((printer) => printer.filament)?.filament;

  const performPrinterAction = async (printer) => {
    const pause = printer.state !== "paused";
    try {
      await api(`/api/printers/${printer.id}/command`, {
        method: "POST",
        body: JSON.stringify({ params: { pause: pause ? 1 : 0 } }),
      });
      notify(pause ? `已请求暂停 ${printer.name}` : `已请求恢复 ${printer.name}`);
    } catch (error) {
      notify(error.message);
    }
  };

  const addPrinter = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/printers", {
        method: "POST",
        body: JSON.stringify({ name: form.get("name"), host: form.get("host") }),
      });
      setAddOpen(false);
      event.currentTarget.reset();
      notify("打印机已添加");
    } catch (error) {
      notify(error.message);
    }
  };

  const discover = async () => {
    setDiscovering(true);
    try {
      const found = await api("/api/discover");
      setDiscoverResults(Array.isArray(found) ? found : []);
      if (!Array.isArray(found) || !found.length) notify("局域网内未发现新的 Creality 打印机");
    } catch (error) {
      notify(error.message);
    } finally {
      setDiscovering(false);
    }
  };

  const fillFromScan = (item) => {
    const elements = addFormRef.current?.elements;
    if (!elements) return;
    elements.host.value = item.host;
    if (!elements.name.value) {
      elements.name.value = `${item.model_name || "Creality"}${item.mac ? ` ${item.mac.slice(-4)}` : ""}`;
    }
    notify(`已填入 ${item.host}`);
  };

  const sendFile = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.elements.file.files[0];
    if (!file) return;
    if (!selectedUploadPrinters.length) {
      notify("请至少选择一台打印机");
      return;
    }
    const body = new FormData();
    body.set("file", file);
    body.set("printers", selectedUploadPrinters.join(","));
    body.set("start", String(startAfterUpload));
    setUploading(true);
    try {
      const job = await api("/api/send", { method: "POST", body });
      setSendOpen(false);
      form.reset();
      notify("文件已加入发送队列，正在上传…");
      trackJob(job.id, () => {}, 2000)
        .then((final) => {
          const targets = Object.values(final?.targets || {});
          const errors = targets.map((target) => target.error).filter(Boolean);
          if (final?.error || errors.length) notify(`发送失败：${final?.error || errors.join("；")}`);
          else notify(startAfterUpload ? "文件已发送并开始打印 ✓" : "文件已发送 ✓");
        })
        .catch((error) => notify(error.message));
    } catch (error) {
      notify(error.message);
    } finally {
      setUploading(false);
    }
  };

  const navigate = (label) => {
    setMobileMenu(false);
    if (label === "设置" && session.user?.role !== "admin") {
      notify("需要管理员权限才能打开设置");
      return;
    }
    setActive(label);
  };

  const openPrinter = (printer) => {
    setSelectedPrinterId(printer.id);
    setActive("打印机");
  };

  const closeOverviewPrinter = () => {
    setSelectedPrinterId(null);
    setActive("总览");
  };

  if (session.checking) {
    return <main className="grid min-h-screen place-items-center text-sm text-muted">正在连接服务…</main>;
  }
  if (!session.user) {
    if (session.error) {
      return <main className="grid min-h-screen place-items-center px-6 text-center"><div className="max-w-md"><p className="text-sm font-medium text-red-300">无法连接服务</p><p className="mt-2 text-xs leading-relaxed text-muted">{session.error}</p><p className="mt-3 text-xs text-muted">请确认服务已启动，并检查前端代理地址配置。</p><button onClick={() => window.location.reload()} className="mt-5 rounded-lg border border-line px-4 py-2 text-xs text-white">重试</button></div></main>;
    }
    return <AuthScreen setup={session.setup} onAuthenticated={(user) => setSession({ checking: false, user, setup: false, error: "" })} />;
  }

  const currentUser = session.user.username || "用户";
  const isAdmin = session.user.role === "admin";
  const currentDate = new Intl.DateTimeFormat("zh-CN", { weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date());
  const recentHistory = history.slice(0, 4);
  const historyLabel = (status) => ({ completed: "已完成", running: "进行中", failed: "失败", stopped: "已停止" })[status] || status;

  return (
    <div className="min-h-screen text-[#e8eaf0]">
      <Sidebar active={active} onNavigate={navigate} printerCount={printerList.length} onlineCount={onlineCount} isAdmin={isAdmin} />
      <main className="min-h-screen lg:ml-[228px]">
        <header className="sticky top-0 z-10 flex h-[68px] items-center justify-between border-b border-line bg-[#090b10]/85 px-5 backdrop-blur-xl sm:px-8">
          <div className="flex items-center gap-3">
            <button onClick={() => setMobileMenu(!mobileMenu)} className="grid h-9 w-9 place-items-center rounded-lg border border-line text-muted lg:hidden" aria-label="打开菜单">☰</button>
            <div>
              <div className="text-[13px] font-medium text-white">工作空间 <span className="px-1.5 text-[#565c68]">/</span> <span className="text-[#9ba1ad]">{active}</span></div>
              <div className="mt-1 text-[10px] text-[#727987]">{currentDate}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="hidden items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-[10px] text-[#a9afbb] sm:flex"><i className={`h-1.5 w-1.5 rounded-full ${connection === "online" ? "bg-lime shadow-[0_0_8px_#c5f36b]" : connection === "connecting" ? "animate-pulse bg-amber-300" : "bg-red-400"}`} />{connection === "online" ? "服务器在线" : connection === "connecting" ? "正在连接" : "连接中断"}</span>
            {isAdmin && <button onClick={() => { setSelectedUploadPrinters(printerList.filter((printer) => printer.online && !["printing", "paused", "processing"].includes(printer.state)).map((printer) => printer.id)); setSendOpen(true); }} className="rounded-lg bg-lime px-3.5 py-2 text-[11px] font-semibold text-ink transition hover:bg-[#d5ff80] sm:px-4">＋ <span className="hidden sm:inline">发送文件</span><span className="sm:hidden">上传</span></button>}
            <button aria-label="退出登录" title={`${currentUser} · 退出登录`} onClick={async () => { try { await api("/api/auth/logout", { method: "POST" }); } catch (error) { notify(error.message); } finally { setSession({ checking: false, user: null, setup: false, error: "" }); } }} className="grid h-9 w-9 place-items-center rounded-full border border-[#353b46] bg-[#1a1e26] text-xs font-semibold text-[#d5d9e1]">{currentUser.slice(0, 1)}</button>
          </div>
        </header>

        {mobileMenu && <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setMobileMenu(false)}>
          <div className="h-full w-[260px] border-r border-line bg-[#0c0e13] p-5" onClick={(event) => event.stopPropagation()}>
            <div className="mb-8 flex items-center justify-between"><span className="text-sm font-semibold">CREALITY MONITOR</span><button onClick={() => setMobileMenu(false)} aria-label="关闭菜单">✕</button></div>
            {navItems.map((item) => <button key={item.label} onClick={() => navigate(item.label)} className={`flex w-full gap-3 rounded-xl px-3 py-3 text-left text-sm ${active === item.label ? "bg-[#1c222b] text-lime" : "text-muted"}`}><Icon>{item.icon}</Icon>{item.label}</button>)}
            {isAdmin && <button onClick={() => navigate("设置")} className={`flex w-full gap-3 rounded-xl px-3 py-3 text-left text-sm ${active === "设置" ? "bg-[#1c222b] text-lime" : "text-muted"}`}><Icon>⚙</Icon>设置</button>}
          </div>
        </div>}

        <div className="mx-auto max-w-[1440px] px-5 pb-10 pt-8 sm:px-8 lg:px-10">
          {active === "总览" && (<>
          <section className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
            <div>
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[.2em] text-lime"><span className="h-px w-5 bg-lime" />Printer overview</div>
              <h1 className="mt-3 text-[26px] font-semibold tracking-[-.04em] text-white sm:text-[32px]">打印机总览<span className="ml-3 text-sm font-normal tracking-normal text-[#737987]">你好，{currentUser}</span></h1>
              <p className="mt-2 text-xs text-[#888e9c]">实时掌握设备状态，让每一次打印都尽在掌控。</p>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-[#777e8b]"><span className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-panel">↻</span>{lastUpdated ? `最后更新于 ${lastUpdated.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "等待设备数据"}</div>
          </section>

          <section className="mt-7 grid grid-cols-2 gap-3 xl:grid-cols-4">
            {[
              { label: "设备总数", value: String(printerList.length).padStart(2, "0"), detail: `${onlineCount} 台在线`, icon: "▦", color: "text-white" },
              { label: "正在打印", value: String(printingCount).padStart(2, "0"), detail: printingCount ? "设备正在运行" : "暂无进行中的任务", icon: "▶", color: "text-lime" },
              { label: "今日完成", value: String(completedToday).padStart(2, "0"), detail: "来自打印历史", icon: "✓", color: "text-sky-300" },
              { label: "运行时长", value: (runtimeToday / 3600).toFixed(1), suffix: "h", detail: "今日累计打印时长", icon: "◷", color: "text-violet-300" },
            ].map((item) => <div key={item.label} className="rounded-2xl border border-line bg-panel p-4 sm:p-5">
              <div className="flex items-center justify-between"><span className="text-[11px] text-[#9298a5]">{item.label}</span><Icon className="text-[#6f7785]">{item.icon}</Icon></div>
              <div className={`mt-4 text-[27px] font-semibold tracking-[-.04em] ${item.color}`}>{item.value}<span className="ml-1 text-sm font-normal text-[#a2a8b4]">{item.suffix}</span></div>
              <div className="mt-1 text-[10px] text-[#707784]">{item.detail}</div>
            </div>)}
          </section>

          <div className="mt-8 grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1fr)_320px]">
            <section>
              <div className="mb-4 flex items-center justify-between">
                <div><h2 className="text-[15px] font-semibold text-white">我的打印机 <span className="ml-1.5 text-xs font-normal text-muted">{printerList.length} 台设备</span></h2></div>
                {isAdmin && <button onClick={() => setAddOpen(true)} className="rounded-lg border border-line px-3 py-2 text-[10px] text-[#c2c6ce] transition hover:border-[#46505e] hover:bg-white/[.03]">＋ 添加设备</button>}
              </div>
              {loadError && <div role="alert" className="mb-4 rounded-xl border border-red-400/25 bg-red-400/[.06] px-4 py-3 text-xs text-red-200">加载失败：{loadError} <button className="ml-2 underline" onClick={() => window.location.reload()}>重试</button></div>}
              <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {loading && !printerList.length ? <div className="col-span-full rounded-2xl border border-line bg-panel p-8 text-center text-xs text-muted">正在读取打印机数据…</div>
                  : printerList.length ? printerList.map((printer) => <PrinterCard key={printer.id} printer={printer} onAction={performPrinterAction} onOpen={openPrinter} isAdmin={isAdmin} />)
                    : <div className="col-span-full rounded-2xl border border-line bg-panel p-8 text-center"><p className="text-sm text-white">还没有添加打印机</p><p className="mt-2 text-xs text-muted">{isAdmin ? "使用“添加设备”录入打印机 IP 地址。" : "请联系管理员添加打印机。"}</p></div>}
              </div>
              <div className="mt-6 rounded-2xl border border-line bg-panel p-4 sm:p-5">
                <div className="flex items-start justify-between">
                  <div><h2 className="text-[13px] font-semibold text-white">打印活动</h2><p className="mt-1 text-[10px] text-muted">月度打印时长 · 最近 12 个月</p></div>
                  <span className="rounded-lg border border-line px-2.5 py-1.5 text-[10px] text-[#9ba1ad]">按月统计</span>
                </div>
                <ActivityChart months={stats.months || []} />
                <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-4 text-[10px] text-[#9ba1ad]">
                  <span><i className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[#647187]" />历史打印时长</span>
                  <span><i className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-lime" />最近月份</span>
                  <span className="ml-auto">本月 <b className="ml-1 font-medium text-white">{formatDuration(stats.months?.at(-1)?.seconds)}</b></span>
                </div>
              </div>
            </section>

            <aside className="space-y-5">
              <section className="rounded-2xl border border-line bg-panel p-5">
                <div className="flex items-center justify-between"><h2 className="text-[13px] font-semibold text-white">最近任务</h2><button onClick={() => navigate("打印历史")} className="text-[10px] text-lime">查看全部 →</button></div>
                <div className="mt-4 space-y-4">
                  {recentHistory.length ? recentHistory.map((row) => <div key={row.id} className="flex items-center gap-3">
                    <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl text-sm ${row.status === "running" ? "bg-lime/10 text-lime" : "bg-white/[.04] text-[#9aa1ae]"}`}>{row.status === "running" ? "◌" : "▤"}</div>
                    <div className="min-w-0 flex-1"><div className="truncate text-[11px] font-medium text-[#e0e2e8]">{row.file || "未命名任务"}</div><div className="mt-1 text-[9px] text-muted">{row.printer_name || printerNames.get(row.printer_id) || row.printer_id} · {formatDate(row.started_at)}</div></div>
                    <span className={`text-[9px] ${row.status === "running" ? "text-lime" : row.status === "failed" ? "text-red-300" : "text-[#8f96a3]"}`}>{row.status === "running" ? `${row.progress || 0}%` : historyLabel(row.status)}</span>
                  </div>) : <p className="py-2 text-xs text-muted">暂无打印记录</p>}
                </div>
              </section>

              <section className="overflow-hidden rounded-2xl border border-[#333c37] bg-[radial-gradient(ellipse_at_90%_0%,rgba(197,243,107,.1),transparent_48%),#111611] p-5">
                <div className="flex items-center justify-between"><h2 className="text-[13px] font-semibold text-white">耗材余量</h2><button className="text-[10px] text-[#a9bc8b]">管理 →</button></div>
                <div className="mt-5 flex items-center gap-3">
                  <div className="grid h-12 w-12 place-items-center rounded-full border-[3px] border-lime/60 text-lg text-lime" style={activeFilament?.color ? { color: activeFilament.color, borderColor: activeFilament.color } : undefined}>◉</div>
                  <div><div className="text-xs font-medium text-[#e1e6db]">{activeFilament?.name || "未检测到已装载耗材"}</div><div className="mt-1 text-[10px] text-[#8b9784]">{activeFilament ? "当前打印机耗材信息" : "耗材信息由打印机上报"}</div></div>
                </div>
                <div className="mt-4 text-[10px] leading-relaxed text-[#86907e]">{printerList.filter((printer) => printer.filament).map((printer) => `${printer.name} · ${printer.filament.name}`).join("　") || "当前没有打印机报告已装载的耗材。"}</div>
              </section>

              <section className="rounded-2xl border border-line bg-panel p-5">
                <div className="flex items-center justify-between"><h2 className="text-[13px] font-semibold text-white">系统动态</h2><span className="h-1.5 w-1.5 rounded-full bg-lime" /></div>
                <div className="mt-4 space-y-4">
                  {printerList.slice(0, 4).map((printer) => <div key={printer.id} className="flex gap-3"><span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${printer.state === "error" ? "bg-red-300" : printer.state === "printing" ? "bg-lime" : printer.state === "paused" ? "bg-amber-300" : "bg-sky-300"}`} /><div><p className="text-[10px] leading-relaxed text-[#c4c8d0]"><b className="font-medium text-white">{printer.name}</b> · {printer.raw.error?.title || (printer.state === "printing" ? `正在打印 ${printer.file}` : printer.state === "paused" ? "打印任务已暂停" : printer.state === "offline" ? "设备离线" : "设备在线，等待任务")}</p><span className="mt-1 block text-[9px] text-[#6f7683]">{printer.raw.online ? "实时设备状态" : "无法连接设备"}</span></div></div>)}
                  {!printerList.length && <p className="text-xs text-muted">暂无设备动态</p>}
                </div>
              </section>
            </aside>
          </div>
          </>)}
          {active === "打印机" && <PrintersPage printers={printerList} isAdmin={isAdmin} notify={notify} onAdd={() => setAddOpen(true)} initialSelectedId={selectedPrinterId} onDetailClose={selectedPrinterId ? closeOverviewPrinter : undefined} />}
          {active === "打印历史" && <HistoryPage printers={printerList} isAdmin={isAdmin} notify={notify} />}
          {active === "文件库" && <FilesPage printers={printerList} isAdmin={isAdmin} notify={notify} onNavigate={setActive} />}
          {active === "设置" && <SettingsPage printers={printerList} user={session.user} notify={notify} />}
        </div>
      </main>
      {addOpen && isAdmin && <div className="fixed inset-0 z-40 grid place-items-center bg-black/70 p-4" onClick={() => setAddOpen(false)}>
        <form ref={addFormRef} onSubmit={addPrinter} onClick={(event) => event.stopPropagation()} className="w-full max-w-sm rounded-2xl border border-line bg-panel p-6">
          <div className="mb-5 flex items-center justify-between"><h2 className="text-base font-semibold text-white">添加打印机</h2><button type="button" onClick={() => setAddOpen(false)} aria-label="关闭" className="text-muted">✕</button></div>
          <label className="mb-4 block text-xs text-[#b8bdc7]">名称<input name="name" placeholder="工作室打印机" className="mt-2 w-full rounded-lg border border-line bg-ink px-3 py-2.5 text-sm text-white outline-none focus:border-lime" /></label>
          <label className="mb-3 block text-xs text-[#b8bdc7]">IP 地址<input name="host" required placeholder="192.168.1.42" className="mt-2 w-full rounded-lg border border-line bg-ink px-3 py-2.5 text-sm text-white outline-none focus:border-lime" /></label>
          <div className="mb-5 rounded-xl border border-line bg-ink p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-[#b8bdc7]">局域网自动发现</span>
              <button type="button" onClick={discover} disabled={discovering} className="rounded-lg border border-line px-3 py-1.5 text-[11px] text-[#c2c6ce] transition hover:bg-white/[.05] disabled:opacity-50">{discovering ? "正在扫描…" : discoverResults === null ? "扫描网络" : "重新扫描"}</button>
            </div>
            <div className="mt-2.5 space-y-2">
              {discoverResults === null && <p className="text-[10px] leading-relaxed text-muted">点击扫描，查找同一网络中已开机的 Creality 打印机。</p>}
              {discoverResults !== null && !discoverResults.length && <p className="text-[10px] leading-relaxed text-muted">未发现打印机，请确认设备已开机且与本机在同一网络。</p>}
              {discoverResults?.map((item) => (
                <div key={`${item.mac || ""}-${item.host}`} className="flex items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-2">
                  <img src={`/models/${encodeURIComponent(item.model || "x")}.webp`} alt="" className="h-7 w-7 rounded object-contain" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] text-white">{item.model_name || "创想打印机"}</div>
                    <div className="text-[9px] text-muted">{item.host}{item.mac ? ` · ${item.mac.slice(-4)}` : ""}</div>
                  </div>
                  {item.known_id
                    ? <span className="shrink-0 text-[9px] text-lime">已添加{item.known_name ? `（${item.known_name}）` : ""}</span>
                    : <button type="button" onClick={() => fillFromScan(item)} className="shrink-0 rounded-lg bg-lime px-2 py-1 text-[10px] font-semibold text-ink transition hover:bg-[#d5ff80]">填入</button>}
                </div>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setAddOpen(false)} className="rounded-lg border border-line px-4 py-2 text-xs text-[#b8bdc7]">取消</button><button className="rounded-lg bg-lime px-4 py-2 text-xs font-semibold text-ink">添加</button></div>
        </form>
      </div>}
      {sendOpen && isAdmin && <div className="fixed inset-0 z-40 grid place-items-center bg-black/70 p-4" onClick={() => setSendOpen(false)}>
        <form onSubmit={sendFile} onClick={(event) => event.stopPropagation()} className="w-full max-w-md rounded-2xl border border-line bg-panel p-6">
          <div className="mb-5 flex items-center justify-between"><h2 className="text-base font-semibold text-white">发送 G-code 文件</h2><button type="button" onClick={() => setSendOpen(false)} aria-label="关闭" className="text-muted">✕</button></div>
          <label className="mb-5 block text-xs text-[#b8bdc7]">选择 .gcode 文件<input name="file" type="file" accept=".gcode" required className="mt-2 block w-full rounded-lg border border-line bg-ink px-3 py-2 text-xs text-[#b8bdc7] file:mr-3 file:rounded-md file:border-0 file:bg-[#242a34] file:px-3 file:py-1.5 file:text-xs file:text-white" /></label>
          <div className="mb-3 text-xs text-[#b8bdc7]">发送到</div>
          <div className="mb-5 max-h-40 space-y-2 overflow-auto">
            {printerList.map((printer) => {
              const busy = ["printing", "paused", "processing", "self_test"].includes(printer.state);
              const disabled = !printer.online || uploading || (startAfterUpload && busy);
              return <label key={printer.id} className={`flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-xs ${disabled ? "text-muted opacity-50" : "text-white"}`}><input type="checkbox" disabled={disabled} checked={selectedUploadPrinters.includes(printer.id) && !disabled} onChange={(event) => setSelectedUploadPrinters((current) => event.target.checked ? [...current, printer.id] : current.filter((id) => id !== printer.id))} />{printer.name}<span className="ml-auto text-[10px]">{!printer.online ? "离线" : busy ? printer.state : "就绪"}</span></label>;
            })}
            {!printerList.length && <p className="text-xs text-muted">请先添加打印机。</p>}
          </div>
          <label className="mb-5 flex items-center gap-2 text-xs text-[#b8bdc7]"><input type="checkbox" checked={startAfterUpload} onChange={(event) => setStartAfterUpload(event.target.checked)} />上传后立即开始打印</label>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setSendOpen(false)} className="rounded-lg border border-line px-4 py-2 text-xs text-[#b8bdc7]">取消</button><button disabled={uploading} className="rounded-lg bg-lime px-4 py-2 text-xs font-semibold text-ink disabled:opacity-60">{uploading ? "发送中…" : "发送文件"}</button></div>
        </form>
      </div>}
      {notice && <div role="status" className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-xl border border-line bg-[#1a1e26] px-4 py-3 text-center text-xs text-white shadow-2xl">{notice}</div>}
    </div>
  );
}

export default App;
