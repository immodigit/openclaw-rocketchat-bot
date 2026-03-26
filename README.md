# OpenClaw Rocket.Chat Plugin

Rocket.Chat channel plugin for OpenClaw.

## 已实现能力

- 原生 OpenClaw channel plugin 包结构
- 支持 `openclaw plugins install` 安装
- 支持两种鉴权方式
  - `token`: `userId + accessToken`
  - `password`: `username + password`
- 支持单聊
- 支持群聊和频道，仅在明确 `@机器人` 时响应
- 回复阶段先发送 `思考中...`，最终内容原地更新
- 保留 Markdown fenced code block，不主动破坏代码块
- 入站接入支持 REST 轮询和 WebSocket/DDP
- 传输层已抽象，可按账号切换 transport

## 当前限制

- 不包含附件、线程、反应、消息撤回同步
- 没有真实 Rocket.Chat E2E 测试，当前以单元测试和模块集成测试为主

## 安装

本地目录安装：

```bash
openclaw plugins install ./
```

后续发布到 npm 后，也可以按包名安装。

```bash
openclaw plugins install @laevateinzzl/openclaw-rocketchat-bot
```

## 配置示例

下面的示例表达的是 `channels.rocketchat` 这段配置结构：

```yaml
channels:
  rocketchat:
    accounts:
      main:
        enabled: true
        serverUrl: "https://chat.example.com"
        auth:
          mode: "token"
          userId: "rocket-user-id"
          accessToken: "rocket-access-token"
        transport:
          mode: "websocket"
          reconnectDelayMs: 5000
        mentionNames:
          - "rocketbot"
          - "assistant"
```

密码登录模式：

```yaml
channels:
  rocketchat:
    accounts:
      main:
        enabled: true
        serverUrl: "https://chat.example.com"
        auth:
          mode: "password"
          username: "rocketbot"
          password: "your-password"
        transport:
          mode: "polling"
          pollIntervalMs: 30000
        mentionNames:
          - "rocketbot"
```

## 行为说明

- 单聊消息默认接入 OpenClaw
- 群聊和频道消息只有在明确提及机器人时才接入
- 提及判断优先用 Rocket.Chat 的 mention metadata
- 如果服务端 payload 没带 mentions，会回退到文本里的 `@alias` 匹配
- `mentionNames` 用于补充别名，不需要重复写主用户名也能工作
- `transport.mode: "websocket"` 会用 DDP 接收入站消息，并在房间列表变化时用一次 REST 刷新订阅
- `transport.mode: "polling"` 继续保留，适合作为兼容回退

## 开发命令

```bash
npm install
npm test
npm run typecheck
npm run build
```

## 调试

`debug:client` 和 `debug:poll` 会先读取项目根目录的 `.env`，再用命令行显式传入的环境变量覆盖同名字段。
当前调试脚本主要覆盖 REST 连通性和轮询链路，WebSocket 入站没有单独脚本。

### 1. 调试 Rocket.Chat 登录和接口连通性

```bash
ROCKETCHAT_SERVER_URL="https://chat.example.com" \
ROCKETCHAT_AUTH_MODE="token" \
ROCKETCHAT_USER_ID="rocket-user-id" \
ROCKETCHAT_ACCESS_TOKEN="rocket-access-token" \
npm run debug:client
```

密码模式：

```bash
ROCKETCHAT_SERVER_URL="https://chat.example.com" \
ROCKETCHAT_AUTH_MODE="password" \
ROCKETCHAT_USERNAME="rocketbot" \
ROCKETCHAT_PASSWORD="your-password" \
npm run debug:client
```

输出会打印：

- 当前账号身份信息
- 当前可见订阅数量
- 鉴权失败时的错误信息

### 2. 调试单次轮询和入站事件

```bash
ROCKETCHAT_SERVER_URL="https://chat.example.com" \
ROCKETCHAT_AUTH_MODE="token" \
ROCKETCHAT_USER_ID="rocket-user-id" \
ROCKETCHAT_ACCESS_TOKEN="rocket-access-token" \
ROCKETCHAT_UPDATED_SINCE="2026-03-26T00:00:00.000Z" \
npm run debug:poll
```

可选环境变量：

- `ROCKETCHAT_ACCOUNT_ID`
- `ROCKETCHAT_MENTION_NAMES`
- `ROCKETCHAT_POLL_INTERVAL_MS`
- `ROCKETCHAT_UPDATED_SINCE`

`debug:poll` 会打印每条标准化后的入站事件，以及本次轮询结束后的 checkpoint。

## 项目结构

```text
src/
  index.ts
  plugin.ts
  client.ts
  config.ts
  channel.ts
  format.ts
  checkpoints.ts
  inbound/
    types.ts
    polling.ts
    websocket.ts
tests/
openclaw.plugin.json
```

## 后续扩展

- 为 WebSocket transport 增加独立调试脚本
- 为 websocket 断线重连增加更细粒度的 backoff 策略
- 保持 mention 规则、回复占位、Rocket.Chat 出站逻辑不变
