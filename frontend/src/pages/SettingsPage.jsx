import { useEffect, useState } from "react";
import { api, num } from "../api.js";

const inputCls = "rounded-lg border border-line bg-ink px-3 py-2 text-xs text-white outline-none focus:border-lime";
const smallBtn = "rounded-lg border border-line px-3 py-1.5 text-[11px] text-[#c2c6ce] transition hover:bg-white/[.05]";
const primaryBtn = "rounded-lg bg-lime px-3.5 py-2 text-xs font-semibold text-ink transition hover:bg-[#d5ff80]";

const buildForm = (raw) => ({
  filaments: Object.entries(raw.filaments || {}).map(([type, v]) => ({ type, price_kg: v.price_kg, density: v.density })),
  default_filament: raw.default_filament || "PLA",
  energy: { price_kwh: raw.energy?.price_kwh ?? 0, power_w: raw.energy?.power_w ?? 0 },
  maintenance: (raw.maintenance || []).map((task) => ({ ...task })),
  plugs: JSON.parse(JSON.stringify(raw.plugs || {})),
});

function Card({ title, hint, children, className = "" }) {
  return (
    <section className={`rounded-2xl border border-line bg-panel p-4 sm:p-5 ${className}`}>
      <h3 className="text-[13px] font-semibold text-white">{title}</h3>
      {hint && <p className="mt-1.5 text-[10px] leading-relaxed text-muted">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

// ---------- user management (changes apply immediately) ----------
function UsersCard({ user, notify }) {
  const [users, setUsers] = useState(null);
  const [draft, setDraft] = useState({ username: "", password: "", role: "user" });

  const load = async () => {
    try {
      setUsers(await api("/api/users"));
    } catch {
      /* keep the previous list */
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeRole = async (name, role) => {
    try {
      await api(`/api/users/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ role }) });
      notify("角色已更新");
      if (name === user.username) window.location.reload(); // our own permissions changed: rebuild the page
      else await load();
    } catch (error) {
      notify(error.message);
      load(); // put the old value back
    }
  };

  const resetPassword = async (name) => {
    const password = window.prompt(`为 ${name} 设置新密码（至少 6 位）`);
    if (!password) return;
    try {
      await api(`/api/users/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ password }) });
      if (name === user.username) {
        notify("密码已修改，请重新登录");
        window.setTimeout(() => window.location.assign("/login"), 900); // all sessions were closed
      } else {
        notify("密码已修改");
      }
    } catch (error) {
      notify(error.message);
    }
  };

  const removeUser = async (name) => {
    if (!window.confirm(`确定删除用户 ${name} 吗？其所有登录会话将立即失效。`)) return;
    try {
      await api(`/api/users/${encodeURIComponent(name)}`, { method: "DELETE" });
      notify("用户已删除");
      load();
    } catch (error) {
      notify(error.message);
    }
  };

  const addUser = async (event) => {
    event.preventDefault();
    const username = draft.username.trim();
    if (!username || !draft.password) {
      notify("请输入用户名和密码");
      return;
    }
    try {
      await api("/api/users", { method: "POST", body: JSON.stringify({ username, password: draft.password, role: draft.role }) });
      notify(`用户 ${username} 已创建 ✓`);
      setDraft({ username: "", password: "", role: "user" });
      load();
    } catch (error) {
      notify(error.message);
    }
  };

  return (
    <Card
      title="用户管理"
      hint="普通用户只能查看监控、耗材、打印任务、温度和最近打印；管理员可使用全部功能。修改角色或密码后立即生效。"
    >
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[11px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-[#6f7683]">
              <th className="pb-2 font-medium">用户名</th>
              <th className="pb-2 font-medium">角色</th>
              <th className="pb-2 font-medium">创建时间</th>
              <th className="pb-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {users?.length ? (
              users.map((u) => (
                <tr key={u.username} className="border-t border-line">
                  <td className="py-2.5 text-[#e0e2e8]">
                    {u.username}
                    {u.username === user.username && <span className="text-muted"> （当前）</span>}
                  </td>
                  <td className="py-2.5">
                    <select
                      value={u.role}
                      onChange={(event) => changeRole(u.username, event.target.value)}
                      aria-label={`${u.username} 的角色`}
                      className={`${inputCls} py-1`}
                    >
                      <option value="user">普通用户</option>
                      <option value="admin">管理员</option>
                    </select>
                  </td>
                  <td className="py-2.5 text-muted">{new Date(u.created_at * 1000).toLocaleDateString("zh-CN")}</td>
                  <td className="py-2.5">
                    <div className="flex justify-end gap-1.5">
                      <button onClick={() => resetPassword(u.username)} className={`${smallBtn} px-2 py-1 text-[10px]`}>改密码</button>
                      {u.username !== user.username && (
                        <button onClick={() => removeUser(u.username)} className="rounded-lg border border-red-400/30 px-2 py-1 text-[10px] text-red-300 transition hover:bg-red-400/10">
                          删除
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="py-4 text-center text-muted">{users === null ? "正在加载…" : "暂无用户。"}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <form onSubmit={addUser} className="mt-4 flex flex-wrap gap-2">
        <input
          value={draft.username}
          onChange={(event) => setDraft({ ...draft, username: event.target.value })}
          placeholder="用户名"
          autoComplete="off"
          className={inputCls}
        />
        <input
          value={draft.password}
          onChange={(event) => setDraft({ ...draft, password: event.target.value })}
          type="password"
          placeholder="密码（至少 6 位）"
          autoComplete="new-password"
          className={inputCls}
        />
        <select
          value={draft.role}
          onChange={(event) => setDraft({ ...draft, role: event.target.value })}
          aria-label="角色"
          className={inputCls}
        >
          <option value="user">普通用户</option>
          <option value="admin">管理员</option>
        </select>
        <button className={primaryBtn}>添加用户</button>
      </form>
    </Card>
  );
}

// ---------- slicer card ----------
function SlicerCard() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setStatus(await api("/api/slicer"));
    } catch {
      /* keep the last known status */
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // poll while an install is running (progress arrives via polling, not the websocket)
  const step = status?.install?.step;
  useEffect(() => {
    if (step !== "download" && step !== "extract") return undefined;
    const timer = window.setInterval(load, 2000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const install = async () => {
    setBusy(true);
    try {
      setStatus(await api("/api/slicer/install", { method: "POST" }));
    } catch (error) {
      setStatus((current) => ({ ...current, install: { step: "error", progress: 0, error: error.message } }));
    } finally {
      setBusy(false);
    }
  };

  const installState = status?.install || {};
  if (!status) return <p className="text-xs text-muted">正在检查切片器状态…</p>;

  if (installState.step === "download" || installState.step === "extract") {
    return (
      <div>
        <p className="text-xs text-[#d5d8df]">
          {installState.step === "download" ? `正在下载 OrcaSlicer… ${Math.round(installState.progress || 0)} %` : "正在解压…"}
        </p>
        <div className="mt-2 h-2 rounded-full bg-white/[.07]">
          <div className="h-2 rounded-full bg-lime transition-all" style={{ width: `${Math.min(100, installState.progress || 0)}%` }} />
        </div>
      </div>
    );
  }

  if (status.available) {
    const catalog = status.catalog || {};
    return (
      <div>
        <p className="flex items-center gap-2 text-xs text-[#d5d8df]">
          <i className="h-2 w-2 rounded-full bg-lime" /> OrcaSlicer 已安装。
        </p>
        <p className="mt-2 text-[10px] text-muted">
          {catalog.machine
            ? `${catalog.machine} 配置：${catalog.processes?.length || 0} 个质量预设，${catalog.filaments?.length || 0} 种耗材。`
            : "未找到 Creality Hi 配置文件。"}
        </p>
        <div className="mt-3 flex gap-2">
          <button className={smallBtn} onClick={load}>刷新状态</button>
        </div>
      </div>
    );
  }

  if (status.can_install === false) {
    return (
      <p className="text-xs leading-relaxed text-muted">
        如需在应用中直接切片 .stl / .3mf 文件，请从{" "}
        <a href="https://orcaslicer.com" target="_blank" rel="noreferrer" className="text-lime underline">orcaslicer.com</a>{" "}
        安装 OrcaSlicer（或将环境变量 <code className="rounded bg-ink px-1">ORCA_SLICER</code> 指向其可执行文件），然后重启应用。
      </p>
    );
  }

  return (
    <div>
      <p className="text-xs leading-relaxed text-muted">
        如需在应用中直接切片 .stl / .3mf 文件，请安装 OrcaSlicer v2.4.2（官方版本，下载约 150 MB，安装后约 380 MB，已校验哈希值）。其中包含 Creality（Hi、K1、K2 等）配置文件。
      </p>
      {installState.step === "error" && (
        <p className="mt-2 rounded-lg border border-red-400/30 bg-red-400/[.07] px-3 py-2 text-[11px] text-red-300">{installState.error}</p>
      )}
      <button onClick={install} disabled={busy} className={`${primaryBtn} mt-3 disabled:opacity-50`}>
        {busy ? "正在启动安装…" : "安装 OrcaSlicer"}
      </button>
    </div>
  );
}

export default function SettingsPage({ printers, user, notify }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoadError("");
    try {
      const raw = await api("/api/settings");
      setSettings(raw);
      setForm(buildForm(raw));
      setDirty(false);
    } catch (error) {
      setLoadError(error.message);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (user.role !== "admin") {
    return (
      <div className="rounded-2xl border border-line bg-panel p-10 text-center">
        <p className="text-sm text-white">需要管理员权限</p>
        <p className="mt-2 text-xs text-muted">设置仅管理员可见。</p>
      </div>
    );
  }

  const update = (mutate) => {
    setForm((current) => {
      const next = JSON.parse(JSON.stringify(current));
      mutate(next);
      return next;
    });
    setDirty(true);
  };

  const save = async () => {
    const filaments = {};
    for (const row of form.filaments) {
      const type = String(row.type || "").trim().toUpperCase();
      if (type) filaments[type] = { price_kg: num(row.price_kg) ?? 0, density: num(row.density) ?? 1.24 };
    }
    const body = {
      filaments,
      maintenance: form.maintenance.map((task) => ({
        id: task.id,
        name: String(task.name || "").trim() || "维护项目",
        hours: Math.max(1, num(task.hours) ?? 100),
      })),
      plugs: Object.fromEntries(
        Object.entries(form.plugs)
          .filter(([, plug]) => plug.type)
          .map(([pid, plug]) => [
            pid,
            {
              type: plug.type,
              host: String(plug.host || "").trim(),
              auto_off: Boolean(plug.auto_off),
              off_below: num(plug.off_below) ?? 50,
              delay_min: num(plug.delay_min) ?? 0,
            },
          ]),
      ),
      default_filament: filaments[String(form.default_filament || "").toUpperCase()]
        ? String(form.default_filament).toUpperCase()
        : Object.keys(filaments)[0] || "PLA",
      energy: { price_kwh: num(form.energy.price_kwh) ?? 0, power_w: num(form.energy.power_w) ?? 0 },
    };
    setSaving(true);
    try {
      const raw = await api("/api/settings", { method: "PATCH", body: JSON.stringify(body) });
      setSettings(raw);
      setForm(buildForm(raw));
      setDirty(false);
      notify("设置已保存 ✓（历史费用已重新计算）");
    } catch (error) {
      notify(error.message, true);
    } finally {
      setSaving(false);
    }
  };

  const plugTypes = settings?.plug_types || {};
  const filaments = form?.filaments || [];
  const defaultType = form?.default_filament?.toUpperCase?.();
  const filamentKeys = filaments.map((row) => String(row.type || "").trim().toUpperCase()).filter(Boolean);

  return (
    <div>
      <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[.2em] text-lime"><span className="h-px w-5 bg-lime" />Configuration</div>
          <h1 className="mt-3 text-[26px] font-semibold tracking-[-.04em] text-white sm:text-[30px]">设置</h1>
          <p className="mt-2 text-xs text-[#888e9c]">费用计算、维护提醒、智能插座与用户管理。</p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-[11px] ${dirty ? "text-amber-300" : "text-muted"}`}>{dirty ? "有未保存的更改" : ""}</span>
          <button onClick={save} disabled={!form || !dirty || saving} className={`${primaryBtn} disabled:cursor-not-allowed disabled:bg-[#333b2a] disabled:text-[#767c6c]`}>
            {saving ? "保存中…" : "保存设置"}
          </button>
        </div>
      </section>

      {loadError && (
        <div role="alert" className="mt-5 rounded-xl border border-red-400/25 bg-red-400/[.06] px-4 py-3 text-xs text-red-200">
          加载失败：{loadError}
          <button className="ml-2 underline" onClick={load}>重试</button>
        </div>
      )}
      {!form && !loadError && <p className="mt-6 text-xs text-muted">正在加载设置…</p>}

      {form && (
        <div className="mt-6 grid gap-4 xl:grid-cols-2">
          {/* filament prices */}
          <Card title="耗材价格" hint="用于计算每次打印的费用。密度用于将耗材长度换算为重量。">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-[#6f7683]">
                    <th className="pb-2 font-medium">类型</th>
                    <th className="pb-2 font-medium">价格 ($/kg)</th>
                    <th className="pb-2 font-medium">密度 (g/cm³)</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filaments.map((row, index) => (
                    <tr key={index} className="border-t border-line">
                      <td className="py-2 pr-2">
                        <input
                          value={row.type}
                          aria-label="类型"
                          placeholder="例如：PLA-SILK"
                          onChange={(event) => update((f) => { f.filaments[index].type = event.target.value; })}
                          className={inputCls}
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <input
                          type="number"
                          step="0.5"
                          min="0"
                          value={row.price_kg}
                          aria-label="每千克价格"
                          onChange={(event) => update((f) => { f.filaments[index].price_kg = event.target.value; })}
                          className={`${inputCls} w-24`}
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <input
                          type="number"
                          step="0.01"
                          min="0.5"
                          value={row.density}
                          aria-label="密度"
                          onChange={(event) => update((f) => { f.filaments[index].density = event.target.value; })}
                          className={`${inputCls} w-24`}
                        />
                      </td>
                      <td className="py-2 text-right">
                        <button
                          onClick={() => update((f) => { f.filaments.splice(index, 1); })}
                          aria-label="删除"
                          className="rounded-lg border border-line px-2 py-1.5 text-[10px] text-[#aeb4c0] hover:bg-white/[.06]"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!filaments.length && (
                    <tr>
                      <td colSpan={4} className="py-3 text-center text-muted">暂无耗材类型。</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <button
                onClick={() =>
                  update((f) => {
                    f.filaments.push({ type: "", price_kg: 20, density: 1.24 });
                  })
                }
                className={smallBtn}
              >
                + 添加耗材
              </button>
              <label className="flex items-center gap-2 text-[11px] text-[#b8bdc7]">
                默认耗材
                <select
                  value={filamentKeys.includes(defaultType) ? defaultType : filamentKeys[0] || ""}
                  onChange={(event) => update((f) => { f.default_filament = event.target.value; })}
                  className={`${inputCls} py-1.5`}
                >
                  {filamentKeys.map((key) => (
                    <option key={key} value={key}>{key}</option>
                  ))}
                </select>
              </label>
            </div>
          </Card>

          {/* energy */}
          <Card title="电费" hint="Creality Hi 打印时的功率约为 100–200 W（含热床加热）。">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-[11px] text-[#b8bdc7]">
                每千瓦时电价
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.energy.price_kwh}
                  onChange={(event) => update((f) => { f.energy.price_kwh = event.target.value; })}
                  className={`${inputCls} mt-1.5 w-full`}
                />
              </label>
              <label className="text-[11px] text-[#b8bdc7]">
                打印时平均功率 (W)
                <input
                  type="number"
                  step="10"
                  min="0"
                  value={form.energy.power_w}
                  onChange={(event) => update((f) => { f.energy.power_w = event.target.value; })}
                  className={`${inputCls} mt-1.5 w-full`}
                />
              </label>
            </div>
          </Card>

          {/* maintenance */}
          <Card title="维护提醒" hint="按每台打印机的累计打印时长提醒维护。">
            <div className="space-y-2">
              {form.maintenance.map((task, index) => (
                <div key={task.id || index} className="flex flex-wrap items-center gap-2">
                  <input
                    value={task.name}
                    aria-label="项目"
                    placeholder="例如：检查 PTFE 管"
                    onChange={(event) => update((f) => { f.maintenance[index].name = event.target.value; })}
                    className={`${inputCls} min-w-[160px] flex-1`}
                  />
                  <label className="flex items-center gap-1.5 text-[11px] text-[#b8bdc7]">
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={task.hours}
                      aria-label="间隔"
                      onChange={(event) => update((f) => { f.maintenance[index].hours = event.target.value; })}
                      className={`${inputCls} w-24`}
                    />
                    小时
                  </label>
                  <button
                    onClick={() => update((f) => { f.maintenance.splice(index, 1); })}
                    aria-label="删除"
                    className="rounded-lg border border-line px-2 py-1.5 text-[10px] text-[#aeb4c0] hover:bg-white/[.06]"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() =>
                update((f) => {
                  f.maintenance.push({ id: `t${Date.now().toString(36)}`, name: "", hours: 100 });
                })
              }
              className={`${smallBtn} mt-3`}
            >
              + 添加维护项目
            </button>
          </Card>

          {/* smart plugs */}
          <Card title="智能插座" hint="支持本地连接的 Shelly 或 Tasmota。自动断电会等待喷嘴冷却；若再次开始打印则取消断电。">
            <div className="space-y-3">
              {printers.map((printer) => {
                const plug = form.plugs[printer.id] || {};
                return (
                  <div key={printer.id} className="rounded-xl border border-line bg-ink p-3">
                    <b className="mb-2 block truncate text-xs font-medium text-white">{printer.name}</b>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={plug.type || ""}
                        aria-label={`${printer.name} 插座类型`}
                        onChange={(event) =>
                          update((f) => {
                            const current = f.plugs[printer.id] || { type: "", host: "", auto_off: false, off_below: 50, delay_min: 0 };
                            current.type = event.target.value;
                            f.plugs[printer.id] = current;
                          })
                          }
                        className={`${inputCls} py-1.5`}
                      >
                        <option value="">不使用插座</option>
                        {Object.entries(plugTypes).map(([key, label]) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                      <input
                        placeholder="插座 IP 地址"
                        value={plug.host || ""}
                        disabled={!plug.type}
                        onChange={(event) =>
                          update((f) => {
                            const current = f.plugs[printer.id] || { type: "", host: "", auto_off: false, off_below: 50, delay_min: 0 };
                            current.host = event.target.value;
                            f.plugs[printer.id] = current;
                          })
                          }
                        className={`${inputCls} py-1.5 disabled:opacity-40`}
                      />
                    </div>
                    {plug.type && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] text-[#b8bdc7]">
                        <label className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={Boolean(plug.auto_off)}
                            onChange={(event) =>
                              update((f) => {
                                const current = f.plugs[printer.id] || { type: "", host: "", auto_off: false, off_below: 50, delay_min: 0 };
                                current.auto_off = event.target.checked;
                                f.plugs[printer.id] = current;
                              })
                            }
                            className="accent-[#c5f36b]"
                          />
                          打印结束后关闭
                        </label>
                        <label className="flex items-center gap-1.5">
                          低于
                          <input
                            type="number"
                            min="30"
                            max="120"
                            value={plug.off_below ?? 50}
                            onChange={(event) =>
                              update((f) => {
                                const current = f.plugs[printer.id] || { type: "", host: "", auto_off: false, off_below: 50, delay_min: 0 };
                                current.off_below = event.target.value;
                                f.plugs[printer.id] = current;
                              })
                            }
                            className={`${inputCls} w-16 px-1.5 py-1`}
                          />
                          °C
                        </label>
                        <label className="flex items-center gap-1.5">
                          延迟
                          <input
                            type="number"
                            min="0"
                            max="240"
                            value={plug.delay_min ?? 0}
                            onChange={(event) =>
                              update((f) => {
                                const current = f.plugs[printer.id] || { type: "", host: "", auto_off: false, off_below: 50, delay_min: 0 };
                                current.delay_min = event.target.value;
                                f.plugs[printer.id] = current;
                              })
                            }
                            className={`${inputCls} w-16 px-1.5 py-1`}
                          />
                          分钟
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
              {!printers.length && <p className="text-xs text-muted">请先添加打印机。</p>}
            </div>
          </Card>

          <SlicerCard />
          <UsersCard user={user} notify={notify} />
        </div>
      )}

      {form && (
        <div className="sticky bottom-4 mt-6 flex items-center justify-between rounded-2xl border border-line bg-panel/95 px-4 py-3 backdrop-blur">
          <span className={`text-[11px] ${dirty ? "text-amber-300" : "text-muted"}`}>
            {dirty ? "有未保存的更改" : settings ? "所有更改已保存" : ""}
          </span>
          <button onClick={save} disabled={!dirty || saving} className={`${primaryBtn} disabled:cursor-not-allowed disabled:bg-[#333b2a] disabled:text-[#767c6c]`}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      )}
    </div>
  );
}
