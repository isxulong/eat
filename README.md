# 吃什么 · 转盘

一个决定「今天吃什么」的转盘。静态页面托管在 Cloudflare Pages，选项存在 D1 里——你在任何设备上改的内容，刷新、换浏览器、换手机之后都还在。

线上地址：<https://eat-4t0.pages.dev>

---

## 它能做什么

**转盘**
- 按权重随机，指针停下就是结果
- 空格键也能转
- 项数多时自动切换绘制策略（少于 20 项用菜单配色，更多时用连续色相环，避免细扇区糊成一片）

**维护选项（两种方式）**

*前端手动*——点右上角「编辑」，输入口令后：
- 单行输入、回车连加
- 整列粘贴：换行、逗号、顿号、分号、制表符都能自动切开，自动去重并实时显示「识别到 N 条」
- 点某行文字直接改，失焦自动保存
- 点某行空白处停用/启用（停用的不参与旋转，显示删除线）
- 勾选多项后批量启用 / 停用 / 删除
- 搜索过滤；一屏之外的行用虚拟滚动，800 条也不卡

*后台批量*——`POST /api/options/batch` 一次提交 add/update/remove，一个事务要么全成要么全不成；`POST /api/wheel/import` 支持全量替换。

**持久化**
- 服务端 D1 是唯一真源
- 浏览器 `localStorage` 只存首屏缓存和未提交草稿——先渲染缓存再静默拉最新，断网也能看到上次的内容
- 编辑操作乐观更新：先在界面上生效，再写服务端；失败自动回滚

---

## 技术方案

| 层 | 选型 | 为什么 |
|---|---|---|
| 前端 | 原生 HTML/CSS/JS，无框架无构建 | 一个转盘不需要打包器；首屏就是最终产物 |
| 托管 | Cloudflare Pages（Direct Upload） | 静态资源免费无限量；Functions 与 D1 一等公民集成 |
| 接口 | Pages Functions（`functions/api/[[path]].js`） | 单文件路由，零依赖 |
| 存储 | **Cloudflare D1** | 行级并发安全 + 单事务批量，是唯一同时满足「持久」「并发不丢」「批量原子」的选项 |
| 缓存 | `localStorage` + 边缘 10s | 首屏即开；写后主动重拉，不存在看到旧数据的窗口 |

为什么不用其他方案：KV 最终一致（改完刷新可能看不到）且无事务；仓库 JSON 每次保存一个 commit、写延迟 1–2s；Durable Objects 对一个转盘过度设计。详细对比见 [docs/技术方案-存储与接口.md](docs/技术方案-存储与接口.md)。

### 数据模型

```sql
wheels(id, title, revision, updated_at)          -- revision 是乐观锁
options(id, wheel_id, text, weight, disabled, sort, created_at, updated_at)
meta(k, v)
```

- `id` 由客户端生成 UUID，重试/连点不会产生重复行
- `disabled` 软删除，误删可一条 SQL 恢复
- `revision` 每次写 +1，写接口带 `expectedRevision`，不一致返回 409 + 最新快照

---

## 接口

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/api/wheel` | 整份快照（含 revision） | 公开 |
| GET | `/api/health` | 自检：DB 可达、项数、存储模式 | 公开 |
| GET | `/api/export?format=txt` | 导出 JSON / 纯文本 | 公开 |
| POST | `/api/login` | 口令换 2h 会话 cookie | — |
| POST | `/api/logout` | 清除会话 | — |
| POST | `/api/options` | 批量新增 `{texts:[...]}` | 写 |
| PATCH | `/api/options/:id` | 改文本/权重/停用 | 写 |
| DELETE | `/api/options/:id` | 软删除（`?hard=1` 物理删除） | 写 |
| POST | `/api/options/batch` | 后台批量事务 `{add,update,remove}` | 写 |
| POST | `/api/wheel/import` | 全量替换或追加 `{mode,texts}` | 写 |

写接口接受两种鉴权：`Authorization: Bearer <口令>`（脚本用）或登录后的 `wheel_session` cookie（浏览器用）。冲突时返回：

```json
HTTP 409 { "error": "revision_conflict", "revision": 43, "options": [ ...最新快照... ] }
```

前端拿到 409 直接吃服务端快照重绘，本地未提交的输入留在输入框里。

---

## 本地开发

```bash
# 纯静态预览（mock 后端，不需要任何凭据）
node dev-preview.mjs          # → http://127.0.0.1:8787
BULK=1 node dev-preview.mjs   # 800 条压力数据

# 真实 Functions + 本地 D1
npx wrangler pages dev public --d1 DB=eat-db --port 8787
```

## 部署

```bash
export CLOUDFLARE_API_TOKEN=...      # D1 Edit + Pages Edit
export CLOUDFLARE_ACCOUNT_ID=...

# 建库（首次）
npx wrangler d1 create eat-db
npx wrangler d1 execute eat-db --remote --file=./schema.sql

# 发布
npx wrangler pages deploy public --project-name=eat --branch=main
```

Pages 项目需要配置的环境变量：

| 变量 | 类型 | 说明 |
|---|---|---|
| `ADMIN_TOKEN` | Secret | **编辑口令，务必改掉默认值** |
| `CLOUDFLARE_API_TOKEN` | Secret | 仅当 Functions 走 REST 回退时需要 |
| `CLOUDFLARE_ACCOUNT_ID` | 明文 | 同上 |
| `CLOUDFLARE_D1_ID` | 明文 | 同上 |

配置了 `DB` 的 D1 绑定时优先走绑定，上面三个 `CLOUDFLARE_*` 可以完全不配。

## 测试

```bash
node tests/e2e.mjs                    # 对生产跑 18 项契约测试
BASE=http://127.0.0.1:8787 node tests/e2e.mjs
```

覆盖：未授权拦截、口令校验、会话下发、批量新增、持久化回读、单条修改、409 冲突与快照、批量事务原子性、软删除、清理复原。

## 目录

```
public/            静态站点（index.html / styles.css / app.js）
functions/api/     Pages Functions，单文件路由
schema.sql         D1 建表
wrangler.toml      D1 绑定
tests/e2e.mjs      端到端契约测试
dev-preview.mjs    本地预览（mock 后端）
docs/              技术方案、令牌创建指引
```

---

## 已知边界

- **写口令默认值是 `eat-2026-let-me-decide`，上线后应立刻在 Pages 环境变量里改掉**，改完重新部署即生效
- 当前只有「一个转盘」，多转盘的表已预留（`wheels.id`），但界面未开放切换
- 中国大陆访问延时不稳（实测同一静态页 1.4s–22s 波动），是到 `pages.dev` 的链路问题，不是服务端——服务端实测 140ms
