# Capability Mapping: EasyAgentCli → agent-bot-gateway

本文档分析 EasyAgentCli（桌面应用）与 agent-bot-gateway（服务端网关）的能力对应关系，为迁移和增强决策提供依据。

## 一、架构对比

### EasyAgentCli 架构
- **类型**: Electron 桌面应用
- **核心**: PTY 管理器 (`pty-manager.ts`) + WebSocket 桥接服务器 (`server.ts`)
- **消息路由**: `message-router.ts` 统一分发到各 IM 适配器
- **Agent 管理**: 本地 PTY 进程，支持多 Tab（多 Agent 实例）
- **状态持久化**: Electron 本地存储

### agent-bot-gateway 架构
- **类型**: Node.js 服务端应用
- **核心**: Codex RPC 客户端 (`codexRpcClient.js`) + Claude SDK 客户端 (`claudeClient.js`)
- **消息路由**: `platformRegistry.js` + `commands/router.js` 分发到各平台
- **Agent 管理**: 多运行时支持（codex/claude），单进程多线程模型
- **状态持久化**: JSON 文件 (`data/state.json`)

---

## 二、能力分类表

### 2.1 已具备（直接对应）

| 能力 | EasyAgentCli 实现 | agent-bot-gateway 对应 | 备注 |
|------|-------------------|------------------------|------|
| **PTY/Agent 管理** | `pty-manager.ts` - 创建、重启、关闭 PTY | `turnRunner.js` + `agentClientRegistry.js` | GW 使用 RPC 而非本地 PTY |
| **会话恢复** | `--resume` / `--continue` 参数 | `state.js` + `thread/resume` RPC | GW 持久化 threadId 绑定 |
| **多 Agent 类型** | claude/codex/gemini/kimi/aider | codex + claude 双运行时 | GW 更侧重代码 Agent |
| **消息路由** | `message-router.ts` | `platformRegistry.js` + `router.js` | GW 按路由分发 |
| **Discord 适配** | `adapters/discord.ts` | `discordPlatform.js` | 功能相当 |
| **飞书适配** | `adapters/feishu.ts` | `feishuPlatform.js` | GW 更完整 |
| **交互式卡片** | `feishu.ts` - `buildCard()` | `notificationRuntime.js` | GW 支持流式更新 |
| **终端状态追踪** | `PaneStatus` (running/confirm/done/error/idle) | `TURN_PHASE` (pending/running/finalizing/done/failed) | GW 更细粒度 |
| **自动化/YOLO 模式** | `yoloLevel` (off/safe/full) | `approvalPolicy` + `sandboxPolicy` | GW 更细粒度权限控制 |
| **心跳/静默通知** | `heartbeatTimer` + `quietTimer` | `notificationRuntime.js` 流式状态更新 | GW 实时推送 |
| **终端快照** | `snapshot()` RingBuffer | 流式 `agent_delta` | GW 无本地缓存，实时流 |
| **权限绕过** | `bypassPermissions` | `sandboxPolicy` + `approvalPolicy` | GW 更严格 |

### 2.2 需增强（部分具备）

| 能力 | EasyAgentCli 实现 | agent-bot-gateway 现状 | 差距分析 |
|------|-------------------|------------------------|----------|
| **Telegram 适配** | `adapters/telegram.ts` 完整实现 | 未实现 | 需新增 `telegramPlatform.js` |
| **Openclaw 桥接** | `adapters/openclaw.ts` WebSocket 客户端 | 未实现 | 需新增 `openclawPlatform.js` |
| **AI 摘要** | `ai-service.ts` - 心跳/完成时 AI 摘要 | 无 | 可作为可选增强 |
| **多 Tab/多会话** | `PtyManager` 支持多 Pane 并行 | 单路由 FIFO 队列 | 架构差异，服务端无需多 Tab |
| **终端输入转发** | `#1 text` 发送到指定 Pane | `!ask` 发送到路由 | GW 按路由隔离，无跨路由输入 |
| **快速确认/拒绝** | `#1y` / `#1n` 快捷回复 | `!approve` / `!decline` 命令 | GW 支持 token 精确控制 |
| **屏幕快照命令** | `/screen` / `/log` | 无直接对应 | GW 实时流式输出，无需快照 |
| **YOLO 级别动态调整** | `/yolo safe\|full` 运行时切换 | 配置文件静态设置 | 可增强为运行时调整 |
| **终端重排序** | `reorder()` 方法 | 无（路由独立） | 服务端无此需求 |

### 2.3 不迁移（桌面特有）

| 能力 | 实现位置 | 排除原因 |
|------|----------|----------|
| **Electron UI** | 渲染进程 | 服务端无 GUI 需求 |
| **本地文件浏览器** | 渲染进程 | 服务端无文件浏览需求 |
| **系统托盘集成** | Electron main | 服务端无桌面集成 |
| **本地配置持久化** | Electron store | GW 使用 JSON 文件 |
| **窗口/Tab 管理** | 渲染进程 | 服务端无窗口概念 |
| **Chrome 内容过滤** | `analyzer.ts` `chromeLines` | 服务端无需过滤启动画面 |

---

## 三、能力详细映射

### 3.1 消息流与命令处理

#### EasyAgentCli
```
用户消息 → MessageAdapter → MessageRouter.handleMessage()
  → parseCommand() → executeCommand()
  → /panes, /use, /screen, /yolo, #input, etc.
```

#### agent-bot-gateway
```
用户消息 → Platform.handleInboundMessage() → CommandRouter.handleCommand()
  → !help, !ask, !status, !new, !restart, !approve, !decline, etc.
```

**命令对照表**:

| EasyAgentCli | agent-bot-gateway | 说明 |
|--------------|-------------------|------|
| `/panes` | `!status` | 列出状态 |
| `/use <id>` | 无（单路由） | GW 按通道隔离 |
| `/screen` | 无（实时流） | GW 无需快照 |
| `/log [n]` | 无（实时流） | GW 无需日志 |
| `/yolo [level]` | 配置控制 | 可增强 |
| `#text` | `!ask text` | 发送提示 |
| `#Ny` / `#Nn` | `!approve` / `!decline` | 确认/拒绝 |

### 3.2 事件分发与通知

#### EasyAgentCli
```
PTY 输出 → Analyzer → PaneEvent (confirm/done/error/idle/heartbeat)
  → MessageRouter.dispatchEvent() → Adapter.sendEvent() → IM 卡片
```

#### agent-bot-gateway
```
Agent RPC 通知 → notificationRuntime.handleNotification()
  → agent_delta, item_lifecycle, turn_completed, error
  → 编辑状态消息 / 流式输出 / 最终摘要
```

**事件对照表**:

| EasyAgentCli | agent-bot-gateway | 说明 |
|--------------|-------------------|------|
| `confirm` | `serverRequest` (approval) | 需用户确认 |
| `done` | `turn_completed` | 任务完成 |
| `error` | `error` notification | 错误 |
| `idle` | 无直接对应 | 静默超时 |
| `heartbeat` | 流式状态更新 | 进度报告 |
| `exit` | `exit` 事件 | 进程退出 |

### 3.3 平台适配器接口

#### EasyAgentCli MessageAdapter 接口
```typescript
interface MessageAdapter {
  readonly name: string;
  sendText(text: string): Promise<void>;
  sendEvent?(event: PaneEvent): Promise<void>;
  sendStatusSummary?(panes: PaneInfo[], entering: boolean): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
}
```

#### agent-bot-gateway Platform 接口
```javascript
{
  platformId: string;
  enabled: boolean;
  capabilities: {
    supportsPlainMessages: boolean;
    supportsSlashCommands: boolean;
    supportsButtons: boolean;
    supportsAttachments: boolean;
    supportsRepoBootstrap: boolean;
    supportsAutoDiscovery: boolean;
    supportsWebhookIngress: boolean;
  };
  canHandleRouteId(routeId): boolean;
  fetchChannelByRouteId(routeId): Promise<Channel>;
  handleInboundMessage(message): Promise<void>;
  handleInboundInteraction(interaction): Promise<void>;
  start(): Promise<object>;
  stop(): Promise<object>;
  getHttpEndpoints(): string[];
  matchesHttpRequest(request): boolean;
  handleHttpRequest(request, response, options): Promise<void>;
}
```

**主要差异**:
1. GW Platform 更强调**能力声明**（capabilities）
2. GW 支持 **HTTP 入口**（Webhook）
3. GW 支持 **交互组件**（Discord Buttons）
4. EasyAgentCli 强调**离开模式**状态广播

---

## 四、差距分析与迁移建议

### 4.1 可迁移能力

| 能力 | 迁移难度 | 建议 |
|------|----------|------|
| **Telegram 适配** | 中 | 新增 `telegramPlatform.js`，复用 Discord 的命令路由 |
| **Openclaw 桥接** | 中 | 新增 `openclawPlatform.js`，作为 WebSocket 客户端 |
| **AI 摘要** | 低 | 可选增强，在 `notificationRuntime` 的 `finalizeTurn` 中集成 |
| **YOLO 运行时调整** | 低 | 新增 `!policy` 命令动态调整审批策略 |
| **快速命令** | 低 | 支持 `!y` / `!n` 作为 `!approve` / `!decline` 别名 |

### 4.2 架构差异（无需迁移）

1. **多 Tab 模型**: 桌面应用需要多 Tab，服务端按路由隔离，无需此能力
2. **终端快照**: 服务端实时推送，无需本地缓存快照
3. **Chrome 过滤**: 服务端无本地终端，无需过滤启动画面
4. **离开模式**: 服务端始终"在线"，无需离开/返回切换

### 4.3 增强建议优先级

1. **高优先级**:
   - Telegram 适配器（用户需求明确）
   - 快速命令别名（提升易用性）

2. **中优先级**:
   - Openclaw 桥接（现有用户迁移）
   - YOLO 运行时调整（灵活控制）

3. **低优先级**:
   - AI 摘要（锦上添花）

---

## 五、文件路径对照

| 功能 | EasyAgentCli | agent-bot-gateway |
|------|--------------|-------------------|
| 核心路由 | `src/main/bridge/message-router.ts` | `src/commands/router.js` |
| PTY/Agent 管理 | `src/main/pty-manager.ts` | `src/codex/turnRunner.js` |
| Agent 客户端 | - | `src/codexRpcClient.js`, `src/claudeClient.js` |
| 客户端注册表 | - | `src/clients/agentClientRegistry.js` |
| Discord 适配 | `src/main/bridge/adapters/discord.ts` | `src/platforms/discordPlatform.js` |
| 飞书适配 | `src/main/bridge/adapters/feishu.ts` | `src/platforms/feishuPlatform.js` |
| Telegram 适配 | `src/main/bridge/adapters/telegram.ts` | **未实现** |
| Openclaw 桥接 | `src/main/bridge/adapters/openclaw.ts` | **未实现** |
| 平台注册 | - | `src/platforms/platformRegistry.js` |
| 通知处理 | `server.ts` (广播) | `src/turns/notificationRuntime.js` |
| 审批处理 | `message-router.ts` (auto-answer) | `src/approvals/serverRequestRuntime.js` |
| 状态持久化 | Electron store | `src/stateStore.js` |
| 配置加载 | - | `src/config/loadConfig.js` |

---

## 六、总结

### 已具备的核心能力
agent-bot-gateway 已完整实现 EasyAgentCli 的核心功能：多平台适配（Discord/飞书）、Agent 管理、会话持久化、权限审批、流式输出。

### 需要增强的能力
1. **Telegram 适配器**: 用户需求明确，迁移难度中等
2. **Openclaw 桥接**: 现有用户迁移路径
3. **运行时策略调整**: 提升灵活性

### 不迁移的能力
桌面特有功能（GUI、多 Tab、本地终端管理）不适合服务端架构，无需迁移。

### 迁移风险评估
- **低风险**: AI 摘要、快速命令别名
- **中风险**: Telegram/Openclaw 适配器（需要平台特定测试）
- **高风险**: 无

### 建议下一步
1. 实现 `telegramPlatform.js`（参考 `discordPlatform.js`）
2. 实现 `openclawPlatform.js`（参考 EasyAgentCli 的 `openclaw.ts`）
3. 新增 `!policy` 命令支持运行时审批策略调整
4. （可选）在 `finalizeTurn` 中集成 AI 摘要功能
