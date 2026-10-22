# Crazy Logi-AI 2.0 — 驾驶安全管理工作台

面向物流车队的驾驶风险管理多人工作台：发现风险 → 核对证据 → 人工确认 → 沟通/培训 → 司机反馈 → 复评。双角色（安全管理员 / 司机）+ 服务端逐次验权 + 运行时 AI（只读事实、结构化草稿、调用审计）。

## 结构

| 路径 | 说明 |
|---|---|
| `server.mjs` | Node.js 22 单文件后端：认证/权限矩阵、只读数据资源（列白名单+filters 白名单）、导入预检→确认 UPSERT、案卷/干预/培训状态机、受控 AI 工具层（14 工具，写操作一律 requires_confirmation）、AI 调用审计、证据卡验权 |
| `src/App.tsx` | 登录/布局 + AI 面板（证据卡、重新验权、采纳/弃用、fill_to 表单回填、按角色会话暂存与会话隔离） |
| `src/admin.tsx` | 管理员页面：EV01/02/03/05、RM01–RM05、TR01–TR03/05/06、SM01–SM06 |
| `src/driver.tsx` | 司机窄屏端：EV04 我的评分、RM04 沟通、TR04 培训作答 |
| `scripts/` | 本地回归与电池：`verify-local.mjs`（主回归 119 项）、`ai03-fillto-battery.cjs`（AI 审计/回填 19 项）、`training-closed-loop-battery.js`、`ai-audit-battery.js` 等 |
| `scripts/contract/` | 数据契约：`app_tables.json`、`data_dictionary.json` |
| `AGENTS.md` | 迭代决策日志（16 轮），含红线：算法事实只读、不为演示造假数据 |

## 运行

```bash
npm install
npm run dev            # 前端 vite；后端见下
node server.mjs        # 需要环境变量（见 env 要求）
npm run build && node scripts/prepare-publish.mjs   # 产出 .qw-pages/publish 发布目录
```

### 环境变量（不随仓库提供）

- `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_INSTANCE_ID` — 平台托管数据库
- `QW_AI_BASE_URL` / `QW_AI_API_KEY` / `QW_AI_MODEL` — 运行时模型网关（缺省时 AI 面板显示 503 缺口卡而非假回答）
- `SSO_PROTECTED`、`HOST`、`PORT`、`NODE_ENV`

工作台账号口令（管理员/司机/属主）一律在环境或密钥管理中设置；本地脚本从 `.runtime-tmp/app.env`（已 gitignore）读取 `ADMIN_PW` / `DRIVER_PW`。

## 关键设计约束

- 评分/预测/六维扣分/事件证据为**只读事实**：页面与 AI 只引用解释，不重算修改；DB 与源 CSV 全量对账。
- AI 不能写业务表：草稿（含 `fill_to` 表单回填）必须在 RM03/TR02 由人工点击原有确认按钮，服务端校验角色、对象、课程审核状态、旧状态版本、幂等键后写入原业务表与审计；重复提交幂等回放同一业务 ID。
- 每次 AI 调用留审计（`ai.chat`/`ai.confirm`），证据卡点击按当前会话重新验权（越权与不存在同语义 404）。
- 低可信度对象：草稿强制“核验优先”话术，不自动下发惩罚性培训；未审核课程 409 拒绝正式分配。
