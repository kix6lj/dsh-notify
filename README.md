# dsh-notify

在一个 DSH Web 页面里同时处理多个会话时，把「有会话在等你」和「有会话跑完一轮」这件事显式地画在页面顶部。

纯 Client 插件：Host 半边为空，不写 session 日志，不新增 Remote 端点。状态全部取自 Harness 已维护的客户端数据；唯一额外的订阅是 `api-session/status`，用来覆盖「当前正在看的那个会话跑完了」这一类通知，因为未读投影刻意不报告它。

## 通知规则

| 类型 | 触发条件 | 行为 |
|---|---|---|
| 等待你操作 | 会话的 `pendingInteraction.kind` ∈ `question` / `plan-review` / `approval` | 常驻，直到你回答或手动关闭 |
| 处理完毕 | 会话的 `completionUnread === true`（Harness 的语义：该会话在你没看它时从 running 变为空闲） | 默认 6 秒后自动消失，悬停暂停；**页面没有被你注视时不消失** |

- 同一会话只出一条通知，等待操作优先于处理完毕。
- 跳过空白会话、`origin: subagent` 的子会话、以及不在 Host 会话列表里的会话。
- 页面首次加载不会把历史会话当成未读，因此不会刷屏。

## 交互

- **点击卡片**：切到对应会话（`ctx.uiWorkspace.openSession`），并移除该通知。
- **右侧 ×**：只关闭通知，不跳转。
- **还有 N 条 / 收起**：超出 3 条时折叠，可展开为可滚动列表。
- **全部关闭**：一次清空当前所有通知。
- 键盘可达：打开/关闭都是真实按钮，Enter/Space 打开，聚焦时 Esc 关闭。

## 系统通知（浏览器级）

除页面内的卡片外，还会通过浏览器的 Notification API 推送**系统级通知**，即使浏览器窗口被最小化、切到别的应用或别的标签页也能看到。

| 项目 | 行为 |
|---|---|
| 开启方式 | 权限尚未决定时，每次页面加载会在顶部浮现 **开启系统通知** 胶囊（30 秒后自动收起，一旦允许或拒绝就永久不再出现）；有通知时卡片下方也会出现同一个胶囊。点击 → 浏览器询问一次权限 → 授权后立刻弹一条测试通知 |
| 触发时机 | 只在页面**没有被你注视**时推送（标签页不可见，或浏览器窗口失焦）；正在看页面时只用页内卡片，避免打扰 |
| 等待你操作 | `requireInteraction`，系统通知会一直停留到你点掉 |
| 处理完毕 | 由系统决定自动消失；同一会话用同一个 tag，新通知覆盖旧的 |
| 点击系统通知 | 聚焦浏览器窗口并切到对应会话 |
| 关闭 | 点胶囊「系统通知已开启」即可关闭，偏好存 `localStorage['dsh-notify.system']` |
| 额外覆盖 | 你正在看的那个会话跑完时也会推送（此处 `completionUnread` 不生效，插件自行跟踪 `api-session/status`） |

## 浏览器内的信号

桌面浏览器里 Web Notification 只有一条投递路径：浏览器把它交给操作系统显示，**不会再在浏览器窗口内渲染第二份**。所以「系统通知已经出现、浏览器里没有」是平台行为，不是遗漏。

浏览器侧提供的是**持续可见的提示**，而不是第二个弹窗：

| 信号 | 行为 |
|---|---|
| 页内卡片 | 页面没有被你注视时**不自动消失**；切回来时它还在，由你决定关闭或跳转 |
| 标签页标题 | 有通知时变为 `(N) 会话标题 — DSH`，停在别的标签页也能在标签条上看到 |
| 标签页图标 | 叠加红色计数角标（超过 9 显示 `9+`） |

通知清空后，标题前缀与图标角标自动还原。标题归 shell 所有，插件每秒校验一次、被改写就补回，不与 shell 抢所有权。

**前提与边界**

- 需要安全上下文：`https://` 或 `localhost` / `127.0.0.1`。通过局域网 IP 的 `http://` 访问时浏览器不提供该 API，胶囊不会出现。
- 需要浏览器进程仍在运行。**标签页关闭或浏览器完全退出后收不到任何通知。**
- 系统「专注模式 / 勿扰」、浏览器站点设置里的通知开关都会拦截，插件无法绕过。
- 若权限被拒绝，只能到浏览器的站点设置里重新允许，胶囊会显示为「系统通知已被浏览器阻止」。


## 可调参数

全部位于 `client.js` 顶部（Client 模块无法读取 Host 行的 Config）：

| 常量 | 默认值 | 含义 |
|---|---|---|
| `MAX_VISIBLE` | `3` | 折叠前显示的条数 |
| `DONE_AUTO_DISMISS_MS` | `6000` | 「处理完毕」自动消失时长 |
| `CLOCK_TICK_MS` | `30000` | 相对时间刷新间隔 |
| `PREF_KEY` | `dsh-notify.system` | 系统通知偏好的 localStorage 键 |
| `OS_REQUIRE_INTERACTION` | `true` | 等待操作的系统通知是否常驻 |

## 已知限制

1. 关闭「处理完毕」通知不会清除侧栏已有的未读标记 —— Harness 没有公开 API 清除 `completionUnread`，只有打开该会话才会清。两者相互独立。
2. 页内卡片不为「当前正在查看的会话」显示完成提示（这正是 `completionUnread` 的语义）；但**系统通知**会，因为插件另行跟踪了 `api-session/status`。
3. 刷新页面后，后台会话里尚未回答的问题可能不再重新弹出（待操作卡片来自实时转发的请求，刷新后需打开该会话才重建）；侧栏仍会显示该会话有等待项。
4. 系统通知依赖页面存活：标签页关闭或浏览器退出后不再推送。跨标签页不共享状态（每个标签页各自判断、各自维护去重）。

## 安装

本仓库就是一个 DSH bundle 包。克隆到本地任意目录，再用 `plugin_manager` 以该目录为 target 安装：

```bash
git clone git@github.com:kix6lj/dsh-notify.git ~/dsh-notify
```

然后在 DSH 会话里：

```
plugin_manager
  action: install_bundle
  target: /absolute/path/to/your/clone
```

安装完成后 bundle 立即激活；客户端代码在页面刷新（或 HMR）后生效。

卸载：

```
plugin_manager
  action: remove_bundle
  target: @local/dsh-notify
```

环境要求：DSH 的 Web 界面（`dsh web`），并且通过 `https://`、`localhost` 或 `127.0.0.1` 访问——系统通知需要安全上下文。

## 隐私

本包不采集、不上报任何数据。系统通知偏好只写在浏览器 `localStorage` 的 `dsh-notify.system` 键里，不写入 DSH 配置或 session 日志。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单 + `dsh.client`（`platform: web`、`immediately: true`） |
| `cordis.patch.yml` | 插入一行 `id: dsh-notify` |
| `index.js` | Host 半边，空实现 |
| `client.js` | 全部功能：词典、状态派生、通知卡片、slot 注册 |
| `locale/*.json` | Plugin Manager 卡片上的展示文案 |
| `icon.svg` | 卡片图标 |
