# dsh-plugin-lcu

[English](../README.md) | 中文

把 [LCU](https://github.com/amontlabs/lcu)（*Codex computer use, decoupled from the app*）接进
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，让 Agent 能看屏幕、点鼠标、操作真实浏览器标签页。

LCU 把 **ChatGPT 桌面端内置的那套 computer-use 运行时**包装成 MCP server。本插件把它变成 DSH 的一等能力：
启用了模式的会话会拿到一个 `js` 工具。**全程不涉及 Codex 认证** —— 运行时来自你本地的 ChatGPT 安装，
LCU 从不解包、下载、认证或改写它。

## 目录

- [能力](#能力)
- [前置条件](#前置条件)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [批准与安全模型](#批准与安全模型)
- [实现说明](#实现说明)
- [排障](#排障)
- [随附工具](#随附工具)
- [已知限制](#已知限制)
- [开发](#开发)
- [许可](#许可)

## 能力

两个模型可见工具，**schema 完全由服务端提供**，本插件不自己发明：

| 工具 | 作用 |
|---|---|
| `js` | 针对 `cua` 桌面/浏览器 API 执行一段 JavaScript。首次调用会返回 API 文档；选中应用或标签页时结果里会带初始 UI 状态。 |
| `js_reset` | 丢弃持久化的 JavaScript 会话，重建运行时。 |

另有两个 host-only 工具只对宿主可见、**绝不暴露给模型**：`turn_ended`（每轮清理）与
`js_add_node_module_dir`。

插件自己**只加一个**工具：

| 工具 | 作用 |
|---|---|
| `computer_use_stop` | 不带参数时列出运行时当前为本次会话持有的应用；带 `app`（上面列出的 bundle identifier）时释放它。这就是 LCU 的显式按应用 Stop —— 它的 Pi adapter 把它暴露为 `/lcu stop` —— 能在**不结束会话**的前提下清掉宿主应用里"computer use 正在使用"的状态。 |

截图会作为**持久化图片**经 DSH 的 attachment store 送达 —— 所以声明了 image input 的模型路由是真的能"看见"屏幕的。

## 前置条件

| | |
|---|---|
| 操作系统 | Apple Silicon 上的 macOS。LCU 也支持 Linux，但本插件在 macOS 上开发与验证。 |
| ChatGPT 桌面端 | 已安装、OpenAI 签名的官方版本。运行时与 instructions 由它提供。 |
| Python | 3.12 或更新，位于 `PATH`，或 `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`。 |
| LCU | 需另行安装，见下。 |
| DSH | 一个你能装 bundle 的 profile。 |

插件面向 **macOS**：`host-guard` 依赖 `ps`/`plutil`，生命周期走 LCU 的 macOS 路径。移植 Linux 需要改这两处。

## 安装

### 1. 安装 LCU

下载对应平台的 release 归档，**校验 checksum**，然后运行它自带的安装器。**不要注册其他 harness** ——
本插件就是你的 harness。

```sh
TAG=v0.9.6
TARGET=darwin-arm64
curl -fLO "https://github.com/amontlabs/lcu/releases/download/$TAG/lcu-${TAG#v}-$TARGET.tar.gz"
curl -fLO "https://github.com/amontlabs/lcu/releases/download/$TAG/lcu-${TAG#v}-$TARGET.tar.gz.sha256"
shasum -a 256 -c "lcu-${TAG#v}-$TARGET.tar.gz.sha256"   # 必须打印 OK
tar -xzf "lcu-${TAG#v}-$TARGET.tar.gz" && cd "lcu-${TAG#v}-$TARGET"
./scripts/install.sh --runtime-only --yes
```

确认运行时能加载：

```sh
~/.local/share/lcu/current/bin/lcu doctor --non-interactive
```

期望看到 `Original Mac provider loaded; app listing and app-state methods are available`。
隐私权限是**首次使用时**才授予的，不在这里。

### 2. 把插件装进 profile

装完插件后，该 profile 里就会有一行 LCU host 处于 active。**加载时不启动任何进程。**

```sh
dsh plugin --profile <profile> add dsh-plugin-lcu
```

桌面版 App 的 **desktop** profile 被应用独占，CLI 会拒绝；请改用 App 内的插件管理器
（Settings ▸ Plugins），它执行的是同一个 pnpm 操作。

### 3. 生成 preset

DSH 的 Agent preset **没有继承**：`config.plugins` 就是完整清单，而 patch 是整段替换而非深合并。
所以自定义 preset 必须重述它的基线。与其手抄，不如从**实际安装的那份** preset 生成：

```sh
node node_modules/dsh-plugin-lcu/scripts/gen-presets.mjs --profile ~/.dsh/profiles/<profile>
```

它会在该 profile 的 `cordis.patch.yml` 里写入一个带标记的块，包含两个 preset：

| preset | 基线 | 额外内容 |
|---|---|---|
| `daily`（显示名「日常」） | 内置 `ptc` preset | 启用 `subagent_codex` |
| `heavy`（显示名「重活」） | 同上，且 `tool-presentation: both` | 以上全部，并且本插件会 attach |

DSH 升级后**重跑一次**，让副本跟上。`--dry-run` 只打印不写入，`--out FILE` 写到别处。

> `heavy` 特意把工具呈现设成 `both`。纯 `ptc` 呈现下模型只看到 `run_code`，
> `js` 就得作为一段 JavaScript 字符串**嵌套**在另一段 JavaScript 程序里。`both` 让 `js` 可以直接调。

### 4. 配置哪些模式能用

插件是**一个 root 行 + 显式 `presets` 白名单**。编辑已安装的 `cordis.patch.yml`
（或 profile patch）让它与你生成的 preset id 一致：

```yaml
- id: lcu
  name: 'dsh-plugin-lcu'
  config:
    presets:
      - heavy
```

### 5. 重启，然后先做一次无害调用

**必须重启** —— 插件的代码与配置都**不会热更新**。然后以 `heavy`（「重活」）模式新建任务，说一句：

> 用 `js` 工具执行 `await cua.getState();`，告诉我哪些应用正在运行。

首次操作某个应用时，运行时会请求批准，见下文。

### 可选：启用 Chrome

```yaml
config:
  chrome: true
```

然后：

```sh
~/.local/share/lcu/current/bin/lcu browser install
```

在你要驱动的 Chrome profile 里启用**官方 ChatGPT 扩展**，并重启 Chrome（或在 `chrome://extensions`
把该扩展关掉再开），让它剥离旧的 native host、重连到 LCU 的 relay。
`lcu browser status` 会告诉你连接器是否已指向本次 LCU 安装。站点仍然逐个精确 origin 批准。

### 可选：预授权站点

运行时首次使用每个站点都会问一次。对可信来源跳过问询，就列出**精确 origin**
（必须能通过 `new URL(...).origin` 原样往返）：

```yaml
config:
  allowedOrigins:
    - http://localhost:3000
```

诊断日志会记下每一个被问到的 origin，这是发现该填什么的最省事办法。

## 使用

新建任务时选择已启用的模式。工具是**按 Agent** 挂载的：其他模式的会话永远看不到它们，也永远不会拉起运行时。

典型请求：

```
截一张 Finder 窗口的图，告诉我分辨率。
列出我当前 Chrome 的标签页。
打开 Safari 访问 example.com，读出页面标题。
```

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `command` | `~/.local/share/lcu/current/bin/lcu` | LCU 启动器。自定义 `--prefix` 时改这里。 |
| `chrome` | `false` | 传 `--chrome`，启用浏览器面。 |
| `audio` | `false` | 传 `--audio`，启用运行时的电脑录音 API。 |
| `presets` | `["heavy"]` | 允许拿到工具的 Agent preset id 列表。 |
| `allowedOrigins` | `[]` | 免问询的精确 HTTP(S) origin。非法项直接丢弃，**绝不放宽**。 |
| `sectionOrder` | `0` | 注入的 LCU instructions 在 prompt 中的排序。 |

## 批准与安全模型

**模型不能批准任何东西**，每个决定都是人的：

- **按应用批准。** 运行时在使用一个应用前会问。插件把运行时提供的选项原样呈现出来 ——
  *Allow once*、运行时提供时的 *Allow for this session* 与 *Always allow*、以及 *Decline* ——
  经 DSH 的提问界面。选择会映射回**恰好被提供的**那个 scope；运行时没提供的 scope 无法被授予。
- **站点批准。** 浏览器访问按精确 origin 逐次批准。`allowedOrigins` 只做精确匹配：
  带尾部斜杠、带路径、大小写不同，都是**另一个 origin**，会去问而不是放行。
- **承载 agent 自己的应用永不可批准。** computer use 能点被批准应用里的任何东西，**包括批准弹窗本身**。
  守卫在问用户之前就拒绝承载 agent 的应用 —— 依据是本进程的祖先链和一份 agent 宿主/终端名单。
- **Fail closed。** 没有提问界面、用户关掉弹窗、请求形状无法识别、调用被中断 —— 全部以 *cancel* 结束，
  而运行时把 cancel 当作拒绝。

LCU 自身不保留权限缓存；`Always allow` 是**运行时**按应用记住的。

## 实现说明

```
src/connection.ts   MCP 客户端：握手、工具发现、调用、elicitation、生命周期
src/approval.ts     批准形状识别与 label→value 映射
src/host-guard.ts   防自批准守卫
src/tool.ts         工具定义、文本投影、持久化截图
src/index.ts        插件：按 Agent attach、instructions、turn_ended、批准桥
src/diag.ts         attach / 批准 诊断日志
```

**不依赖任何 MCP SDK。** harness 自带的 MCP 桥声明 `capabilities: {}`，因此**答不了 elicitation** ——
而那正是 LCU 请求批准的方式；同时往 profile 插件里塞第二个 SDK 又会引入宿主并不拥有的版本。
MCP over stdio 就是 newline-delimited JSON-RPC，所以这条线自己实现。
再配合对 DSH 包的 **type-only import**，本插件**运行时零依赖**。

**工具是按 Agent 注册的，不是挂载时注册。** 服务端拥有工具 schema，只有握手之后才能取到。
连接在 Agent 创建时、或它提交 preset 选择时建立；插件贡献的一切都注册进**该 Agent 自己的 context**，
因此会随其销毁而回退。

**两种 preset 时序都处理了。** 新任务先以部署默认 preset 创建，选择器的选择是**之后**才生效的，
所以只看 `agent/created` 会看到错误的组合；注册表会重新发出 `agent-preset/selected`，插件同时也监听它。

**天然懒启动。** 加载时什么都不起。没有启用的会话，就没有 `lcu` 进程。

**instructions 会注入。** 服务端 `initialize.instructions` 成为该 Agent 的一个 prompt section。
它本身很短 —— API 手册在 `js` 的工具描述和首次调用结果里。

## 排障

插件关于 attach 与批准的每个决定都会追加到：

```
~/.dsh/lcu-diag.log
```

超过 1 MB 会清空重来。`LCU_DIAG=0` 可关闭。**这是第一个该看的地方**：
harness 没有当前会话可读的插件日志出口，而失败的 `agent/created` 监听器否则会被静默吞掉。

| 现象 | 原因与处理 |
|---|---|
| 启用的模式里始终没有工具 | 在日志里找 `decide … composed=`。若组合出的 preset 不在 `presets` 里，修正白名单；若压根没有 `agent-preset/selected` 行，说明模式从未提交。 |
| `no userQuestions service -> cancel (fail closed)` | 该 profile 没有挂载提问面。 |
| `refusing to approve the app hosting this agent` | 按设计如此；换一个应用。 |
| 一轮之后调用被挡住 | 运行时的一轮清理尚未结束；插件会在下次调用前重试，未成功前拒绝调用。 |
| `lcu doctor` 报 socket 路径错误 | 签名助手把 socket 绑在 home 目录下，路径超过 103 字节会被拒。换一个 home 路径更短的账号。 |
| attach 报 spawn 失败 | 直接跑 `~/.local/share/lcu/current/bin/lcu doctor`，再检查配置里的 `command`。 |
| ChatGPT 里仍显示某个应用在用 computer use | 运行时还持有它。让 agent 调 `computer_use_stop`，或直接关掉那个会话 —— 连接持有整棵运行时进程树，关闭时会一并释放。 |
| `lcu status` 报 `changed_since_install` | ChatGPT 应用在会话运行期间自我更新了。LCU 警告这种会话可能"混用新旧文件"：停掉这些会话并重启 harness，让所有东西来自同一个 app 版本。 |

`node scripts/probe-lcu.mjs` 不经 harness 直连 LCU，打印协议版本、服务端身份、instructions 长度与工具清单 ——
用来把「插件的问题」和「LCU 的问题」分开。

## 随附工具

`scripts/` 里还有两个服务于同级 Codex subagent bundle 的工具（同一个 profile 通常两个都要）：

- **`update-codex.mjs`** —— 把 profile 里的 `@openai/codex` 保持在**能通过三道门**的最新版本上
  （握手、协议 schema 断言、一次真实回合），任一门不过自动回退。官方发布的
  `@deepseek-ai/dsh-subagent-codex` 钉死 `0.153.4`，而它**并不能服务所有当前的 ChatGPT 账号模型**；
  该脚本通过 profile 层、作用域限定的 pnpm override 把它顶上去。
  用法见 `node scripts/update-codex.mjs --help`（`--check` / `--verify-only` / `--to` / `--rollback`）。
- **`codex-baseline.json`** —— 最近一次通过全部三道门的版本。

## 已知限制

- **被委派的子代理无法弹出批准。** DSH 只接受「精确的 live runtime root」上的人工作答，
  因此子代理里的 LCU 批准会 fail closed。子代理可以做**不需要批准**的只读操作；
  需要批准的事必须由顶层会话发起。
- **一次"按应用停止"可能活得比会话长。** `computer_use_stop`、以及在宿主应用"正在使用你的电脑"
  横幅上按 **Esc**，都是要求运行时停止使用某个应用。清除它要靠宿主应用自己的 turn-ended 清理，
  而这一步在这里**不可靠**：它的 Apple Events 环节被 macOS 拒绝（hardened runtime 的 harness 不给弹窗）。
  如果某个应用此后每一轮都回"已被用户显式停止"，**退出并重启 ChatGPT 应用**即可清除。
  **日常使用（截图、点击、打字、浏览器标签页）不受影响，永远不需要重启**——插件的工具描述里写明了这一点，
  所以模型不会自作主张去停止应用。
- **`js` 沙箱不能写文件。** 所有写入都以 `EPERM` 失败（连临时目录也不行），所以**无法在 `js` 里存截图**。
  图片改为作为附件交给 harness，每张存下来的图片都会在工具结果里给出它的**宿主文件系统路径**；
  复制进工作区只需一行 `bash`（`install -m 644 '<path>' <target>`——存储对象是 mode 400）。
  这两件事插件既写在工具结果里，也写进它注入的 instructions。
- **macOS 权限是给 harness 的，不是给 OpenAI 助手的。** macOS 把权限请求归给**负责进程**，
  而 harness 派生的一切，负责进程就是 harness 本身。所以必须在系统设置里给 **DeepSeek Harness**
  开启屏幕录制与辅助功能；只给 ChatGPT 或 "Codex Computer Use" 是不够的，而且 macOS 不会自己弹出缺失的那项。
- **每个 Agent 一条 LCU 连接。** LCU 的 JavaScript 会话是按连接隔离的，其批准绑定真实 session 与 turn，
  跨 Agent 共用会互相串扰。
- **`chrome` 需要扩展。** 只开开关、没装官方 ChatGPT 扩展、或没跑 `lcu browser install`，都不会有浏览器面。
- **未在 Linux 上验证。** 见[前置条件](#前置条件)。

## 开发

```sh
npm install
npm run typecheck     # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm run build         # 产出 lib/
npm test              # node --test，无需构建
```

连接层测试会连**真实安装的** `lcu`，未安装时自动跳过 —— 所以本地 `npm test` 有意义，
CI 上也能通过。批准、投影、守卫三组是纯函数测试，永远会跑。

插件的**代码与配置都不会热更新**：运行中的进程持有它加载时的那个模块。改完要重新构建并重启。

## 许可

MIT。LCU 为 MIT（Amont Labs）；ChatGPT 应用及其 instructions 仍受其自身条款约束，且取自你本地的安装。
