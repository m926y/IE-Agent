// R54：找回 RM02「历史事件回放」云端只读实现（合并前的宿主功能，R47 交付合并时被本地引擎页顶替）。
// 数据源即云端在线表：admin.replay_events（cap view.replay）+ admin.alerts 证据回链；
// 只做显示时钟推进，不生成告警、不写任何业务表；车辆一律"车辆N"展示（红线：界面不出原始 gpsno）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { getData } from './api';
import { vehicleLabel } from './vehicles';
type Ev = { event_id: string; gpsno: string; driver_id: string | null; event_time: string; event_type: string | number; event_name: string; speed_kmh: number | string | null; dimension: string | null; replay_date: string };
type Al = { alert_id: string; evidence_id: string | null };
const fmt = (s: string) => new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
export function HistoryReplayPage() {
  const [all, setAll] = useState<Ev[] | null>(null), [err, setErr] = useState('');
  const [date, setDate] = useState(''), [gpsSel, setGpsSel] = useState(''), [speed, setSpeed] = useState(60);
  const [cursor, setCursor] = useState<number | null>(null), [playing, setPlaying] = useState(false);
  const [alerts, setAlerts] = useState<Map<string, string>>(new Map());
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { let alive = true; (async () => {
    const acc: Ev[] = []; for (let off = 0; ; off += 200) { const r = await getData<Ev>('admin.replay_events', { limit: 200, offset: off }); acc.push(...r.rows); if (r.rows.length < 200) break; }
    if (!alive) return; acc.sort((a, b) => String(a.event_time).localeCompare(String(b.event_time))); setAll(acc);
    const ds = [...new Set(acc.map(x => String(x.replay_date)))].sort(); setDate(ds[ds.length - 1] || ''); setCursor(0); setPlaying(false);
    const al = await getData<Al>('admin.alerts', { limit: 200 }); if (alive) setAlerts(new Map(al.rows.filter(x => x.evidence_id).map(x => [String(x.evidence_id), x.alert_id])));
  })().catch(() => { if (alive) setErr('回放数据读取失败，请重试。'); }); return () => { alive = false; }; }, []);
  const dates = useMemo(() => [...new Set((all || []).map(x => String(x.replay_date)))].sort(), [all]);
  const dayRows = useMemo(() => (all || []).filter(x => (!date || String(x.replay_date) === date) && (!gpsSel || String(x.gpsno) === gpsSel)), [all, date, gpsSel]);
  const vehicles = useMemo(() => [...new Set(dayRows.map(x => String(x.gpsno)))], [dayRows]);
  const total = dayRows.length, idx = Math.max(0, Math.min(cursor ?? 0, total));
  const shown = dayRows.slice(0, idx);
  const clock = idx > 0 ? dayRows[idx - 1].event_time : (dayRows[0]?.event_time || '');
  useEffect(() => { if (!playing || !total) return; const iv = setInterval(() => setCursor(c => { const n = Math.min(total, (c ?? 0) + Math.max(1, Math.round(speed / 10))); if (n >= total) setPlaying(false); return n; }), 100); return () => clearInterval(iv); }, [playing, speed, total]);
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [shown.length]);
  const byVeh = useMemo(() => { const m = new Map<string, number>(); for (const e of shown) m.set(String(e.gpsno), (m.get(String(e.gpsno)) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); }, [shown]);
  const findAlert = (e: Ev) => alerts.get(String(e.event_id));
  return <div className="stack"><h1>历史事件回放</h1>
    <p className="alert info">数据来自云端已导入的历史事件投影（replay_events，只读）。回放只推进显示时钟，不生成告警、不写任何业务表；这不是车队全量监控，也不是实时推送。实时案卷引擎（建会话/案卷处置闭环）属本地完整数据工作台，云端工作台不提供。</p>
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
    <section className="panel"><h3>回放时间线（随时钟累加，最新一行高亮）</h3>{!all && <p className="meta">正在读取…</p>}{all && !total && <p className="meta">replay_events 未导入或未选中有数据日期；不展示虚构回放。</p>}
      <div className="risk-replay-table-wrap" ref={listRef}>{total > 0 && <table className="risk-replay-table">
        <thead><tr><th aria-label="序号">#</th><th>时间（北京时间）</th><th>车辆</th><th>事件</th><th>类型</th><th>维度</th><th>时速</th><th>档案</th></tr></thead>
        <tbody>{[...shown].reverse().map((e, i) => { const v = e.speed_kmh == null || e.speed_kmh === '' ? null : Number(e.speed_kmh); const speedCls = v == null ? '' : v >= 80 ? 'speed-high' : v >= 60 ? 'speed-mid' : 'speed-low'; return <tr key={String(e.event_id)} className={i === 0 ? 'is-latest' : ''}>
          <td className="mono seq">{shown.length - i}</td>
          <td className="mono">{fmt(String(e.event_time))}</td>
          <td>{vehicleLabel(String(e.gpsno))}</td>
          <td className="ev-name"><b>{String(e.event_name)}</b></td>
          <td className="mono">{String(e.event_type)}</td>
          <td className="dim">{e.dimension ? String(e.dimension) : '—'}</td>
          <td className={`mono ${speedCls}`}>{v == null ? '—' : <>{v}<small> km/h</small></>}</td>
          <td>{findAlert(e) ? <a className="btn replay-alert-link" href={`#/rm-alerts?alert_id=${encodeURIComponent(findAlert(e) || '')}`}>关联告警档案</a> : <span className="meta">—</span>}</td>
        </tr>; })}</tbody>
      </table>}</div>
      <p className="meta">已播 {idx}/{total} 条；表格按时间正序排列并随播放自动滚动到最新一行。速度仅展示记录值，不作为限速判定依据。</p></section>
  </div>;
}
