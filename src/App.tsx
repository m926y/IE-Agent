import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, aiCallsStatus, aiChat, aiConfirm, aiEvidenceCheck, aiSelftest, getMe, login } from "./api";
import type { EvidenceCard } from "./api";
import { Tag } from "./ui";
import type { Selftest } from "./api";
import type { MeUser } from "./api";
function clearAiSession() { try { const owner = sessionStorage.getItem("claw_ai_owner"); if (owner) sessionStorage.removeItem("claw_ai_msgs_" + owner); sessionStorage.removeItem("claw_ai_owner"); sessionStorage.removeItem("claw_fill"); sessionStorage.removeItem("claw_fill_seen"); } catch {} window.dispatchEvent(new Event("claw:auth-lost")); }
import { AdminShell } from "./admin";
import { DriverShell } from "./driver";

function LoginView({ onDone }: { onDone: () => void }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      await login(u.trim(), p);
      onDone();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "network_error";
      setMsg({ tone: code === "invalid_credentials" ? "danger" : "warn",
        text: code === "invalid_credentials" ? "账号或密码不正确。"
          : code === "account_disabled" ? "账号已停用，请联系安全管理员。"
          : code === "too_many_attempts" ? "尝试次数过多，请 5 分钟后再试。"
          : code === "database_unavailable" ? "数据库暂不可用（服务端已拒绝本次写入/读取）。"
          : "暂时无法完成登录，请稍后重试。" });
    } finally { setBusy(false); }
  }
  return <div className="login-wrap">
    <form className="login-card" onSubmit={submit}>
      <div className="login-brand"><div className="logo">CL</div><div><h1>Crazy Logi-AI 2.0</h1><div className="login-sub">驾驶安全管理工作台 · 演示搭建中</div></div></div>
      {msg && <div className={`alert ${msg.tone}`}>{msg.text}</div>}
      <div className="field"><label htmlFor="ln">登录账号</label><input id="ln" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} placeholder="工作台账号（服务端会话）" /></div>
      <div className="field"><label htmlFor="pw">密码</label><input id="pw" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} /></div>
      <button className="btn primary" disabled={busy || !u || !p}>{busy ? "登录中…" : "登 录"}</button>
      <p className="login-note">身份与角色由服务端依据会话校验；未登录时所有业务 API 返回 401，隐藏菜单只是辅助。登录后按角色进入：安全管理员 → PC 工作台；司机 → 窄屏端。</p>
      <p className="login-note">算法边界：40天预测、近14天评分、六维扣分、可信度与事件证据为只读事实，页面与 AI 只引用解释，不重算修改。</p>
    </form>
  </div>;
}

function SsoUnboundView({ name, provider, onUseAppAccount }: { name: string; provider: string; onUseAppAccount: () => void }) {
  return <div className="login-wrap"><div className="login-card">
    <h1>已识别平台身份，等待授权</h1>
    <p className="login-sub">{provider === "dingtalk" ? "钉钉" : "千问"} 账号「{name || "—"}」尚未绑定工作台角色。</p>
    <div className="alert info">安全管理员在「系统管理 → 账号与角色」为你开通并配置范围后，重新访问即可进入。行级数据权限在服务端按 user_bindings 生效。</div>
    <button className="btn lg" onClick={onUseAppAccount}>使用工作台账号登录（管理员引导入口）</button>
  </div></div>;
}

function AiPanel({ onClose, who }: { onClose: () => void; who: { role: string; userId: string } }) {
  type Msg = { role: "user" | "assistant"; content: string; citations?: string[]; limitations?: string[]; drafts?: Record<string, unknown>[] | null; err?: string; cards?: EvidenceCard[]; callId?: string | null; restored?: boolean };
  const storeKey = "claw_ai_msgs_" + who.userId;
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try {
      const owner = sessionStorage.getItem("claw_ai_owner");
      if (owner && owner !== who.userId) { sessionStorage.removeItem("claw_ai_owner"); sessionStorage.removeItem("claw_ai_msgs_" + owner); sessionStorage.removeItem("claw_fill"); }
      sessionStorage.setItem("claw_ai_owner", who.userId);
      const raw = sessionStorage.getItem(storeKey);
      const arr: Msg[] = raw ? JSON.parse(raw) : [];
      return arr.map(m => ({ ...m, restored: true }));
    } catch { return []; }
  });
  useEffect(() => { try { sessionStorage.setItem(storeKey, JSON.stringify(msgs.slice(-24))); } catch {} }, [msgs, storeKey]);
  useEffect(() => { const on401 = () => { try { sessionStorage.removeItem(storeKey); sessionStorage.removeItem("claw_ai_owner"); } catch {} }; window.addEventListener("claw:auth-lost", on401); return () => window.removeEventListener("claw:auth-lost", on401); }, [storeKey]);
  function doFill(ft: Record<string, unknown>) { try { sessionStorage.setItem("claw_fill", JSON.stringify(ft)); window.dispatchEvent(new CustomEvent("claw:fill", { detail: ft })); } catch {} const r = String(ft.route || ""); if (r) location.hash = r.replace(/^#/, ""); }
  const [confirms, setConfirms] = useState<Record<string, { decision: string; at: string; business: string | null }>>({});
  const [bizDraft, setBizDraft] = useState<Record<string, string>>({});
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<string | null>(null);
  const [st, setSt] = useState<null | Selftest>(null);
  const page = location.hash.replace(/^#\//, "").slice(0, 40);
  async function send(preset?: string) {
    const text = (preset ?? input).trim();
    if (!text || busy) return;
    setInput("");
    const next = [...msgs, { role: "user" as const, content: text }];
    setMsgs(next); setBusy(true);
    try {
      const r = await aiChat(next.map((m) => ({ role: m.role, content: m.content })), page);
      setMsgs(next.concat({ role: "assistant", content: r.answer, citations: r.citations, limitations: r.data_limitations, drafts: r.draft_preview, cards: (r as { evidence_cards?: EvidenceCard[] }).evidence_cards || [], callId: (r as { ai_call_id?: string | null }).ai_call_id || null }));
      { const ids = msgs.filter((m) => m.callId).map((m) => m.callId as string).concat([(r as { ai_call_id?: string | null }).ai_call_id || ""].filter(Boolean)); if (ids.length) aiCallsStatus(ids).then((x) => setConfirms((c0) => ({ ...c0, ...x.confirms }))).catch(() => {}); }
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "network_error";
      setMsgs(next.concat({ role: "assistant", content: "", err: code }));
    }
    setBusy(false);
  }
  const suggestions = who.role === "driver"
    ? ["我的评分怎么构成？", "我能问别人分数吗", "待审核课程算正式制度吗"]
    : ["今天先处理谁？", "说明 DEMO_D0149 三路信号", "2026-07-29 回放时点的 40 天预测能用吗", "给 alert-1e7ec09935dd735b 起草干预消息", "三种管理路径预演（95302616）"];
  return <div className="ai-panel" role="complementary" style={{ width: 380, padding: 0 }}>
    <div style={{ padding: "10px 14px", background: "var(--navy)", color: "#fff", borderRadius: "12px 12px 0 0" }}>
      <button className="ai-close" onClick={onClose} style={{ color: "#cdd9ef" }} aria-label="关闭">✕</button>
      <b style={{ fontSize: 13 }}>业务 AI 助手（运行时）</b>
      <div style={{ fontSize: 11, color: "#b9c8e2" }}>内置 Qwen3.8-MAX · 固定指令版本 {st?.prompt_version || probe?.match(/ver ([a-f0-9]{12})/)?.[1] || "加载中…"} · 仅经服务端受控工具读事实 · 写入须人工确认</div>
    </div>
    <div style={{ maxHeight: "52vh", overflow: "auto", padding: "10px 12px" }}>
      {msgs.length === 0 && <p style={{ fontSize: 12.5, color: "var(--ink-2)" }}>回答结构：结论→数字与证据（record_id/截止日/source_version/可信度）→限制→下一步。草稿仅预演，不自动写。</p>}
      {msgs.map((m, i) => m.role === "user"
        ? <div key={i} className="task-card" style={{ background: "var(--info-bg)" }}>{m.restored ? <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 2 }}>— 上一上下文的历史快照（以下数字未重新计算；追问将实时重查并重新验权）</div> : null}<div className="t">{m.content}</div></div>
        : m.err
          ? <div key={i} className="alert warn" style={{ fontSize: 12.5 }}>{m.err === "ai_provider_not_configured" ? "AI 通道未配置（属主 Page env）：运行时模型尚未接通——本界面不是静态聊天模拟，拒绝假回答。人工流程不受影响。探针：/api/meta/egress-probe 输出 ai_provider_not_configured" : m.err === "ai_upstream_error" ? "模型上游暂时不可用；工具与人工流程不受影响。" : `请求失败：${m.err}`}</div>
          : <div key={i} className="task-card">
              {m.restored ? <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 2 }}>— 上一上下文的历史快照（数字未重新计算；追问将实时重查并重新验权）</div> : null}
              <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{m.content}</div>
              {m.cards && m.cards.length > 0 && <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 4 }}>证据卡（数字仅来自受控工具真实返回；点击按当前会话重新验权；空值显示“—”不出 0）：</div>
                <div style={{ display: "grid", gap: 6 }}>
                {m.cards.map((cd) => <div key={cd.ref} className="task-card" style={{ padding: 8 }}>
                  <div className="t" style={{ fontSize: 12.5 }}>{cd.field} = <b style={{ color: cd.confidence === "low" ? "var(--warn)" : "var(--ink)" }}>{cd.value === null ? "—" : String(cd.value)}</b>{cd.confidence ? <> <Tag tone={cd.confidence === "low" ? "amber" : "green"}>可信度 {cd.confidence}</Tag></> : null}</div>
                  <div className="meta" style={{ fontSize: 11 }}>来源表 {cd.table} · record_id <span className="mono">{cd.ref.slice(cd.ref.indexOf(":") + 1)}</span>{cd.window ? ` · ${cd.window}` : ""}{cd.as_of_date ? ` · 截止 ${cd.as_of_date}` : ""}{cd.source_version ? ` · ${String(cd.source_version).slice(0, 22)}` : ""}</div>
                  {cd.limitations ? <div className="meta" style={{ color: "var(--warn)" }}>⚠ {cd.limitations}</div> : null}
                  <button className="btn" style={{ padding: "3px 10px", fontSize: 12, marginTop: 4 }} onClick={() => { setCheckMsg(null); aiEvidenceCheck(cd.ref).then((r2) => { if (r2.ok) { if (r2.route) { location.hash = r2.route; setCheckMsg(`重新验权通过，已跳转：${r2.route}`); } else { setCheckMsg("服务端已按当前会话重新验权：记录在你授权范围内（该来源无独立详情页）。"); } } else { setCheckMsg(`验权未通过/记录失效：${r2.hint || "请重新向AI查询"}`); } }).catch(() => setCheckMsg("校验未完成：请重试")); }}>打开 / 重新验权</button>
                  {m.callId && m.drafts && m.drafts.length > 0 && null}
                </div>)}
                </div>
              </div>}
              {m.citations && m.citations.length > 0 && <details style={{ marginTop: 6 }}><summary style={{ fontSize: 12, cursor: "pointer" }}>原始引用（{m.citations.length}）</summary>
                {m.citations.map((c) => <div key={c} className="mono" style={{ fontSize: 11 }}>{c}</div>)}
              </details>}
              {m.limitations && m.limitations.length > 0 && <div style={{ fontSize: 11.5, color: "var(--warn)", marginTop: 4 }}>限制：{m.limitations.join("；")}</div>}
              {m.drafts && m.drafts.length > 0 && <div style={{ marginTop: 6 }}>
                {m.drafts.map((d, k) => <div key={k} style={{ border: 0 }}>{d.kind === "intervention"
                  ? <div className="task-card"><div className="t">干预草稿（requires_confirmation=true）</div><div className="meta">{String((d as { draft_text?: string }).draft_text || "").slice(0, 210)}…</div><div className="meta">发送前在 RM03 编辑并确认；AI 未写库</div>{(d as { fill_to?: Record<string, unknown> }).fill_to ? <button className="btn" style={{ padding: "3px 10px" }} onClick={() => doFill((d as { fill_to: Record<string, unknown> }).fill_to)}>填入 RM03 草稿表单 →</button> : null}</div>
                  : d.kind === "training"
                    ? <div className="task-card"><div className="t">培训草稿（requires_confirmation=true）{(d as { fill_to?: Record<string, unknown> }).fill_to ? <button className="btn" style={{ padding: "3px 10px" }} onClick={() => doFill((d as { fill_to: Record<string, unknown> }).fill_to)}>填入 TR02 表单 →</button> : null}</div><div className="meta">{String((d as { goal?: string }).goal || "")}</div><div className="meta">仅 approved 课程可分配；TR02 页面确认；未审核课程由服务端 409 拒绝</div></div>
                    : <div className="task-card"><div className="t">管理动作建议（预演，未写入）</div><div className="meta">{JSON.stringify((d as { paths?: unknown[] }).paths || (d as { draft_action?: unknown[] }) || []).slice(0, 240)}</div>{(d as { fill_to?: Record<string, unknown> }).fill_to ? <button className="btn" style={{ padding: "3px 10px" }} onClick={() => doFill((d as { fill_to: Record<string, unknown> }).fill_to)}>填入表单 →</button> : null}</div>}
                </div>)}
              </div>}
            </div>)}
      {probe && <div className="alert info" style={{ fontSize: 12 }}>{probe}</div>}
    </div>
    {checkMsg && <div className="alert info" style={{ margin: "0 12px 6px" }}>{checkMsg}</div>}
    <div style={{ padding: "8px 12px", display: "flex", gap: 6 }}>
      <input style={{ flex: 1, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8 }} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} placeholder={busy ? "运行中…" : "问业务问题（越权会被工具层拒绝）"} aria-label="AI 提问" />
      <button className="btn primary" style={{ width: "auto" }} onClick={() => send()} disabled={busy || !input.trim()}>发送</button>
    </div>
    <div className="row" style={{ padding: "0 12px 10px" }}>
      {suggestions.map((s) => <button key={s} className="btn" style={{ padding: "4px 8px", fontSize: 12 }} onClick={() => send(s)}>{s}</button>)}
      {who.role === "safety_admin" && <button className="btn" style={{ padding: "4px 8px", fontSize: 12 }} onClick={() => { aiSelftest().then((r) => { setSt(r); setProbe(`工具自检 ${r.tools.length} 项 · 写入=${r.writes==="zero_confirmed"?"零":"异常"} · ${r.provider} · ver ${r.prompt_version}`);
 const pre: Record<string, unknown>[] = [];
 const pi = (r as { preplan?: Record<string, Record<string, unknown>> }).preplan;
 if (pi?.intervention?.fill_to) pre.push({ kind: "intervention", ...(pi.intervention as Record<string, unknown>) });
 if (pi?.training?.fill_to) pre.push({ kind: "training", ...(pi.training as Record<string, unknown>) });
 setMsgs((m) => m.concat({ role: "assistant" as const, content: `【工具链自检（真实执行，非模型对话）】\n` + r.tools.map((x) => `${x.tool}:${x.status}${x.requires_confirmation ? "(需确认草稿)" : ""}`).join("\n") + `\n业务表计数前后一致=${r.writes}`, drafts: pre.length ? pre : null })); }).catch((e) => setProbe("自检失败 " + (e instanceof ApiError ? e.code : "?"))); }}>运行工具链自检</button>}
    </div>
  </div>;
}

export function App() {
  const [me, setMe] = useState<MeUser | null | undefined>(undefined);
  const [unbound, setUnbound] = useState<{ name: string; provider: string } | null>(null);
  const [forceLogin, setForceLogin] = useState(false);
  const [ai, setAi] = useState(false);
  const reload = () => getMe().then((r) => {
    if (!r) { setMe(null); return; }
    if (r.user) { setMe(r.user); setUnbound(null); }
    else if (r.unbound) { setMe(null); setUnbound({ name: r.unbound.name, provider: r.unbound.provider }); }
    else setMe(null);
  }).catch(() => setMe(null));
  useEffect(() => { reload(); }, []);
  if (me === undefined) return <div className="login-wrap"><div className="skeleton" style={{ width: 240 }} /></div>;
  if (unbound && !forceLogin) return <SsoUnboundView {...unbound} onUseAppAccount={() => setForceLogin(true)} />;
  if (!me) return <LoginView onDone={reload} />;
  return <>
    {me.role === "driver" ? <DriverShell user={me} /> : <AdminShell user={me} />}
    <button className="ai-fab" onClick={() => setAi((v) => !v)} title="AI 助手">AI</button>
    {ai && <AiPanel onClose={() => setAi(false)} who={{ role: me!.role, userId: me!.userId }} />}
  </>;
}
