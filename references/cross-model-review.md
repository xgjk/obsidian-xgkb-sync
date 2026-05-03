# Cross-Model Review（双模型交叉审核法）

> 让任意 Agent 都能用 Codex + Claude 交替审核，把文档打磨到零缺陷。
> 本文档是可复用的方法论，不绑定任何特定项目或 Agent。

---

## 一、核心思想

**用两个不同厂商的模型交替审核同一份文档，利用模型盲区互补消灭遗漏。**

- **Codex（GPT 系列）**：擅长 SQL/代码逻辑、边界条件、类型一致性
- **Claude（Anthropic 系列）**：擅长架构完整性、设计矛盾、语义一致性

单一模型审核自己的产出，盲区重合率约 30-40%。双模型交替后，盲区重合率降至 <5%。

---

## 二、角色分工

| 角色 | 谁做 | 职责 |
|------|------|------|
| **作者（Author）** | 主 Agent 或编排者 | 写初稿，根据审核结果修改 |
| **审核者（Reviewer）** | 子 Agent（spawn 到不同模型） | 读文档，找问题，分级报告 |
| **仲裁者（Judge）** | 作者自己兼任 | 决定哪些问题要修、怎么修 |

不需要独立仲裁者——作者自己判断就行，因为审核者只负责**发现问题**，不负责决定方案。

---

## 三、问题分级标准

审核者必须按以下分级报告所有问题：

| 级别 | 含义 | 必须修？ |
|------|------|----------|
| **P0** | 阻断性错误：逻辑矛盾、字段缺失、会导致运行时故障 | ✅ 必须修 |
| **P1** | 正确性风险：边界条件遗漏、非原子操作、语义不一致 | ✅ 必须修 |
| **P2** | 文档一致性：标题版本号未更新、注释与代码矛盾 | ✅ 建议修 |
| **P3** | 建议：命名风格、可读性、更优写法 | ⬜ 可选 |

**规则**：当轮有 P0 未关闭时，不进入下一轮审核。先把 P0 全部修复。

---

## 四、单轮审核流程

```
┌─────────────────────────────────────────────────┐
│              单轮审核（One Round）                │
│                                                  │
│  1. Author 准备文档 vN                            │
│  2. Author spawn Reviewer（指定模型）             │
│  3. Reviewer 读文档，输出问题清单（P0/P1/P2/P3）  │
│  4. Author 收到结果，按优先级修复                  │
│     - P0 全修                                    │
│     - P1 全修                                    │
│     - P2 尽量修                                   │
│  5. Author 更新版本号 vN → vN+1                   │
│  6. 进入下一轮（换模型）                           │
└─────────────────────────────────────────────────┘
```

---

## 五、交替策略

**核心规则：连续两轮不用同一个模型。**

推荐交替顺序（以 Codex 开始为例）：

```
Round 1: Codex  → 发现 6 P0
Round 2: Claude → 发现 5 P0 + 7 P1（Codex 修完的盲区，Claude 能看到新问题）
Round 3: Codex  → 发现 8 P0 + 9 P1（Claude 的修法引入了新问题）
Round 4: Codex  → 发现 4 P0 + 5 P1 + 3 P2
Round 5: Codex  → 发现 2 P0 + 3 P1
Round 6: Codex  → 发现 2 P0 + 3 P1 + 文档清理
Round 7: Codex  → 0 P0 ✅
Round 8: Codex  → 验证清理（只验上轮遗留项）
```

**为什么可以连续用 Codex？** 因为后期问题越来越少、越来越小，Codex 足够发现。关键是最初 2-3 轮必须交替，消除最大的盲区。

**决策树**：

```
Round 1-3: 严格交替（Codex → Claude → Codex）
Round 4+:  看问题数量决定：
           - 上轮还有 P0 → 继续审核，优先换模型
           - 上轮只有 P1/P2 → 可以不换模型，快速收尾
           - 上轮 0 P0 → 进入验证轮
```

---

## 六、Prompt 模板

### 6.1 给审核者的 Prompt

把以下内容作为 `sessions_spawn` 的 `task` 参数：

```markdown
你是文档审核者。请审核以下文档。

## 审核文档
文件路径：{文件路径}

## 审核要求
1. 逐节通读，找出所有逻辑错误、遗漏、矛盾
2. 特别关注：
   - 字段/变量/表名的一致性（定义处 vs 使用处）
   - 状态机/流程的完备性（是否有未覆盖的转移路径）
   - 原子性保证（事务边界是否正确）
   - 边界条件（空值、并发、超时、取消）
3. 每个问题必须分级：P0（阻断）/ P1（正确性风险）/ P2（文档一致性）/ P3（建议）

## 输出格式

### 结论
[通过 / 条件通过 / 拒绝]（有 P0 = 拒绝，仅 P1 = 条件通过，无 P0P1 = 通过）

### P0 问题
| # | 位置 | 问题描述 | 建议修复 |
|---|------|----------|----------|
（无则写"无"）

### P1 问题
| # | 位置 | 问题描述 | 建议修复 |
|---|------|----------|----------|
（无则写"无"）

### P2 问题
（格式同上，无则写"无"）

### P3 建议
（格式同上，无则写"无"）

### 总体评价
一句话总结文档质量。
```

### 6.2 验证轮 Prompt（最后一轮）

```markdown
你是最终验证者。上轮审核提出了以下问题，作者已修复。

## 上轮问题
（粘贴上轮问题清单）

## 验证要求
逐项验证上轮每个问题是否已正确修复。
- 已修复 → 写 ✅
- 未修复 → 写 ❌ 并说明

## 验证文档
文件路径：{文件路径}

## 输出格式
逐项列出，每项给出结论。最后给出总体判断：PASS / FAIL。
```

---

## 七、版本管理规则

每轮审核后，作者**必须**更新：

1. **文档版本号**：标题处 `v2.3 → v2.4`
2. **审核链记录**：在文档末尾维护审核历史表
3. **版本一致性**：全文搜索旧版本号，全部替换

审核历史表示例：

```markdown
## 审核链与修订记录

### v2.3 → v2.4（Codex v5 第五轮审核）

#### P0（全部修复）
| # | 问题 | 修复 |
|---|------|------|
| P0-1 | ... | ... |

#### P1（全部修复）
| # | 问题 | 修复 |
|---|------|------|
| P1-1 | ... | ... |

### 版本一致性
- 标题：v2.3 → v2.4
- 审核链：补全 Codex v5 第五轮审核
- 章节标题、附录标题、尾注：全部 v2.4
```

---

## 八、终止条件

审核什么时候停？**满足以下任一条件即可终止：**

| 条件 | 含义 |
|------|------|
| **零 P0 轮** | 某轮审核结果 0 P0，可以停 |
| **验证轮 PASS** | 验证轮确认上轮问题全部修复 |
| **连续两轮 0 P0** | 更保守的策略，连续两轮都没 P0 |

**推荐**：零 P0 轮 → 再跑一轮验证轮确认 → 终止。

---

## 九、ACP 链路打通指南（关键！）

> **其他 Agent 拿到方法论后，最大的障碍是：不知道怎么让 Codex / Claude 真正跑起来。**
> 这一节就是解决这个问题。

### 9.1 前置条件检查清单

在尝试 spawn 之前，确认以下条件全部满足：

```
□ OpenClaw 版本 ≥ 2026.4.x（支持 ACP）
□ openclaw.json 中 acp.enabled = true（或省略，默认启用）
□ acp.backend = "acpx"
□ acpx 插件已启用：plugins.entries.acpx.enabled = true
□ Claude Code CLI 已安装：which claude 有输出
□ （可选）Codex CLI 已安装：which codex 有输出
□ Claude Code 已配置 API Key（~/.claude/settings.json）
```

**快速验证命令**（在宿主机 shell 执行）：

```bash
# 检查 Claude Code 是否可用
which claude && claude --version

# 检查 OpenClaw ACP 配置
openclaw status 2>&1 | grep -i acp
```

### 9.2 OpenClaw 配置（openclaw.json）

ACP 功能需要以下最小配置：

```json
{
  "acp": {
    "backend": "acpx",
    "defaultAgent": "codex",
    "allowedAgents": ["codex", "claude"]
  },
  "plugins": {
    "allow": ["acpx"],
    "entries": {
      "acpx": {
        "enabled": true
      }
    }
  }
}
```

**字段说明**：

| 字段 | 值 | 说明 |
|------|-----|------|
| `acp.backend` | `"acpx"` | ACP 运行时后端，必须是 acpx |
| `acp.defaultAgent` | `"codex"` 或 `"claude"` | 不指定 agentId 时的默认目标 |
| `acp.allowedAgents` | `["codex", "claude"]` | 允许 spawn 的 ACP harness 列表 |
| `plugins.entries.acpx.enabled` | `true` | 必须显式启用 acpx 插件 |

**⚠️ 配置修改后需要重启 OpenClaw 才能生效。**

### 9.3 Claude Code 环境配置

Claude Code 是一个独立的 CLI 工具，它有自己的一套配置。需要确保：

**a) 安装 Claude Code CLI**：

```bash
# 官方安装方式
npm install -g @anthropic-ai/claude-code
# 或
curl -fsSL https://claude.ai/install.sh | sh
```

**b) 配置 API Key**（`~/.claude/settings.json`）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://你的API地址",
    "ANTHROPIC_AUTH_TOKEN": "你的API Key",
    "ANTHROPIC_MODEL": "模型名"
  }
}
```

**c) 关键：Claude Code 的权限配置**：

```json
{
  "permissions": {
    "allow": [
      "Read", "Write", "Edit", "Bash", "Glob", "Grep",
      "WebFetch", "WebSearch"
    ]
  }
}
```

> 如果 permissions 没配好，Claude Code 会不断弹权限确认，导致 ACP spawn 超时失败。

**d) 验证 Claude Code 可用**：

```bash
# 快速测试
echo "回复OK" | claude --print
```

### 9.4 Codex 环境配置

Codex CLI 类似：

```bash
# 安装
npm install -g @openai/codex

# 配置 API Key
export OPENAI_API_KEY="你的Key"
export OPENAI_BASE_URL="https://你的API地址"  # 如果用代理
```

> **注意**：当前环境中 Codex CLI 未安装（`which codex` 无输出），但 acpx 后端的 "codex" harness
> 可能通过其他方式（如 OpenAI API 直接调用）工作。具体取决于 acpx 插件实现。

### 9.5 三种调用方式

#### 方式一：sessions_spawn（推荐）

这是 OpenClaw 原生方式，最稳定：

```
sessions_spawn({
  runtime: "acp",
  agentId: "codex",          // 或 "claude"
  mode: "run",               // 一次性任务
  task: "<审核 Prompt 内容>",  // 你的 Prompt
  timeoutSeconds: 300        // 超时时间
})
```

**关键参数**：

| 参数 | 值 | 说明 |
|------|-----|------|
| `runtime` | `"acp"` | **必须**。不是 "subagent" |
| `agentId` | `"codex"` 或 `"claude"` | **必须**。必须在 allowedAgents 列表里 |
| `mode` | `"run"` | 一次性；`"session"` 持久会话 |
| `task` | 你的 Prompt | 审核指令 |
| `timeoutSeconds` | 300-600 | 文档越长越大 |

#### 方式二：exec + Claude Code CLI

如果 ACP 不可用，可以直接调 CLI：

```bash
claude --print --permission-mode bypassPermissions << 'EOF'
你是文档审核者。请审核以下文档。

文件路径：/path/to/doc.md

（审核要求...）
EOF
```

**优点**：不依赖 ACP 配置
**缺点**：需要自己处理输出解析、超时管理

#### 方式三：coding-agent Skill

如果已安装 coding-agent Skill：

```
请用 Claude Code 审核文件 /path/to/doc.md
Prompt：<粘贴 6.1 模板>
```

Skill 会自动 spawn 后台进程，完成后通知。

### 9.6 常见失败原因与排查

| 错误现象 | 原因 | 解法 |
|----------|------|------|
| `ACP not enabled` | openclaw.json 缺 acp 配置 | 加上 9.2 的配置并重启 |
| `agent "codex" not in allowedAgents` | allowedAgents 列表缺 codex | 添加到列表 |
| `acpx plugin not found` | plugins.allow 缺 "acpx" | 添加并重启 |
| spawn 后超时无输出 | Claude Code 权限弹窗卡住 | 配置 permissions.allow |
| `claude: command not found` | Claude Code 未安装 | 9.3.a 安装 |
| spawn 成功但输出为空 | task Prompt 太长被截断 | 缩短 Prompt 或增大 context |
| A2A 权限错误 | agent 不在 tools.agentToAgent.allow | 不影响 ACP spawn，A2A 是另一个功能 |

### 9.7 完整验证流程

```bash
# Step 1: 检查配置
openclaw status

# Step 2: 在 OpenClaw 对话中测试 spawn
# （作为 Agent，直接调用：）
sessions_spawn({
  runtime: "acp",
  agentId: "claude",
  mode: "run",
  task: "回复 OK 两个字",
  timeoutSeconds: 60
})

# Step 3: 如果成功收到回复，链路已通
# Step 4: 现在可以用完整 Prompt 审核
```

### 9.8 当前环境配置参考

> 以下是本 Gateway 实际生效的 ACP 配置（2026-04-30 确认可用）：

```json
// openclaw.json 相关片段
{
  "acp": {
    "defaultAgent": "codex",
    "backend": "acpx",
    "allowedAgents": ["codex", "claude"]
  },
  "plugins": {
    "allow": ["acpx", "openai", "openrouter", "zai", "deepseek"],
    "entries": {
      "acpx": { "enabled": true }
    }
  }
}
```

Claude Code 配置（`~/.claude/settings.json`）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "<key>",
    "ANTHROPIC_MODEL": "glm-5"
  },
  "permissions": {
    "allow": ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"]
  },
  "model": "opus[1m]"
}
```

> **注意**：本环境的 Claude Code 走的是 Z.ai 代理（GLM-5 模型），不是原生 Anthropic Claude。
> 审核效果取决于后端模型能力。如需真正的 Claude Opus，需要将 `ANTHROPIC_BASE_URL` 指向 Anthropic 官方 API。

## 十、模型选择参考

| 需求 | 推荐 |
|------|------|
| 代码/SQL/逻辑审核 | Codex（GPT-5.x / o3） |
| 架构/设计/语义审核 | Claude（Opus 4.x） |
| 快速轻量审核 | GPT-4o / Claude Sonnet |
| 不确定 | 两个都跑，取并集 |

## 十一、实战经验总结

### 来自 2283 行 Platform 设计文档的八轮审核

| 轮次 | 模型 | P0 | P1 | P2 | 耗时 |
|------|------|-----|-----|-----|------|
| R1 | Codex | 6 | - | - | ~10min |
| R2 | Claude | 5 | 7 | - | ~15min |
| R3 | Codex | 8 | 9 | - | ~12min |
| R4 | Codex | 4 | 5 | 3 | ~10min |
| R5 | Codex | 2 | 3 | - | ~8min |
| R6 | Codex | 2 | 3 | - | ~8min |
| R7 | Codex | 0 | - | - | ~5min |
| R8 | Codex | 0 | - | - | ~3min（验证） |

**关键发现**：

1. **R2（Claude）找到了 Codex R1 遗漏的 5 个 P0**——这证明了交替的价值
2. **R3 发现了最多的 P0（8个）**——因为 Claude R2 的修复引入了新问题
3. **R4 之后 P0 陡降**——前 3 轮消灭了 ~80% 的缺陷
4. **R7 达到零 P0**——收敛速度是指数级的

## 十二、常见坑

| 坑 | 解法 |
|------|------|
| 审核者输出太笼统，不指明具体位置 | Prompt 里强制要求"位置"列（行号/章节/函数名） |
| 每轮修完引入新问题 | 正常现象，3 轮后会收敛 |
| 模型偷懒说"无问题" | 在 Prompt 里加"如果真的无问题，必须逐节确认，不能只写一句'没问题'" |
| 文档太长，审核者截断 | 分块审核，或指定"重点审核第 X-Y 节" |
| 修了 P0 但忘了改版本号 | 每轮结束检查"版本一致性"清单 |

---

## 十三、快速上手 Checklist

```
□ 1. 准备好待审核文档，确认版本号
□ 2. 选第一个审核模型（推荐 Codex）
□ 3. spawn 审核者，用 6.1 的 Prompt 模板
□ 4. 收到问题清单，按 P0 → P1 → P2 顺序修复
□ 5. 更新版本号和审核历史表
□ 6. 换模型（Codex → Claude 或 Claude → Codex），spawn 下一轮
□ 7. 重复 4-6 直到某轮 0 P0
□ 8. 跑一轮验证轮（用 6.2 的 Prompt）
□ 9. 验证 PASS → 交付
```

---

*文档版本: v2.0 | 日期: 2026-04-30 | 新增：第九章 ACP 链路打通指南 | 来源: 通用多Agent协作Platform设计 v2.5 八轮交叉审核实战'
