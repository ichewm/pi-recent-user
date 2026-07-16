# pi-recent-user

> pi 扩展：在编辑器上方常驻一个 widget，显示你**最近几轮输入的内容**。长期会话离开很久回来，不用往上翻就能接上"最近都在聊什么"。

## 解决什么问题

一个 pi 会话用久了会有很多轮对话。中途离开很久再回来时，屏幕上是 LLM 最近一轮的思考过程和回答，**往上翻半天找不到"最近这一轮我自己问了什么"**，接不上上下文。

本插件在编辑器上方放一个常驻 widget，始终显示最近 N 条 user 输入，回来一眼就接上。

## 效果

编辑器上方会常驻显示（示例）：

```
📝 最近你在问：
· 帮我看一下登录模块的 token 刷新逻辑
· Redis 有哪些典型应用场景
▶ 设计一个秒杀系统要考虑哪些点
```

最新一条用 `▶` 标记，更早的用 `·`。

## 安装

三种方式任选：

```bash
# 1. 本地路径（开发/自用）
pi install /path/to/pi-recent-user

# 2. GitHub
pi install git:github.com/<你的用户名>/pi-recent-user@v0.1.0
# 或不锁版本：
pi install https://github.com/<你的用户名>/pi-recent-user

# 3. npm
pi install npm:pi-recent-user
```

装好后**任何 pi 启动都自动加载**，不用 `-e`。卸载：`pi remove <上面用的源>`。

> 安装/卸载不需要重启 pi 之外的操作。注意：改了 skill 等启动时加载的资源，需要 `Ctrl+D` 退出 pi 再重开（`/reload` 不重建当前会话的 system prompt）。

## 用法

装上就自动工作，无需配置。提供一个命令调整：

| 命令 | 作用 |
|---|---|
| `/recent` | 查看当前状态（显示/隐藏、条数） |
| `/recent on` / `/recent off` | 显示 / 隐藏 widget |
| `/recent 5` | 设置显示最近 5 条（范围 1~10） |

**所有调整都会持久化**（写入配置文件），重启 pi 后保留。

## 配置

配置存在插件自己的文件：`~/.pi/agent/pi-recent-user.json`

**不写入 pi 的 `settings.json`**（符合 pi 生态惯例，避免安装/卸载时遗留配置）。首次运行无此文件、用默认值；`/recent` 调整后才会生成。

字段：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `count` | number | `3` | 显示最近几条 user 输入（1~10，超范围自动 clamp） |
| `maxLine` | number | `70` | 每条最多显示的宽度（终端列数），超出截断加 `…`（范围 10~200） |
| `show` | boolean | `true` | 是否显示 widget |

示例：

```json
{
  "count": 5,
  "maxLine": 80,
  "show": true
}
```

想改默认值（不想用 `/recent` 调），直接编辑代码 `src/index.ts` 里的 `DEFAULTS` 常量。

## 工作原理

- **触发时机**：`session_start`（回到会话/新建，立即显示）+ `turn_end`（每轮结束刷新）
- **数据来源**：从 `ctx.sessionManager.getBranch()` 读取当前会话分支，取最近 N 条 `role === "user"` 的消息
- **显示方式**：`ctx.ui.setWidget()` 常驻编辑器上方
- **零副作用**：只读会话历史用于显示，不改 context、不改消息流、不调用 LLM

## 注意事项

1. **按显示宽度截断**：`maxLine` 是终端列数（中英文都按实际宽度算，用 `truncateToWidth` 实现），中文不会撑宽。
2. **widget 位置**：固定在编辑器**上方**。想放下方，给 `setWidget` 加 `{ placement: "belowEditor" }`。
3. **`pi remove` 后**：配置文件 `~/.pi/agent/pi-recent-user.json` 会残留，但插件不加载就不读，**无害**。想彻底清理，手动删该文件。
4. **空会话**：新会话没有 user 历史时，widget 不显示（避免占屏）。
5. **多行/长输入**：每条压成一行（换行变空格）再截断，不会撑高 widget。
6. **手动改配置文件**：直接编辑 `~/.pi/agent/pi-recent-user.json` 后需重启 pi 才生效（运行中不重读，只用 `/recent` 改才能实时生效）。

## 自定义

代码就一个文件 `src/index.ts`（约 130 行），常见改动：

- 默认条数/长度：改 `DEFAULTS`
- widget 标题文案：改 `updateWidget` 里的 `"📝 最近你在问："`
- 位置改下方：`setWidget(key, lines, { placement: "belowEditor" })`
- 截断宽度：改 `DEFAULTS.maxLine`

改完 `/reload` 或重启 pi 生效。

## 依赖

- 只依赖 `@earendil-works/pi-coding-agent`（pi 自带，列在 `peerDependencies`，不用打包）
- 无需编译，pi 用 jiti 直接跑 `.ts`

## License

MIT
