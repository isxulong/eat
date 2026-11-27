# 吃什么 · 转盘

一个决定「今天吃什么」的转盘。静态页面托管在 Cloudflare Pages，选项存在 D1 里——你在任何设备上改的内容，刷新、换浏览器、换手机之后都还在。

线上地址：<https://eat.isxl.cn>（备用：<https://eat-4t0.pages.dev>）

---

## 它能做什么

**转盘**
- 按权重随机，指针停下就是结果
- 空格键也能转
- 项数多时自动切换绘制策略：≤20 项用菜单配色，21–60 项用低饱和色相环，>60 项画平滑色轮（扇区已不足 2px，逐个上色只会糊成噪点）；落点判定始终按真实扇区精确计算

**分类筛选**
- 每个选项可属于多个分类
- 筛选条点一下只看该分类，可多选（并集），转盘和项数实时跟着变
- 列表每行右侧显示分类色点

**维护选项（两种方式）**

*前端手动*——点右上角「编辑」，输入口令后：
- 单行输入、回车连加
- 整列粘贴：换行、逗号、顿号、分号、制表符都能自动切开，自动去重并实时显示「识别到 N 条」
- 点某行文字直接改，失焦自动保存
- 点某行空白处停用/启用（停用的不参与旋转，显示删除线）
- 勾选多项后批量打分类 / 启用 / 停用 / 删除
- 搜索过滤；一屏之外的行用虚拟滚动，800 条也不卡

*后台批量*——`POST /api/options/batch` 一次提交 add/update/remove，一个事务要么全成要么全不成；`POST /api/wheel/import` 支持全量替换。

**改编辑口令**
- 解锁编辑后点右上角「口令」，输入新口令两次即可
- **立刻生效，不需要重新部署**，也不需要去 Cloudflare 控制台
- 口令用 PBKDF2-SHA256（10 万次迭代）加盐后存进 D1，改了之后所有旧会话自动失效
- 忘了口令：删掉 D1 `meta` 表里 `admin_pass_hash` / `admin_pass_salt` 两行，退回 `ADMIN_TOKEN` 引导值

**管理分类**
- 打标签浮层里每个分类右侧有铅笔按钮：点开可改名，或删除
- 删除分类不会删掉选项，只解除关联
- 窄屏下分类芯片横向可滚，不换行堆成两排

**持久化**
- 服务端 D1 是唯一真源
- 浏览器 `localStorage` 只存首屏缓存和未提交草稿——先渲染缓存再静默拉最新，断网也能看到上次的内容
- 编辑操作乐观更新：界面立刻变化，再写服务端；失败自动回滚
- 切回标签页、或每 20 秒静默同步一次，别人的改动自动出现，**不用手动刷新**

---

## 技术方案

| 层 | 选型 | 为什么 |
|---|---|---|
| 前端 | 原生 HTML/CSS/JS，无框架无构建 | 一个转盘不需要打包器；首屏就是最终产物 |
| 托管 | Cloudflare Pages（Direct Upload） | 静态资源免费无限量；Functions 与 D1 一等公民集成 |
| 接口 | Pages Functions（`functions/api/[[path]].js`） | 单文件路由，零依赖 |
| 存储 | **Cloudflare D1** | 行级并发安全 + 单事务批量，是唯一同时满足「持久」「并发不丢」「批量原子」的选项 |
| 缓存 | `localStorage` + 边缘 `no-store` | 首屏即开；写入后必须立刻能读到自己的改动 |

为什么不用其他方案：KV 最终一致（改完刷新可能看不到）且无事务；仓库 JSON 每次保存一个 commit、写延迟 1–2s；Durable Objects 对一个转盘过度设计。详细对比见 [docs/技术方案-存储与接口.md](docs/技术方案-存储与接口.md)。

### 数据模型

```sql
wheels(id, title, revision, updated_at)          -- revision 是乐观锁
options(id, wheel_id, text, weight, disabled, sort, created_at, updated_at)
tags(id, wheel_id, name, color, sort, created_at) -- 分类
option_tags(option_id, tag_id)                    -- 多对多
meta(k, v)                                        -- 口令哈希等
```

- `id` 由客户端生成 UUID，重试/连点不会产生重复行
- `disabled` 软删除，误删可一条 SQL 恢复
- `revision` 每次写 +1，写接口带 `expectedRevision`，不一致返回 409 + 最新快照

---

## 接口

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/api/wheel` | 整份快照（含 revision、tags） | 公开 |
| GET | `/api/health` | 自检：DB 可达、项数、是否仍用初始口令 | 公开 |
| GET | `/api/export?format=txt` | 导出 JSON / 纯文本 | 公开 |
| POST | `/api/login` | 口令换 2h 会话 cookie | — |
| POST | `/api/password` | 改口令 `{current, next}` | 当前口令 |
| POST | `/api/options` | 批量新增 `{texts:[...]}` | 写 |
| PATCH | `/api/options/:id` | 改文本/权重/停用 | 写 |
| DELETE | `/api/options/:id` | 软删除（`?hard=1` 物理删除） | 写 |
| POST | `/api/options/batch` | 后台批量事务 `{add,update,remove}` | 写 |
| POST | `/api/wheel/import` | 全量替换或追加 `{mode,texts}` | 写 |
| POST | `/api/tags` | 新建分类 `{name,color}` | 写 |
| PATCH | `/api/tags/:id` | 改名 / 改色 | 写 |
| DELETE | `/api/tags/:id` | 删分类并断开关联 | 写 |
| POST | `/api/option-tags` | 给选项打/撤标签 `{optionIds,tagIds,mode}` | 写 |

写接口接受两种鉴权：`Authorization: Bearer <口令>`（脚本用）或登录后的 `wheel_session` cookie（浏览器用）。**所有写接口都直接返回完整快照**，前端因此不需要写后再 GET。冲突时返回：

```json
HTTP 409 { "error": "revision_conflict", "revision": 43, "options": [ ...最新快照... ] }
```

---

## 本地开发

```bash
# 纯静态预览（mock 后端，不需要任何凭据；默认口令 demo）
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

# 增量迁移
npx wrangler d1 execute eat-db --remote --file=./migrations/001-tags.sql

# 构建（内联 css/js → 单文件，首屏请求 3 → 1）
node build.mjs

# 发布
npx wrangler pages deploy dist --project-name=eat --branch=main
```

> **为什么发布 `dist` 而不是 `public`**：这条线路上是 HTTP/1.1，每次请求要完整往返 0.8–2.6 秒。把 `styles.css` 和 `app.js` 内联进 HTML 后，首屏只发 1 个请求，省掉 2 次往返。实测静态请求从 3 降到 1，渲染行为完全一致。
>
> 改完 `public/` 下的文件后**必须重新跑 `node build.mjs`**，否则部署的还是旧内容。

Pages 项目需要配置的环境变量：

| 变量 | 类型 | 说明 |
|---|---|---|
| `ADMIN_TOKEN` | Secret | **仅作为首个口令的引导值**；在页面里改过口令后它就不再被使用 |

配置了 `DB` 的 D1 绑定时优先走绑定，REST 回退用的 `CLOUDFLARE_*` 变量可完全不配。

## 测试

```bash
# 接口契约（18 项，对生产跑）
node tests/e2e.mjs
BASE=http://127.0.0.1:8787 TOKEN=demo1234 node tests/e2e.mjs

# 抽选随机性：卡方拟合优度检验，5 类场景 × 20 万样本
node tests/randomness.mjs

# 界面行为（需要先起 dev-preview.mjs 和本地 Edge）
node dev-preview.mjs &
node tests/ui-tags.mjs        # 分类筛选：点选→转盘范围收缩→落点验证
node tests/ui-tagman.mjs      # 分类改名/删除
node tests/ui-rollback.mjs    # 写失败时乐观更新是否回滚、幽灵行是否残留
node tests/ui-scroll.mjs      # 滚动 60 帧，逐帧检查行可见性（防闪烁回归）
node tests/ui-spin.mjs        # 转盘落点与显示结果几何一致性
```

`randomness.mjs` 直接复刻 `app.js` 的抽选函数跑 20 万次样本做卡方拟合优度检验，覆盖等权 / 带权重 / 极端权重 / 确定性序列；确定性序列那项要求三等分精确无偏（实测极差 0），能证明分段逻辑本身没有取整偏差。

`ui-scroll.mjs` 是防回归的关键：它模拟手指持续拖动，逐帧读取每一行的 `computedStyle.opacity`，断言 `worstInvisible = 0`。曾经因为行的入场动画在虚拟滚动重建时重放，导致拖动中文字始终透明。

UI 测试通过 CDP 驱动 headless Edge，可用环境变量覆盖：

| 变量 | 默认 | 说明 |
|---|---|---|
| `EDGE` | Edge 默认安装路径 | 浏览器可执行文件 |
| `OUT_DIR` | 系统临时目录 | 截图输出位置 |

## 目录

```
public/            静态站点（index.html / styles.css / app.js）
functions/api/     Pages Functions，单文件路由
schema.sql         完整建表
migrations/        增量迁移
tests/
  e2e.mjs          接口契约测试（18 项）
  randomness.mjs   抽选随机性卡方检验
  ui-*.mjs         界面行为测试（CDP 驱动 headless Edge）
dev-preview.mjs    本地预览（mock 后端，零依赖）
docs/              技术方案、令牌创建指引
```

---

## 已知边界

- 中国大陆访问 `pages.dev` / 自定义域延时不稳（实测 1–3s 波动，偶发超时），是到 Cloudflare 边缘节点（被调度到 LAX/SJC）的链路问题，不是服务端——服务端稳定 140ms。绑自定义域后略有改善。根本解法是走优化线路的代理。
- 当前只有「一个转盘」，多转盘的表结构（`wheels.id`）已预留，界面未开放切换。
- 分类没有颜色选择器：`tags.color` 字段已支持，前端只用默认色点。需要区分配色时可调 `PATCH /api/tags/:id` 传 `color`。
- `Math.random` 不是密码学随机源。对「今天吃什么」够用；若将来用于抽奖发奖这类需要不可预测性的场景，应换成 `crypto.getRandomValues`。

