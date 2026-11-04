// R54：找回 RM02「历史事件回放」只读实现（合并前的宿主功能，R47 交付合并时被本地引擎页顶替）。
// 数据源即云端在线表：admin.replay_events（cap view.replay）+ admin.alerts 证据回链；
// 只做显示时钟推进，不生成告警、不写任何业务表；车辆一律"车辆N"展示（红线：界面不出原始 gpsno）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import './risk-monitor.css';
import { getData } from './api';
import { vehicleLabel } from './vehicles';
type Ev = { event_id: string; gpsno: string; driver_id: string | null; event_time: string; event_type: string | number; event_name: string; speed_kmh: number | string | null; dimension: string | null; replay_date: string };
/* 风险判定完全来自服务端下发的冻结因子表（severity + 现行规则），前端不自带任何数字表 */
type Rule = { code: number; name: string; severity: number | null; dimension: string | null; rule: string | null; course: string | null; message: string | null; level: 'red' | 'orange' | 'watch' | null };
type Al = { alert_id: string; evidence_id: string | null };
const fmt = (s: string) => new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
export function HistoryReplayPage() {
  const [all, setAll] = useState<Ev[] | null>(null), [err, setErr] = useState('');
  const [date, setDate] = useState(''), [gpsSel, setGpsSel] = useState(''), [speed, setSpeed] = useState(60);
  const [cursor, setCursor] = useState<number | null>(null), [playing, setPlaying] = useState(false);
  const [alerts, setAlerts] = useState<Map<string, string>>(new Map());
  const [rules, setRules] = useState<Record<string, Rule>>({}), [speedHigh, setSpeedHigh] = useState(80);
  const [toast, setToast] = useState<{ key: string; level: 'red' | 'orange'; text: string; detail: string; more: number; alert_id: string | null } | null>(null);
  const seen = useRef<Set<string>>(new Set()), toastTimer = useRef<number>(0);
  const listRef = useRef<HTMLDivElement>(null);
  /* 严重度定级：≥6 险情，≥4 预警；超速（服务端阈值）至少算预警。规则表未覆盖的事件类型不臆测。 */
  const riskOf = (e: Ev): { level: 'red' | 'orange' | 'watch'; text: string; detail: string } | null => {
    const r = rules[String(e.event_type)];
    const v = e.speed_kmh === null || e.speed_kmh === '' ? null : Number(e.speed_kmh);
    const fast = v !== null && Number.isFinite(v) && v >= speedHigh;
    if (r && r.level) {
      if (r.level === 'watch' && fast) return { level: 'orange', text: '车速偏高', detail: r.message || `${e.event_name}：请按路况控制车速` };
      return { level: r.level === 'red' ? 'red' : r.level === 'orange' ? 'orange' : 'watch', text: r.level === 'red' ? '险情提醒' : r.level === 'orange' ? '风险预警' : '关注事件', detail: r.message || e.event_name };
    }
    if (fast) return { level: 'orange', text: '车速偏高', detail: `记录速度 ${v} km/h，请按路况控制车速` };
    return null;
  };
  useEffect(() => { let alive = true; (async () => {
    const acc: Ev[] = []; for (let off = 0; ; off += 200) { const r = await getData<Ev>('admin.replay_events', { limit: 200, offset: off }); acc.push(...r.rows); if (r.rows.length < 200) break; }
    if (!alive) return; acc.sort((a, b) => String(a.event_time).localeCompare(String(b.event_time))); setAll(acc);
    const ds = [...new Set(acc.map(x => String(x.replay_date)))].sort(); setDate(ds[ds.length - 1] || ''); setCursor(0); setPlaying(false);
    const al = await getData<Al>('admin.alerts', { limit: 200 }); if (alive) setAlerts(new Map(al.rows.filter(x => x.evidence_id).map(x => [String(x.evidence_id), x.alert_id])));
    try { const md = await api<{ by_code?: Record<string, Rule>; risk_speed_high?: number }>('/api/risk/metadata'); if (alive) { setRules(md.by_code || {}); setSpeedHigh(Number(md.risk_speed_high) || 80); } } catch { /* 规则表取不到时只是不显示风险标注，回放本身照常 */ }
  })().catch(() => { if (alive) setErr('回放数据读取失败，请重试。'); }); return () => { alive = false; }; }, []);
  const dates = useMemo(() => [...new Set((all || []).map(x => String(x.replay_date)))].sort(), [all]);
  const dayRows = useMemo(() => (all || []).filter(x => (!date || String(x.replay_date) === date) && (!gpsSel || String(x.gpsno) === gpsSel)), [all, date, gpsSel]);
  const vehicles = useMemo(() => [...new Set(dayRows.map(x => String(x.gpsno)))], [dayRows]);
  const total = dayRows.length, idx = Math.max(0, Math.min(cursor ?? 0, total));
  const shown = dayRows.slice(0, idx);
  const clock = idx > 0 ? dayRows[idx - 1].event_time : (dayRows[0]?.event_time || '');
  useEffect(() => { if (!playing || !total) return; const iv = setInterval(() => setCursor(c => { const n = Math.min(total, (c ?? 0) + Math.max(1, Math.round(speed / 10))); if (n >= total) setPlaying(false); return n; }), 100); return () => clearInterval(iv); }, [playing, speed, total]);
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [shown.length]);
  /* 播放时逐条比对：本轮新露出的事件里有风险的就弹右下提示框（6 秒后自动收起，可手动关闭）；
   * 首次进入页面已显示的历史行不弹窗，避免一打开就糊一屏提示。 */
  useEffect(() => {
    const ids = shown.map((e) => String(e.event_id));
    if (seen.current.size === 0) { ids.forEach((id) => seen.current.add(id)); return; }
    if (!playing) return;
    const fresh = shown.filter((e) => !seen.current.has(String(e.event_id)));
    ids.forEach((id) => seen.current.add(id));
    const risky = fresh.map((e) => ({ e, r: riskOf(e) })).filter((x) => x.r && x.r.level !== 'watch');
    if (!risky.length) return;
    risky.sort((a, b) => (a.r!.level === 'red' ? 0 : 1) - (b.r!.level === 'red' ? 0 : 1));
    const top = risky[0];
    setToast({ key: String(top.e.event_id), level: top.r!.level as 'red' | 'orange', text: `${vehicleLabel(String(top.e.gpsno))} · ${top.r!.text}`, detail: `${top.e.event_name}｜${top.r!.detail}`, more: risky.length - 1, alert_id: findAlert(top.e) || null });
    window.clearTimeout(toastTimer.current); toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }, [shown.length, playing]);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  const byVeh = useMemo(() => { const m = new Map<string, number>(); for (const e of shown) m.set(String(e.gpsno), (m.get(String(e.gpsno)) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); }, [shown]);
  const findAlert = (e: Ev) => alerts.get(String(e.event_id));
  return <div className="stack"><h1>历史事件回放</h1>
    {err && <p className="alert warn" role="alert">{err}</p>}
    <section className="panel risk-clock"><div className="risk-clock-face"><small>回放日期：{date || '—'} · 北京时间</small><strong>{clock ? String(clock).slice(11, 19) : '--:--:--'}</strong><span>{playing ? '播放中' : (idx >= total && total > 0 ? '已播完' : '已暂停')} · {speed}× 速进 · {idx}/{total} 条</span></div>
      <div className="risk-clock-controls"><div className="row">
        <label>日期 <select aria-label="回放日期" value={date} onChange={e => { setDate(e.target.value); setCursor(0); setPlaying(false); }}>{dates.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
        <label>车辆 <select aria-label="回放车辆" value={gpsSel} onChange={e => { setGpsSel(e.target.value); setCursor(0); setPlaying(false); }}><option value="">全部（{vehicles.length} 辆）</option>{vehicles.map(g => <option key={g} value={g}>{vehicleLabel(g)}</option>)}</select></label>
        <label>倍速 <select aria-label="回放倍速" value={speed} onChange={e => setSpeed(Number(e.target.value))}><option value={10}>10×</option><option value={60}>60×</option><option value={300}>300×</option></select></label>
        <button className="btn primary" disabled={!total} onClick={() => setPlaying(p => !p)}>{playing ? '暂停' : '播放'}</button>
        <button className="btn" disabled={!total || idx >= total} onClick={() => { const next = dayRows.findIndex((x, i) => i >= (cursor ?? 0) && findAlert(x)); setCursor(next >= 0 ? next + 1 : total); setPlaying(false); }}>下一条有档案的事件</button>
        <button className="btn" onClick={() => { setCursor(total); setPlaying(false); }}>跳到当日结束</button>
      </div>
      <p className="meta">当日覆盖车辆 {vehicles.length} 台 · 事件总数 {total} 条{byVeh.slice(0, 6).length ? ` · 累计最多：${byVeh.slice(0, 6).map(([g, n]) => `${vehicleLabel(g)}(${n})`).join('，')}` : ''}</p></div></section>
    <section className="panel"><h3>回放时间线（随时钟累加，最新一行高亮）</h3>{!all && <p className="meta">正在读取…</p>}{all && !total && <p className="meta">该日期暂无事件记录。</p>}
      <div className="risk-replay-table-wrap" ref={listRef}>{total > 0 && <table className="risk-replay-table">
        <thead><tr><th aria-label="序号">#</th><th>风险</th><th>时间（北京时间）</th><th>车辆</th><th>事件</th><th>类型</th><th>维度</th><th>时速</th><th>档案</th></tr></thead>
        <tbody>{[...shown].reverse().map((e, i) => { const v = e.speed_kmh == null || e.speed_kmh === '' ? null : Number(e.speed_kmh); const speedCls = v == null ? '' : v >= speedHigh ? 'speed-high' : v >= 60 ? 'speed-mid' : 'speed-low'; const rk = riskOf(e); const rowCls = [i === 0 ? 'is-latest' : '', rk && rk.level !== 'watch' ? `replay-warning-row risk-${rk.level}` : ''].filter(Boolean).join(' '); return <tr key={String(e.event_id)} className={rowCls || undefined}>
          <td className="mono seq">{shown.length - i}</td>
          <td>{rk ? <span className={`replay-warning-badge${rk.level === 'red' ? ' risk-red' : ''}`} title={rk.detail} role="img" aria-label={rk.level === 'red' ? '险情提醒' : '风险预警'}>{rk.level === 'red' ? '⚠ 险情' : rk.level === 'orange' ? '⚠ 预警' : '关注'}</span> : <span className="meta">—</span>}</td>
          <td className="mono">{fmt(String(e.event_time))}</td>
          <td>{vehicleLabel(String(e.gpsno))}</td>
          <td className="ev-name"><b>{String(e.event_name)}</b></td>
          <td className="mono">{String(e.event_type)}</td>
          <td className="dim">{e.dimension ? String(e.dimension) : '—'}</td>
          <td className={`mono ${speedCls}`}>{v == null ? '—' : <>{v}<small> km/h</small></>}</td>
          <td>{findAlert(e) ? <a className="btn replay-alert-link" href={`#/rm-alerts?alert_id=${encodeURIComponent(findAlert(e) || '')}`}>关联告警档案</a> : <span className="meta">—</span>}</td>
        </tr>; })}</tbody>
      </table>}</div>
      {toast && <aside className={`replay-risk-toast${toast.level === 'red' ? ' risk-red' : ''}`} role="alert" aria-live="assertive">
        <button className="replay-toast-close" aria-label="关闭风险提示" onClick={() => setToast(null)}>×</button>
        <span className="replay-toast-icon" aria-hidden="true">⚠</span>
        <div><b>{toast.text}</b><p>{toast.detail}</p><small>回放时钟 {fmt(String((dayRows.find((x) => String(x.event_id) === toast.key) || { event_time: '' }).event_time))}{toast.more > 0 ? ` · 同批另有 ${toast.more} 条风险事件` : ''}</small>
        {toast.alert_id && <a className="btn" href={`#/rm-alerts?alert_id=${encodeURIComponent(toast.alert_id)}`}>查看关联告警档案</a>}
        </div>
      </aside>}
      <p className="meta">已播 {idx}/{total} 条 · 共 {total} 条</p></section>
  </div>;
}
