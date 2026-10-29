import { createServer } from "node:http";
import { compileFilters } from "./local-data-store.mjs";

// Restricted localhost adapter. The app server owns user authorization.
export function createLocalBroker(store, key, faults) {
  const broker = createServer(async (req, res) => {
    const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(req.method === "HEAD" ? undefined : JSON.stringify(body)); };
    try {
      if (req.headers.apikey !== key) return send(403, { code: "forbidden" });
      const url = new URL(req.url, "http://local"), table = url.pathname.replace(/^\/rest\/v1\//, "");
      if (!Object.hasOwn(store.pk, table)) return send(404, { code: "unknown_local_table" });
      if (!["GET", "HEAD", "POST", "PATCH", "DELETE"].includes(req.method)) return send(405, { code: "method_not_allowed" });
      if (store.immutable.has(table) && !["GET", "HEAD"].includes(req.method)) return send(403, { code: "source_facts_read_only" });
      if (table === "training_courses" && !["GET","HEAD","PATCH"].includes(req.method)) return send(403,{code:"source_course_content_read_only"});
      if (table === "notification_events" && req.method === "POST" && faults.notifications) return send(503, { code: "local_test_notification_outage" });
      const { sql, bind } = compileFilters(url.searchParams);
      const parameters = [table, ...bind], where = "table_name=?" + sql;
      let order = "record_id ASC";
      if (url.searchParams.get("order")) order = url.searchParams.get("order").split(",").map(part => { const [col, dir] = part.split("."); if (!/^[a-z_][a-z0-9_]*$/.test(col) || ![undefined,"asc","desc"].includes(dir)) throw new Error("Unsupported order"); return `json_extract(payload,'$.${col}') ${dir === 'desc' ? 'DESC' : 'ASC'}`; }).join(",") + ",record_id ASC";
      const limit = Number(url.searchParams.get("limit") || 100000), offset = Number(url.searchParams.get("offset") || 0);
      if (!Number.isSafeInteger(limit)||limit<0||limit>100000||!Number.isSafeInteger(offset)||offset<0) return send(400,{code:"invalid_pagination"});
      const project = row => {
        const select = url.searchParams.get("select"); if (!select || select === "*") return row;
        const cols = select.split(","); if (cols.some(x => !/^[a-z_][a-z0-9_]*$/.test(x))) throw new Error("Unsupported local projection");
        return Object.fromEntries(cols.map(c => [c, row[c] ?? null]));
      };
      if (["GET","HEAD"].includes(req.method)) {
        const count = store.db.prepare(`SELECT COUNT(*) n FROM objects WHERE ${where}`).get(...parameters).n;
        const rows = store.db.prepare(`SELECT payload FROM objects WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...parameters,limit,offset).map(x=>project(JSON.parse(x.payload)));
        return send(200, rows, { "content-range": `${offset}-${offset+Math.max(0,rows.length-1)}/${count}` });
      }
      let text = ""; for await (const c of req) { text += c; if (text.length > 5*1024*1024) return send(413,{code:"body_too_large"}); }
      const body = text ? JSON.parse(text) : {};
      const affected = store.transaction(() => {
        if (req.method === "POST") {
          const incoming = Array.isArray(body) ? body : [body];
          return incoming.map(row => store.put(table, row, String(req.headers.prefer||"").includes("merge-duplicates")));
        }
        const matches = store.db.prepare(`SELECT record_id,payload FROM objects WHERE ${where}`).all(...parameters);
        return matches.map(item => {
          const row = JSON.parse(item.payload);
          if (req.method === "DELETE") store.db.prepare("DELETE FROM objects WHERE table_name=? AND record_id=?").run(table,item.record_id);
          else {
            if (table === "training_courses" && Object.keys(body).some(k=>!["content_status","version_no","updated_at"].includes(k))) throw new Error("Course content can only come from IE亮剑");
            const merged = {...row,...body}; if (merged[store.pk[table]] !== row[store.pk[table]]) throw new Error("Cannot change primary key");
            store.db.prepare("UPDATE objects SET payload=? WHERE table_name=? AND record_id=?").run(JSON.stringify(merged),table,item.record_id);
            return merged;
          }
          return row;
        });
      });
      return send(req.method === "POST" ? 201 : 200, String(req.headers.prefer||"").includes("return=representation") ? affected.map(project) : []);
    } catch (e) {
      if (String(e.code || "").includes("SQLITE_CONSTRAINT") || String(e.message).includes("UNIQUE constraint")) return send(409,{code:"23505"});
      return send(400, { code: "unsupported_local_request" });
    }
  });
  return broker;
}
