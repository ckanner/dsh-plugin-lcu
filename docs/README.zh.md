# dsh-plugin-lcu

[English](../README.md) | 中文

用 **ChatGPT 桌面应用内置的 computer-use 运行时**，从 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 驱动桌面和 Chrome。

本插件**直接启动那个运行时**并通过 MCP 与它通信。整个集成都在这里：定位并校验应用、构造运行时需要的环境、批准桥、回合生命周期、以及负责逐轮清理的 macOS 服务 wrapper。**不需要额外安装任何东西** —— 不需要别的包装项目、不需要第二个解释器、不需要 Python。

**不涉及 Codex 或 ChatGPT 的登录。** 运行时来自你本机的安装，插件从不下载、改写或认证它。

## 目录

- [能力](#能力)
- [前置条件](#前置条件)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [批准与安全模型](#批准与安全模型)
- [实现说明](#实现说明)
- [排障](#排障)
- [与 LCU 的关系](#与-lcu-的关系)
- [配套工具](#配套工具)
- [已知限制与未做的工作](#已知限制与未做的工作)
- [开发](#开发)
- [许可](#许可)

## 能力

| 工具 | 作用 |
|---|---|
| `js` | 对 `cua` 桌面/浏览器 API 运行一段 JavaScript。第一次调用会返回 API 文档；选中应用或标签页会返回初始 UI 状态。 |
| `js_reset` | 丢弃持久的 JavaScript 会话，重新起一个运行时。 |

另外两个**只给宿主、永不暴露给模型**的工具：`turn_ended`（逐轮清理）和 `js_add_node_module_dir`。

插件自己只加了一个工具：

| 工具 | 作用 |
|---|---|
| `computer_use_stop` | 不带参数时列出运行时当前为本次会话持有的应用；带 `app`（其中一个 bundle id）时释放它。它清除宿主应用对**某一个**应用的"正在使用你的电脑"状态，而不结束会话。 |

截图通过 DSH 的附件存储以持久图片返回，所以声明了图像输入的模型路由**真的能看见屏幕**。

## 前置条件

| | |
|---|---|
| 系统 | **Apple Silicon 上的 macOS。** 启动器解析 macOS 应用包，生命周期 wrapper 是 macOS 服务；其他平台这两块都要重做。 |
| ChatGPT 桌面应用 | 装在 `/Applications/ChatGPT.app`（或用 `app` 指定）。它提供运行时、指令和签名助手。 |
| DSH | 一个你能装 bundle 的 profile。 |

**没有** Python 要求，**没有**需要单独安装的运行时。插件启动的是应用自己的 `node` 和它自己的入口。

## 安装

### 1. 把插件装进 profile

装完这一行配置就在该 profile 里生效。**加载时不启动任何东西。**

```sh
dsh plugin --profile <profile> add dsh-plugin-lcu
```

桌面版 App 的托管 profile 用 CLI 会被拒；请用 App 内的插件管理器（设置 ▸ 插件），它跑的是同一个 pnpm 操作。

### 2. 生成 preset

DSH 的 agent preset **没有继承**：一个 preset 的 `config.plugins` 就是它完整的插件列表，而 patch 是**整体替换**一个条目而不是合并进去。所以自定义 preset 必须重述它的基底。与其手抄那份列表，不如从**实际装着的** preset 生成：

```sh
node node_modules/dsh-plugin-lcu/scripts/gen-presets.mjs --profile ~/.dsh/profiles/<profile>
```

它会在该 profile 的 `cordis.patch.yml` 里写一个带标记的块，含两个 preset：

| preset | 基底 | 增加 |
|---|---|---|
| `daily` | 自带的 `ptc` preset | 启用 `subagent_codex` |
| `heavy` | 同上，且 `tool-presentation: both` | 以上全部，且本插件接入 |

DSH 升级后重跑一次，让副本跟上。`--with-heavy` 是隐含的；`--dry-run` 只打印不写；`--out FILE` 写到别处。

> `heavy` 特意把工具呈现设为 `both`。纯 `ptc` 呈现下模型只看得到 `run_code`，`js` 就得嵌成另一个 JavaScript 程序里的字符串。`both` 让 `js` 可以被直接调用。

### 3. 配置哪些模式能用

插件是一个根行，带 `presets` 白名单。编辑已安装的 `cordis.patch.yml`（或 profile patch），让它匹配你生成的 preset id：

```yaml
- id: lcu
  name: 'dsh-plugin-lcu'
  config:
    presets:
      - heavy
```

### 4. 重启，然后做一次调用

重启 harness —— 插件**代码和配置都不热更新**。然后在 `heavy` 模式（显示为**重活**）里起一个任务，让它做点无害的事：

> 用 `js` 工具运行 `await cua.getState();`，告诉我哪些应用在跑。

第一次触碰某个应用时，运行时会请求批准。见下文。

首次 attach 时插件会解析应用，并把结果写进诊断日志：

```
app: /Applications/ChatGPT.app version=26.1002.52244 runtime=0.0.29/20261003001300-807782c586fc
attach: launching /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node [...]
```

如果应用缺失，或者它某个文件**别的账号可以改写**，attach 会被拒绝并写明原因，会话就只是没有这个能力而已。

### 可选：启用 Chrome

```yaml
config:
  chrome: true
```

这会打开运行时的浏览器面。浏览器那一半是 OpenAI 的，驱动页面靠**官方 ChatGPT Chrome 扩展**，它连的是一个 native messaging host。在装了 ChatGPT 桌面应用的机器上，那个 host 已经注册好了，所以**不需要再做别的**：在你想驱动的浏览器 profile 里启用该扩展，并确认它出现在 `cua.getState()` 里。

站点仍然是逐个精确 origin 批准。

### 可选：预授权站点

运行时想用的每个站点都会问一次。要跳过你信任的 origin 的提示，就列出**精确 origin** —— 消息必须经 `new URL(...).origin` 往返后不变：

```yaml
config:
  allowedOrigins:
    - http://localhost:3000
```

诊断日志会记下每一个被问到的 origin，这是发现它们最方便的办法。

## 使用

起任务时选一个已启用的模式。工具是**按 Agent 挂载**的：其他模式下的会话永远看不到它们，也永远不会起运行时。

典型的请求：

```
截一张 Finder 窗口的图，告诉我分辨率。
列出我当前的 Chrome 标签页。
打开 Safari，去 example.com，把页面标题读回来。
```

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `app` | `/Applications/ChatGPT.app` | 提供 computer use 的应用。 |
| `command` | 未设 | 用一个显式可执行文件替换计算出的启动方式，用于内置解析够不到的应用。它会跳过运行时自己的环境设置。 |
| `chrome` | `false` | 打开浏览器面。 |
| `audio` | `false` | 打开运行时的 computer-audio API。 |
| `presets` | `["heavy"]` | 允许使用这些工具的 Agent preset id。 |
| `allowedOrigins` | `[]` | 免问的精确 HTTP(S) origin。非法条目会被丢弃，绝不放宽。 |
| `allowedApps` | `[]` | 免批准的 bundle identifier。**承载 agent 的应用即使被列进去也会被拒**。 |
| `sectionOrder` | `0` | 注入的运行时指令在 prompt 中的排序。 |

## 批准与安全模型

**模型不能批准任何东西。每个决定都是人的。**

- **按应用批准。** 运行时在用某个应用前会问。插件把它的选项 —— *仅此次*、*本次会话*、*始终允许*（运行时提供哪些就渲染哪些）、以及 *拒绝* —— 通过 DSH 的提问界面呈现。回答被精确映射回运行时提供的那个 scope；**运行时没提供的 scope 授不出去**。
- **站点批准。** 浏览器访问按精确 origin 询问。`allowedOrigins` 只匹配精确 origin；多一个斜杠、带路径、大小写不同都算不同 origin，会被问而不是被授予。
- **承载 agent 的宿主永不可批准。** Computer use 能点击已批准应用显示的任何东西，**包括批准弹窗本身**。守卫在问任何问题**之前**就拒绝承载 agent 的应用 —— 通过进程祖先和一份 agent 宿主/终端名单。
- **Fail closed。** 没有提问界面、被忽略的提示、无法识别的请求形状、被中止的调用 —— 全都以 *cancel* 结束，而运行时把它当作拒绝。

插件自己不存任何权限缓存；"始终允许"由运行时按应用记住。

### 无人值守

每个批准都属于人，而**没人回答就是拒绝** —— 运行时不默认授予。所以无人值守的运行必须两半都提前定好：

```yaml
config:
  allowedApps:
    - com.google.Chrome        # 免问使用这个应用
  allowedOrigins:
    - https://example.com      # 免问访问这个精确 origin
```

- `allowedApps` 按 bundle identifier 匹配，忽略大小写。**承载 agent 的应用在查列表之前就被拒**，所以没有任何条目能授权它。
- `allowedOrigins` 只匹配精确 origin；带路径、多斜杠或大小写不同都算不同 origin，仍然会问。
- 没列进去的都会被问，而没人在场时就是拒绝。

诊断日志会记下每一个被问到的应用和 origin（`approval: site https://example.com asking (add it to allowedOrigins to skip this)`），这是发现一次运行需要哪些确切值的方法。

## 实现说明

```
src/app.ts          定位并校验应用；构造运行时环境；规划启动
src/connection.ts   MCP 客户端：握手、工具发现、调用、elicitation、生命周期
src/approval.ts     批准形状识别与 label→value 映射
src/host-guard.ts   防自我批准的守卫
src/tool.ts         工具定义、文本投影、持久截图
src/index.ts        插件：按 Agent 挂载、指令、turn_ended、批准
src/control.ts      relay：把运行时的控制 API 在插件与 wrapper 之间搬运
src/session.ts      连接门面，跟随应用更新
src/diag.ts         attach/批准 诊断日志
helper/sky-service.mjs  运行时的 Sky 服务：turn-ended 钩子 + 控制通道
```

**运行时是被直接启动的。** `src/app.ts` 找到 `ChatGPT.app`，确认它需要的部件都在、且**别的账号改不了**，然后算出运行时需要的环境 —— 它自己的 `node` 和 `node_repl`、模块根、trusted code paths、API 面、以及 macOS native pipe 用的签名助手。它**不**把 `NODE_REPL_TRUSTED_SERVICES` 设成应用默认值：原因见下。

**turn-ended 钩子是运行时唯一缺的东西。** 一个永不结束的回合，就是一个**永不释放**的按应用 Stop，之后应用会拒绝每一个后续回合。运行时向它的 trusted services 暴露 `addTurnEndedHandler`，但自己**没有装任何 handler**，所以 `helper/sky-service.mjs` 是**作为** `sky` trusted service 被加载的：它把每个请求原样转发给应用自己的服务，并加上那个钩子 —— 钩子通过**应用自己的签名客户端**请应用清理已结束的回合。

这**刻意少于**那个显而易见的实现。让一个监督者进程去做、再让它 spawn 签名客户端并传 `turn-ended` 参数，需要 **Apple Events** —— 而当负责进程是一个 hardened-runtime 的 harness 时，macOS **既拒绝授予、也拒绝弹窗询问**。那一步**必然超时**。应用自己的 IPC 才是执行清理的那一步，不需要 Apple Events，**几十毫秒就完成**。所以这里没有监督者进程，也没有 lifetime socket。

**控制通道是一个 relay，而且由插件自己 serve。** 提前释放某个应用需要用运行时的控制 API，而它活在运行时的进程里。wrapper 连上插件 serve 的 socket，自称 *service*，上报它见过的回合 context，并在那里回答 `status` 与 `stop`。**relay 不做任何判断**：某个会话和回合是否真实、某个应用是否真被持有，只有 wrapper 能回答 —— 因为只有它手里有运行时用来标记这些状态的回合元数据。

这条通道有两个细节猜不出来。wrapper 运行在运行时的 JavaScript 沙箱里，而沙箱**拒绝普通 socket 连接（`EPERM`）** —— 无论 socket 在每用户临时目录还是 `/private/tmp` —— 所以它走运行时自己的 `nativePipe` API。而且那条管道**会静默丢弃字符串写入**，消息必须以 Buffer 写出；这一点极易被误判成"对端从未应答"。

**没有 MCP SDK 依赖。** harness 自带的 MCP 桥声明 `capabilities: {}`，因此**无法回答 elicitation** —— 而那正是运行时请求批准的方式；把第二个 SDK 拉进 profile 插件又会钉住一个宿主并不拥有的版本。MCP over stdio 就是按行分隔的 JSON-RPC，所以这里自己拥有这条线。加上对 DSH 包只用类型导入，本插件**没有任何运行时依赖**。

**工具是按 Agent 注册的，不是在挂载时。** 工具 schema 归服务器所有，所以只能握手之后取。一个 Agent 的连接在它被创建时、或它确定了 preset 选择时打开，插件贡献的一切都注册进**该 Agent 自己的 context**，所以销毁时一起回退。

**两种 preset 时序都处理了。** 新任务先用部署默认值创建，picker 的选择之后再应用，所以只看 `agent/created` 会看到错误的组合；注册表会重新发出 `agent-preset/selected`，插件也响应它。

**构造上就是懒的。** 加载时不启动任何东西。没有启用的会话，就没有运行时进程。

**指令是注入的。** 服务器的 `initialize.instructions` 变成 Agent 上的一个 prompt 段。它刻意很短 —— API 手册在 `js` 工具描述和第一次工具结果里。

## 排障

插件关于 attach、启动和批准的每个决定都会追加到：

```
~/.dsh/lcu-diag.log
```

超过 1 MB 就重头开始。`LCU_DIAG=0` 关闭它。**这是第一个该看的地方**：harness 没有运行中的会话能读的插件日志界面，而一个抛错的 `agent/created` 监听器否则会被静默吞掉。

| 现象 | 原因与处理 |
|---|---|
| 已启用的模式里工具从不出现 | 看日志里的 `decide … composed=`。如果组合出的 preset 不在 `presets` 里，修白名单。如果没有 `agent-preset/selected` 行，说明模式从未被确定。 |
| 加载时报 `computer use is unavailable (…)`，或没有工具 | 应用解析失败。日志里有原因和路径；检查 `app`。 |
| `no userQuestions service -> cancel (fail closed)` | 这个 profile 里没挂载提问界面。 |
| `refusing to approve the app hosting this agent` | 按设计工作；换一个应用。 |
| ChatGPT 应用仍显示某应用正被 computer use 占用 | 让模型调 `computer_use_stop`，或关掉会话 —— 连接拥有运行时进程树，退出时会释放。 |
| `chrome: true` 但 Chrome 标签页一直不出现 | 那个浏览器 profile 里没启用官方扩展。打开 `chrome://extensions` 启用它，并确认它出现在 `cua.getState()` 里。 |
| 某应用后续每个回合都报 "explicitly stopped by the user" | 宿主应用的回合清理没跑成。检查日志里的 `turn cleanup` 失败；退出并重启 ChatGPT 应用可清除该状态。 |

`node scripts/probe-lcu.mjs` 会在**完全不涉及 harness** 的情况下启动运行时，打印协议版本、服务器身份、指令长度和工具列表 —— 用来区分是插件问题还是运行时问题。

`helper/sky-service.mjs` 有三个诊断开关（默认全关），因为它运行的地方**显而易见的通道都不可用**：运行时的 JavaScript 沙箱拒绝文件写入，而且它会捕获 console 输出。`DSH_SKY_DEBUG=1` 追踪钩子，`DSH_SKY_REPORT=1` 让下一次调用带着上一次清理的结果失败，`DSH_SKY_FORCE_ERROR=1` 用来证明模块确实被加载了。

## 与 LCU 的关系

[LCU](https://github.com/amontlabs/lcu)（MIT，Amont Labs）是证明这条路可行的项目：*Codex computer use, decoupled from the app*。它定位同一个运行时并把它作为 MCP 暴露出来。

**本插件自己做了这件事，不再安装或调用 LCU。** 有意义的差别：

- **不需要第二个解释器。** LCU 的启动器是 Python，要求 3.12+；这里是 TypeScript，唯一的要求就是应用本身。attach 因此快了大约一个数量级。
- **没有监督者进程，也不需要 Apple Events。** 回合清理走应用自己的 IPC，而不是一个去 shell 出签名客户端的监督者。
- **在失败那一刻给出诊断。** 应用在加载时就解析并报告，每个 attach、启动和批准决定都是日志里的一行。

## 配套工具

`scripts/` 还带了两个给姊妹 Codex 子代理 bundle 的工具，因为同一个 profile 通常两个都要：

- **`update-codex.mjs`** —— 把 profile 的 `@openai/codex` 保持在仍能通过三道闸（握手、协议 schema 断言、真实回合）的最新版本，失败时自动回滚。已发布的 `@deepseek-ai/dsh-subagent-codex` 钉在 `0.153.4`，它并不服务当前所有 ChatGPT 账号模型；这个脚本通过 profile 级、限定范围的 pnpm override 把它顶上去。`node scripts/update-codex.mjs --help` 里有 `--check`、`--verify-only`、`--to` 和 `--rollback`。
- **`codex-baseline.json`** —— 最后一次三道闸全过的版本。

## 已知限制与未做的工作

- **被委派的子代理无法被询问批准。** DSH 只接受来自活跃 runtime root 的人的回答，所以子代理的批准会 fail closed。子代理可以做不需要批准的只读工作；需要批准的事必须从顶层会话驱动。
- **按应用的 Stop 会被"请求它的那个回合"释放。** `computer_use_stop`（以及在宿主应用的"正在使用你的电脑"横幅上按 Esc）会请求运行时**在当前回合内**停用某一个应用。插件通过应用自己的 IPC 执行宿主应用的 turn-ended 清理，所以**下一个回合可以重新使用那个应用**；不带参数的 `computer_use_stop` 会报告当前持有哪些。如果某应用后续每个回合仍被拒绝，说明那次清理失败了，日志会写明。**常规使用 —— 截图、点击、输入、浏览器标签页 —— 不受影响**；插件的工具描述也这么写，所以模型不会自行去停用某个应用。
- **`js` 沙箱不能写文件。** 每一次写入都以 `EPERM` 失败，**包括临时目录**，所以截图无法从 `js` 里保存。图片改为以附件形式交给 harness，每张存下来的图都会在工具结果里带上它的宿主文件系统路径；把它复制进工作区是一行 `bash`（`install -m 644 '<path>' <target>` —— 存储对象的模式是 400）。插件在工具结果和注入的指令里都写了这两点。
- **macOS 权限属于 harness，不属于 OpenAI 助手。** macOS 把权限请求归给**负责进程**，而 harness 派生的一切都归给 harness 自己。所以屏幕录制和辅助功能必须给 **DeepSeek Harness** 打开；只给 ChatGPT 或 "Codex Computer Use" 是不够的，而且 macOS **不会自己弹窗**询问缺失的那些。
- **没有 Codex 账号时的浏览器面还没接。** 驱动页面靠桌面应用注册的 native messaging host。那台"没有 Codex 应用"的机器上需要的 relay（强制扩展的 agent-request header）还没有实现。
- **应用在会话运行期间更新，只做了警告。** 运行时是从应用更新时会替换的文件里执行的，所以长会话可能同时跑两代文件。应用更新后请重启 harness。
- **每个 Agent 一个连接。** 运行时的 JavaScript 会话是按连接隔离的，它的批准绑定到真实的会话和回合，所以让多个 Agent 共用一个连接会让两者交错。
- **未在 Linux / Windows 上验证。** 见[前置条件](#前置条件)。

## 开发

```sh
npm install
npm run typecheck     # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm run build         # 产出 lib/
npm test              # node --test，无需构建
```

连接与启动器测试会与**真实的**已安装计算机使用运行时通信，应用不存在时自动跳过，所以 `npm test` 在本地有意义、在 CI 上也能过。批准、投影、守卫和 wrapper 那几套是纯函数，始终会跑。

插件代码和配置**都不被 harness 热更新**：运行中的进程保留它加载的那个模块。改完要重新构建并重启。

## 许可

MIT。**没有内联任何东西**：原生那一半是应用自己的，本包没有运行时依赖。ChatGPT 应用及其指令仍按其自身条款，来自你本机的安装。
