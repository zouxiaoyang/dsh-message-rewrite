# dsh-message-rewrite

[![npm](https://img.shields.io/npm/v/dsh-message-rewrite)](https://www.npmjs.com/package/dsh-message-rewrite)
[![GitHub](https://img.shields.io/github/stars/zouxiaoyang/dsh-message-rewrite)](https://github.com/zouxiaoyang/dsh-message-rewrite)

> **DeepSeek Harness（DSH）消息原地编辑插件** —— Codex 风格：hover 历史用户消息 → ✎ 编辑 → 同会话从编辑点截断旧回复并重新生成。

适用于 DeepSeek Harness 桌面 App / Web（DSH profile 插件体系，Cordis bundle 双半包：host `index.js` + client `client.js`）。

## 功能

- **消息原地编辑**：鼠标 hover 自己发过的任意用户消息 → 出现「✎ 编辑」按钮。
- **精致浮层编辑器**：点击后弹出居中玻璃拟态卡片，预填原内容，可反复编辑（编辑链），支持 Esc 取消 / ⌘Enter 发送 / 字数统计 / loading 状态。
- **Codex 式截断重生成**：发送后，被编辑消息及其后的旧回复从**消息表面（surface）**被替换（`surfaceOp: replace`），同一会话从编辑点重新生成——不开新会话。
- **编辑链**：编辑过的消息可以继续再编辑（A → B → C…），只显示最终版本。
- **中间消息自动 fork**：编辑的若是中间消息（其后还有更新的用户消息），自动 fork 新会话改写，不误伤后续对话。
- **虚拟滚动兼容**：按钮/气泡经 uuid 精确绑定，长会话、虚拟列表复用均不错位。
- 深色/浅色主题自适应。

## 安装

### 方式 A：profile bundle（推荐，与官方插件一致）

1. 把本仓库 `index.js`、`client.js`、`cordis.patch.yml` 放到你的 DSH profile 插件目录，例如：
   ```bash
   # 桌面 App profile 通常为 ~/.dsh/profiles/web
   PLUGIN_DIR=~/.dsh/profiles/web/plugins/dsh-message-rewrite
   mkdir -p "$PLUGIN_DIR"
   cp index.js client.js cordis.patch.yml package.json "$PLUGIN_DIR/"
   ```
2. 在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 加入：
   ```json
   "dsh-message-rewrite": "file:./plugins/dsh-message-rewrite"
   ```
   在 `dsh.profile.bundles` 数组加入：`"dsh-message-rewrite"`
3. 安装依赖并重启 DSH server（如 `~/bin/dsh-server-restart`），刷新页面。

### 方式 B：从 npm 安装（已发布）

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-message-rewrite
# 并把 "dsh-message-rewrite" 加入 package.json 的 dsh.profile.bundles
bash ~/bin/dsh-server-restart   # 重启后刷新页面
```

> ⚠️ `cordis.patch.yml` 通过 bundle 通道自动加载；**请勿**再在主 `cordis.patch.yml` 重复 insert 本插件，否则 webserver 会因 `duplicate prefix route /dsh-rewrite` 启动崩溃。

## 使用

1. 打开任意会话，把鼠标移到一条**用户消息**上（你自己的消息）。
2. 点击行尾的 **✎ 编辑**。
3. 在浮层里修改文本，按 **发送并重新生成**（或 ⌘Enter）。
4. 该消息之后被替换的旧回复会被隐藏，编辑后的内容气泡 + 新生成的回复出现在原位置。
5. 编辑后的内容气泡 hover 会出现「✎ 再次编辑」，可继续形成编辑链。

> Agent 运行中提交会提示「请先等待本轮结束」（不静默吞点击）。编辑中间消息会自动 fork 到新会话。

## 工作原理（适配 DSH 内核 0.1.2-rc.1）

- **host**（`index.js`，CJS，inject `connection` + `agents`）
  - RPC `/dsh-rewrite/list`：列出会话 surface 上可编辑的用户消息（seq + 文本 + id + rewrite 元数据）。
  - RPC `/dsh-rewrite/rewrite`：校验 agent idle → 构造带 `source.rewrite` 的新 user message → `agent.followup()` 入 inbox 唤醒 driver → 在 `agent/pre-step`（prepend）拦截该消息的 append，包成 `surfaceOp:{op:"replace", start, end}` + `sourceEventSeqs`，旧尾部从表面移除（审计日志保留）。
- **client**（`client.js`）：`__ModuleLoader__` 加载的 web 客户端；扫描官方消息列表（`data-chat-flow-kind="user"` + `data-chat-anchor-key`），用 uuid 与 host list 精确对齐挂 ✎ 按钮；自绘「✎ 已编辑」气泡（双锚点定位，兼容虚拟滚动）；被 replace shadow 的旧行打 `data-message-rewrite-discarded` 隐藏。

## 关键内核 API（0.1.2-rc.1 实测）

- `ctx.on("agent/pre-step", ({agent, messages, signal}, next), {prepend:true})`
- `agent.session.append(type, data, {surfaceOp:{op:"replace",start,end}, sourceEventSeqs})`
- `agent.followup(msg)` = inbox "next-turn" 插入 + wakeDriver
- `agent.status`（idle/running）、`agent.session.surface.nodes`、`agent.session.events`
- `createUserMessage` from `@deepseek-ai/dsh-llm`（ESM，host 动态 `import`）

## 卸载

1. 从 `~/.dsh/profiles/web/package.json` 移除依赖与 `dsh.profile.bundles` 条目。
2. 删除 `plugins/dsh-message-rewrite` 目录（如已软链进 `node_modules` 一并删除）。
3. 重启 DSH server 并刷新页面。

## 已知边界

- 只对「用户消息」行挂编辑按钮；AI 回复行暂不支持编辑（可扩展「重新生成」）。
- 依赖 DSH 桌面 App / Web 的 profile 插件体系（Cordis + `__ModuleLoader__`），非独立 CLI。
- 内核 API 随 DSH 版本演进可能变化（适配目标：0.1.2-rc.1）。

## License

MIT
