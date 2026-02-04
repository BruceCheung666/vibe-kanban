# Codex 多代理集成实现方案

## 背景与目标

Vibe Kanban 已支持 Codex 执行，但目前未显式开启或展示 Codex 的 multi-agent（collab）能力。目标是在不破坏现有单代理体验的前提下，提供可配置、可观测、可审阅的多代理执行能力。

## 现状梳理（基于代码）

- `crates/executors/src/executors/codex.rs` 仅在 `build_new_conversation_params` 里传入基础字段（model、sandbox、approval_policy 等），没有 multi-agent 配置入口。
- `crates/executors/src/executors/codex/normalize_logs.rs` 能识别 `EventMsg::Collab*` 事件，但目前全部忽略，导致多代理日志不可见。
- `crates/executors/src/logs/mod.rs` 的 `NormalizedEntry` 没有 actor/agent 维度字段，前端无法区分主代理与子代理。
- 前端会话渲染（`frontend/src/components/ui-new/containers/NewDisplayConversationEntry.tsx` 与 `frontend/src/components/NormalizedConversation/DisplayConversationEntry.tsx`）只基于 `entry_type` 绘制，没有多代理标签。
- 配置 UI 依赖 `shared/schemas/*.json`（由 `pnpm run generate-types` 生成），因此新增 Codex 配置字段即可自动出现在设置面板。

## 设计原则

- **兼容性**：多代理为可选配置，未开启时行为完全一致。
- **可观测性**：多代理生命周期、消息与工具调用都要可回溯。
- **最小侵入**：不改动通用执行流程，仅补充配置与日志归一化。
- **版本一致性**：Rust 协议与 `npx @openai/codex` 版本需同步。

## 方案总览

1. 在 Codex 配置结构中引入 multi-agent 配置字段。
2. 将配置映射到 Codex `NewConversationParams`（或 config overrides）。
3. 解析 Collab 事件，写入带 actor 的 `NormalizedEntry`。
4. 前端渲染 actor 标签，并在工具审批中展示来源。
5. 更新类型、schema 与文档。

## 详细实现

### 1) 配置模型扩展

新增结构建议放在 `crates/executors/src/executors/codex.rs`：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
pub struct CollabConfig {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<Vec<CollabAgent>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_parallel: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>, // e.g. "parallel" | "phased"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share_context: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
pub struct CollabAgent {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
}
```

并在 `Codex` 结构新增字段：

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub collab: Option<CollabConfig>,
```

> 具体字段需与 Codex 协议匹配（见“开放问题”）。

配置示例（`profiles.json`）：

```json
{
  "executors": {
    "CODEX": {
      "DEFAULT": {
        "CODEX": {
          "sandbox": "danger-full-access",
          "collab": {
            "enabled": true,
            "max_parallel": 2,
            "strategy": "parallel",
            "agents": [
              { "name": "planner", "role": "planning" },
              { "name": "reviewer", "role": "review" }
            ]
          }
        }
      }
    }
  }
}
```

### 2) 启动参数映射

在 `crates/executors/src/executors/codex.rs` 的 `build_new_conversation_params` 中传入 multi-agent 配置：

- 若 Codex 协议已有显式字段（例如 `collab`），直接赋值。
- 若协议仅支持 config overrides，则将 `collab` 写入 `config` map。

同时确保 `resume_conversation` 的 overrides 包含相同配置，避免 follow-up 失效。

### 3) 日志归一化与 actor 传递

#### 3.1 增加 actor 字段

在 `crates/executors/src/logs/mod.rs`：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ActorInfo {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>, // "main" | "collab"
}

pub struct NormalizedEntry {
    ...
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<ActorInfo>,
}
```

#### 3.2 处理 Collab 事件

在 `crates/executors/src/executors/codex/normalize_logs.rs`：

- 维护 `LogState`：
  - `actors: HashMap<String, ActorInfo>`
  - `active_actor_id: Option<String>`
- 解析事件：
  - `CollabAgentSpawnBegin/End`：注册/更新 actor，并生成 `SystemMessage` 提示（例如“collab agent planner started”）。
  - `CollabAgentInteractionBegin/End`：切换 `active_actor_id`，影响后续 `AgentMessage/AgentReasoning` 的 `actor`。
- 对 `AgentMessage`/`AgentReasoning` 输出的 `NormalizedEntry` 附带 `actor`。

> 若协议在消息事件中直接携带 `agent_id`，优先使用事件字段，不依赖 `active_actor_id`。

### 4) 前端展示

在以下位置渲染 actor 标签（若 `entry.actor` 存在）：

- `frontend/src/components/ui-new/containers/NewDisplayConversationEntry.tsx`
- `frontend/src/components/NormalizedConversation/DisplayConversationEntry.tsx`
- `frontend/src/components/ui-new/primitives/conversation/ChatAssistantMessage.tsx`
- `frontend/src/components/ui-new/primitives/conversation/ChatSystemMessage.tsx`
- `frontend/src/components/ui-new/primitives/conversation/ChatThinkingMessage.tsx`

UI 建议：

- 主代理显示 “Assistant”，子代理显示 “Collab: {name/role}”。
- 子代理消息可用淡色徽标或左侧图标区分。

### 5) 审批展示（可选）

如果子代理会触发工具审批，建议在审批卡片中展示 `actor`：

- 在 `NormalizedEntry` 的 `ToolUse` 渲染处附加 actor 标签。
- `ToolCallMetadata` 可选扩展 `actor_id` 以追踪来源。

### 6) 类型与 schema 更新

修改 Rust 类型后执行：

```bash
pnpm run generate-types
```

这会更新：

- `shared/types.ts`
- `shared/schemas/codex.json`

前端 JSON Schema 表单会自动显示新字段。

### 7) 文档补充

建议更新：

- `docs/agents/openai-codex.mdx`：新增 multi-agent 配置说明
- `docs/configuration-customisation/agent-configurations.mdx`：示例配置片段

## 测试计划

1. **单元测试**（建议新增）  
   - 在 `crates/executors/src/executors/codex/normalize_logs.rs` 添加样例 Collab 事件日志，断言 actor 标注与系统提示。
2. **回归**  
   - 单代理 session：日志与 UI 不变化。
3. **联调**  
   - 开启多代理配置，确认：
     - Collab agent 生命周期可见
     - 子代理消息带标签
     - 审批显示来源

## 风险与开放问题

- **协议字段确认**：需要核对 `codex_app_server_protocol::NewConversationParams` 是否已有 `collab` 字段；如无则需升级 codex Rust 依赖与 `npx @openai/codex` 版本。
- **事件格式差异**：`EventMsg::Collab*` 具体字段可能变化，需对齐实际事件结构。
- **token 使用统计**：子代理 token 统计是否要独立展示，当前仅聚合在主会话。

## 里程碑建议

1. 类型与配置扩展（Rust + schema）  
2. 参数映射与多代理启动  
3. 日志归一化 + UI actor 展示  
4. 文档与测试完善
