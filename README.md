# dsh-memory-inherit · 记忆继承

> 把 DeepSeek 网页版账号里的历史对话拉下来，转成 `dsh-persona-select` 的「历史对话」写进一条人设。
> 之后在新对话里选中这条人设，旧账号的记忆就会作为「已经发生过的对话」被注入一次。

换号、重装、迁移的时候，新账号是白的。这个插件把旧账号里那些「你是谁、你在做什么、你说过不要什么」
从聊天记录里捞出来，变成新账号开局就带着的记忆。

<img src="assets/icon.png" width="96" alt="icon">

## 前置：还需要 dsh-persona-select

本插件只负责**把数据准备好、放对地方**，真正的注入是
[dsh-persona-select](https://github.com/gosutry/dsh-persona-select) 做的：它在新对话的第一步把
历史对话包进 `<system-reminder>…CONTEXT_ROAD: … CONTINUE_CONTEXT.</system-reminder>` 注入，
并且**同一个对话只注入一次**（重注会推倒整个对话的 KV 缓存）。

没装它的话，数据照样能写进去，但不会出现在对话里——插件界面会直接告诉你缺这一块。

## 安装

方式任选一种。装完**重启 DSH**。

### 1. 拿到的是 `.zip`（最省事）

解压，**双击 `install.cmd`**（或者在解压目录里跑 `powershell -ExecutionPolicy Bypass -File .\install-local.ps1`）。

它会自己找 `~/.dsh/profiles/desktop`、备份 `package.json`、把插件放进 `node_modules`、
加进 `dsh.profile.bundles`。找不到 pnpm 也能装（手动铺文件），装完会告诉你缺什么。

别的 profile：`install.cmd -Profile <名字>`；DSH 装在别处：加 `-DshHome <路径>`。

### 2. 插件管理页（推荐，包已发布到 npm 时）

在 DSH 的插件管理里装 `dsh-memory-inherit`，再装 `dsh-persona-select`。

### 3. 拿到的是 `.tgz` 文件

在 DSH profile 目录（`~/.dsh/profiles/<profile>`）里：

```powershell
pnpm add file:D:/path/to/dsh-memory-inherit-0.1.0.tgz
```

然后把包名加进同一个目录 `package.json` 的 `dsh.profile.bundles` 数组：

```json
"dsh-memory-inherit"
```

### 4. 拿到的是源码目录

```powershell
# 把目录里的 package.json 的 dependencies 加一行（路径换成你的）：
"dsh-memory-inherit": "link:D:/path/to/dsh-memory-inherit"
```

```powershell
# 再让 node_modules 指到那个目录（Windows 用 junction，不需要管理员）
New-Item -ItemType Junction -Path "C:/Users/<你>/.dsh/profiles/<profile>/node_modules/dsh-memory-inherit" -Target "D:/path/to/dsh-memory-inherit"
```

同样要把它加进 `dsh.profile.bundles`。`dsh-persona-select` 也是这么装的（它目前只在 GitHub 上）。

### 装完怎么确认

重启后打开 设置 → **记忆继承**；或者在对话里敲 `/memory`，能看到 token / 账号 / 本地会话数就对了。

## 用法

1. **拿 token**：浏览器里登录要继承的那个 DeepSeek 账号 → `chat.deepseek.com` →
   F12 → Console → 粘贴：

   ```js
   copy(JSON.parse(localStorage.getItem('userToken')||'{}').value||'NOT-FOUND')
   ```

   剪贴板里就是 token，粘进插件输入框，点「保存」。插件会立刻调 `/api/v0/users/current`
   验一次，通过后显示账号名和打了码的手机号。

2. **拉取**：点「拉取全部对话」。会话列表按 50 条一页翻，每个会话拉一次消息，两件事同时落盘：
   `raw/`（原始 JSON）和 `corpus/`（可读 Markdown）。

3. **挑**：默认全选，可取消。三种粒度：
   - **完整对话**：你的和 AI 的话都进历史。
   - **只要我发的**：只留 `<user_message>`，体积小、信息密度高，最适合当「记忆」。
   - **带上思考过程**：额外带上 `<thinking>`（一般不需要，费 token）。

4. **导入**：填人设名称（默认「旧账号记忆」），点「导入 N 段对话」。
   同名人设会被**更新**而不是堆一条新的，所以可以反复拉、反复导。

5. **用**：回到对话页，在输入框下方「人设」里选「旧账号记忆」。
   **必须是新对话**——已经聊过的对话不会再注入历史（persona-select 的设计，为了不毁缓存）。

## 它怎么工作

```
chat.deepseek.com  ──GET /api/v0/chat_session/fetch_page──▶  会话列表
                   ──GET /api/v0/chat/history_messages───▶  每个会话的消息树
                                                             │
                        lib/convert.js（走 current_message_id 那条分支）
                                                             ▼
              raw/<会话id>.json   （原文，给机器）
              corpus/<会话id>.md  （可读语料，给人/给 agent 蒸馏）
                                                             │
                        lib/persona-store.js
                                                             ▼
        ~/.dsh/persona-select/personas.json + history/<人设id>.txt
```

- **分支**：DeepSeek 的消息是树，重新生成会留下旁支。插件从 `chat_session.current_message_id`
  沿 `parent_id` 走回根，只取你实际看到的那条线。
- **碎片**：一条消息拆成 `REQUEST` / `THINK` / `RESPONSE` / `FILE` / `TOOL_*` 等 fragment。
  只把 `REQUEST`（你）、`RESPONSE`（AI）、`THINK`（可选）收进历史，工具调用之类的丢掉。
- **格式**：历史正文按 persona-select 认的标签写：

  ```
  <user_message>
  …
  </user_message>

  <assistant_message>
  …
  </assistant_message>
  ```

  多段对话之间插一行 `【旧对话：标题 · 日期】`；超过字数上限时按**整块**丢，绝不切坏标签。

## 数据文件

```
~/.dsh/memory-inherit/
  config.json           token + 验证到的账号信息（token 是明文，自己保管）
  index.json            会话索引：标题、时间、轮数、字数
  raw/<会话id>.json     接口原样返回的 session + messages
  corpus/<会话id>.md    可读语料，可以自己翻，也可以让 agent 读了蒸馏成摘要
```

`~/.dsh/persona-select/personas.json` 和 `history/<人设id>.txt` 是 persona-select 的数据，
本插件只是往里写一条人设（`sectionOrder: -1`，正文留空、只带历史对话）。
如果那边的数据格式版本比插件认识的新，插件会**拒绝写入**而不是冒险改坏它。

## HTTP 接口与命令

挂在宿主 webServer 的 `/memory-inherit` 前缀下：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/memory-inherit/state` | 配置、账号、进度、会话列表、persona-select 现状 |
| PUT/DELETE | `/memory-inherit/token` | 保存（会验证）/ 清除 token |
| POST | `/memory-inherit/sync` | 拉全部对话，`{maxSessions}` |
| POST | `/memory-inherit/import` | `{name, ids, mode, includeThinking, maxChars}` |
| GET | `/memory-inherit/preview` | `?ids=a,b&mode=user-only&thinking=1`，最多 4000 字预览 |

对话里的 `/memory` 命令（设置页被关掉时的兜底）：

| 命令 | 作用 |
| --- | --- |
| `/memory` | 状态：token、账号、本地会话数、是否在拉 |
| `/memory sync` | 后台开拉（拉完用 `/memory` 看结果） |
| `/memory list` | 列出本地会话（标题 / 轮数 / 字数） |
| `/memory import [人设名]` | 用默认选项（完整对话、6 万字上限）导入全部 |
| `/memory token <userToken>` | 保存并验证 token |

## 已知限制

- **这是网页版的私有接口，不是公开 API。** 路径和参数是从 `fe-static.deepseek.com` 的前端
  bundle 里读出来的，官方随时可能改、可能加风控、可能限流。插件对超时、401/403、非 JSON
  响应都做了明确报错，但改版之后仍然可能失效。
- **token 等于账号。** 它明文存在 `~/.dsh/memory-inherit/config.json` 里；不想留就点「清除」，
  或者在浏览器里退出登录让它失效。
- **账号可能是空的**：`/api/v0/users/current` 的 `has_legacy_chat_history` 和会话数量能直接
  看出这一点。空账号拉下来就是 0 条，插件正常返回 0 而不是报错。
- **一个对话只注入一次**：想让已经聊起来的对话也带上历史，只能把内容写进人设正文，
  但效果差（persona-select 的 README 里也这么说）。
- **字数上限**：默认 60000 字。真塞满会显著吃 token；先想想是不是该先蒸馏成摘要再导入。

## 测试

```powershell
$node = '<DSH 自带的 node>'
& $node test/convert.test.mjs
& $node test/e2e.mjs            # 不碰真数据，DSH_HOME 指向临时目录
& $node test/e2e.mjs <token文件> # 顺带验一次真账号
```

`test/e2e.mjs` 会起一个真的 HTTP 服务当宿主，用真 `fetch` 打插件自己的路由，覆盖：
读写配置、导入、同名更新、只留用户消息、空选择被拒、空账号拉取。

## Publish / 分享

要让别人在 DSH 插件管理页里**搜名字直接装**，得先发到 npm（包名 `dsh-memory-inherit` 目前还没被占用）。
仓库里带了一个发布脚本，它会先查版本有没有被占、发布、再回头查 registry 确认：

```powershell
# 第一次：走浏览器登录，登录完直接发布
powershell -ExecutionPolicy Bypass -File .\scripts\publish.ps1 -Login

# 已经登录过（~/.npmrc 里有 token）：
powershell -ExecutionPolicy Bypass -File .\scripts\publish.ps1
```

手动等价操作：

```powershell
pnpm login                       # 或把 //registry.npmjs.org/:_authToken=npm_xxx 写进 ~/.npmrc
pnpm publish --no-git-checks --access public
```

发不上去的常见原因：版本已被占（改 `package.json` 的 `version`）、token 没有 publish 权限、
账号开了 2FA（加 `-Otp 123456`）。发包前可以用 `pnpm publish --dry-run` 空跑一遍。

只想发文件给别人，不经过 npm：

```powershell
pnpm pack           # 得到 dsh-memory-inherit-0.1.0.tgz，别人用 pnpm add file:… 装
```

English: pull your DeepSeek web account's chat history and turn it into a
`dsh-persona-select` persona history, so a new account starts with the old account's memory.
Requires [dsh-persona-select](https://github.com/gosutry/dsh-persona-select) for injection.

## 许可

MIT
