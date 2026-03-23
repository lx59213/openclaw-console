# OpenClaw Console

本地一站式管理 [OpenClaw](https://openclaw.ai) 的模型、会话和 Gateway。

零依赖，纯 Node.js 标准库，单文件自包含。

## 功能

- **模型管理** — 从渠道 API 实时拉取可用模型，点选添加到配置
- **会话切换** — 一键切换全局默认模型，自动清除所有渠道（飞书/本地/定时任务）的旧模型锁定
- **常用操作** — 分门别类的 CLI 命令卡片，点击即执行
- **日志查看** — 实时查看 Gateway 日志和错误日志

## 使用

### macOS

双击 `openclaw-console.command`，浏览器自动打开。

### 命令行

```bash
node openclaw-console.mjs
```

浏览器访问 `http://localhost:9831`。

## 工作原理

- 读写 `~/.openclaw/openclaw.json`（OpenClaw 配置文件）
- 通过 Node 服务端代理请求渠道 API（绕过浏览器 CORS 限制）
- 操作 `sessions.json` 清除会话级模型锁定
- 代理执行 `openclaw` CLI 命令

## 要求

- Node.js 18+
- [OpenClaw](https://openclaw.ai) 已安装并运行

## License

MIT
