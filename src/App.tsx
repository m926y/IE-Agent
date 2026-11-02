import {BrandMark} from './brand';
import {LoginHome} from './login-home';
import {ConversationSidebar,readConversations} from './ai-conversations';
import {MessagingProvider} from './messaging';
import { AiMessage } from './ai-message';
import './ai-message.css';
import { AgentReportCard, AgentActionCard, AgentAccountUpload } from './agent-tools';
import {RiskMonitorProvider} from './risk-monitor';
import type { AgentArtifact, AgentPlan } from './agent-tools';
import { AccountProfile } from "./account";
import { loadVehicleLabels, displayText } from "./vehicles";
import {useEffect, useState, useRef} from "react";
import type { FormEvent } from "react";
import {ApiError, aiCallsStatus, aiChat, aiConfirm, aiEvidenceCheck, aiEvidenceCheckVer, aiSelftest, getMe, login, opsList, opsSet} from "./api";
import type { Selftest } from "./api";
import type { EvidenceCard } from "./api";
import { Tag } from "./ui";
import type { MeUser } from "./api";
function clearAiSession() { try { const owner = sessionStorage.getItem("claw_ai_owner"); if (owner) sessionStorage.removeItem("claw_ai_msgs_" + owner); sessionStorage.removeItem("claw_ai_owner"); sessionStorage.removeItem("claw_fill"); sessionStorage.removeItem("claw_fill_seen"); } catch {} window.dispatchEvent(new Event("claw:auth-lost")); }
import { AdminShell } from "./admin";
import { DriverShell } from "./driver";

function LoginView({ onDone }: { onDone: () => void }) {
  const [notice] = useState(() => { const s = sessionStorage.getItem("account_notice"); sessionStorage.removeItem("account_notice"); return s; });
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
          : code === "database_unavailable" ? "登录服务暂不可用，请稍后重试。"
          : code === "network_error" ? "登录服务暂不可用，请稍后重试。"
          : "暂时无法完成登录，请稍后重试。" });
    } finally { setBusy(false); }
  }
  return <LoginHome>
    <form id="login-form" className="login-card" onSubmit={submit}>
      <div className="login-brand"><BrandMark/><div><h1>易流智安</h1><div className="login-sub">驾驶安全管理</div></div></div>
      <h2 className="login-heading">欢迎回来</h2><p className="lh-form-subtitle">登录易流智安，进入安全管理工作台</p>{notice && <div className="alert info">{notice}</div>}
      {msg && <div className={`alert ${msg.tone}`} role="alert">{msg.text}</div>}
      <div className="field"><label htmlFor="ln">账号</label><input id="ln" autoComplete="username" autoCapitalize="none" spellCheck={false} value={u} onChange={(e) => { setU(e.target.value); setMsg(null); }} placeholder="请输入账号" required /></div>
      <div className="field"><label htmlFor="pw">密码</label><div className="password-input"><input id="pw" type={showPassword ? "text" : "password"} autoComplete="current-password" value={p} onChange={(e) => { setP(e.target.value); setMsg(null); }} placeholder="请输入密码" required /><button type="button" className="password-toggle" aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword} onClick={() => setShowPassword(v => !v)}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />{showPassword && <path d="M3 3l18 18" />}</svg></button></div></div>
      <button className="btn primary login-submit" disabled={busy || !u.trim() || !p}>{busy ? "登录中…" : "登录"}<span aria-hidden="true">→</span></button>
    </form>
  </LoginHome>;
}

function SsoUnboundView({ name, provider, onUseAppAccount }: { name: string; provider: string; onUseAppAccount: () => void }) {
  return <div className="login-wrap sso-unbound"><div className="login-card">
    <h1>等待账号授权</h1>
    <p className="login-sub">{provider === "dingtalk" ? "钉钉" : "千问"} 账号「{name || "—"}」尚未绑定工作台角色。</p>
    <div className="alert info">安全管理员在「系统管理 → 账号与角色」为你开通并配置范围后，重新访问即可进入。</div>
    <button className="btn lg" onClick={onUseAppAccount}>使用账号登录</button>
  </div></div>;
}

function openEvidenceRoute(route:string){if(route.startsWith('driver:'))window.dispatchEvent(new CustomEvent('claw:driver-nav',{detail:route.slice(7)}));else location.hash=route.replace(/^#/, '');}

function AiPanel({ onClose, who, preset, onPresetUsed }: { onClose: () => void; who: { role: string; userId: string }; preset?: string | null; onPresetUsed?: () => void }) {
  type Msg = { artifacts?:AgentArtifact[]; actionPlans?:AgentPlan[]; role: "user" | "assistant"; content: string; citations?: string[]; limitations?: string[]; drafts?: Record<string, unknown>[] | null; err?: string; cards?: EvidenceCard[]; callId?: string | null; restored?: boolean; longTerm?: boolean; replayed?: boolean };
  const [historyOpen,setHistoryOpen]=useState(false);
  const [driverGreeting]=useState(()=>[
    '开车辛苦了，有什么想问的？',
    '一路辛苦了，有什么我能帮忙的？',
    '歇一会儿吧，有问题随时问我。',
    '辛苦了，今天有什么想了解的？',
    '休息一下，有什么想聊的吗？'
  ][Math.floor(Math.random()*5)]);
  const storeKey = "claw_ai_msgs_" + who.userId;
  const chatScrollRef=useRef<HTMLDivElement>(null);
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try {
      const owner = sessionStorage.getItem("claw_ai_owner");
      if (owner && owner !== who.userId) { sessionStorage.removeItem("claw_ai_owner"); sessionStorage.removeItem("claw_ai_msgs_" + owner); sessionStorage.removeItem("claw_fill"); }
      sessionStorage.setItem("claw_ai_owner", who.userId);
      const history=readConversations(who.userId);
      const historical=history.items.find(t=>t.id===history.active);
      const raw = historical?JSON.stringify(historical.messages):sessionStorage.getItem(storeKey);
      const arr: Msg[] = raw ? JSON.parse(raw) : [];
      let lg: Msg[] = [];
      try { const lr = localStorage.getItem("claw_ai_long_" + who.userId); if (lr) { const d = JSON.parse(lr); if (Number(d.exp) < Date.now()) localStorage.removeItem("claw_ai_long_" + who.userId); else lg = (d.items || []).map((x: { r: string; x: string }): Msg => ({ role: x.r === "assistant" ? "assistant" : "user", content: String(x.x), longTerm: true, restored: true })); } } catch {}
      const base: Msg[] = arr.map((m): Msg => ({ ...m, restored: true }));
      return arr.length ? base : base.concat(lg);
    } catch { return []; }
  });
  useEffect(() => { try { sessionStorage.setItem(storeKey, JSON.stringify(msgs.slice(-24))); } catch {} if(chatScrollRef.current)chatScrollRef.current.scrollTop=chatScrollRef.current.scrollHeight; }, [msgs, storeKey]);
  const sendRef = useRef<(p?: string) => void>(() => undefined);
  sendRef.current = (text?: string) => { void send(text); };
  useEffect(() => { if (preset) { const t = setTimeout(() => { sendRef.current(preset); onPresetUsed && onPresetUsed(); }, 60); return () => clearTimeout(t); } }, [preset]);
  useEffect(() => { const on401 = () => { try { sessionStorage.removeItem(storeKey); sessionStorage.removeItem("claw_ai_owner"); } catch {} }; window.addEventListener("claw:auth-lost", on401); return () => window.removeEventListener("claw:auth-lost", on401); }, [storeKey]);
  function doFill(ft: Record<string, unknown>) { try { sessionStorage.setItem("claw_fill", JSON.stringify(ft)); window.dispatchEvent(new CustomEvent("claw:fill", { detail: ft })); } catch {} const r = String(ft.route || ""); if (r) location.hash = r.replace(/^#/, ""); }
  const [confirms, setConfirms] = useState<Record<string, { decision: string; at: string; business: string | null }>>({});
  const [bizDraft, setBizDraft] = useState<Record<string, string>>({});
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
  const [longOn, setLongOn] = useState<boolean | null>(null);
  const longKey = "claw_ai_long_" + who.userId;
  const [longBanner, setLongBanner] = useState<string | null>(null);
  function excerpt(s: string) { return String(s).replace(/(密码|口令|token|cookie|sk-)[^\s，。,]*/gi, "$1***").slice(0, 90); }
  useEffect(() => { if (who.role !== "safety_admin") { setLongOn(false); return; } opsList().then((r) => { const row = (r as { rows: Record<string, unknown>[] }).rows.find((x) => String(x.config_id) === "ai_long_session"); setLongOn(String(row?.value || "off") === "on"); }).catch(() => setLongOn(false)); }, [who.role]);
  useEffect(() => { if (who.role !== "safety_admin" || !longOn) return; try { const items = msgs.slice(-8).map(m => ({ r: m.role, x: excerpt(m.content), refs: (m.cards || []).map(c => c.ref).slice(0, 6) })); localStorage.setItem(longKey, JSON.stringify({ exp: Date.now() + 7200000, items })); } catch { setLongBanner("本平台不支持安全本地存储或配额受限：长期恢复不可用（现跨页 sessionStorage 能力不受影响）"); } }, [msgs, longOn, longKey, who.role]);
  useEffect(() => { try { const raw = localStorage.getItem(longKey); if (raw) { const d = JSON.parse(raw); if (Number(d.exp) > Date.now() && (d.items || []).length) setLongBanner(`已加载本设备长期摘要（脱敏 ${d.items.length} 条，非业务状态；数字将在追问时重查）`); else if (Number(d.exp) < Date.now()) { localStorage.removeItem(longKey); setLongBanner("长期摘要已过期（2h）自动清除——重登从空会话开始"); } } } catch {} }, [longKey]);
  const [probe, setProbe] = useState<string | null>(null);
  const [st, setSt] = useState<null | Selftest>(null);
  const [lastModel, setLastModel] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const page = location.hash.replace(/^#\//, "").slice(0, 40);
  async function send(preset?: string) {
    const text = (preset ?? input).trim();
    if (!text || busy) return;
    setInput("");
    const next = [...msgs, { role: "user" as const, content: text }];
    setMsgs(next); setBusy(true);
    // 幂等键（agent1 client_request_id 语义）：网络重试/双击由服务端回放同一结果
    const crid = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "r" + Date.now() + Math.random().toString(36).slice(2, 10);
    try {
      const r = await aiChat(next.map((m) => ({ role: m.role, content: m.content })), page, crid,page.startsWith('rm-live')?sessionStorage.getItem('claw_current_case')||undefined:undefined);
      if (r.meta?.model) setLastModel(String(r.meta.model));
      setMsgs(next.concat({ role: "assistant", content: r.answer, artifacts:r.artifacts, actionPlans:r.action_plans, citations: r.citations, limitations: r.data_limitations, drafts: r.draft_preview, cards: (r as { evidence_cards?: EvidenceCard[] }).evidence_cards || [], callId: (r as { ai_call_id?: string | null }).ai_call_id || null, replayed: r.idempotent_replay === true }));
      { const ids = msgs.filter((m) => m.callId).map((m) => m.callId as string).concat([(r as { ai_call_id?: string | null }).ai_call_id || ""].filter(Boolean)); if (ids.length) aiCallsStatus(ids).then((x) => setConfirms((c0) => ({ ...c0, ...x.confirms }))).catch(() => {}); }
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "network_error";
      setMsgs(next.concat({ role: "assistant", content: "", err: code }));
    }
    setBusy(false);
  }
  const suggestions = who.role === "driver"
    ? ["我的评分怎么构成？", "我能问别人分数吗", "待审核课程算正式制度吗", "如何提交复核申请"]
    : ["生成最近有数据的一周车队周报，输出HTML和Markdown文件", "分析车队评分分布及重点关注车辆", "查看课程，准备给D级车辆创建培训任务"];
  return <div className={"ai-panel ai-with-history"+(who.role==="driver"?" mobile-ai "+(historyOpen?"history-open":""):"")} role="complementary" style={{ width: 380, padding: 0 }}>
    {who.role==="driver"&&<div className="mobile-ai-toolbar"><button aria-label="历史会话" onClick={()=>setHistoryOpen(true)}>☰</button><strong>新会话</strong><button aria-label="新建会话" disabled={busy} onClick={()=>window.dispatchEvent(new Event("claw:driver-new-chat"))}>＋</button></div>}
    <div style={{ padding: "10px 14px", background: "var(--navy)", color: "#fff", borderRadius: "12px 12px 0 0" }}>
      <button className="ai-close" onClick={onClose} style={{ color: "#cdd9ef" }} aria-label="关闭">✕</button>
      <b style={{ fontSize: 14 }}>AI 助手</b>
      <details className="ai-tools-menu"><summary>更多</summary><div>    {["safety_admin","safety_officer"].includes(who.role) && <details className="ai-advanced"><summary>会话设置</summary><div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <label className="meta" style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" checked={Boolean(longOn)} aria-label="长期会话摘要开关" onChange={(e) => { const v = e.target.checked; setLongOn(v); if (!v) { try { localStorage.removeItem(longKey); } catch {} setLongBanner("已关闭并清除本设备长期摘要"); } opsSet("ai_long_session", v ? "on" : "off").then((r) => setLongBanner(`长期摘要开关=${v ? "on" : "off"}（config v${r.new_version}，审计 ${r.audit_id}）`)).catch(() => setLongBanner("开关写入失败（需 manage.operation_config 能力）")); }} />重登后保留脱敏摘要（默认关；2h 过期；不含令牌/明文个人数据/业务状态）</label>
      <button className="btn" style={{ padding: "2px 8px" }} onClick={() => { try { localStorage.removeItem(longKey); } catch {} setLongBanner("已一键清除本设备长期摘要"); }}>一键清除</button>
    </div>{longBanner && <p className="meta">{longBanner}</p>}</details>}
    {["safety_admin","safety_officer"].includes(who.role) && <details className="ai-advanced"><summary>Excel账号导入</summary><AgentAccountUpload disabled={busy} onPlan={p=>setMsgs(m=>m.concat({role:"assistant",content:`已上传并校验账号表，批次 ${p.id}，共 ${p.count} 个账号；尚未创建。可以在下方确认，或让我检查这个批次。`,actionPlans:[p]}))}/></details>}
</div></details>
      
    </div>
    {who.role==="driver"&&historyOpen&&<button className="mobile-history-backdrop" aria-label="关闭历史会话" onClick={()=>setHistoryOpen(false)}/>}
    <ConversationSidebar mobile={who.role==="driver"} onDismiss={()=>setHistoryOpen(false)} user={who.userId} messages={msgs} busy={busy} onSelect={items=>{setMsgs(items);setInput('');setCheckMsg(null);setBizDraft({});setConfirms({})}}/>
    <div className="ai-main">
    <div className="ai-chat-body" ref={chatScrollRef} style={{ overflow: "auto", padding: "10px 12px" }}>

      {who.role==="driver"&&msgs.length===0&&<div className="mobile-chat-welcome"><img className="mobile-chat-logo" src="/brand/yiliu-mark.svg" alt="易流智安"/><h2>{driverGreeting}</h2></div>}
      {msgs.map((m, i) => m.role === "user"
        ? <div key={i} className="task-card" style={{ background: "var(--info-bg)" }}><div className="t">{displayText(m.content).startsWith("AI04 三种管理路径并排预演") ? "分析当前车辆的处置方案" : displayText(m.content)}</div></div>
        : m.err
          ? <div key={i} className="alert warn" style={{ fontSize: 12.5 }}>{m.err === "ai_provider_not_configured" ? "AI 通道未配置（属主 Page env）：运行时模型尚未接通——本界面不是静态聊天模拟，拒绝假回答。人工流程不受影响。" : m.err === "ai_upstream_error" ? "模型上游暂时不可用；工具与人工流程不受影响（可稍后重试）。" : m.err === "ai_request_version_conflict" ? "该问题已有返回结果（幂等保护）；请修改问题后重试。" : m.err === "unauthenticated" ? "登录已过期：请刷新页面重新登录。" : m.err === "ai_policy_blocked" ? "模型端点策略不允许（必须是外部 HTTPS 地址）；请属主检查 Page env。" : `请求失败：${m.err}`}</div>
          : <div key={i} className="task-card">
              {m.longTerm ? <div style={{ fontSize: 11, color: "#ad6800", marginBottom: 2 }}>⌛ 长期摘要（本设备暂存·已截断，非业务状态；重登恢复）</div> : null}
              
              <AiMessage content={displayText(m.content)} />
              {m.artifacts?.map(a=><AgentReportCard key={a.id} artifact={a}/>)}
              {m.actionPlans?.map(p=><AgentActionCard key={p.id} initial={p}/>)}
              {m.cards && m.cards.length > 0 && <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 4 }}>证据卡（数字仅来自受控工具真实返回；点击按当前会话重新验权；空值显示“—”不出 0）：</div>
                <div style={{ display: "grid", gap: 6 }}>
                {m.cards.map((cd) => <div key={cd.ref} className="task-card" style={{ padding: 8 }}>
                  <div className="t" style={{ fontSize: 12.5 }}>{cd.field} = <b style={{ color: cd.confidence === "low" ? "var(--warn)" : "var(--ink)" }}>{cd.value === null ? "—" : displayText(cd.value)}</b>{cd.confidence ? <> <Tag tone={cd.confidence === "low" ? "amber" : "green"}>可信度 {cd.confidence}</Tag></> : null}</div>
                  <div className="meta" style={{ fontSize: 11 }}>来源表 {cd.table} · record_id <span className="mono">{cd.ref.slice(cd.ref.indexOf(":") + 1)}</span>{cd.window ? ` · ${cd.window}` : ""}{cd.as_of_date ? ` · 截止 ${cd.as_of_date}` : ""}{cd.source_version ? ` · ${String(cd.source_version).slice(0, 22)}` : ""}</div>
                  {cd.limitations ? <div className="meta" style={{ color: "var(--warn)" }}>⚠ {cd.limitations}</div> : null}
                  <button className="btn" style={{ padding: "3px 10px", fontSize: 12, marginTop: 4 }} onClick={() => { setCheckMsg(null);
                    const go = cd.verification_id
                      ? aiEvidenceCheckVer(cd.verification_id).then((r2) => {
                          if ("ok" in r2 && r2.ok) { if (r2.route) { openEvidenceRoute(r2.route); setCheckMsg("回执重验通过，已请求打开对应记录。"); } else setCheckMsg("回执重验通过：记录在你授权范围内（该来源无独立详情页）。"); }
                          else setCheckMsg(`验权未通过/回执已过期（5 分钟）：${("hint" in r2 && r2.hint) || "请重新向 AI 查询"}`);
                        })
                      : aiEvidenceCheck(cd.ref).then((r2) => {
                          if (r2.ok) { if (r2.route) { openEvidenceRoute(r2.route); setCheckMsg("重新验权通过，已请求打开对应记录。"); } else setCheckMsg("服务端已按当前会话重新验权：记录在你授权范围内（该来源无独立详情页）。"); } else setCheckMsg(`验权未通过/记录失效：${r2.hint || "请重新向AI查询"}`);
                        });
                    go.catch(() => setCheckMsg("校验未完成：请重试")); }}>打开 / 重新验权</button>
                  {m.callId && m.drafts && m.drafts.length > 0 && null}
                </div>)}
                </div>
              </div>}
              {m.citations && m.citations.length > 0 && <details style={{ marginTop: 6 }}><summary style={{ fontSize: 12, cursor: "pointer" }}>原始引用（{m.citations.length}）</summary>
                {m.citations.map((c) => <div key={c} className="mono" style={{ fontSize: 11 }}>{displayText(c)}</div>)}
              </details>}
              {m.limitations && m.limitations.length > 0 && <details style={{ fontSize:11.5,marginTop:6 }}><summary style={{cursor:"pointer",color:"var(--ink-3)"}}>数据口径与限制</summary><div style={{color:"var(--warn)"}}>{m.limitations.join("；")}</div></details>}
              {m.drafts && m.drafts.length > 0 && <div style={{ marginTop: 6 }}>
                {m.drafts.map((d, k) => <div key={k} style={{ border: 0 }}>{d.kind === "intervention"
                  ? <div className="task-card"><div className="t">干预草稿</div><div className="meta">{displayText((d as { draft_text?: string }).draft_text || "").slice(0, 210)}…</div><div className="meta">AI 未写库；发送前在 RM03 编辑并独立确认</div>{(d as { fill_to?: Record<string, unknown> }).fill_to ? <button className="btn" style={{ padding: "3px 10px" }} onClick={() => doFill((d as { fill_to: Record<string, unknown> }).fill_to)}>编辑干预草稿 →</button> : null}</div>
                  : d.kind === "training"
                    ? <div className="task-card"><div className="t">培训计划草稿{(d as { fill_to?: Record<string, unknown> }).fill_to ? <button className="btn" style={{ padding: "3px 10px" }} onClick={() => doFill((d as { fill_to: Record<string, unknown> }).fill_to)}>编辑培训方案 →</button> : null}</div><div className="meta">{String((d as { goal?: string }).goal || "")}</div><div className="meta">仅 approved 课程可分配；TR02 页面确认；未审核课程由服务端 409 拒绝</div></div>
                    : <div className="task-card"><div className="t">管理动作建议（预演，未写入）</div><div className="meta">{JSON.stringify((d as { paths?: unknown[] }).paths || (d as { draft_action?: unknown[] }) || []).slice(0, 240)}</div>{(d as { fill_to?: Record<string, unknown> }).fill_to ? <button className="btn" style={{ padding: "3px 10px" }} onClick={() => doFill((d as { fill_to: Record<string, unknown> }).fill_to)}>填入表单 →</button> : null}</div>}
                </div>)}
              </div>}
            </div>)}
    </div>
    {probe && <div className="alert info" style={{ fontSize: 12 }}>{probe}</div>}
    {checkMsg && <div className="alert info" style={{ margin: "0 12px 6px" }}>{checkMsg}</div>}
    <div className="row ai-shortcuts" style={{ padding: "0 12px 10px" }}>
      {suggestions.map((s,index) => <button key={s} className="btn" style={{ padding: "4px 8px", fontSize: 12 }} onClick={() => send(s)}>{who.role === "driver"?s:["生成周报","数据分析","创建培训"][index]}</button>)}
      {["safety_admin","safety_officer"].includes(who.role) && <button className="btn" style={{ padding: "4px 8px", fontSize: 12 }} onClick={() => { aiSelftest().then((r) => { setSt(r); setProbe(`工具自检 ${r.tools.length} 项 · 写入=${r.writes==="zero_confirmed"?"零":"异常"} · ${r.provider} · ver ${r.prompt_version}`);
 const pre: Record<string, unknown>[] = [];
 const pi = (r as { preplan?: Record<string, Record<string, unknown>> }).preplan;
 if (pi?.intervention?.fill_to) pre.push({ kind: "intervention", ...(pi.intervention as Record<string, unknown>) });
 if (pi?.training?.fill_to) pre.push({ kind: "training", ...(pi.training as Record<string, unknown>) });
 setMsgs((m) => m.concat({ role: "assistant" as const, content: `【工具链自检（真实执行，非模型对话）】\n` + r.tools.map((x) => `${x.tool}:${x.status}${x.requires_confirmation ? "(需确认草稿)" : ""}`).join("\n") + `\n业务表计数前后一致=${r.writes}`, drafts: pre.length ? pre : null })); }).catch((e) => setProbe("自检失败 " + (e instanceof ApiError ? e.code : "?"))); }}>检查工具</button>}
    </div>
    <div className="ai-composer" style={{ padding: "8px 12px", display: "flex", gap: 6 }}>
      <input style={{ flex: 1, minWidth: 0, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8 }} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} placeholder={busy ? "正在回复…" : "发送消息"} aria-label="AI 提问" />
      <button className="btn primary" style={{ width: "auto" }} onClick={() => send()} disabled={busy || !input.trim()}>发送</button>
    </div>
    </div>
  </div>;
}

export function App() {
  const [me, setMe] = useState<MeUser | null | undefined>(undefined);
  const [unbound, setUnbound] = useState<{ name: string; provider: string } | null>(null);
  const [forceLogin, setForceLogin] = useState(false);
  const [ai, setAi] = useState(false);
  const [scoreVersion,setScoreVersion] = useState("initial");
  const [aiPreset, setAiPreset] = useState<string | null>(null);
  useEffect(() => { const h = (ev: Event) => { const d = (ev as CustomEvent<{ prompt?: string }>).detail; if (d && d.prompt) { setAiPreset(String(d.prompt).slice(0, 400)); setAi(true); window.dispatchEvent(new CustomEvent("claw:driver-nav",{detail:"ai"})); } }; window.addEventListener("claw:ai-preset", h); return () => window.removeEventListener("claw:ai-preset", h); }, []);
  const reload = () => getMe().then(async (r) => {
    if (!r) { setMe(null); return; }
    if (r.user) { if (!r.user.mustChangePassword) await loadVehicleLabels().catch(() => {}); setMe(r.user); setUnbound(null); setAi(false); }
    else if (r.unbound) { setMe(null); setUnbound({ name: r.unbound.name, provider: r.unbound.provider }); }
    else setMe(null);
  }).catch(() => setMe(null));
  useEffect(() => { reload(); const h = () => { void reload(); }; window.addEventListener("claw:account-updated", h); return () => window.removeEventListener("claw:account-updated", h); }, []);
  useEffect(() => { if (!me || me.role !== "driver") return; const refresh = () => { getMe().then(async r => { if (r?.user && (r.user.driverId !== me.driverId || r.user.bindingVerified !== me.bindingVerified)) { await loadVehicleLabels().catch(() => {}); sessionStorage.removeItem("claw_ai_msgs_" + me.userId); sessionStorage.removeItem("claw_ai_threads_" + me.userId); setAi(false); setMe(r.user); } }).catch(() => {}); }; const timer = setInterval(refresh, 15000); window.addEventListener("focus", refresh); return () => { clearInterval(timer); window.removeEventListener("focus", refresh); }; }, [me?.userId, me?.driverId, me?.bindingVerified]);
  useEffect(() => { if (!me) return; let alive=true, previous:string|null=null; const sync=async()=>{ try { const response=await fetch("/api/score-version",{credentials:"same-origin"}); if(!response.ok)return; const result=await response.json(); if(!alive)return; if(previous!==null&&result.version!==previous){sessionStorage.removeItem("claw_ai_msgs_"+me.userId);setAi(false);setScoreVersion(result.version);} previous=result.version; }catch{} }; void sync(); const timer=setInterval(sync,15000); window.addEventListener("claw:scores-updated",sync); window.addEventListener("focus",sync); return()=>{alive=false;clearInterval(timer);window.removeEventListener("claw:scores-updated",sync);window.removeEventListener("focus",sync);}; },[me?.userId]);
  if (me === undefined) return <div className="login-wrap"><div className="skeleton" style={{ width: 240 }} /></div>;
  if (unbound && !forceLogin) return <SsoUnboundView {...unbound} onUseAppAccount={() => setForceLogin(true)} />;
  if (!me) return <LoginView onDone={reload} />;
  if (me.mustChangePassword) return <div className="first-login"><AccountProfile user={me} required /></div>;
  return <RiskMonitorProvider key={me.userId+':'+me.driverId} user={me}><MessagingProvider user={me}><div className={`app-workspace ${me.role === "driver" ? "driver-workspace" : "admin-workspace"} ${ai ? "ai-open" : ""}`}>
    {me.role === "driver" ? <DriverShell key={`${me.userId}:${me.driverId}:${me.bindingVerified}:${scoreVersion}`} user={me} aiContent={<AiPanel onClose={()=>window.dispatchEvent(new CustomEvent("claw:driver-nav",{detail:"safety"}))} who={{role:me.role,userId:me.userId}} preset={aiPreset} onPresetUsed={()=>setAiPreset(null)}/>} /> : <AdminShell key={`${me.userId}:${scoreVersion}`} user={me} aiOpen={ai} onAiToggle={() => setAi(v => !v)} />}
    
    {ai && me.role!=="driver" && <AiPanel onClose={() => setAi(false)} who={{ role: me!.role, userId: me!.userId }} preset={aiPreset} onPresetUsed={() => setAiPreset(null)} />}
  </div></MessagingProvider></RiskMonitorProvider>;
}
