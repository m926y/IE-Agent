import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { ListResult } from './api';
import { EmptyState, ResourceTable, cellView } from './ui';
import { vehicleLabel, vehicleOptions } from './vehicles';

const labels: Record<string,string> = { gpsno:'车辆', driver_id:'司机', event_date:'日期', event_time:'发生时间', event_type:'事件类型', event_name:'事件名称', speed_kmh:'速度 km/h', dimension:'维度', coordinate_valid:'坐标有效', speed_valid:'速度有效', source_version:'来源版本', event_count:'日志条数', energy_type:'能源类型', source_rows:'原始采样条数', distance_km:'行驶里程 km', run_time_hours:'运行小时（源列）', reported_run_time_hours:'运行小时', speed_mean_kmh:'平均速度', speed_std_kmh:'速度标准差', speed_max_kmh:'最高速度', moving_rows:'移动点数', valid_speed_rows:'有效速度行数', invalid_speed_rows:'无效速度行数', valid_coordinate_rows:'有效坐标行数', invalid_coordinate_rows:'无效坐标行数', invalid_course_rows:'无效航向行数', invalid_distance_rows:'无效距离行数', large_distance_gap_rows:'大距离跳变行数', invalid_run_time_rows:'无效运行时长行数', imei_count:'设备数', date_mismatch_rows:'日期不匹配行数', missing_ems_speed_rows:'缺 EMS 速度行数', missing_gps_speed_rows:'缺 GPS 速度行数', ems_speed_mean:'EMS 均速', ems_speed_max:'EMS 最高速度', gps_speed_mean:'GPS均速', gps_speed_max:'GPS最高速度', ems_gps_abs_diff_mean:'EMS/GPS 均速差绝对值', accel_norm_mean:'加速度模均值', accel_norm_std:'加速度模标准差', accel_norm_max:'加速度模最大值', gyro_norm_mean:'角速度模均值', gyro_norm_std:'角速度模标准差', gyro_norm_max:'角速度模最大值', accel_norm_outlier_rows:'加速度异常采样（源列）', gyro_norm_gt20_rows:'角速度模>20 采样（源列）', accel_norm_outlier_samples:'加速度异常采样', gyro_norm_gt20_samples:'角速度异常采样', missing_accel_rows:'缺加速度行数', missing_gyro_rows:'缺角速度行数', monthly_mileage_km:'月均里程 km', monthly_drive_hours:'月均驾驶小时', monthly_stop_count:'月均停车次数', highway_mileage_ratio:'高速里程占比', morning_drive_time_ratio:'早间驾驶时长占比', dusk_drive_time_ratio:'黄昏驾驶时长占比', night_drive_time_ratio:'夜间驾驶时长占比', night_mileage_ratio:'夜间里程占比', accel_x_mean:'加速度X均值', accel_x_std:'加速度X标准差', accel_x_abs_max:'加速度X绝对最大', gyro_x_mean:'角速度X均值', gyro_x_std:'角速度X标准差', gyro_x_abs_max:'角速度X绝对最大', accel_y_mean:'加速度Y均值', accel_y_std:'加速度Y标准差', accel_y_abs_max:'加速度Y绝对最大', gyro_y_mean:'角速度Y均值', gyro_y_std:'角速度Y标准差', gyro_y_abs_max:'角速度Y绝对最大', accel_z_mean:'加速度Z均值', accel_z_std:'加速度Z标准差', accel_z_abs_max:'加速度Z绝对最大', gyro_z_mean:'角速度Z均值', gyro_z_std:'角速度Z标准差', gyro_z_abs_max:'角速度Z绝对最大' };
const kinds = {
  events: { title:'事件明细', columns:['event_time','gpsno','event_name','speed_kmh','dimension'] },
  event_daily: { title:'事件日统计', columns:['event_date','gpsno','event_name','event_count'] },
  trajectory_daily: { title:'轨迹日汇总', columns:['event_date','gpsno','source_rows','distance_km','reported_run_time_hours','speed_mean_kmh','speed_max_kmh','invalid_coordinate_rows'] },
  imu_daily: { title:'IMU 日汇总', columns:['event_date','gpsno','source_rows','gps_speed_mean','gps_speed_max','accel_norm_outlier_samples','gyro_norm_gt20_samples','missing_gps_speed_rows'] },
  profiles: { title:'车辆画像', columns:['gpsno','energy_type','monthly_mileage_km','monthly_drive_hours','monthly_stop_count','highway_mileage_ratio','night_drive_time_ratio','night_mileage_ratio'] },
};
type EventsExtras = { requested_date: string | null; sample_dates: string[]; daily_index: { gpsno: string; event_date: string; event_type: string; event_name: string | null; event_count: number | null }[] | null };
export function DataExplorer({ driver=false, hostedSources=null, defaultDate='2026-07-31', eventStart, eventEnd }: { driver?: boolean; hostedSources?: Record<string,string|null> | null; defaultDate?: string; eventStart?: string | null; eventEnd?: string | null }) {
  const options=vehicleOptions();
  const [kind,setKind]=useState<keyof typeof kinds>('events');
  const [gps,setGps]=useState(options[0]?.gpsno||'');
  const [date,setDate]=useState(defaultDate);
  const [selected,setSelected]=useState<Record<string,unknown>|null>(null);
  useEffect(()=>{setDate(defaultDate)},[defaultDate]);
  const params={...(gps?{gpsno:gps}:{}),...(kind!=='profiles'?{event_date:date}:{}),order:kind==='events'?'event_time.desc':kind==='profiles'?'gpsno.asc':'event_date.desc'};
  const unavailable=Boolean(hostedSources)&&hostedSources![String(kind)]===null;
  const aggregatedSample=hostedSources?.event_daily==='aggregated_from_online_events';
  // R59：事件明细在所选日期无逐条样本时，用云端数据补齐空态——该车辆该日的全量索引日统计 + 有样本的日期一键跳转
  const renderEventsEmpty=(data:ListResult<Record<string,unknown>>|null)=>{
    const ex=(data as unknown as {hosted_extras?:EventsExtras}|null)?.hosted_extras||null;
    return <div className="stack events-empty">
      <p className="meta">当前条件下没有逐条回放样本。</p>
      {ex?.daily_index&&ex.daily_index.length>0&&<div className="panel"><h4>{vehicleLabel(gps)} · {date} 全量索引日统计</h4>
        <div className="table-wrap"><table className="events-index-table"><thead><tr><th>事件名称</th><th>事件类型</th><th>日志条数</th></tr></thead><tbody>{ex.daily_index.map((r,i)=><tr key={i}><td><b>{r.event_name||'未命名事件'}</b></td><td className="mono">{String(r.event_type??'—')}</td><td><b>{r.event_count==null?'—':Number(r.event_count).toLocaleString()}</b></td></tr>)}</tbody></table></div>
        <p className="meta">该日全量索引统计（按 车辆×日×事件类型 的真实聚合，覆盖完整观测窗{eventStart&&eventEnd?` ${eventStart} 至 ${eventEnd}`:''}）；逐条原始日志未入库，故此处无法展开单条明细。</p></div>}
      {ex&&ex.daily_index!==null&&ex.daily_index.length===0&&<p className="meta">该车辆在 {date} 无任何事件记录（当日确无已入库事件，不是数据丢失）。</p>}
      {ex&&ex.sample_dates.length>0&&<div className="panel"><h4>有回放样本的日期（点击切换）</h4><div className="row">{ex.sample_dates.map(d=><button key={d} className={`btn ${d===date?'primary':''}`} onClick={()=>{setDate(d);setSelected(null);}}>{d}</button>)}</div><p className="meta">以上日期来自在线 replay_events 表的真实样本日；选中有样本的日期即可查看逐条明细。</p></div>}
      {!ex&&<p className="meta">暂无该日汇总数据。</p>}
    </div>;
  };
  return <section className="panel stack">
    <div className="row data-filters">
      <label>数据类型<select className="btn" value={kind} onChange={e=>{setKind(e.target.value as keyof typeof kinds);setSelected(null);}}>{Object.entries(kinds).map(([key,v])=><option key={key} value={key}>{v.title}</option>)}</select></label>
      {!driver&&<label>车辆<select className="btn" value={gps} onChange={e=>{setGps(e.target.value);setSelected(null);}}><option value="">全部车辆</option>{options.map(v=><option key={v.gpsno} value={v.gpsno}>{v.label}</option>)}</select></label>}
      {kind!=='profiles'&&!unavailable&&<label>日期<input className="btn" type="date" min={eventStart||'2026-06-01'} max={eventEnd||'2026-07-31'} value={date} onChange={e=>{if(e.target.value)setDate(e.target.value);setSelected(null);}} /></label>}
    </div>
    {unavailable&&<p className="meta">该数据类型暂无可展示的明细。</p>}
    <ResourceTable key={`${kind}:${gps}:${date}`} resource={`${driver?'my':'admin'}.${kind}`} params={unavailable?{}:params} columns={kinds[kind].columns} labels={labels} pageSize={20} rowActionLabel="详情" onRowClick={setSelected} renderEmpty={kind==='events'?renderEventsEmpty:undefined} />
    {selected&&<div className="panel"><div className="row"><h3>数据详情 · {vehicleLabel(selected.gpsno)}</h3><button className="btn" onClick={()=>setSelected(null)}>关闭</button></div><div className="kv">{Object.keys(labels).filter(k=>selected[k]!==undefined).map(k=><div key={k}><span className="meta">{labels[k]} </span><b>{cellView(k,selected[k])}</b></div>)}</div></div>}
    
  </section>;
}

type IndexProvenance={source_version:string|null;dataset:string|null;observation_start:string|null;observation_end:string|null;vehicle_count:number|null;source_event_rows:number|string|null;source_trajectory_rows:number|string|null;source_imu_rows:number|string|null;profile_rows:number|null;trajectory_daily_rows:number|null;imu_daily_rows:number|null;event_daily_groups:number|null;quality_report_at:string|null;imported_at:string|null;imported_by:string|null;notes:string|null};
type Manifest={counts:Record<string,number|null>;level_counts:Record<string,number>;event_start:string;event_end:string;history_start:string;history_end:string;published_score_max_difference:number;ledger_max_difference:number;hosted_note?:string|null;hosted_sources?:Record<string,string|null>|null;index_imported?:boolean;index_provenance?:IndexProvenance|null};
export function DataCenter() {
  const [data,setData]=useState<Manifest|null>(null),[failed,setFailed]=useState<string|null>(null);
  useEffect(()=>{api<Manifest>('/api/data-status').then(setData).catch((e)=>setFailed(e instanceof ApiError?e.code:'network_error'));},[]);
  if(failed)return <EmptyState kind="error" hint={`数据状态读取失败（${failed}），请重试。`}/>;
  if(!data)return <EmptyState kind="loading"/>;
  // bigint 列经 REST 可能回字符串：统一按数值渲染，空值显示"—"，不以 0 冒充
  const show=(v:number|string|null|undefined)=>{if(v===null||v===undefined||v==='')return '—';const n=Number(v);return Number.isFinite(n)?n.toLocaleString():String(v);};
  const prov=data.index_provenance;
  return <div className="stack data-center"><h1>数据中心</h1>
    <div className="cards">{[['drivers','车辆'],['score_snapshots','当前评分'],['score_history','历史评分'],['events','回放事件样本'],['event_daily','事件日统计'],['trajectory_daily','轨迹日汇总'],['imu_daily','IMU 日汇总'],['profiles','车辆画像']].map(([key,title])=><div className="card" key={key}><div className="k">{title}</div><div className="v">{show(data.counts[key])}</div></div>)}</div>
    <p className="meta">回放事件覆盖 {data.event_start||'—'} 至 {data.event_end||'—'}；评分历史 {data.history_start||'—'} 至 {data.history_end||'—'}。A/B/C/D：{['A','B','C','D'].map(k=>`${k} ${data.level_counts[k]}`).join(' · ')}。</p>
    {prov&&<section className="panel" aria-label="全量索引溯源"><h3>全量索引溯源</h3>
      <div className="prov-grid">
        <div className="prov-item prov-wide"><span className="meta">数据集</span><b>{prov.dataset||'—'}</b><small className="meta">版本 {prov.source_version||'—'}</small></div>
        <div className="prov-item"><span className="meta">观测窗</span><b>{prov.observation_start||'—'} ~ {prov.observation_end||'—'}</b><small className="meta">{show(prov.vehicle_count)} 车</small></div>
        <div className="prov-item"><span className="meta">清洗质量报告</span><b>{prov.quality_report_at||'—'}</b><small className="meta">导入 {prov.imported_at||'—'} · {prov.imported_by||'—'}</small></div>
        <div className="prov-item"><span className="meta">源数据量 · 事件</span><b>{show(prov.source_event_rows)} <small>条</small></b><small className="meta">按 车辆×日×事件类型 聚合入库</small></div>
        <div className="prov-item"><span className="meta">源数据量 · 轨迹点</span><b>{show(prov.source_trajectory_rows)} <small>条</small></b><small className="meta">聚合成 {show(prov.trajectory_daily_rows)} 车·日</small></div>
        <div className="prov-item"><span className="meta">源数据量 · IMU 采样</span><b>{show(prov.source_imu_rows)} <small>条</small></b><small className="meta">聚合成 {show(prov.imu_daily_rows)} 车·日</small></div>
        <div className="prov-item"><span className="meta">事件日聚合</span><b>{show(prov.event_daily_groups)} <small>行</small></b><small className="meta">逐条原始日志未入库</small></div>
        <div className="prov-item"><span className="meta">车辆画像</span><b>{show(prov.profile_rows)} <small>车</small></b><small className="meta">月均里程 / 驾驶小时 / 时段占比等</small></div>
      </div>
          </section>}
    <DataExplorer hostedSources={data.hosted_sources} defaultDate={data.event_end||prov?.observation_end||'2026-07-31'} eventStart={data.event_start} eventEnd={data.event_end}/>
  </div>;
}

