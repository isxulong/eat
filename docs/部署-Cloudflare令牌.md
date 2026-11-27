# Cloudflare API 令牌制作步骤（本项目专用 · 中文界面版）

> 用途：让自动化流程能创建 D1 数据库、绑定到 Pages 项目、执行 schema、触发首次部署。
> 最小权限原则：只给下面三行，不要用「API 密钥」（Global API Key），不要给「读取所有资源」。
> 界面按 Cloudflare 中文控制台（User settings · 创建令牌）实际文案书写。

---

## 一、创建步骤（对着中文界面走）

1. 打开 <https://dash.cloudflare.com/profile/api-tokens>，进入 **User settings → API 凭据 → API 令牌**。
2. 点右上角 **创建令牌**。
3. 到了「创建令牌 / 选择该令牌可访问的内容及其有效期」这页：
   - **令牌名称**：填 `eat-wheel-deploy`
   - **策略**：**不要**用下面任何一个预设（编辑区域 DNS、编辑 Cloudflare Workers、读取所有资源……都不匹配本项目），直接点最上面第一项 **「从头开始 / Custom」**。
4. 点「从头开始」会弹出三个子项，**选「从 Account 策略开始」**（D1 与 Pages 都是账户级资源；Zone 是域名级、User 是个人资料级，选错后面选不到 D1 / Pages）。
5. 选完「从 Account 策略开始」后，页面出现一条 **「编辑账户策略」** 权限块（含 `包括 / 所有账户` 与一个权限分类折叠列表）。权限组按分类折叠、每类后面是 `已选/总数`，**不要逐类展开翻找**——直接用块内的 **「搜索权限组……」** 搜索框：
   - 输入 `Pages` → 勾选 **Cloudflare Pages** 行的 **编辑**
   - 清空，输入 `D1` → 勾选 **D1** 行的 **编辑**
   - 清空，输入 `账户设置`（或 `Account Settings`）→ 勾选 **账户设置** 行的 **读取**

   三行对应关系（每行是三个下拉框，即 类型 / 资源 / 级别）：

   | 行 | 下拉框①（类型） | 下拉框②（资源） | 下拉框③（级别） | 作用 |
   |---|------|----------|-------|------|
   | 1 | **账户** | **Cloudflare Pages** | **编辑** | 建 Pages 项目、绑定 D1、触发部署 |
   | 2 | **账户** | **D1** | **编辑** | 建库、执行 schema、读写数据 |
   | 3 | **账户** | **账户设置 / Account Settings** | **读取** | 取 Account ID（可省） |

   分类位置（不想用搜索时）：`Cloudflare Pages` 与 `D1` 都在 **开发人员平台**（该分类计数从 `0/64` 起）；`账户设置` 在 **账户和账单**。

   > 权限块右侧有 **「全选」** 下拉——**不要点**，那会把该分类 64 项全给出去。勾对三项后计数应显示为 `3/64`（或 2/64，若省掉第三行）。

5. **账户资源**：选 **「包括 / Include」→ 你的账户名**（只有一个账户时通常已自动选中，若显示「所有账户」也可以）。
6. **令牌过期时间**：保持你截图里默认选中的 **「无过期时间」**。
   - 选 7 天 / 30 天这类，到期那天部署会突然 401，且不会有任何提醒。
7. **客户端 IP 地址筛选**：**留空**。
   - 这台机器出网走本地代理（`127.0.0.1:7897`），填了 IP 段很容易把自己挡在外面。
8. 点底部 **继续以显示摘要** → 核对三行权限无误 → **创建令牌**。
9. 复制生成的令牌。新格式以 `cfut_` 开头，**只显示这一次**，关掉页面只能重新生成。

> 你截图里「策略」列表中的 **「读取所有资源（179 项权限）」** 看着最省事，但那是全账户只读，**建不了库也部署不了**，而且权限面过大，不要选。

---

## 二、验证令牌（本机 Cloudflare API 可直连，失败再挂代理）

```powershell
$env:CLOUDFLARE_API_TOKEN = '<粘贴令牌>'
curl.exe -sS -m 20 `
  -H "Authorization: Bearer $env:CLOUDFLARE_API_TOKEN" `
  https://api.cloudflare.com/client/v4/user/tokens/verify
```

期望返回：

```json
{"result":{"id":"...","status":"active"},"success":true,"errors":[],"messages":[...]}
```

若报 `schannel: failed to receive handshake` 或超时，加代理重试（同一端点，测过可用）：

```powershell
curl.exe -sS -m 20 --proxy http://127.0.0.1:7897 `
  -H "Authorization: Bearer $env:CLOUDFLARE_API_TOKEN" `
  https://api.cloudflare.com/client/v4/user/tokens/verify
```

顺手取 Account ID（第 3 行权限存在时）：

```powershell
curl.exe -sS -m 20 -H "Authorization: Bearer $env:CLOUDFLARE_API_TOKEN" `
  https://api.cloudflare.com/client/v4/accounts
```

`result[0].id` 即 Account ID（32 位十六进制）。

---

## 三、把令牌交给自动化流程

| 方式 | 做法 | 适用 |
| --- | --- | --- |
| 会话内直接贴 | 把令牌发在对话里 | 最快；用完控制台 Roll/Delete 一键失效 |
| 环境变量 | `setx CLOUDFLARE_API_TOKEN "<令牌>"`，重开终端 | 长期使用 |
| 本地文件 | 项目根目录 `.dev.vars`（Wrangler 自动读） | 本地反复部署 |

**绝对不要**写进 `wrangler.toml`、`functions/` 源码、前端 JS——这些都会进 git。

---

## 四、不需要令牌的替代路径

```powershell
npx wrangler login
```

浏览器授权一次，凭据落在 `%USERPROFILE%\.wrangler\config\default.toml`，之后所有 wrangler 命令免令牌。代价：只能交互式做，脚本/子进程无法静默复用；换机器要重来。

---

## 五、用完如何收紧 / 撤销

- **滚动 / Roll**：该令牌右侧 `...` → Roll，生成新值、旧值立即失效（权限不变）。
- **删除**：直接删，所有使用该令牌的自动化立即 401。
- **降权**：建库和首次部署跑完后，可换成只读的 `D1 读取` + `Cloudflare Pages 读取`，日常排查看日志够用。

---

## 六、排错对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `success:false` + `code 1000` | 令牌无效/已撤销 | 重新生成 |
| `Authentication error` 但令牌正确 | 少了对应资源的权限 | 补 `D1 编辑` / `Cloudflare Pages 编辑` |
| `code 9109` / `Unauthorized to access requested resource` | 令牌是区域级或账户选错 | 三行都改成账户级，账户资源 Include 本账户 |
| `Unable to connect` / 超时 / schannel 握手失败 | 网络抖动 | 命令加 `--proxy http://127.0.0.1:7897` 重试 |
| wrangler 报 `not authorized for account` | 令牌绑定账户与实际账户不一致 | 检查账户资源 Include |
| `exceeded D1's free tier daily row` | 日写入超 10 万行 | 真源换仓库 JSON（方案 C），或升 Workers 付费版 |
