# Remote Control Command Design

本文档设计远程控制命令的交互模型和实现规范，为从 EasyAgentCli 迁移远程控制能力提供设计蓝图。

## 一、新增命令设计

### 1.1 快照/日志命令

#### 命令语法

| 命令 | 语法 | 说明 |
|------|------|------|
| `/screen` | `/screen [route?]` | 获取当前 turn 的最近输出（默认 60 行） |
| `/log` | `/log [n] [route?]` | 获取最近 n 行输出（默认 20 行，最大 200） |

#### 平台差异

| 平台 | 字符限制 | 处理策略 |
|------|----------|----------|
| Discord | 1900 字符 | 分块发送，代码块包裹 |
| Feishu | 8000 字符 | 单条消息，交互卡片可选 |

#### 输出缓冲设计

```javascript
// 在 notificationRuntime 中维护
const OUTPUT_BUFFER_CONFIG = {
  maxLines: 500,           // 最大行数
  defaultScreenLines: 60,  // /screen 默认行数
  defaultLogLines: 20,     // /log 默认行数
  maxLogLines: 200         // /log 最大行数
};

// 追踪器扩展
tracker.outputBuffer = {
  lines: [],               // 输出行数组
  timestamps: [],          // 时间戳数组
  maxLines: OUTPUT_BUFFER_CONFIG.maxLines
};

// 追加输出
function appendOutput(tracker, line) {
  tracker.outputBuffer.lines.push(line);
  tracker.outputBuffer.timestamps.push(Date.now());
  // 环形缓冲区：超出时删除最旧
  if (tracker.outputBuffer.lines.length > tracker.outputBuffer.maxLines) {
    tracker.outputBuffer.lines.shift();
    tracker.outputBuffer.timestamps.shift();
  }
}
```

#### 命令处理流程

```
用户发送 /screen 或 /log
  ↓
CommandRouter 解析命令
  ↓
查找活跃 turn (activeTurns.get(threadId))
  ↓
若无活跃 turn → 返回 "当前没有活跃的对话"
  ↓
若有活跃 turn → 从 outputBuffer 获取内容
  ↓
格式化输出（代码块、截断）
  ↓
分块发送到平台
```

#### 输出格式

**Discord**:
```
📺 终端输出 (最近 60 行):
```
[输出内容]
```
```

**Feishu**:
```json
{
  "config": { "wide_screen_mode": true },
  "header": {
    "title": { "tag": "plain_text", "content": "📺 终端输出" },
    "template": "blue"
  },
  "elements": [
    {
      "tag": "div",
      "text": { "tag": "lark_md", "content": "```\n[输出内容]\n```" }
    }
  ]
}
```

### 1.2 YOLO 模式命令

#### 命令语法

| 命令 | 说明 |
|------|------|
| `/yolo` | 查看当前路由的 YOLO 模式 |
| `/yolo off` | 关闭自动审批（所有操作需确认） |
| `/yolo safe` | 安全模式：自动批准低风险操作 |
| `/yolo full` | 完全自动：批准所有操作（危险） |

#### 三级模式语义

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| `off` | 所有审批请求都推送给用户 | 生产环境、重要项目 |
| `safe` | 自动批准低风险操作，高风险推送用户 | 日常开发 |
| `full` | 自动批准所有操作（危险） | 可靠网络、信任环境 |

#### 风险判断规则

```javascript
// 高风险操作（永不自动批准）
const HIGH_RISK_PATTERNS = [
  /rm\s+-/,              // rm -rf
  /drop\s+/,             // SQL DROP
  /git\s+push/,          // git push
  /sudo/,                // sudo
  /format/i,             // 格式化
  /truncate/i,           // 截断表
  /delete\s+--force/i,   // 强制删除
  /\|.*sh\b/,            // 管道到 shell
];

// 中风险操作（safe 模式推送）
const MEDIUM_RISK_PATTERNS = [
  /bash/i,               // Bash 工具
  /shell/i,              // Shell 工具
  /execute/i,            // 执行命令
  /run\s+command/i,      // 运行命令
];

// 低风险操作（safe 模式自动批准）
// - 文件读取 (Read, Glob, Grep)
// - 文件编辑 (Edit, Write) - 非 rm
// - Web 搜索
// - MCP 工具调用
```

#### 配置存储

```javascript
// config/channels.json 扩展
{
  "channels": {
    "1234567890": {
      "cwd": "/path/to/repo",
      "yoloMode": "safe"  // off | safe | full
    }
  },
  "defaultYoloMode": "off"  // 全局默认
}
```

### 1.3 心跳/空闲通知

#### 通知时机

| 通知类型 | 触发条件 | 内容 |
|----------|----------|------|
| 心跳 | 每 N 分钟（可配置） | 当前工作进度摘要 |
| 空闲 | 无输出超过 N 分钟 | 最后输出 + 提示 |

#### 配置项

```javascript
// 环境变量
HEARTBEAT_INTERVAL_MINUTES=10    // 心跳间隔（分钟）
HEARTBEAT_ENABLED=true           // 是否启用心跳
IDLE_THRESHOLD_MINUTES=15        // 空闲阈值（分钟）
IDLE_NOTIFICATION_ENABLED=true   // 是否启用空闲通知
```

#### 通知内容

**心跳通知**:
```
📊 进度报告 [#1 agent-work]
正在执行: 编辑 src/index.js
已工作: 5m 32s
最近操作:
- 读取 package.json
- 编辑 src/utils.js
```

**空闲通知**:
```
💤 终端静默 15 分钟

最后输出:
[最近 5 行输出]

💡 发送消息继续对话
```

---

## 二、Feishu 交互卡片设计

### 2.1 审批卡片结构

```json
{
  "config": { "wide_screen_mode": true },
  "header": {
    "title": { "tag": "plain_text", "content": "⚠️ 需要确认" },
    "template": "orange"
  },
  "elements": [
    {
      "tag": "div",
      "text": { "tag": "lark_md", "content": "**命令**\n```\nrm -rf node_modules\n```" }
    },
    {
      "tag": "div",
      "text": { "tag": "lark_md", "content": "**工作目录**\n`/home/user/project`" }
    },
    {
      "tag": "hr"
    },
    {
      "tag": "action",
      "actions": [
        {
          "tag": "button",
          "text": { "tag": "plain_text", "content": "✅ 批准" },
          "type": "primary",
          "value": { "action": "approve", "token": "abc123", "routeId": "feishu:oc_xxx" }
        },
        {
          "tag": "button",
          "text": { "tag": "plain_text", "content": "❌ 拒绝" },
          "type": "danger",
          "value": { "action": "decline", "token": "abc123", "routeId": "feishu:oc_xxx" }
        },
        {
          "tag": "button",
          "text": { "tag": "plain_text", "content": "⏹️ 取消" },
          "type": "default",
          "value": { "action": "cancel", "token": "abc123", "routeId": "feishu:oc_xxx" }
        }
      ]
    },
    {
      "tag": "note",
      "elements": [
        { "tag": "plain_text", "content": "💡 或发送 \"!approve abc123\" / \"!decline abc123\"" }
      ]
    }
  ]
}
```

### 2.2 按钮回调处理

```javascript
// Feishu 卡片回调路由
// POST /feishu/card (webhook)

async function handleCardAction(payload) {
  const { action, token, routeId } = payload;

  // 1. 验证 token 有效性
  const approval = pendingApprovals.get(token);
  if (!approval) {
    return { text: "审批已过期或不存在" };
  }

  // 2. 验证路由匹配
  if (approval.repoChannelId !== routeId) {
    return { text: "路由不匹配" };
  }

  // 3. 执行决策
  const decision = action; // approve | decline | cancel
  const result = await applyApprovalDecision(token, decision, "飞书用户");

  // 4. 更新卡片状态
  return {
    card: {
      // 更新为已处理状态
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: `✅ 已${decision === 'approve' ? '批准' : decision === 'decline' ? '拒绝' : '取消'}` },
        template: decision === 'approve' ? 'green' : 'red'
      },
      elements: [
        {
          tag: "div",
          text: { tag: "plain_text", content: `操作已被${decision === 'approve' ? '批准' : decision === 'decline' ? '拒绝' : '取消'}` }
        }
      ]
    }
  };
}
```

### 2.3 状态更新卡片

```json
{
  "config": { "wide_screen_mode": true },
  "header": {
    "title": { "tag": "plain_text", "content": "🔧 正在工作" },
    "template": "blue"
  },
  "elements": [
    {
      "tag": "div",
      "text": { "tag": "lark_md", "content": "**当前操作**\n编辑 src/commands/router.js" }
    },
    {
      "tag": "div",
      "text": { "tag": "lark_md", "content": "**已用时**\n3m 45s" }
    }
  ]
}
```

---

## 三、平台适配策略

### 3.1 能力查询

```javascript
// 平台能力查询
const platformCapabilities = platformRegistry.getCapabilities(platformId);

// 使用示例
if (platformCapabilities.supportsButtons) {
  // 发送带按钮的消息
} else {
  // 发送纯文本 + 命令提示
}

if (platformCapabilities.supportsSlashCommands) {
  // 使用 /command 语法
} else {
  // 使用 !command 语法
}
```

### 3.2 消息长度处理

```javascript
// 平台消息长度限制
const MESSAGE_LIMITS = {
  discord: 1900,
  feishu: 8000,
  telegram: 4000
};

function truncateForPlatform(text, platformId) {
  const limit = MESSAGE_LIMITS[platformId] || 1900;
  if (text.length <= limit) {
    return text;
  }
  const suffix = "\n...[截断]";
  return text.slice(0, limit - suffix.length) + suffix;
}

function splitForPlatform(text, platformId) {
  const limit = MESSAGE_LIMITS[platformId] || 1900;
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += limit) {
    chunks.push(text.slice(offset, offset + limit));
  }
  return chunks;
}
```

### 3.3 降级方案

| 场景 | 降级策略 |
|------|----------|
| 卡片发送失败 | 回退到纯文本消息 |
| 按钮回调超时 | 提示用户使用命令 |
| 输出超长 | 截断 + 分块发送 |
| 无活跃 turn | 返回 "当前没有活跃的对话" |

---

## 四、命令语法对照表

### 4.1 现有命令（不变）

| 命令 | 说明 |
|------|------|
| `!help` | 显示帮助 |
| `!ask <prompt>` | 发送提示 |
| `!status` | 显示状态 |
| `!new` | 清除 thread 绑定 |
| `!restart [reason]` | 请求重启 |
| `!interrupt` | 中断当前 turn |
| `!where` | 显示路径信息 |
| `!approve [token]` | 批准请求 |
| `!decline [token]` | 拒绝请求 |
| `!cancel [token]` | 取消请求 |
| `!setpath <path>` | 绑定路径 |
| `!agents` | 显示代理列表 |

### 4.2 新增命令

| 命令 | 说明 | 平台 |
|------|------|------|
| `/screen [route?]` | 终端快照（60行） | 全平台 |
| `/log [n] [route?]` | 最近 n 行日志 | 全平台 |
| `/yolo` | 查看当前 YOLO 模式 | 全平台 |
| `/yolo off\|safe\|full` | 设置 YOLO 模式 | 全平台 |

### 4.3 快捷别名

| 快捷命令 | 等价命令 |
|----------|----------|
| `!y` | `!approve` (最新 token) |
| `!n` | `!decline` (最新 token) |

---

## 五、配置项设计

### 5.1 环境变量

```bash
# YOLO 模式
DEFAULT_YOLO_MODE=off                    # 全局默认 YOLO 模式

# 心跳通知
HEARTBEAT_INTERVAL_MINUTES=10            # 心跳间隔
HEARTBEAT_ENABLED=true                   # 是否启用

# 空闲通知
IDLE_THRESHOLD_MINUTES=15                # 空闲阈值
IDLE_NOTIFICATION_ENABLED=true           # 是否启用

# 输出缓冲
OUTPUT_BUFFER_MAX_LINES=500              # 最大缓冲行数
SCREEN_DEFAULT_LINES=60                  # /screen 默认行数
LOG_DEFAULT_LINES=20                     # /log 默认行数
LOG_MAX_LINES=200                        # /log 最大行数
```

### 5.2 channels.json 扩展

```json
{
  "defaultYoloMode": "off",
  "channels": {
    "discord:1234567890": {
      "cwd": "/path/to/repo",
      "model": "claude-sonnet-4-6",
      "yoloMode": "safe",
      "heartbeatEnabled": true,
      "idleNotificationEnabled": true
    },
    "feishu:oc_xxx": {
      "cwd": "/path/to/another/repo",
      "agentId": "claude",
      "yoloMode": "off"
    }
  }
}
```

---

## 六、错误处理

### 6.1 错误场景

| 场景 | 错误消息 | 处理 |
|------|----------|------|
| 无活跃 turn | "当前没有活跃的对话" | 直接返回 |
| 无输出内容 | "(终端为空)" | 直接返回 |
| YOLO 配置无效 | "无效的 YOLO 模式，可选: off, safe, full" | 直接返回 |
| 卡片发送失败 | 回退到纯文本 | 记录日志 |
| 按钮回调无效 | "审批已过期或不存在" | 更新卡片状态 |

### 6.2 降级逻辑

```javascript
async function sendInteractiveCard(channel, card) {
  try {
    // 尝试发送交互卡片
    if (channel.platform === 'feishu') {
      return await channel.send({ card });
    }
    // Discord 使用按钮组件
    return await channel.send(cardToDiscordButtons(card));
  } catch (error) {
    // 降级到纯文本
    console.error('Card send failed, falling back to text:', error);
    return await channel.send(cardToPlainText(card));
  }
}
```

---

## 七、实现优先级

| 优先级 | 功能 | 复杂度 | 依赖 |
|--------|------|--------|------|
| P0 | `/screen` `/log` 命令 | 低 | outputBuffer |
| P1 | Feishu 交互卡片 | 中 | 无 |
| P1 | YOLO 模式配置 | 低 | 无 |
| P2 | 心跳/空闲通知 | 中 | outputBuffer |
| P2 | 快捷别名 `!y`/`!n` | 低 | 无 |

---

## 八、测试用例

### 8.1 快照命令

```javascript
// 测试用例
describe('/screen command', () => {
  it('should return "no active turn" when no turn is active');
  it('should return last 60 lines by default');
  it('should truncate output for Discord (1900 chars)');
  it('should send full output for Feishu (8000 chars)');
  it('should return "(terminal empty)" when buffer is empty');
});

describe('/log command', () => {
  it('should return last 20 lines by default');
  it('should respect n parameter');
  it('should cap at 200 lines max');
});
```

### 8.2 YOLO 模式

```javascript
describe('YOLO mode', () => {
  it('should default to "off"');
  it('should auto-approve low-risk operations in "safe" mode');
  it('should not auto-approve high-risk operations in "safe" mode');
  it('should auto-approve all operations in "full" mode');
  it('should persist YOLO mode to channel config');
});
```

### 8.3 Feishu 卡片

```javascript
describe('Feishu interactive cards', () => {
  it('should send approval card with buttons');
  it('should handle approve button click');
  it('should handle decline button click');
  it('should handle cancel button click');
  it('should reject invalid token');
  it('should reject mismatched route');
  it('should update card after action');
});
```
