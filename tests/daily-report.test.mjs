import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocalStore } from '../scripts/local-data-store.mjs';
import { readDriverFacts } from '../scripts/daily-report/data-reader.mjs';
import { computeDriverSnapshot, generateDailySafetyReport } from '../scripts/daily-report/report-service.mjs';
import { validateDailySafetyReport } from '../scripts/daily-report/report-validator.mjs';
import { computeDriverSnapshot as analyze } from '../scripts/daily-report/safety-analyzer.mjs';
import { publishDailyReport, listSafetyGoals, feedbackSafetyGoal } from '../scripts/daily-report/report-store.mjs';

test('daily report stage 1 uses only the real isolated source and rejects changed facts', async t => {
  const root=fileURLToPath(new URL('../.source-tests/',import.meta.url));
  await mkdir(root,{recursive:true});
  const directory=await mkdtemp(join(root,'daily-report-test-'));
  const store=await openLocalStore({directory});
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const sourceEvents=store.rows('replay_events');
  const withEvents=sourceEvents[0].driver_id;
  const withoutEvents=store.rows('drivers').find(row=>!sourceEvents.some(event=>event.driver_id===row.driver_id)).driver_id;

  await t.test('two drivers produce stable distinct source-backed reports',()=>{
    const a=generateDailySafetyReport(store,withEvents,'2026-08-01');
    const b=generateDailySafetyReport(store,withoutEvents,'2026-08-01');
    assert.deepEqual(a,generateDailySafetyReport(store,withEvents,'2026-08-01'));
    assert.notDeepEqual(a,b);
    assert.equal(a.dataAsOf,'2026-07-31T23:59:59+08:00');
    assert.equal(a.dataStatus,'historical_replay');
    const score=store.rows('score_history').find(row=>row.driver_id===withEvents && row.as_of_date==='2026-07-31');
    assert.equal(a.metrics.personalScore,score.safety_score);
    assert.equal(a.metrics.scoreEvidenceId,score.score_id);
    assert.equal(a.metrics.scoreChange,null);
    assert.equal(a.metrics.scoreComparisonStatus,'overlapping_window');
    assert.equal(a.metrics.fleetScoredDrivers,500);
    assert.equal(a.risks[0].observedCount,sourceEvents.filter(row=>row.driver_id===withEvents && row.event_type===a.risks[0].eventType).length);
    assert.ok(a.risks[0].evidenceRefs.every(ref=>sourceEvents.some(event=>ref===`event:${event.event_id}` && event.driver_id===withEvents)));
    assert.equal(a.metrics.riskCount7d,null);
    assert.equal(a.metrics.riskRate,null);
    assert.deepEqual(a.approvedCourseRefs,[]);
    assert.equal(b.risks.length,0);
    assert.equal(b.dailyGoal,null);
    assert.equal(b.metrics.riskCount7d,null);
  });

  await t.test('missing scores and fleet samples degrade without zero-filling',()=>{
    const report=generateDailySafetyReport(store,withEvents,'2026-07-24');
    assert.equal(report.metrics.personalScore,null);
    assert.equal(report.metrics.fleetAverage,null);
    assert.equal(report.metrics.fleetScoredDrivers,null);
    assert.equal(report.metrics.scoreChange,null);
    assert.equal(report.metrics.riskCount7d,null);
    assert.equal(report.risks.length,0);
    assert.ok(report.dataLimitations.some(x=>x.includes('没有当前司机可引用')));
  });

  await t.test('a score with unavailable fleet rows has no invented fleet mean',()=>{
    const facts=readDriverFacts(store,withEvents,'2026-07-31');
    const snapshot=analyze({...facts,fleetScores:[]});
    assert.notEqual(snapshot.score.latest,null);
    assert.equal(snapshot.fleet.average,null);
    assert.equal(snapshot.fleet.scoredDrivers,null);
    assert.equal(snapshot.fleet.status,'insufficient_sample');
  });

  await t.test('consecutive days without new source facts do not claim new events',()=>{
    const first=generateDailySafetyReport(store,withEvents,'2026-10-29');
    const next=generateDailySafetyReport(store,withEvents,'2026-10-30');
    assert.equal(first.metrics.personalScore,next.metrics.personalScore);
    assert.deepEqual(first.risks,next.risks);
    assert.match(next.summary,/不代表本日新增事件/);
    assert.ok(next.coverage.observedDates.every(day=>day==='2026-07-29'));
  });

  await t.test('source low-confidence score carries a data-verification warning',()=>{
    const low=store.rows('score_snapshots').find(row=>row.confidence_level==='low');
    const report=generateDailySafetyReport(store,low.driver_id,'2026-08-01');
    assert.equal(report.metrics.scoreConfidence,'low');
    assert.ok(report.dataLimitations.some(x=>x.includes('评分可信度低')));
    assert.equal(report.metrics.scoreChange,null);
  });

  await t.test('numeric and evidence changes fail validation',()=>{
    const facts=readDriverFacts(store,withEvents,'2026-07-31');
    const snapshot=computeDriverSnapshot(store,withEvents,'2026-07-31');
    const report=generateDailySafetyReport(store,withEvents,'2026-08-01');
    assert.equal(facts.fingerprint,report.sourceFingerprint);
    const numberTamper=structuredClone(report); numberTamper.metrics.personalScore=0;
    assert.throws(()=>validateDailySafetyReport(numberTamper,snapshot),/report_fact_mismatch/);
    const evidenceTamper=structuredClone(report); evidenceTamper.risks[0].evidenceRefs[0]='event:OTHER_DRIVER';
    assert.throws(()=>validateDailySafetyReport(evidenceTamper,snapshot),/report_fact_mismatch/);
    const courseTamper=structuredClone(report); courseTamper.approvedCourseRefs=['DEMO_C01'];
    assert.throws(()=>validateDailySafetyReport(courseTamper,snapshot),/report_fact_mismatch/);
    const dateTamper=structuredClone(report); dateTamper.reportDate='2026-08-02';
    assert.throws(()=>validateDailySafetyReport(dateTamper,snapshot),/report_date_snapshot_mismatch/);
  });

  await t.test('invalid dates and unknown drivers are refused',()=>{
    assert.throws(()=>generateDailySafetyReport(store,withEvents,'2026-02-30'),/invalid_report_date/);
    assert.throws(()=>generateDailySafetyReport(store,'UNKNOWN_DRIVER','2026-08-01'),/driver_not_found_or_ambiguous/);
  });

  await t.test('cross-day goals keep feedback and withhold improvement claims without comparable new evidence',()=>{
    const first=publishDailyReport(store,{driverId:withEvents,reportDate:'2026-10-29',actorId:'test_admin'});
    const firstGoal=listSafetyGoals(store,withEvents).find(row=>row.reportId===first.id);
    assert.ok(firstGoal);
    feedbackSafetyGoal(store,withEvents,firstGoal.id,{code:'dismissed',actorId:'test_driver'});
    const next=publishDailyReport(store,{driverId:withEvents,reportDate:'2026-10-30',actorId:'test_admin'});
    assert.equal(next.report.schemaVersion,2);
    assert.equal(next.report.goalTracking.previousGoalId,firstGoal.id);
    assert.equal(next.report.goalTracking.previousStatus,'dismissed');
    assert.equal(next.report.goalTracking.previousFeedbackCode,'dismissed');
    assert.equal(next.report.goalTracking.newEvidence,false);
    assert.equal(next.report.goalTracking.assessment,'pending_evidence');
    assert.equal(listSafetyGoals(store,withEvents).find(row=>row.reportId===next.id).previousGoalId,firstGoal.id);
    assert.equal(next.report.metrics.personalScore,first.report.metrics.personalScore);
  });

  await t.test('only a course approved before the report cutoff may match source-backed evidence',()=>{
    const course=store.rows('training_courses').find(row=>row.dimension==='driving_stability');
    assert.ok(course);
    store.put('training_courses',{...course,content_status:'approved',updated_at:'2026-08-01T00:00:00Z'},true);
    const before=generateDailySafetyReport(store,withEvents,'2026-08-01');
    const after=generateDailySafetyReport(store,withEvents,'2026-08-02');
    assert.deepEqual(before.approvedCourseRefs,[]);
    assert.deepEqual(after.approvedCourseRefs,[course.course_id]);
    assert.equal(after.cards.find(card=>card.type==='learning_tip')?.evidenceRefs[0],after.risks[0].evidenceRefs[0]);
    const tampered=structuredClone(after);tampered.approvedCourseRefs=['DEMO_C02'];
    assert.throws(()=>validateDailySafetyReport(tampered,computeDriverSnapshot(store,withEvents,'2026-08-01')),/report_fact_mismatch/);
  });
});
