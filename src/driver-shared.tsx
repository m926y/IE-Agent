import { ApiError } from "./api";
import { EmptyState } from "./ui";

export const driverDimensions = [["history_contribution", "历史"], ["fatigue_distraction_contribution", "疲劳分心"], ["driving_stability_contribution", "驾驶稳定性"], ["road_rule_contribution", "道路规则"], ["management_contribution", "管理配合"], ["imu_evidence_contribution", "IMU证据"]] as const;
export const trainingStatusNames: Record<string, string> = { assigned: "待开始", in_progress: "学习中", submitted: "待人工复核", returned: "需补充", reviewed: "复核通过", observation: "继续观察", interview: "需面谈" };

export function finiteValue(value: unknown): number | null {
  if (value == null || !["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}
export function numberText(value: unknown, digits = 2): string {
  return finiteValue(value)?.toFixed(digits) ?? "—";
}
export function DriverReadError({ error, retry }: { error: unknown; retry: () => void }) {
  const code = error instanceof ApiError ? error.code : "network";
  if (["binding_required", "binding_not_verified"].includes(code)) return <EmptyState kind="nocov" hint="当前账号尚未完成已核实司机绑定，请联系安全管理员。" />;
  if (error instanceof ApiError && [403, 404].includes(error.status)) return <EmptyState kind="noperm" hint="记录不存在或当前账号无权查看。" />;
  return <EmptyState kind="error" hint={`读取失败（${code}），未以空记录或零风险代替。`} onRetry={retry} />;
}
