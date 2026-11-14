# SDK 受管挂载

[English](MANAGED.md) | [桌面安装](README.zh.md)

0.5 版通过 `dsh-plugin-lcu/managed` 提供正式宿主接口。调度器可给真实的 DSH SDK Agent 挂载原有 CUA 运行时，不创建桌面会话、不改写 `agentPreset`、不假冒 root 身份，也不绕过应用与网站批准。原来的桌面插件和 preset 白名单继续通过默认入口工作。

## 公开接口

```ts
import { attachManagedLcu, installManagedLcu } from 'dsh-plugin-lcu/managed'

const lcu = await attachManagedLcu(ctx, {
  agent, // 必须是 ctx.get('agents') 内已登记的同一个对象
  identity: { runId, invocationId, rootSessionId, candidateId },
  lease: { leaseId, resourceId, leaseEpoch, ownerInvocationId: invocationId },
  config: {
    app: '/Applications/ChatGPT.app',
    chrome: true,
    allowedApps: ['com.google.Chrome'],
    allowedOrigins: ['https://example.com'],
  },
  async verifyLease(admission) {
    await scheduler.verify(admission) // 核验真实系谱、当前租约与 epoch；失败应抛错
  },
  async onEvent(event) {
    await journal.append(event) // 等待持久化回执；写入失败会阻止后续 GUI 工作
  },
})

// 正常由 DSH 的 pre-step / turn-stopping / disposal 生命周期驱动。
// 手动 loop 也可使用宿主分配的唯一 turn ID。
await lcu.beginTurn(hostTurnId)
await lcu.stopTurn('Stop')
const receipt = await lcu.close('Interrupt')
if (receipt.cleanup !== 'confirmed') await scheduler.blockResource(receipt)
else await scheduler.releaseLease(receipt)
```

例中的 `scheduler`、`journal` 由宿主实现。`verifyLease` 在 attach、每次完整 bridge 调用及每次批准前执行；取得回答后和写入批准事件后会再次核验，防止租约撤销后迟到回答放行。每次回调前后都验证原 Agent 仍是注册表中的同一存活对象。输入包括 `identity`、`lease`、`agentSessionId`、`runtimeEpoch`、`phase`，以及当时可用的 `turnId`、`callId`、`method`。这些身份由宿主产生，模型参数不能指定。

`installManagedLcu(ctx, resolve)` 是对正式 `agent/created` 钩子的便捷封装。异步 resolver 返回去掉 `agent` 的挂载选项，或用 `undefined` 排除未准入的 Agent；返回值提供 `get(agent)` 和会等待清理的 `closeAll()`。如果宿主已在自己的 created 钩子里完成权限和真实系谱检查，应直接 `await attachManagedLcu(...)`。本包自己注册每个 Agent 的 pre-step、turn-stopping 和 disposal 钩子。

`config` 支持 `app`、`command`、`chrome`、`audio`、`allowedApps`、`allowedOrigins`。managed 路径没有 `presets` 字段。SDK worker 不会因为进程来自桌面应用就自动继承桌面的 preset。

## GUI 所有权和多 Agent

调度器必须先取得真实 GUI 资源的跨进程独占租约。租约包含 `leaseId`、`resourceId`、`leaseEpoch`、`ownerInvocationId`；传入这些字段本身不授予权限。`verifyLease` 必须核验当前有效所有权，不能只比较同一请求里两份自报数据。

同一次 invocation 的 root 和已准入后代可以共享租约，没有 root-only 或固定助手数量限制。每个 Agent 保持独立运行时连接、真实 session ID 和唯一 turn ID。所有 Agent 按 `resourceId` 串行执行完整 GUI 调用，包括一次 PTC RPC 内的两次原生调用。某个调用取消或失败后，同资源的兄弟 Agent 会被阻断，直到该所有者的 turn cleanup 获得确认。进程内串行队列与宿主的跨进程租约互补。

如果 Agent 已存在 `cua`、`lcu_cua`、`js`、`js_reset` 工具，managed attach 会拒绝。宿主应保持受管组合唯一，避免旧工具绕过租约核验；挂载后也应保持此条件。桌面默认插件会跳过已经被 managed 入口认领的 Agent。

## PTC、代理句柄和图片

注册工具名为 **`lcu_cua`**，程序内的对象仍叫 **`cua`**：

```ts
var { connectCua } = await import('dsh-plugin-lcu/bridge')
var cua = connectCua(request => tools.lcu_cua(request))
var app = await cua.getApp('Finder')
await app.activate()
```

从 0.4.x 升级时需更新手写的 `tools.cua` 绑定；`connectCua` 的参数与对象方法树保持兼容。没有注册旧 `cua` 工具别名，因为新 DSH PTC executor 对该名字有特殊图片转换：单图替换 JSON 返回值，多图报错。独立工具名让 canonical JSON 句柄和图片投影继续走普通工具契约。

句柄绑定 runtime epoch。reset 会换 epoch，旧句柄报 `LCU_STALE_HANDLE`。managed 会话固定应用代次，bundle 改变或无法读取时拒绝准入，不在持有 GUI 时自动更换运行时。启动前后都核验应用代次，握手过程中发生更新也会拒绝准入。桥接解码保留 Image 类实例与带 symbol 标记对象的身份。只有当前 executor 声明了 `inspect` 才使用它；旧执行器可用 `console.log` 输出结构化值。

`media` 事件记录操作、目标句柄、观察时间、模型路由、`capturedImages`、`preparedImages`，以及每张观察到的图片的 SHA-256、MIME、字节数。准备成功时会有真实 attachment 引用和附件后端返回的宿主路径；路径来自存储服务，不来自模型参数。

| 事实 | 能证明什么 |
|---|---|
| `capturedImages` | CUA 返回了图片内容块；单独不能证明字节有效或模型接收。 |
| `preparedImages` | 当前模型路由声明图片输入，DSH 附件存储返回了投影图片引用；之后的执行器或策略仍可能改变结果。 |
| `imageDeliveredToModel: 'unverified'` | 本包没有模型消费回执，不把准备投影当成已经送达。 |
| `evidenceAttachedToRun: false` | 本包尚未在调度器的 run/candidate 证据目录里复制、核验该图片；宿主完成后应另记回执。 |

测试覆盖零图、单图、多图与可调用句柄组合，以及 Image 身份。它们没有运行完整 rc.3/master PTC executor、视觉模型或真实 macOS 桌面；部署侧仍须分别探测这些组合，不能据此宣称模型已看见屏幕。

## 批准

仍通过原来的 exact app/origin allowlist、`userQuestions`、host-app 守卫及真实 elicitation 请求批准。没有提问服务，即使目标在白名单中也取消；未知请求形状取消；turn 被取消后不能再接受待答或刚完成的问题。managed 模式忽略旧的 `LCU_ALLOW_AGENT_HOST_APPROVAL` 测试开关。

DSH 无法向用户展示某个子 Agent 的问题时，该子 Agent 仍可使用已批准目标；其余请求按真实服务结果取消。不把子 Agent 的身份换成 root 来让批准通过。`approval` 事件包含实际 request ID、目标和 `responseSent: 'unverified'`，选择答案不等于已证明远端收到。

## 取消和清理回执

`stopTurn()` 先阻止准入、abort 当前 turn、等待资源串行队列，然后等待原运行时 `turn_ended`。工具取消还会尽力发送 MCP cancellation 通知，但通知只是请求，不是清理确认。可信 Sky wrapper 保留失败的应用 IPC cleanup，令对应 turn hook 及后续 GUI 操作报错；重试耗尽后也不会把 pending 丢弃成成功。

`close()` 先停 turn、移除工具和钩子，再等待 kernel 退出。stdin 关闭、TERM、KILL 均有时限；进程仍未退出时报告错误。kernel 退出不等于宿主应用已释放 turn。最终回执分别记录 `turnCleanupConfirmed`、`runtimeExitConfirmed`；只有两者均为 true 且最终事件成功持久化，`cleanup` 才是 `confirmed`。turn-stop 的确认仅证明回合已清理，运行时仍在；释放最终租约必须使用 **close 回执**。

snapshot 包含版本、identity、lease、Agent/runtime 身份、状态、工具与值契约、清理状态及错误。事件再加每 Agent 递增的 `sequence`、类型、turn/call ID 和 facts。类型有 `attached`、`turn.started`、`call.started`、`call.completed`、`call.failed`、`approval`、`media`、`turn.stopped`、`cleanup`。

遇到 `unknown`，宿主必须保留资源阻断。之后拿到实际清理确认可以恢复；仅 kill kernel、等待超时或 worker 消失不能释放租约。挂载过程已经进入运行时生命周期时，异常会携带 `ManagedLcuError.receipt`；便捷安装器的 `closeAll()` 也保留失败挂载的回执。

## 验证

`npm run test:packed` 构建、打包，在独立临时消费者目录用正常 `npm install` 同时安装 tarball、精确 Cordis 4.1.0 和 DSH tools/system-prompt 0.2.2-rc.3，然后通过正式导出的 JavaScript 运行完整 managed 测试。不使用 `--force` 或 legacy peer resolver，同时验证真实 prerelease peer 兼容和构建产物。真实子进程 MCP fixture 执行生成的 bridge 程序，处理 wire cancellation、elicitation 和确定性图片，没有绕过运行时文件校验或批准守卫。wrapper 测试独立证明失败清理保持 unknown 并阻止后续动作。

这些 fixture 不验证 macOS 辅助功能、已签名应用 IPC 的真实行为、Chrome 扩展或下游视觉模型。目标 Mac 必须完成部署探测、真实 turn/abort/image 测试，才可将那些能力报告为已观察成功。
