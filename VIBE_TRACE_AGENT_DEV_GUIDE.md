# Vibe Trace 开发指导文档

本文档用于指导另一个 coding agent 继续开发本项目。目标是把前期脑暴收敛成可执行的产品和技术说明。

## 1. 一句话定位

Vibe Trace 是一个开源、local-first 的 AI coding trace 工具，用统一 schema 记录 Claude Code、Codex、Cursor 等 coding agent 的完整开发过程，并允许用户在本地浏览、搜索、恢复 checkpoint。当用户愿意时，可以上传到闭源服务端进行公开分享、评论和社区交流。

它不是单纯的聊天记录备份工具，而是给 AI 编程过程做一层可回放、可恢复、可分享的记录系统。

## 2. 核心原则

1. 本地优先。
   默认所有数据都保存在本地，不上传聊天记录、代码、终端输出或 trace。

2. 用户明确同意后才上传。
   上传只发生在用户主动选择公开分享、跨设备同步或团队协作时。

3. 本地客户端完全开源。
   采集、解析、schema、本地存储、本地 Web UI、checkpoint、Git 集成都应开源。

4. 服务端闭源。
   服务端承担公开分享、社区、评论、账号、跨设备同步和商业化能力。

5. 统一 schema 优先。
   不要为每个 agent 做孤立的数据结构。所有 agent 通过 adapter 转成统一 Trace Schema。

6. 隐私过滤必须是核心能力。
   上传前在本地过滤一次，服务端公开展示前再过滤一次。

## 3. 目标用户

### 3.1 AI 重度开发者

高频使用 Cursor、Claude Code、Codex 等工具写代码。

主要场景：

- 找回过去某个 bug 的解决过程。
- 复用成功的 prompt 或任务拆解方式。
- 恢复到某个 checkpoint 继续开发。
- 对比不同 agent 的表现。

### 3.2 独立开发者和 vibe coder

经常用 AI 做小产品、demo、工具或游戏。

主要场景：

- 展示完整 vibe coding 过程。
- 把 trace 作为作品集的一部分。
- 分享“我是如何用 AI 做出这个项目”的过程。
- 吸引用户、合作机会或社区关注。

### 3.3 团队开发者

团队内部大量使用 AI 编程，但过程散落在个人本地和聊天窗口里。

主要场景：

- PR 中解释 AI 参与了哪些修改。
- code review 时查看某个 diff 背后的 prompt 和 agent 推理过程。
- 新人 onboarding 时学习项目历史 trace。
- 团队沉淀 prompt、踩坑记录和架构决策。

### 3.4 AI 编程学习者

想学习如何和 coding agent 协作的人。

主要场景：

- 看真实 AI 编程案例。
- 学习 prompt、纠错、拆任务、测试和调试方式。
- 评论提问，和作者交流心得。

### 3.5 技术博主和教程作者

需要把 AI coding 过程变成内容的人。

主要场景：

- 一键生成案例页。
- 把 trace 转成文章素材。
- 展示关键 prompt、diff 和最终结果。

## 4. 整体架构

推荐架构：

```text
Coding Agent
  ↓
Adapter / Parser
  ↓
Unified Trace Schema
  ↓
本地存储
  ↓
本地 Web UI
  ↓
可选上传到服务端
  ↓
公开分享 / 评论 / 社区
```

### 4.1 本地客户端

本地客户端负责：

- 探测和导入 coding agent 历史。
- 将不同 agent 数据转换为统一 Trace Schema。
- 管理本地 trace 数据。
- 启动本地 Web UI，例如 `http://localhost:xxxx`。
- 记录 checkpoint。
- 关联 Git commit、branch、diff、PR、issue。
- 执行上传前隐私扫描和脱敏。
- 将用户明确选择的 trace 上传到服务端。

本地客户端应完全开源。

### 4.2 服务端

服务端负责：

- 用户账号。
- 公开 trace 页面。
- 评论。
- 社区 feed。
- 搜索和发现。
- 用户 profile。
- 可选跨设备同步。
- 可选团队空间。
- 服务端二次隐私扫描和展示前脱敏。

服务端不开源。

## 5. 统一 Trace Schema

统一 schema 是本项目最重要的技术基础之一。

不同来源的数据都要走下面的路径：

```text
Claude Code / Codex / Cursor / Cline / Kiro / Copilot
        ↓
Adapter / Parser
        ↓
Unified Trace Schema
        ↓
本地 UI / Checkpoint / 上传 / 分享 / 评论
```

### 5.1 Schema 需要覆盖的核心对象

建议至少包含以下对象：

- `Trace`
- `TraceSession`
- `TraceMessage`
- `ToolCall`
- `ToolResult`
- `FileChange`
- `GitState`
- `Checkpoint`
- `Artifact`
- `PrivacyFinding`
- `Redaction`
- `PublishMetadata`

### 5.2 Trace 字段建议

```json
{
  "schema_version": "0.1.0",
  "trace_id": "uuid",
  "source": "codex | claude_code | cursor | cline | kiro | copilot | unknown",
  "source_session_id": "string",
  "title": "string",
  "workspace": {
    "name": "string",
    "path": "string",
    "repo_url": "string"
  },
  "started_at": "datetime",
  "ended_at": "datetime",
  "messages": [],
  "tool_calls": [],
  "file_changes": [],
  "checkpoints": [],
  "git": {},
  "metadata": {}
}
```

### 5.3 Message 字段建议

```json
{
  "message_id": "uuid",
  "role": "user | assistant | system | tool",
  "content": "string",
  "created_at": "datetime",
  "model": "string",
  "parent_id": "uuid",
  "tool_call_ids": [],
  "privacy_findings": [],
  "metadata": {}
}
```

### 5.4 Checkpoint 字段建议

```json
{
  "checkpoint_id": "uuid",
  "trace_id": "uuid",
  "label": "登录逻辑跑通",
  "kind": "auto | manual",
  "reason": "before_agent | after_edit | tests_passed | pre_commit | commit | user_marked",
  "created_at": "datetime",
  "git": {
    "repo_root": "string",
    "branch": "string",
    "head_sha": "string",
    "hidden_ref": "refs/vibetrace/trace_id/checkpoint_id",
    "is_dirty": true
  },
  "diff_ref": "string",
  "test_status": "passed | failed | unknown",
  "metadata": {}
}
```

### 5.5 开源仓库中必须高优先级展示 schema

开源客户端仓库应包含：

- JSON Schema。
- TypeScript types。
- 示例 trace 文件。
- adapter 开发指南。
- parser 测试 fixtures。
- 各 agent 支持矩阵。

这样社区开发者可以提交 patch 来适配更多 coding agent。

## 6. Adapter 设计

每个 coding agent 一个 adapter。

Adapter 负责：

- 找到该 agent 的本地数据位置。
- 读取原始聊天历史、工具调用和元数据。
- 解析成统一 Trace Schema。
- 保留 parser 版本。
- 允许格式变化时通过 fixture 做回归测试。

### 6.1 Adapter 接口建议

```ts
interface AgentAdapter {
  source: string;
  detect(): Promise<DetectResult>;
  listSessions(): Promise<SourceSessionSummary[]>;
  importSession(sessionId: string): Promise<Trace>;
  validateRaw?(raw: unknown): Promise<ValidationResult>;
}
```

### 6.2 优先支持顺序

建议 MVP 优先级：

1. Cursor 或既有 `llm-chat-history` 插件数据。
2. Claude Code。
3. Codex。
4. Cline / Kiro / Copilot 等。

如果某个 agent 自动读取成本过高，先支持手动上传。

## 7. 本地 Web UI

用户安装后，应能在本地浏览器中访问 UI。

例如：

```text
http://localhost:4317
```

本地 UI 需要支持：

- 查看所有 trace。
- 搜索 trace。
- 按 agent、workspace、repo、时间过滤。
- 查看单个 trace 的消息时间线。
- 查看 tool call、diff、测试结果。
- 查看和创建 checkpoint。
- 从 checkpoint 恢复到新 worktree。
- 发布前编辑标题、描述、标签、总结。
- 选择隐藏某些消息或 tool output。
- 上传前隐私扫描和脱敏预览。
- 用户确认后上传到服务端。

## 8. Git 和 Checkpoint

Trace 要和 Git 深度结合。

Git 记录“代码变了什么”，Trace 记录“为什么这么变、AI 怎么参与”。

### 8.1 需要记录的 Git 信息

- repo root
- remote URL
- branch
- HEAD commit
- dirty status
- changed files
- diff
- untracked files
- commit message
- PR URL
- issue URL
- test command 和 test result

### 8.2 Checkpoint 创建时机

自动 checkpoint：

- agent session 开始前。
- 用户提交 prompt 后。
- agent 修改文件后。
- 测试通过后。
- commit 前。
- commit 后。
- PR 创建时。

手动 checkpoint：

```text
/trace checkpoint 登录逻辑跑通
/trace save 这个版本可以继续
```

### 8.3 Checkpoint 存储方式

优先使用 Git-native 方式。

推荐：

- 对干净 commit，记录 commit SHA。
- 对未提交修改，创建本地 hidden ref 或保存 patch。
- 对恢复操作，默认创建新 `git worktree`。

示例 hidden ref：

```text
refs/vibetrace/<trace_id>/<checkpoint_id>
```

### 8.4 恢复原则

默认不要覆盖用户当前工作区。

推荐恢复方式：

```bash
git worktree add ../project-vibetrace-<checkpoint_id> <checkpoint_sha>
```

如果 checkpoint 包含未提交 diff，则在新 worktree 中应用 patch。

## 9. 嵌入 Codex / Claude Code

不要试图一开始改造 agent 本体。优先通过已有扩展入口接入。

### 9.1 Hooks

Hooks 用于自动记录。

适合记录：

- session start
- user prompt submit
- tool use
- file edit
- command output
- agent stop

Hooks 是“确定会发生”的记录器，不依赖 agent 主动想起来。

### 9.2 MCP

做一个 Vibe Trace MCP server，让 agent 可以主动调用：

- `vibetrace.start_trace`
- `vibetrace.create_checkpoint`
- `vibetrace.list_checkpoints`
- `vibetrace.restore_checkpoint`
- `vibetrace.publish_trace`
- `vibetrace.attach_pr`

MCP 是 agent 可见的工具层。

### 9.3 Slash Command / Custom Command

给用户主动控制入口。

建议命令：

```text
/trace start
/trace checkpoint
/trace restore
/trace publish
/trace status
```

### 9.4 Plugin / Skill

Codex 侧可以做 plugin，把 hooks、MCP 配置、skills 打包。

Claude Code 侧可以用 hooks、custom commands、MCP、skills 组合。

目标安装体验：

```bash
vibetrace install codex
vibetrace install claude-code
```

## 10. 隐私和安全

这是产品信任的核心。

### 10.1 两层过滤

上传服务端时必须做两层过滤：

```text
本地扫描
  ↓
用户确认
  ↓
上传前脱敏
  ↓
服务端二次扫描
  ↓
展示前脱敏
```

### 10.2 本地上传前过滤

客户端上传前必须扫描：

- API key
- access token
- SSH key
- private key
- `.env` 内容
- cookie
- session
- 数据库连接串
- webhook URL
- 内网 IP
- 内网域名
- 邮箱
- 手机号
- 本地绝对路径
- 私有 repo 地址
- 公司或客户敏感名称

用户必须看到扫描结果并确认。

示例：

```text
检测到 8 处疑似敏感信息
- 2 个 API key
- 1 个数据库连接串
- 3 个本地路径
- 2 个邮箱
```

### 10.3 服务端展示前过滤

即使客户端已经过滤，服务端公开展示前仍要再次扫描。

原因：

- 客户端版本可能过旧。
- 用户可能绕过客户端上传。
- 某些 adapter 可能漏掉。
- 后续会发现新的 secret pattern。

### 10.4 脱敏策略

尽量替换敏感值，不要整段删除。

示例：

```text
sk-xxxxxxx → [REDACTED_API_KEY]
postgres://user:pass@host/db → [REDACTED_DATABASE_URL]
/Users/clark/Project/foo → [REDACTED_LOCAL_PATH]
```

这样能保留 trace 可读性。

## 11. 服务端能力

服务端是闭源商业化部分。

MVP 服务端需要：

- 用户注册和登录。
- 上传公开 trace。
- 公开 trace 页面。
- trace 评论。
- message-level 评论。
- 用户 profile。
- explore feed。
- report / hide / delete 基础审核能力。

### 11.1 上传 API 建议

```http
POST /api/traces/upload
```

要求：

- 必须认证。
- 只接受通过 schema 校验的数据。
- 服务端必须再次执行隐私扫描。
- 存储原始上传前，应明确区分 raw、redacted、public view。

### 11.2 公开页面

公开 trace 页面应展示：

- 标题。
- 作者。
- agent 来源。
- 技术栈标签。
- 任务类型。
- outcome。
- 消息时间线。
- 关键 diff。
- checkpoint 信息。
- 评论。

## 12. MVP 范围

MVP 要验证两个问题：

1. 用户是否愿意本地记录和浏览 AI coding trace。
2. 用户是否愿意选择部分 trace 上传公开分享，并让别人评论。

### 12.1 MVP 必做

- 统一 Trace Schema。
- 至少一个可用 adapter。
- 本地存储。
- 本地 Web UI。
- trace 列表和详情页。
- Git 信息采集。
- 手动 checkpoint。
- 从 checkpoint 恢复到新 worktree。
- 上传前隐私扫描。
- 服务端公开 trace 页面。
- trace 评论。

### 12.2 MVP 暂不做

- 团队空间。
- 付费计划。
- 高级权限。
- 完整多 agent 自动导入。
- 复杂推荐系统。
- 向量搜索。
- 自动生成长文章。
- 企业私有化部署。

## 13. 推荐开发顺序

### 阶段 1：本地基础

目标：能导入一个 trace，并在本地浏览器查看。

任务：

- 定义 Trace Schema。
- 实现本地数据目录。
- 实现第一个 adapter。
- 实现本地 Web server。
- 实现 trace 列表和详情页。

验收：

- 用户运行本地客户端后能打开 localhost UI。
- UI 能展示至少一个真实或 fixture trace。

### 阶段 2：Git 和 Checkpoint

目标：让 trace 关联代码状态。

任务：

- 采集 repo、branch、HEAD、diff。
- 实现手动 checkpoint。
- 实现 hidden ref 或 patch 保存。
- 实现恢复到新 worktree。

验收：

- 用户可以在 UI 中看到 checkpoint。
- 用户可以从 checkpoint 创建新 worktree。

### 阶段 3：隐私过滤

目标：上传前可放心预览。

任务：

- 实现 secret scanner。
- 在 UI 中展示风险项。
- 实现一键脱敏。
- 实现选择隐藏消息和 tool output。

验收：

- 测试 fixture 中的 token、数据库连接串、本地路径能被识别。
- 用户可以看到脱敏后的预览。

### 阶段 4：上传和公开分享

目标：形成社区分享闭环。

任务：

- 实现服务端上传 API。
- 服务端二次扫描。
- 公开 trace 页面。
- 评论。
- message-level 评论。

验收：

- 用户可以从本地 UI 上传一个脱敏 trace。
- 其他人可以访问公开页面并评论。

### 阶段 5：Codex / Claude Code 集成

目标：让记录过程更自动。

任务：

- 设计 hooks 安装器。
- 实现基本 MCP server。
- 支持 `/trace checkpoint` 等命令。
- 打包成 Codex plugin 或 Claude Code 配置。

验收：

- agent session 过程中能自动产生 trace event。
- 用户能用命令创建 checkpoint。

## 14. 非目标

短期不要把产品做成：

- 纯聊天记录云备份。
- 纯社区论坛。
- 纯 prompt 分享站。
- 纯 Git 可视化工具。
- 只支持某一个 agent 的封闭工具。

真正目标是：

```text
AI coding 过程记录 + 本地恢复 + 可选公开分享
```

## 15. 给开发 Agent 的执行提醒

开发时优先保证：

1. 数据结构清晰。
2. 本地默认安全。
3. 上传必须显式确认。
4. schema 和 adapter 易扩展。
5. checkpoint 恢复不能破坏当前工作区。
6. 隐私扫描不能只做服务端，也不能只做客户端。
7. 本地开源客户端和闭源服务端边界要清楚。

如果需要取舍，优先级如下：

```text
Schema > 本地导入 > 本地查看 > Git checkpoint > 隐私过滤 > 上传分享 > 社区评论
```

## 16. 最终产品判断

Vibe Trace 可以被理解为：

```text
AI 编程过程的 GitHub + Time Machine + 社区展示层
```

GitHub 展示代码结果，Vibe Trace 展示 AI 参与开发的过程。

Time Machine 让用户回到某个 AI 开发节点。

社区展示层让其他人学习、评论和复盘真实 vibe coding 案例。

