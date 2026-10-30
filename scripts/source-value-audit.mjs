import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { startLocalWorkbench } from "./local-workbench.mjs";
import { candidateFiles, projectRoot, sha256 } from "./candidate-files.mjs";

const parent=join(projectRoot,'.source-tests');await mkdir(parent,{recursive:true});
const directory=await mkdtemp(join(parent,'value-audit-'));
const work=await startLocalWorkbench({directory,pauseOutbox:true});
try {
  const candidate=await candidateFiles();
  const account=work.store.get('app_users','local_driver'), credentials=work.store.accounts.find(x=>x.username==='local_driver');
  const login=await fetch(work.base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(credentials)});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  async function request(path,method='GET',body) {
    const response=await fetch(work.base+path,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  }
  const originalFacts=sha256(JSON.stringify(['drivers','score_snapshots','score_history','deduction_ledger','replay_events'].map(x=>work.store.rows(x))));
  const scores=work.store.rows('score_snapshots');
  const cases=['low','medium','high'].flatMap(level=>scores.filter(x=>x.confidence_level===level).slice(0,6));
  assert.ok(cases.length>=12&&cases.length<=20,'Use actual supported cases, never fabricate missing strata');
  const runs=[],packets=[],ratings=[],durations={A:[],B:[],C:[]};
  let checkedFacts=0,deniedForeignReads=0,unauthorizedWrites=0,qualityCorrect=0;
  const arms={A:'现有分散页面的数据入口',B:'本人来源证据与历史核对入口',C:'行动摘要加来源证据与质量分流入口'};
  for(const [index,score] of cases.entries()) {
    const person=work.store.get('drivers',score.driver_id);assert.ok(person);
    work.store.put('app_users',{...account,driver_id:person.driver_id,fleet_scope:person.fleet_id},true);
    const caseId='T10-'+String(index+1).padStart(2,'0');
    const history=work.store.rows('score_history').filter(x=>x.driver_id===person.driver_id),events=work.store.rows('replay_events').filter(x=>x.driver_id===person.driver_id);
    const ownIds=new Set([score.score_id,...history.map(x=>x.score_id),...events.map(x=>x.event_id)]);
    const evidencePath='/api/driver/evidence?kind=score&id='+encodeURIComponent(score.score_id);
    const paths={A:['/api/data/my.score','/api/data/my.trainings','/api/data/my.interventions','/api/data/my.review_requests','/api/data/my.score_history','/api/driver/risk-center?date='+score.as_of_date],B:['/api/data/my.score',evidencePath,'/api/data/my.score_history'],C:['/api/driver/action-center',evidencePath,'/api/driver/score-comparison']};
    const order=['A','B','C'].map((_,n)=>['A','B','C'][(n+index)%3]);
    const examples={};
    for(let repeat=0;repeat<3;repeat++) for(const arm of order) {
      const started=performance.now(),responses=await Promise.all(paths[arm].map(path=>request(path))),elapsed=performance.now()-started;
      assert.ok(responses.every(x=>x.status===200));durations[arm].push(elapsed);
      const actual=arm==='C'?responses[1].data.record:responses[0].data.rows[0];
      for(const field of ['score_id','safety_score','as_of_date','source_version']){assert.deepEqual(actual[field],score[field]);checkedFacts++;}
      if(arm==='B')assert.equal(responses[1].data.record.score_id,score.score_id);
      if(arm==='C') {
        const center=responses[0].data;assert.equal(center.as_of_date,score.as_of_date);assert.ok(center.timeline.every(node=>ownIds.has(node.source_id)));
        assert.doesNotMatch(JSON.stringify(center),/actor_id|audit_id|created_by|draft_text|password/);
        if(score.confidence_level==='low'){assert.equal(center.next_step.code,'verify_data');qualityCorrect++;}
      }
      runs.push({case_id:caseId,arm,repeat:repeat+1,endpoint_count:paths[arm].length,elapsed_ms:elapsed,critical_fields_checked:4});
      if(repeat===0)examples[arm]={label:arms[arm],paths:paths[arm],responses:responses.map(x=>x.data)};
    }
    const foreign=scores.find(x=>x.driver_id!==person.driver_id);
    const denied=await request('/api/driver/evidence?kind=score&id='+encodeURIComponent(foreign.score_id));assert.equal(denied.status,404);deniedForeignReads++;
    work.store.put('app_users',{...account,driver_id:person.driver_id,fleet_scope:person.fleet_id,binding_verified:false},true);
    const before=work.store.rows('review_requests').length;
    const refused=await request('/api/review-requests','POST',{score_id:score.score_id,reason_code:'score_explanation',description:'隔离技术验收：未核实身份必须拒绝'});assert.equal(refused.status,403);
    unauthorizedWrites+=work.store.rows('review_requests').length-before;assert.equal(unauthorizedWrites,0);
    packets.push({case_id:caseId,source_driver_id:person.driver_id,confidence_level:score.confidence_level,source_reference:{score_id:score.score_id,as_of_date:score.as_of_date,source_version:score.source_version},task:'核对本人评分和依据，判断当前应核验数据、查看任务还是等待人工处理，并解释结论限制。此案例初始无培训任务，不假定已经完成培训。',presentation_order:order,examples});
    for(const reviewerSlot of [1,2])for(const arm of order)ratings.push({case_id:caseId,arm,reviewer_slot:reviewerSlot,reviewer_id:null,started_at:null,finished_at:null,task_completed:null,fact_accuracy:null,next_step_appropriate:null,limitations_understood:null,notes:null});
  }
  work.store.put('app_users',account,true);
  assert.equal(sha256(JSON.stringify(['drivers','score_snapshots','score_history','deduction_ledger','replay_events'].map(x=>work.store.rows(x)))),originalFacts);
  assert.equal(work.store.rows('training_tasks').length,0);assert.equal(work.store.rows('review_requests').length,0);
  assert.ok(work.store.rows('training_courses').every(x=>x.content_status==='demo_draft_requires_team_review'));
  for(const source of work.store.provenance)assert.equal(sha256(await readFile(fileURLToPath(new URL('../../IE亮剑/'+source.file,import.meta.url)))),source.sha256);
  const percentile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);return Number(sorted[Math.max(0,Math.ceil(p*sorted.length)-1)].toFixed(3));};
  const summary={status:'technical_pass_human_pending',created_at:new Date().toISOString(),code_hash:candidate.code_hash,source_hash:work.store.sourceHash,node:process.version,case_count:cases.length,repeats_per_arm:3,case_strata:Object.fromEntries(['low','medium','high'].map(level=>[level,cases.filter(x=>x.confidence_level===level).length])),critical_fields:{checked:checkedFacts,matched:checkedFacts,match_rate:1,definition:'score_id、安全分、截止日、来源版本逐字段对照原始来源；不代表自然语言建议的人工评分。'},privacy:{foreign_record_attempts:deniedForeignReads,foreign_records_returned:0,unverified_business_writes:unauthorizedWrites},quality_routing:{low_confidence_checks:qualityCorrect,correct:qualityCorrect},interface_collection:Object.fromEntries(Object.entries(durations).map(([arm,values])=>[arm,{label:arms[arm],samples:values.length,p50_ms:percentile(values,.5),p95_ms:percentile(values,.95)}])),human_review:{reviewer_count:0,status:'pending',ratings_completed:0,completion_time:null,understanding_improvement:null},limits:['A/B/C为当前产品的三种信息采集入口，不是历史版本回退或等负载性能竞赛。','耗时是本机接口并行采集耗时，不是司机查找时间或认知收益。','人工表格留空；没有真实评审者参与，不宣称可用性提升。','案例初始无培训任务；完整培训/干预流程由独立浏览器验收覆盖。','来源只读，未触及现有.local，未联网获取业务数据。'],evidence_directory:relative(projectRoot,directory).replaceAll('\\','/')};
  await Promise.all([writeFile(join(directory,'cases.json'),JSON.stringify(packets,null,2)),writeFile(join(directory,'interface-runs.json'),JSON.stringify(runs,null,2)),writeFile(join(directory,'human-ratings.json'),JSON.stringify(ratings,null,2)),writeFile(join(directory,'technical-summary.json'),JSON.stringify(summary,null,2))]);
  await writeFile(join(projectRoot,'docs','验收结果.json'),JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify({status:summary.status,case_count:cases.length,critical_fields:checkedFacts,foreign_records_returned:0,unverified_business_writes:0,low_confidence_checks:qualityCorrect,evidence_directory:summary.evidence_directory}));
}finally{await work.stop();}
