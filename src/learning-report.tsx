import { useState } from "react";
import { learningReport } from "./api";
import type { LearningReport } from "./api";
import { EmptyState } from "./ui";
export function LearningReportPanel({ taskId, onLoaded }: { taskId: string; onLoaded?: () => void }) {
  const [report,setReport]=useState<LearningReport|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false);
  const load=async()=>{setBusy(true);setError(false);try{setReport(await learningReport(taskId));onLoaded?.();}catch{setError(true);}finally{setBusy(false);}};
  return <div><button className="btn" disabled={busy} onClick={load}>查看学习复盘汇总</button>{error?<EmptyState kind="error" onRetry={load}/>:report&&<section className="panel" aria-label="学习复盘汇总"><h4>{report.course?.title||"课程未取得"}</h4><p>目标：{report.goal||"未记录"}</p><p style={{whiteSpace:"pre-wrap"}}>学习记录：{report.learning_record||"尚未填写"}</p><p style={{whiteSpace:"pre-wrap"}}>本人反馈：{report.feedback||"尚未填写"}</p><p>人工复核意见：{report.review_note||"暂无"}</p><p>{report.conclusion}</p><p className="meta" style={{overflowWrap:"anywhere"}}>课程来源版本 {report.course?.source_version||"未取得"} · 汇总时间 {report.generated_at}</p><p className="login-note">{report.limitations}</p></section>}</div>;
}
