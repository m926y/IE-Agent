#!/usr/bin/env python3
"""把属主提供的「处理后清洗数据」导入云端托管库的全量数据索引四表（迁移017）。

用法（属主本机或 Agent 沙箱，凭据只走环境变量，脚本永不打印/落盘密钥）：
    SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_INSTANCE_ID=... \
      python3 scripts/import-cloud-index.py --data-dir /path/to/processed/cleaned

设计约定：
- 只写本脚本负责的四张 local_* 索引表；绝不触碰 drivers/score_*/replay_events/alerts 等业务表
  （红线：评分与历史索引只读；也不改写既有用户数据）。
- 幂等：按主键 upsert（resolution=merge-duplicates）。重复运行只会覆盖同键行，不产生重复行。
- 空值保持 NULL，绝不转 0；数值以字符串下发，保住清洗阶段的小数位与精度。
- driver_id 不入库：本地模式是查询期 JOIN drivers，云端同样在宿主输出层按当前 drivers 解析，
  避免把换绑前的身份冻结进聚合行。
- risk_events.parquet 逐条事件不导入（315 万行），只导入其真实日聚合；vehicle_day 是
  trajectory_daily ∪ imu_daily 的合并副本（零独有事实行），同样不导入。
"""
from __future__ import annotations

import argparse
import concurrent.futures as futures
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta

import pyarrow as pa
import pyarrow.parquet as pq


def die(message: str) -> None:
    print(f"ERROR {message}", file=sys.stderr)
    raise SystemExit(2)


def scalar(value):
    """转成 PostgREST 可接受且保精度的 JSON 值；None 保持 None（不转 0）。"""
    if value is None or (isinstance(value, float) and value != value):  # NaN 视作缺失
        return None
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")[:19]
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    return str(value)


def rows_of(table: pa.Table, columns: list[str], casts: dict):
    data = {name: table.column(name).to_pylist() for name in columns}
    for index in range(table.num_rows):
        row = {}
        for name in columns:
            value = data[name][index]
            cast = casts.get(name)
            row[name] = scalar(cast(value) if cast else value)
        yield row


def read_profile(data_dir: str) -> pa.Table:
    path = os.path.join(data_dir, "vehicle_profile.parquet")
    if os.path.exists(path):
        return pq.read_table(path)
    csv_path = os.path.join(data_dir, "vehicle_profile.csv")
    if not os.path.exists(csv_path):
        die("vehicle_profile.parquet / .csv 均不存在")
    import csv as csvmod

    with open(csv_path, newline="", encoding="utf-8") as handle:
        reader = csvmod.DictReader(handle)
        names = reader.fieldnames or []
        columns = {name: [] for name in names}
        for record in reader:
            for name in names:
                raw = record.get(name)
                columns[name].append(None if raw in (None, "", "NA") else raw)
    arrays = []
    for name in names:
        values = columns[name]
        if name == "gpsno" or name == "energy_type":
            arrays.append(pa.array(values, type=pa.string()))
        else:
            arrays.append(pa.array([None if v is None else float(v) for v in values], type=pa.float64()))
    return pa.Table.from_arrays(arrays, names=names)


def build_event_daily(data_dir: str) -> pa.Table:
    """risk_events 逐条日志 → 车辆×日×事件类型 的真实日聚合（不虚构、不抽样）。"""
    path = os.path.join(data_dir, "risk_events.parquet")
    if not os.path.exists(path):
        die("risk_events.parquet 不存在，无法生成事件日统计")
    events = pq.read_table(path, columns=["gpsno", "event_date", "event_type", "event_name"])
    grouped = events.group_by(["gpsno", "event_date", "event_type", "event_name"]).aggregate([("gpsno", "count")])
    return grouped.rename_columns(["gpsno", "event_date", "event_type", "event_name", "event_count"])


DATASETS = ("local_profiles", "local_trajectory_daily", "local_imu_daily", "local_event_daily")


class Client:
    def __init__(self, base: str, key: str, instance_id: str, workers: int):
        self.base = base.rstrip("/")
        self.headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "content-type": "application/json",
            "X-Instance-ID": instance_id,
        }
        self.workers = max(1, workers)

    def _request(self, method: str, path: str, payload=None, extra_headers=None, timeout: int = 180):
        url = f"{self.base}/rest/v1/{path}"
        body = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(url, data=body, method=method,
                                         headers={**self.headers, **(extra_headers or {})})
        return urllib.request.urlopen(request, timeout=timeout)

    def count(self, table: str) -> int | None:
        try:
            with self._request("GET", f"{table}?select=*&limit=1",
                               extra_headers={"Prefer": "count=exact"}) as response:
                header = response.headers.get("content-range") or ""
                total = header.split("/")[-1]
                return None if total in ("", "*") else int(total)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise

    def insert(self, table: str, batch: list[dict], conflict: str, merge: bool) -> int:
        headers = {"Prefer": "return=minimal"}
        path = table
        if merge:
            headers["Prefer"] = "resolution=merge-duplicates,return=minimal"
            path = f"{table}?on_conflict={conflict}"
        for attempt in range(4):
            try:
                with self._request("POST", path, batch, extra_headers=headers) as response:
                    if response.status not in (200, 201):
                        raise RuntimeError(f"unexpected status {response.status}")
                return len(batch)
            except urllib.error.HTTPError as error:
                detail = error.read()[:200].decode(errors="replace")
                if merge and error.code in (400, 404) and attempt == 0:
                    return self.insert(table, batch, conflict, False)  # 上游不支持 upsert 时退回普通插入
                if error.code == 413 and len(batch) > 1:  # 宽表批次超网关体积上限：对半拆后重投（仍按主键幂等）
                    middle = len(batch) // 2
                    return (self.insert(table, batch[:middle], conflict, merge)
                            + self.insert(table, batch[middle:], conflict, merge))
                if error.code in (409,) and not merge:
                    return 0
                if attempt == 3 or error.code not in (408, 429, 500, 502, 503, 504):
                    raise RuntimeError(f"{table} insert failed: {error.code} {detail}") from None
            except (urllib.error.URLError, TimeoutError, RuntimeError) as error:
                if attempt == 3:
                    raise RuntimeError(f"{table} insert failed: {error}") from None
            time.sleep(1.2 * (attempt + 1))
        return 0


PROVENANCE_NOTES = ("risk_events 逐条事件日志未入库（仅按 车辆×日×事件类型 导入真实日聚合）；"
                    "vehicle_day 为 trajectory_daily ∪ imu_daily 的合并副本（零独有事实行），未导入；"
                    "数值保持清洗阶段小数位与精度，空值为 NULL（未转 0）；driver_id 不入库，运行时按当前 drivers 解析。")


def observation_end(window: dict) -> str | None:
    """quality_report 给的是 end_exclusive，转成含端点的观测末日。"""
    raw = window.get("end_exclusive") or window.get("end")
    if not raw:
        return None
    day = date.fromisoformat(str(raw)[:10])
    if str(raw)[:19].endswith("00:00:00"):
        day = day - timedelta(days=1)
    return day.isoformat()


def write_provenance(client, args, report: dict, window: dict, summary: dict) -> dict:
    """把本批数据集的来源事实写成溯源行：数字取自质量报告与云端实测行数，不硬编码在服务端。"""
    stages = report.get("stages") or {}
    counts = {name: client.count(name) for name in DATASETS}
    row = {
        "source_version": args.source_version,
        "dataset": "processed/cleaned（属主交付的处理后清洗数据）",
        "observation_start": str(window.get("start") or "")[:10] or None,
        "observation_end": observation_end(window),
        "vehicle_count": ((stages.get("profile") or {}).get("vehicles")),
        "source_event_rows": ((stages.get("risk") or {}).get("rows")),
        "source_trajectory_rows": ((stages.get("trajectory") or {}).get("rows")),
        "source_imu_rows": ((stages.get("imu") or {}).get("rows")),
        "profile_rows": counts["local_profiles"],
        "trajectory_daily_rows": counts["local_trajectory_daily"],
        "imu_daily_rows": counts["local_imu_daily"],
        "event_daily_groups": counts["local_event_daily"],
        "quality_report_at": report.get("generated_at"),
        "imported_at": datetime.now().replace(microsecond=0).isoformat(sep=" "),
        "imported_by": "scripts/import-cloud-index.py",
        "notes": PROVENANCE_NOTES,
    }
    inserted = client.insert("local_index_provenance", [row], "source_version", True)
    return {"upserted": inserted, **{k: counts[k] for k in counts}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-dir", required=True, help="processed/cleaned 目录（含 parquet 与 quality_report.json）")
    parser.add_argument("--source-version", default="processed_cleaned_20260921", help="写入 source_version 的来源标识")
    parser.add_argument("--batch-size", type=int, default=1000)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--only", action="append", choices=DATASETS, help="只导入指定表（可重复）")
    parser.add_argument("--provenance-only", action="store_true",
                        help="不导数据，只按云端现有行数刷新溯源行（local_index_provenance）")
    parser.add_argument("--dry-run", action="store_true", help="只统计与体检，不写库")
    args = parser.parse_args()

    base = os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_URL").rstrip("/")
    key = os.environ.get("SUPABASE_ANON_KEY")
    instance = os.environ.get("SUPABASE_INSTANCE_ID")
    if not args.dry_run and not (base and key and instance):
        die("缺少 SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_INSTANCE_ID（三项必须同时提供）")

    report_path = os.path.join(args.data_dir, "quality_report.json")
    report = json.load(open(report_path, encoding="utf-8")) if os.path.exists(report_path) else {}
    window = (report.get("observation_window") or {})
    print(f"数据来源质量报告 generated_at={report.get('generated_at')} "
          f"观测窗 {window.get('start')} 至 {window.get('end_exclusive')}", file=sys.stderr)

    wanted = set() if args.provenance_only else set(args.only or DATASETS)
    # name -> (源表, 主键列（upsert on_conflict）, 类型转换)
    tables: dict[str, tuple[pa.Table, str, dict]] = {}

    if "local_profiles" in wanted:
        columns = ["gpsno", "energy_type", "monthly_mileage_km", "monthly_drive_hours", "monthly_stop_count",
                   "highway_mileage_ratio", "morning_drive_time_ratio", "dusk_drive_time_ratio",
                   "night_drive_time_ratio", "night_mileage_ratio"]
        tables["local_profiles"] = (read_profile(args.data_dir).select(columns), "gpsno", {})

    if "local_trajectory_daily" in wanted:
        tables["local_trajectory_daily"] = (pq.read_table(os.path.join(args.data_dir, "trajectory_daily.parquet")), "gpsno,event_date", {})

    if "local_imu_daily" in wanted:
        tables["local_imu_daily"] = (pq.read_table(os.path.join(args.data_dir, "imu_daily.parquet")), "gpsno,event_date", {})

    if "local_event_daily" in wanted:
        tables["local_event_daily"] = (build_event_daily(args.data_dir), "gpsno,event_date,event_type,event_name",
                                       {"event_type": lambda value: None if value is None else str(value)})

    client = Client(base, key, instance, args.workers) if not args.dry_run else None
    summary = {}
    for name, (table, conflict, casts) in tables.items():
        columns = list(table.schema.names)
        before = None if args.dry_run else client.count(name)
        if before is None and not args.dry_run:
            die(f"{name} 在云端不存在：请先执行迁移 017_cloud_full_data_index.up.sql")
        started = time.time()
        batches = []
        batch: list[dict] = []
        for row in rows_of(table, columns, casts):
            row["source_version"] = args.source_version
            batch.append(row)
            if len(batch) >= args.batch_size:
                batches.append(batch)
                batch = []
        if batch:
            batches.append(batch)
        if args.dry_run:
            summary[name] = {"rows": table.num_rows, "batches": len(batches)}
            print(f"[dry-run] {name}: rows={table.num_rows} batches={len(batches)}", file=sys.stderr)
            continue
        inserted = 0
        if client.workers > 1 and len(batches) > 1:
            with futures.ThreadPoolExecutor(max_workers=client.workers) as pool:
                for count in pool.map(lambda b: client.insert(name, b, conflict, True), batches):
                    inserted += count
        else:
            for item in batches:
                inserted += client.insert(name, item, conflict, True)
        after = client.count(name)
        summary[name] = {"rows": table.num_rows, "batches": len(batches), "upserted": inserted,
                         "before": before, "after": after, "seconds": round(time.time() - started, 1)}
        print(f"{name}: 源 {table.num_rows} 行 → upsert {inserted}，云端 {before} → {after} 行"
              f"（{summary[name]['seconds']}s）", file=sys.stderr)

    provenance = write_provenance(client, args, report, window, summary) if not args.dry_run else None

    print(json.dumps({"source_version": args.source_version, "observation_window": window, "provenance": provenance,
                      "quality_report_generated_at": report.get("generated_at"), "tables": summary}, ensure_ascii=False))


if __name__ == "__main__":
    main()
