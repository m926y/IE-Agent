import { readDriverFacts, validDay } from './data-reader.mjs';
import { computeDriverSnapshot as analyze } from './safety-analyzer.mjs';
import { organizeDailyReport } from './report-agent.mjs';
import { validateDailySafetyReport } from './report-validator.mjs';

export function dataAsOfDate(reportDate) {
  if (!validDay(reportDate)) throw new Error('invalid_report_date');
  return new Date(Date.parse(reportDate+'T00:00:00Z')-86400000).toISOString().slice(0,10);
}

export function computeDriverSnapshot(store, driverId, asOf) {
  return analyze(readDriverFacts(store,driverId,asOf));
}

function previousGoalContext(store,driverId,reportDate) {
  const previous=store.db?.prepare("SELECT r.report_date,r.report_json,g.id goal_id,g.status goal_status,g.feedback_code FROM driver_safety_goals g JOIN daily_safety_reports r ON r.id=g.report_id WHERE r.driver_id=? AND r.report_date<? AND r.status='published' AND r.is_current=1 ORDER BY r.report_date DESC LIMIT 1").get(driverId,reportDate);
  if(!previous)return null;
  const report=JSON.parse(previous.report_json);
  return {id:previous.goal_id,reportDate:previous.report_date,status:previous.goal_status,feedbackCode:previous.feedback_code,scoreEvidenceId:report.metrics.scoreEvidenceId,eventType:report.risks[0]?.eventType||null,evidenceRefs:report.risks[0]?.evidenceRefs||[]};
}

export function generateDailySafetyReport(store, driverId, reportDate) {
  const snapshot = {...computeDriverSnapshot(store,driverId,dataAsOfDate(reportDate)),previousGoal:previousGoalContext(store,driverId,reportDate)};
  return validateDailySafetyReport(organizeDailyReport(snapshot,reportDate),snapshot);
}
