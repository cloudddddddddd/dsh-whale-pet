# dsh-whale-pet · DSH 桌面伴侣桌宠

一只住在桌面上的 **Live2D 鲸鱼娘**：透明、无边框、真正置顶的独立窗口，
实时跟着 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
的会话状态换表情和动作，还能跟她互动。

**一个插件搞定**：DSH 侧的状态服务 + Electron 桌宠本体 + 独立控制面板 + Live2D 资源，
全部在一个 npm 包里。
---

## 🤖 关于本项目的生成方式

> **本项目的全部内容均由 AI 生成。**
>
> - **生成者**：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 AI agent（DeepSeek V4 模型）
> - **生成范围**：全部代码（lib/ · pet/ · scripts/）、全部文档（README / NOTICE / CHANGELOG）、
>   图标（由 Live2D 模型渲染生成）、打包与配置文件
> - **人工介入**：需求提出、功能取舍、验收测试、效果反馈与调整决策由人类完成
>
> **上游资产不因 AI 生成而改变版权**：Live2D 模型「DS鲸鱼娘」版权归原作者
> B站 @氵六青（见 NOTICE.md 第一节）；Cubism Core 归 Live2D Inc.；
> pixi.js 与 pixi-live2d-display 为 MIT。**逐文件溯源见 NOTICE.md 第四节。**
>
> ⚠️ **使用者请注意**：代码由 AI 编写，虽经测试但**不提供任何担保**（见 LICENSE）。
> 投入生产前请自行审查。

---

## 功能

### 形象与窗口
| 功能 | 说明 |
|---|---|
| Live2D 模型 | 「DS鲸鱼娘」（**44 个表情** + **7 个动作**）|
| 渲染引擎 | Cubism Core 5 + pixi.js 6.5 + WebGL |
| 窗口形态 | 透明、无边框、不占任务栏 |
| 真正置顶 | 用 `screen-saver` 层级（Windows 上唯一真正生效的写法）|
| 尺寸档位 | 100% / 125% / 150% / 200% / 250% / 300% |
| 位置记忆 | 拖拽移动，位置持久化并自动约束在屏幕内 |

### 鼠标交互
| 功能 | 说明 |
|---|---|
| 眼睛跟随 | 眼珠 + 头部（±30°）+ 身体跟随鼠标，全屏范围内都有效 |
| 静止回正 | 鼠标 8 秒不动，缓缓转回正前方 |
| 拖拽 | 跟手移动，松手后有小走步动作 |
| 左键单击 | 打开 / 隐藏 DSH 网页窗口 |
| 右键 | 打开控制面板窗口 |

### 表情与动作
- **44 个表情**，分 9 组：眼睛 / 情绪 / 符号 / 嘴部 / 眼镜 / 贴纸 / 发型 / 手部 / 道具
- **三层叠加**：道具层 → 手部层 → 情绪层，互不覆盖
- **6 个动作**：吹泡泡 / 喷水 / 开盖 / 番茄酱 / 自拍 / 快速自拍（按真实时长循环）
- **点选即取消**：再点一次同一个选项就取消选择

### 自动行为（不用管它也会动）
| 功能 | 参数 |
|---|---|
| 待机随机表演 | 空闲 18~50 秒随机演一段，每次 3~5.5 秒，演完**完全恢复**默认 |
| 睡眠循环 | 无操作 5 分钟入睡 → 睡 **5~15 分钟（随机）** → 醒来活动 5 分钟 → 循环 |
| 呼吸 / 眨眼 | 模型自带 |

### 默认状态（干净）
桌宠默认是 **素颜 + 自然手 + 无道具 + 桌面原样**。
模型自带的 idle 动画有 89 条曲线、会自动摆姿势和变东西，本插件用一张
**125 项参数抑制表**每帧把这些按回原位；你自己设置的不会被覆盖。

### 会话状态联动
| 功能 | 说明 |
|---|---|
| 状态机 | 16 态：思考 / 等待批准 / 干活 / 读文件 / 写代码 / 跑命令 / 搜索 / 派子代理 / 列计划 / 庆祝 / 出错 / 打盹 / 醒觉 … |
| 会话气泡 | 每个运行中的会话一个白色气泡：标题 + 当前动作 + 进度条 |
| 互动 | 喂食 / 玩耍 / 摸摸头，带回复气泡 |

### 控制面板（独立窗口）
| 功能 | 说明 |
|---|---|
| 形态 | 400×520 白色系窗口，可拖动标题栏，不自动关闭 |
| 标签 | **⚙️ 系统**（第一）· **😊 表情 & 动作** |
| 常驻快捷钮 | 喂食 / 玩耍 / 摸摸头 / 随机表演 |
| ✕ | 只关闭面板 |
| 退出程序 | **退出整个桌宠** |

### 计时器（控制面板第三个标签）
三种模式，精度到秒，上限 **99:00:00**，格式 `00:00:00`：

| 模式 | 能力 |
|---|---|
| **⏱ 秒表** | 从 0 开始计时；**中途取时**（记录每圈时长，最多 100 条）、**暂停**、**继续**、**重置**、清空记录 |
| **⏳ 计时器** | 自行设置 时/分/秒（也有 1/3/5/10/15/25/30/60 分快捷预设），**到点在桌宠气泡提醒**；支持暂停、继续、重置 |
| **📋 会话** | 设置**多个时间段**（各带名称，最多 20 段），每段到点都提醒；可设**循环轮数**（0 = 无限），跑完一轮自动进入下一轮 |

- 计时状态由**主进程**持有，桌宠窗口与控制面板共用一份，不会出现两个计时器各走各的。
- 所有推进都用 `Date.now()` 计算，**不累加定时器节拍**，所以卡顿或系统休眠都不会累积误差。
- 到点提醒 = **桌宠气泡** + 桌宠演一段（比只有气泡更容易注意到）。

### DSH 集成
| 功能 | 说明 |
|---|---|
| 打开 / 隐藏 DSH 网页窗口 | 内嵌浏览器窗口 |
| 系统浏览器打开 DSH | 走默认浏览器 |
| 插件市场 / 插件目录（本地、GitHub）| 快捷入口 |
| 重启 DSH | 一键重启服务 |

---

## 安装

### 1. 装插件

```bash
dsh plugin --profile web add <本插件>
# 或本地目录
dsh plugin --profile web add "link:<本插件绝对路径>"
```

> ⚠️ `file:` / `link:` 安装是**复制**而非符号链接 —— 改了源码要重新 `add` 一次，
> 否则 dsh 加载的仍是旧副本。

### 2. 准备运行时（首次一次）

```bash
node <插件目录>/scripts/ensure-runtime.mjs
```

它会做两件事：

1. 在 `pet/` 里 `npm install`，装 **Electron 运行时**（约 200 MB，不进仓库）
2. 从 **Live2D 官方 CDN** 取一份 **Cubism Core**，缓存到 `pet/live2d/vendor/`
   （专有软件，不随本仓库分发）

> 国内网络下 Electron 二进制下载可能卡住，可用镜像：
> ```bat
> set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> node scripts\ensure-runtime.mjs
> ```

### 3. 重启 dsh web

插件默认 **自动拉起桌宠**（`autoStart: true`）。

---

## 配置

| 选项 | 默认 | 说明 |
|---|---|---|
| `autoStart` | `true` | 插件加载时自动启动桌宠 |
| `pollMs` | `1000` | 任务快照轮询间隔（毫秒）|
| `extraArgs` | `[]` | 额外传给 Electron 的参数 |

手动启停（HTTP）：

```bash
curl -X POST http://127.0.0.1:3080/dsh-whale-pet/control -d "{\"action\":\"start\"}"
curl -X POST http://127.0.0.1:3080/dsh-whale-pet/control -d "{\"action\":\"stop\"}"
curl http://127.0.0.1:3080/dsh-whale-pet/control        # 查状态
```

---

## 服务端端点

桌宠是这些端点的唯一消费者。如果你要写自己的宠物，可以直接复用这套契约。

| 端点 | 返回 |
|---|---|
| `GET /dsh-whale-pet/state` | `{ activity: { name, label, until, sessionThink, sessionWait } }` |
| `GET /dsh-whale-pet/sessions` | `[{ id, title, activity }]`，`activity` 为 `done` 时气泡消失 |
| `POST /dsh-whale-pet/presence` | 心跳，标记桌宠在线 |
| `POST /dsh-whale-pet/interact` | `{ action: 'feed' \| 'play' \| 'pet' }` → `{ reply }` |
| `POST /dsh-whale-pet/control` | `{ action: 'start' \| 'stop' \| 'status' }` |

`activity` 的取值约定：`thinking` · `waiting` · `tool:<工具名>` · `done` · `error`。

---

## 目录结构

```
dsh-whale-pet/
├── package.json            插件清单（dsh.bundle.patch + exports）
├── cordis.patch.yml        把插件挂进 web 组合
├── NOTICE.md               ★ 版权、来源与追溯（务必阅读）
├── LICENSE                 MIT（仅覆盖代码）
├── lib/
│   └── index.mjs           DSH 侧：状态推导 + 五个端点 + 桌宠进程管理
├── pet/                    Electron 桌宠本体
│   ├── main.cjs            主进程：窗口、轮询、心跳、互动、托盘、控制面板
│   ├── preload.cjs         暴露 window.pet
│   ├── menu-preload.cjs    控制面板的 IPC 桥
│   ├── renderer/
│   │   ├── index.html      桌宠页面（气泡 + Live2D 舞台）
│   │   ├── renderer.js     16 态状态机 + 气泡渲染
│   │   ├── live2d-pet.js   Live2D 渲染：表情/动作/三层外观/注视/抑制表
│   │   ├── menu.html       控制面板界面
│   │   └── menu.js         控制面板逻辑
│   ├── live2d/
│   │   ├── vendor/         pixi + cubism4（MIT）· cubismcore（首次下载）
│   │   └── model/          DS鲸鱼娘（原作者授权，见 NOTICE）
│   └── assets/             图标
└── scripts/
    └── ensure-runtime.mjs  Electron + Cubism Core 首次安装
```

---

## 调试

```bash
# 直接跑桌宠（不经过 DSH）
pet\node_modules\electron\dist\electron.exe pet --dev

# 转发渲染器控制台日志
pet\node_modules\electron\dist\electron.exe pet --dev

# 换个 DSH 地址
pet\node_modules\electron\dist\electron.exe pet --base-url=http://127.0.0.1:3999

# 缩短入睡时间（测试睡眠循环）
pet\node_modules\electron\dist\electron.exe pet --sleep-after=8000
```

---

## 版权

| 对象 | 许可 |
|---|---|
| 本插件代码 | **MIT**，© 2026 Dee |
| Live2D 模型「DS鲸鱼娘」 | 原作者 **@氵六青**（B站 uid 11272072）授权：无偿分享、可商用直播、可自印物料；**禁止盗用与出售**；转发需保留声明 |
| Live2D Cubism Core | **Live2D Inc.** 专有，不随本仓库分发 |
| pixi.js / pixi-live2d-display | MIT |

**详细来源与追溯（本插件由哪些项目融合而来）见 [NOTICE.md](NOTICE.md)** ——
其中逐条列出了每个上游项目以及各自借鉴了什么。

> 二次分发本插件时，请保留 `NOTICE.md` 与 `LICENSE`，不要删掉模型声明。
> 想把模型单独拿出来发布的话，请先取得原作者许可。
