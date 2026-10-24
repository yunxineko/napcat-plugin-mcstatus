# napcat-plugin-mcstatus

QQ 机器人收到**关键词**后，向 [mcstatus-api](../main/README.md) 请求 Minecraft 服务器状态图，并把图片发送到当前群 / 私聊。**每个关键词都可以自定义自己的请求参数**。

支持两种运行方式，共用同一份 `rules.json` 与同一套处理逻辑：

| 方式 | 适用 | 说明 |
| --- | --- | --- |
| **A. NapCat 插件** | 仅 NapCat **v4.18.5 及更早** | 把本目录放进 NapCat 的 `plugins/` 由插件系统加载。⚠️ **v4.18.11 起 NapCat 加了官方插件白名单，第三方插件会被直接拒绝、在 WebUI 里完全看不到**（详见文末 FAQ） |
| **B. OneBot 11 客户端**（推荐） | 任何 NapCat 版本 | `node client.mjs` 作为独立进程连接到 NapCat 的 OneBot WebSocket 服务器，不走插件系统，不受白名单影响 |

## 特性

- **关键词驱动**：触发词、别名、匹配方式（精确 / 包含 / 正则）全写在插件目录的 `rules.json` 里
- **每个关键词独立参数**：`host`、`port`、`queryPort`、`name`、`theme`、`style`、`layout`、`scale`、`refresh`……直接透传 mcstatus-api 的查询参数
- **地址可自定义**：全局默认 `http://127.0.0.1:3002`（WebUI 里随时改）；单条规则还能用 `apiBaseUrl` 字段单独指向其它 API 地址
- **热加载**：改完 `rules.json` 保存立即生效，不用重启 NapCat
- **两种发送方式**：`base64` 直传（插件先请求，连不上会回复失败原因）/ `url` 直链（把图片地址交给 NapCat 拉取）
- 冷却时间、私聊开关、群白名单、调试日志均可在 WebUI 配置
- 零第三方依赖，只用 Node 内置模块

## 目录结构

```
napcat-plugin/
├── package.json        # 插件元数据（NapCat 插件模式用）
├── index.mjs           # 插件模式入口（生命周期、WebUI 配置面板）
├── client.mjs          # ★ 客户端模式入口（OneBot 11，新版 NapCat 推荐）
├── client.config.json  # 客户端模式配置（连接地址、API 地址等；本地实际配置，不进仓库）
├── client.config.example.json  # 上面那份的模板
├── rules.json          # ★ 关键词规则（两种模式共用，主要编辑这个文件；不进仓库）
├── rules.example.json  # 规则模板，带注释的 4 种写法示例
├── lib/
│   ├── engine.mjs      # 两种模式共用的处理逻辑（匹配 → 请求 → 发送）
│   ├── config.mjs      # 配置默认值 / 清洗 / 持久化 / Schema
│   ├── rules.mjs       # 规则解析（支持注释）、热加载、关键词匹配
│   └── api.mjs         # 拼接请求地址、下载 PNG
├── test/               # 单元 / 集成测试（node --test，不需要 NapCat）
└── README.md
```

## 首次使用

```bash
cp rules.example.json rules.json              # 规则（关键词 + 请求参数）
cp client.config.example.json client.config.json  # 只有方式 B 需要，填上 NapCat 的 token
```

`rules.json` 与 `client.config.json` 都在 `.gitignore` 里——里面是真实服务器地址和 NapCat 令牌，不会被提交。

## 方式 A：NapCat 插件（仅 v4.18.5 及更早）

> ⚠️ **v4.18.11 起 NapCat 只允许官方白名单插件加载**，第三方插件会被静默拒绝，
> 放进去也**不会出现在 WebUI 插件页**，日志里会有：
> `[PluginLoader] Rejected napcat-plugin-mcstatus (...): not in official plugin whitelist`。
> 新版 NapCat 请直接用下面的「方式 B」。

1. 把整个目录（建议重命名为 `napcat-plugin-mcstatus`）复制到 NapCat 的插件目录：
   `<NapCat 工作目录>/plugins/`（`package.json` 与 `index.mjs` 必须在插件文件夹根部，别多套一层）
   - 工作目录 = 启动参数目录 / `NAPCAT_WORKDIR` / NapCat 安装目录；macOS 默认 `~/Library/Application Support/QQ/NapCat`
2. 打开 NapCat WebUI → 插件页，刷新 / 重载插件（或重启 NapCat）
3. 打开本插件配置，确认「mcstatus-api 地址」（默认 `http://127.0.0.1:3002`，可自定义）
4. 编辑 `rules.json`，把示例里的 `play.example.com` 换成你的服务器地址

## 方式 B：OneBot 11 客户端（推荐，任何 NapCat 版本可用）

NapCat 的 OneBot 服务器不受插件白名单影响，让它当一个普通的 OneBot 客户端即可：

```
NapCat（OneBot WebSocket 服务器）  ⇄  client.mjs  →  mcstatus-api
```

**第 1 步：在 NapCat 里开一个 WebSocket 服务器**

WebUI → 网络配置 → 新建 → **WebSocket 服务器**：

| 配置 | 建议值 |
| --- | --- |
| host | `127.0.0.1`（与本程序同机）或 `0.0.0.0` |
| port | `3000`（未被占用即可） |
| token / 令牌 | 可留空；填了就要和 `client.config.json` 的 `accessToken` 一致 |
| messagePostFormat | `array`（推荐） |

保存并启用。

**第 2 步：配置并运行本程序**（要求 Node ≥ 21，建议 22+）

```bash
cd napcat-plugin
# 编辑 client.config.json：websocketUrl 填上面 NapCat 里的 host:port，
# 有令牌就填 accessToken；apiBaseUrl 默认 http://127.0.0.1:3002
node client.mjs
```

启动日志出现「已连接，等待消息」后，在群里发送关键词（示例规则里是 `查服`）即可。

**后台常驻**：systemd（`ExecStart=/usr/bin/node /opt/napcat-plugin/client.mjs`）或 `pm2 start client.mjs --name mcstatus-client`。

> 两种模式可以同时存在、也可以只用一种；`rules.json` 的修改对两者都即时生效。

## 使用

聊天里发送关键词（示例规则里是 `查服`、`mc状态`、`全部服务器`），机器人回复一张状态图。

## rules.json 说明

规则文件是 JSONC 风格：支持 `//` 注释和尾随逗号，方便在文件里写说明。**保存后自动热加载**。

### 字段

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `keyword` | ✅ | — | 触发关键词，字符串或数组（数组 = 别名） |
| `endpoint` | ❌ | `banner` | `banner` = 单服状态图；`overview` = 多服一览图（仅当 API 地址是**基础地址**时自动拼接；地址已带路径则忽略此项） |
| `match` | ❌ | `exact` | `exact` 完全相同；`contains` 包含即可；`regex` 正则 |
| `params` | ❌ | `{}` | 请求参数，两种写法：对象 `{ "host": "..." }` 或查询串 `"?host=play.example.com&theme=midnight&layout=stack"` |
| `apiBaseUrl` | ❌ | 全局默认 | 这条规则单独使用的 API 地址（基础地址或完整接口地址都行） |
| `beforeText` | ❌ | — | 发图前先发一段文字 |
| `cooldownSeconds` | ❌ | 全局配置 | 这条规则单独的冷却秒数，0 = 不限 |
| `enabled` | ❌ | `true` | 临时停用这条规则 |
| `note` | ❌ | — | 备注，随便写 |

### params 可用参数（与 mcstatus-api 一致）

- 单服 `banner`：`host`✅、`port`（默认 25565）、`queryPort`（默认等于 port）、`timeout`（默认 3000，范围 500–10000）、`refresh: 1`（跳过 30 秒缓存）、`name`（图上的显示名）、`scale`（1/2/3，默认 2）、`theme`、`style`、`layout`
- 多服 `overview`：`servers`✅（`显示名@地址:端口:查询端口` 逗号分隔，最多 8 台；不写则用 API 端配的 `OVERVIEW_SERVERS`）、`timeout`、`refresh`、`scale`

> **API 地址的两种写法**（全局 `apiBaseUrl` 或规则里的 `apiBaseUrl` 都适用）：
> 1. **基础地址**（如 `http://127.0.0.1:3002`）：按 `endpoint` 自动补成 `/api/banner.png` / `/api/overview.png`，参数拼在最后 ——
>    `http://127.0.0.1:3002/api/banner.png?host=play.example.com&theme=midnight&layout=stack`
> 2. **完整接口地址**（如 `http://127.0.0.1:3002/api/banner.png`，或直接从 API 文档复制带参数的一整串）：**不再追加端点**，
>    参数直接以 `?host=...` 跟在后面；地址里已有 `?` 时用 `&` 追加。
>
> 查询串形式的 `params` 会**原样拼接**（不做转义），中文等非 ASCII 字符由 Node 在发请求时自动编码。

可选主题：`default` `midnight` `ocean` `forest` `sunset` `frost` `mono`；
视觉风格：`material` `swiss` `cosmic` `organic` `editorial`；
版式：`stack` `compact` `split`。

### 示例

```jsonc
// 单服 + 别名 + 自定义显示名 + 主题
{
  "keyword": ["查服", "mc状态"],
  "endpoint": "banner",
  "params": {
    "host": "play.example.com",
    "port": 25565,
    "queryPort": 25566,
    "name": "主服",
    "theme": "midnight",
    "scale": 2
  }
}

// 多服一览（最多 8 台）
{
  "keyword": "全部服务器",
  "endpoint": "overview",
  "params": { "servers": "主服@play.example.com:25565:25566,生存服@play.example.com:25575:25577" }
}

// 包含匹配 + 强制刷新（跳过 API 的 30 秒缓存）
{
  "keyword": "刷新主服",
  "match": "contains",
  "params": { "host": "play.example.com", "refresh": 1 }
}

// 正则匹配 + 这条规则单独用另一个 API 地址
{
  "keyword": "^状态\\s+(.+)$",
  "match": "regex",
  "apiBaseUrl": "http://10.0.0.2:3001",
  "params": { "host": "play.example.com" }
}

// 直接写「完整接口地址 + 查询串」（与对象写法等效，把 API 文档里的地址复制过来即可）
{
  "keyword": "查主服",
  "apiBaseUrl": "http://127.0.0.1:3002/api/banner.png",
  "params": "?host=play.example.com&theme=midnight&layout=stack"
}
```

## WebUI 配置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| 启用插件 | 开 | 关闭后不响应任何关键词 |
| mcstatus-api 地址（全局默认） | `http://127.0.0.1:3002` | 可自定义：基础地址或完整接口地址均可；单条规则可覆盖 |
| 图片发送方式 | `base64` | `base64` 直传（失败回复原因）/ `url` 直链 |
| 请求超时（毫秒） | `15000` | 等待 API 返回图片的最长时间（1000–120000） |
| 冷却时间（秒） | `5` | 同一会话、同一关键词的触发间隔；0 = 不限 |
| 响应私聊 | 开 | 关闭后只在群里响应 |
| 群白名单 | 空 | 逗号 / 空格分隔群号；留空 = 所有群都响应 |
| 调试日志 | 关 | 在 NapCat 日志中输出匹配与请求详情 |

## 自测

```bash
cd napcat-plugin
node --test test/logic.test.mjs test/engine.test.mjs   # 或 npm test
node test/smoke.mjs
```

不依赖 NapCat：单测覆盖规则解析 / 匹配 / URL 拼接 / 配置清洗；引擎测试用本地假 API 验证「关键词 → 请求 → 发送」整条链路。

## 常见问题

| 现象 | 排查方向 |
| --- | --- |
| **WebUI 插件页看不到本插件** | 新版 NapCat（v4.18.11 起，含最新版）的插件加载器有硬编码白名单，只放行 4 个官方插件；其它插件在扫描阶段被直接拒绝（源码注释原文：被拒绝的插件视为不可见，不入列表、不加载、不导入）。日志特征：`[PluginLoader] Rejected ...: not in official plugin whitelist`。**解决：改用「方式 B：OneBot 11 客户端」**；或把 NapCat 降到 v4.18.5 及更早（不推荐：缺安全加固与新版 QQ 适配） |
| 客户端模式连不上 | ① 确认 NapCat 里已启用「WebSocket 服务器」网络配置 ② `client.config.json` 的 `websocketUrl` 与 NapCat 里的 host:port 一致 ③ 令牌两边一致 ④ 看启动日志的重连提示 |
| 发关键词没反应 | ① 程序没在运行 / 插件没加载成功（看对应日志）② `rules.json` 不存在或有语法错误（日志会提示）③ 关键词不匹配（`exact` 需完全一致，或改用 `contains`）④ 群不在白名单 / 私聊被关 ⑤ 还在冷却中 |
| 回复的是「离线」图 | API 通了但服务器查不到：确认 `params.host` 已改成你的地址、游戏端口 / 防火墙正确；Query 没开只会显示 SLP 采样玩家，属正常 |
| 回复「无法连接 mcstatus-api」 | 插件所在机器访问不了配置的地址：检查地址、端口、服务是否启动 |
| 回复「请求超时」 | 调大「请求超时」，或检查网络 / API 负载 |
| URL 模式收不到图 | `url` 模式下由 NapCat 拉取图片，NapCat 所在机器必须能访问该地址；不确定就用默认 `base64` |
| 每个关键词想用不同 API | 给该规则写 `"apiBaseUrl": "http://其它地址:端口"` |

## License

MIT
