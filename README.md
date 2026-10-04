# 骗子酒馆 · Liar's Table（LLM 版）

由大语言模型驱动的 AI 版骗子酒馆：四个 LLM 同桌厮杀的吹牛卡牌游戏，带完整可视化 GUI——酒馆场景、左轮弹巢、翻牌揭示、人设台词与观战上帝视角。支持**人机混战**、**纯 LLM 互殴围观**与**局域网 2-4 人联机**。

基于开源项目 [Hanazar-Games/Liars-Bar-webgame](https://github.com/Hanazar-Games/Liars-Bar-webgame) 改造：把原版的本地规则 AI 替换为真实 LLM 玩家（座位名 = 模型名）。

## 玩法规则

20 张牌：A/K/Q 各 6 张 + 2 张 JOKER（万能牌）。每轮随机指定一张目标牌，每人发 5 张，轮流出 1-3 张宣称是目标牌（可以掺假牌撒谎）；下家可选择质疑——吹牛被揭穿或冤枉好人，输家对自己开一枪（每人一把 6 弹巢左轮，随机 1 发实弹，逐格推进不重转）。每轮结束重新发牌换目标牌，活到最后获胜。

## 运行

需要 Node.js 18+（依赖仅 `ws` 一个包）：

```
cd webgame
npm install
npm start        # 浏览器打开 http://localhost:4173
```

## 三种玩法

- **人机混战**：你亲自上桌，与 3 名 LLM 玩家较量（取阵容前 3 个模型）
- **纯 LLM 互殴**：4 名 LLM 同桌厮杀，你以上帝视角围观——所有模型明牌、每手实际牌面（掺假牌红光高亮，撒谎当场现形）、牌堆构成 tally
- **局域网联机**：2-4 人实时同桌（不涉及 LLM）

## LLM 是怎么接进去的

调用链路：

```
浏览器（game.js）
  → 本地服务端 POST /api/llm（server.js，密钥经环境变量注入、只留在服务端）
    → 本地反代 Anthropic /v1/messages（qoder :8288 / workbuddy :8377）
      → 大模型
```

| 文件 | 职责 |
|---|---|
| `webgame/src/llm-config.js` | **唯一的阵容配置入口**。`LLM_SEATS` 每行一个 AI 座位 `{ model, provider, persona }`，玩家名 = 模型名自动映射；`PERSONAS` 人设库（移植自终端版 personas.py） |
| `webgame/src/llm-decision.js` | 把局面（手牌/目标牌/牌堆/各家弹巢/本轮发言）组装成中文 prompt，要求模型只输出 JSON 决策（可选附 `behavior` 台词：动作写在中文圆括号里）；解析失败自动带纠错重试（最多 3 次） |
| `webgame/server.js` | `POST /api/llm` 转发端点：按 provider 路由到对应反代并转成 Anthropic 协议；反代端点在文件顶部 `LLM_PROVIDERS`，密钥经环境变量注入，**密钥只留在服务端、不进浏览器** |
| `webgame/game.js` | AI 座位由 `LLM_SEATS` 生成（人设标签显示在模型名下方，台词以斜体条展示在座位卡上）；每回合先问 LLM，失败/超时（120s）/输出不合法时自动退回原版概率策略并弹 toast 提示，游戏永不卡死；本回合各家台词会注入后续 LLM prompt |

## 怎么接入 / 切换模型

1. **前提**：对应反代已在运行（`qoder` 127.0.0.1:8288 免客户端鉴权；`workbuddy` 127.0.0.1:8377 需要 key——启动前通过环境变量 `WORKBUDDY_API_KEY` 注入，例如 `WORKBUDDY_API_KEY=sk-xxx npm start`，**不要把密钥写进代码**）。
2. **换模型**：编辑 `webgame/src/llm-config.js` 的 `LLM_SEATS`，把 `model` 改成反代侧的模型 ID，`provider` 填 `qoder` 或 `workbuddy`，`persona` 选一个 `PERSONAS` 里的人设（删掉该字段则该座位不演人设）：

   ```js
   export const LLM_SEATS = [
     { model: 'Qwen3.8-Flash', provider: 'qoder', persona: 'Qwen3.8-Flash' },
     { model: 'Qwen3.8-Max', provider: 'qoder', persona: 'Qwen3.8-Max' },
     { model: 'deepseek-v4.1-flash', provider: 'workbuddy', persona: 'DeepSeek-V4.1-Flash' },
     { model: 'space-bunny', provider: 'workbuddy', persona: 'Space-Bunny' },
   ];
   ```

   座位名自动跟随模型名，改完刷新页面即生效，无需改任何其他代码。

3. **增删座位**：列表即座位，增删行即可，上限 4 个（引擎支持 2-4 人）。人机混战只取前 3 个（你自己占一位），纯 LLM 互殴取全部 4 个。
4. **断网 / 纯规则模式**：把 `LLM_ENABLED` 改为 `false`，AI 退回内置概率策略（座位名仍是模型名），离线也能玩。
5. **接入新的反代**：在 `server.js` 的 `LLM_PROVIDERS` 里加一项 `{ base_url, api_key }`（反代需暴露 Anthropic `/v1/messages` 协议；有鉴权的话 key 同样走环境变量），然后在 `LLM_SEATS` 里引用它的 provider 名即可。

## LLM 增强功能（相对上游）

- **台词/动作通道**（移植自终端版 behavior 字段）：LLM 决策 JSON 可附 `behavior` 台词（纯文字，动作写在中文圆括号里，如"（转着酒杯）这把稳了，信我。"），台词以斜体金句显示在座位卡上，同一轮内各家的发言会注入后续玩家的 LLM prompt——AI 之间有了心理博弈与虚张声势的通道。
- **人设系统**（移植自终端版 personas.py）：座位模型名下方显示人设徽标（老千·小飞 / 戏精·麦斯 / 牌油子·老Deep / 星际兔·Bunny），人设文本以 system 消息注入，只影响台词风格、不影响决策与 JSON 格式。
- **观战上帝视角**：纯 LLM 互殴模式下，观战者可以看到四个模型的明牌手牌（座位卡面朝上）、每一手的实际牌面（掺假牌红光高亮，撒谎当场现形）与牌堆构成 tally（如 `A×3`）。实现为引擎 `viewFor(id, { god: true })` 专用视图，联机模式不带该参数，真人玩家之间互不泄露。
- **LLM 失败提示**：LLM 决策失败（超时/输出不合法/下标无效）退回概率策略时，页面顶部弹 toast「某某 LLM 决策失败，本轮改用概率策略」，不再无声降级。
- **5 秒自动继续**：揭示弹窗的"继续"按钮带倒计时——纯 LLM 对局没人点按钮也不会卡住；手动点击仍然即时生效。
- 节奏提示：纯 LLM 互殴偏慢属正常（推理模型 + 网关排队，每手 10~120 秒，座位显示"正在盘算…"）；服务端日志会打印每次 `LLM 请求: provider/model`，可用于确认请求在流动。

## 上游功能与项目结构

- 单人模式（AI 对局）与局域网模式（房间码、2-4 人实时同步、房主开局与重赛）。
- 服务端权威规则：其他玩家的手牌不会发送到你的浏览器；断线玩家自动离席判负。
- 程序生成的分层音效与动态酒馆环境氛围；20 项可调参数（视觉、AI 节奏、辅助、BGM、SFX）。
- 10 种界面语言 + 四步新手引导；酒客档案（本场行为统计与动态称号，不跨会话保存）。
- 无障碍支持：原生隐藏、模态焦点循环、状态播报、减少动画。

```text
webgame/
├── index.html              页面与所有游戏弹层
├── styles.css              桌面、移动端、动画与无障碍样式
├── game.js                 单人 AI、联机客户端、UI 与音频
├── server.js               HTTP 静态服务、房间与 WebSocket 协议、LLM 转发
├── src/game-engine.js      单机和联机共用的纯规则引擎
├── src/llm-config.js       LLM 阵容与人设配置（唯一的改动入口）
├── src/llm-decision.js     LLM 决策 prompt 构建与 JSON 解析
├── src/guest-profile.js    会话统计、行为评价与动态称号
├── src/i18n.js             核心界面翻译与语言回退
├── test/                   规则、协议与 LLM 决策测试
└── assets/tavern-bg.png    酒馆背景
```

## 联机边界

- 房间与牌局仅保存在服务器内存中，服务器重启后清空。
- 当前版本不包含账号、密码、公网匹配、跨服务重连或局域网自动发现。
- 房间码用于快速加入，不是安全凭证；只应在可信局域网内使用。
- 默认监听 `0.0.0.0:4173`，可用 `HOST` 和 `PORT` 环境变量修改。

## 测试

```
cd webgame
npm test
```

25 个测试：上游的规则引擎（牌组、发牌保密、回合权限、出牌校验、质疑、左轮淘汰、断线离席）、两个真实 WebSocket 客户端的联机流程，以及新增的 LLM 决策解析（behavior 台词提取、人设注入、发言上下文）与上帝视角视图（god 模式公开、联机模式严格保密）。

完整版本记录见 [webgame/CHANGELOG.md](webgame/CHANGELOG.md)。

## 许可证与来源

- `webgame/` 引擎与界面基于 [Hanazar-Games/Liars-Bar-webgame](https://github.com/Hanazar-Games/Liars-Bar-webgame)（MIT License，见 `webgame/LICENSE`），本仓库对其的修改同样以 MIT 释出。
- 人设与台词玩法机制参考自 [LYiHub/liars-bar-llm](https://github.com/LYiHub/liars-bar-llm)（Apache-2.0，根目录 `LICENSE` 为其许可证副本）。
- 《Liar's Bar》名称与玩法灵感来自 Steam 同名游戏，本项目是与原作无关的非商业同人实现。
- 本仓库不含任何 API 密钥：`workbuddy` 反代的鉴权 key 通过环境变量 `WORKBUDDY_API_KEY` 在本地注入。
