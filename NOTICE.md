# NOTICE · 版权、来源与逐文件溯源

`dsh-whale-pet` 不是从零写的——它是把**多个上游项目的成果**、**一份第三方 Live2D 模型**
和**本项目自己新写的代码**拼装出来的。

本文件有两个作用：

1. **版权声明**（第一 ~ 三节）
2. **逐文件溯源**（第四节 ★）—— 拿到任何一个文件，都能查出它的出处和改动范围

---

## 第一节 · Live2D 模型「DS鲸鱼娘」

**版权不属于本项目。** 本仓库随插件分发该模型，分发时按原作者要求**原样保留**下述声明。

| 项目 | 内容 |
|---|---|
| 模型名 | DS鲸鱼娘 |
| 作者 | B站 **@氵六青**（uid `11272072`）|
| 授权 | 无偿分享；可商用直播、可自印物料 |
| 禁止 | **任何形式的盗用与出售** |
| 额外要求 | 转发时请保留本声明；**不要把模型单独提取出来另行分发或售卖** |

**原文声明（来自上游项目 README，逐字引用）：**

> **Live2D 模型「DS鲸鱼娘」版权不属于本项目**：
> - 作者：B站 **@氵六青** (uid 11272072)
> - 授权：无偿分享；可商用直播、可自印物料
> - **禁止：任何形式的盗用与出售**
>
> 转发时请保留此声明，也不要把模型单独提取出来另行分发或售卖。

**文件位置**：`pet/live2d/model/`（61 个文件）
**直接来源**：上游 [deanzhang2026-max/dsh-lived-pet](https://github.com/deanzhang2026-max/dsh-lived-pet) 的分发包

---

## 第二节 · Live2D Cubism Core（专有，不随本仓库分发）

| 项目 | 内容 |
|---|---|
| 文件 | `live2dcubismcore.min.js` |
| 版权 | **Live2D Inc.**（株式会社 Live2D）|
| 性质 | **专有运行时，不可再分发** |
| 处理 | **不入库**（`.gitignore` 已排除）；首次运行由 `scripts/ensure-runtime.mjs` 从官方 CDN 获取并缓存 |

官方 CDN：`https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`

---

## 第三节 · 随仓库分发的第三方 JavaScript（均为 MIT）

| 文件 | 项目 | 许可 |
|---|---|---|
| `pet/live2d/vendor/pixi.min.js` | [pixijs/pixijs](https://github.com/pixijs/pixijs) 6.5.10 | MIT |
| `pet/live2d/vendor/cubism4.min.js` | [guansss/pixi-live2d-display](https://github.com/guansss/pixi-live2d-display)（Cubism 4 构建）| MIT |
| Electron 运行时 | [electron/electron](https://github.com/electron/electron) | MIT（脚本安装，不入库）|

---

## 第四节 · 逐文件溯源（★ 核心）

### 4.0 四类来源标记

| 标记 | 含义 |
|---|---|
| **【新写】** | 本项目完全新写，无上游对应物 |
| **【改造】** | 从某个上游文件改来，改动范围见下表 |
| **【思路】** | 只借鉴设计 / 契约 / 经验，**未复制代码** |
| **【分发】** | 第三方原样分发的文件（模型 / 第三方 JS）|

---

### 4.1 根目录与插件层

| 文件 | 类型 | 出处与改动 |
|---|---|---|
| `package.json` | 【新写】 | 参照 `vlln/whale-girl` 的 `dsh.bundle.patch` / `exports` 结构写的插件清单 |
| `cordis.patch.yml` | 【新写】 | 结构照 `whale-girl` 的 patch 写法（`- insert: - id/name`）|
| `.gitignore` | 【新写】 | — |
| `README.md` / `README.en.md` | 【新写】 | 功能表按本项目实际实现整理 |
| `LICENSE` | 【新写】 | MIT 正文 + 第三方资产范围说明 |
| `NOTICE.md` | 【新写】 | 本文件 |

---

### 4.2 `lib/` —— DSH 侧插件

| 文件 | 类型 | 出处与改动 |
|---|---|---|
| `lib/index.mjs` | **【新写】+【思路】** | **代码全新**（约 400 行）。**数据源与契约来自 `vlln/whale-girl`**：<br>· 端点形状 `state` / `sessions` / `interact` / `presence`<br>· 用 `jobs.list()` 任务快照翻转（`running → completed/failed/killed`）派生 celebrate / error<br>· 用 `session/event` 的 `turn/start`、`turn/end(reason.kind === 'blocked')` 派生 sessionThink / sessionWait<br>· **事件字段是 `type` 不是 `kind`**（来自该项目的 bug-fix 记录）<br>· 气泡 `activity` 取值：`thinking` / `waiting` / `tool:<工具名>` / `done`<br>**未复制其代码**：不含它的资产服务、账本、XP/称号、页面注入、client half。 |

---

### 4.3 `pet/` —— Electron 桌宠

#### 4.3.1 从「前身桌面壳」改造而来

**前身**：`whale-girl-desktop`（本地目录，2026-09-30 删除，**从未发布**）。
它是本项目**在更早阶段自己写的** sprite 版 Electron 桌面壳（MIT, © 2026 Dee）。

| 文件 | 类型 | 出处与改动 |
|---|---|---|
| `pet/main.cjs` | **【改造】** | 来自前身 `main.cjs`。改动：<br>· 端点 `/whale-girl/*` → `/dsh-whale-pet/*`<br>· 删除 sprite 素材加载（`sendManifest()` 与 `pet-manifest` 通道）<br>· 日志前缀 → `[dsh-whale-pet]`<br>· 新增控制面板：`openMenuWindow()`、`menu-data`/`menu-cmd`/`menu-close`/`pet-look`、`pushMenuState()`、`setGaze()`<br>· **置顶改为 `false → true,'screen-saver'` 序列**（实测只有这个序列在 Windows 上真正生效）<br>· 托盘右键改为打开控制面板（移除 `setContextMenu`）<br>**保留未动**：窗口管理、状态与会话轮询、心跳、互动代理、拖拽、尺寸档位、托盘、DSH 菜单项 |
| `pet/preload.cjs` | **【改造】** | 来自前身同文件。新增 `onCursor`/`onGaze`/`onHand`/`onIdleShow`/`reportLook`/`openMenu` |
| `pet/renderer/renderer.js` | **【改造】** | 来自前身同文件（16 态状态机、气泡渲染、拖拽判定、Live2D 分支）。改动：<br>· `ASSETS` 置空（不再引用 `/whale-girl/assets`）<br>· 新增 `onCursor`/`onGaze`/`onHand`/`onProp`/`onIdleShow` 处理 |
| `pet/renderer/index.html` | **【改造】** | 来自前身同文件。改动：白色气泡主题、进度条、`#live2d-stage`、`body.live2d-active` |
| `pet/start-pet.vbs` | **【改造】** | 来自前身 `start-whale-girl.vbs`。改动：`PET_EXE`/`PET_DIR` 指向本插件 |
| `pet/tests/mock-dsh.cjs` | **【改造】** | 来自前身 `tests/mock-dsh.cjs`（离线调试的 mock DSH），随迁移保留 |
| `pet/package.json` | 【新写】 | Electron 壳清单 |

#### 4.3.2 本项目全新编写

| 文件 | 类型 | 说明 |
|---|---|---|
| `pet/renderer/live2d-pet.js` | **【新写】** | **约 900 行，无上游对应物**。含：<br>· 模型加载与舞台适配（按真实内容边界缩放）<br>· 44 个表情**动态加载**（读 `.exp3.json`，不硬编码参数表）<br>· **三层外观系统**（道具层 → 手部层 → 情绪层，合并去重、后层覆盖前层）<br>· **125 项参数抑制表** `IDLE_SUPPRESS`（把模型自带 idle 的道具/手势/泡泡/星星按回原位）<br>· **手部/耳朵钉在自然值 1.0**（模型 idle 起始值；钉 0 会让手消失）<br>· 鼠标注视（眼珠 + 头 ±30° + 身体）与静止回正<br>· 待机随机表演（表情+手部+道具+动作，演完完全恢复）<br>· 按真实时长的动作循环调度 |
| `pet/renderer/menu.html` · `menu.js` | **【新写】** | 控制面板界面与逻辑（白色系、分类标签在顶部、常驻快捷栏、toggle 选择）；**计时器三模式（秒表/计时器/会话）的界面与交互**也在这里 |
| `pet/main.cjs` 中的计时模块 | **【新写】** | 秒表 / 计时器 / 会话的计时与提醒逻辑，含 99 小时上限夹取。**无上游对应物**：状态放主进程统一持有，全部用 `Date.now()` 推进以消除累积误差 |
| `pet/menu-preload.cjs` | **【新写】** | 控制面板 IPC 桥 |
| `pet/assets/*` | **【新写】** | 图标由本项目从 Live2D 模型渲染生成（透明底、7 档尺寸 16~256） |
| `scripts/ensure-runtime.mjs` | **【新写】+【思路】** | 代码新写；**"Cubism Core 首次从官方 CDN 取"的做法**借鉴 `A8Chann/dsh-pet-live2d` |

#### 4.3.3 第三方分发（原样）

| 路径 | 类型 | 出处 |
|---|---|---|
| `pet/live2d/vendor/pixi.min.js` | 【分发】 | pixi.js 6.5.10（MIT）|
| `pet/live2d/vendor/cubism4.min.js` | 【分发】 | pixi-live2d-display 的 Cubism 4 构建（MIT）|
| `pet/live2d/model/**` | 【分发】 | **DS鲸鱼娘** —— 作者 @氵六青（见第一节）|
| `pet/live2d/vendor/live2dcubismcore.min.js` | 【分发】 | Live2D Inc. 专有，**不入库**，首次下载（见第二节）|

---

### 4.4 上游参考项目：各自借鉴了什么

#### ① `deanzhang2026-max/dsh-lived-pet`
<https://github.com/deanzhang2026-max/dsh-lived-pet> · 代码 MIT

| 借鉴内容 | 说明 |
|---|---|
| **模型文件本体** | `pet/live2d/model/**` 直接取自该项目分发包（版权归 @氵六青）|
| **模型版权声明的原始措辞** | 第一节那段逐字引用来自该项目 README |
| **状态与表情/动作解耦的思路** | 表情与动作独立选择，表情不从动作推导 |
| **参数抑制的必要性** | 该项目记录了「番茄酱动作会写 `ParamCheek21` 导致表情串味」这类隐藏 bug —— 本插件"每帧在 `internalModel.update()` 返回后重写参数"与 `IDLE_SUPPRESS` 表正为解决同类问题 |
| **用 `cdi3.json` 普查参数** | 该模型自带中文参数名（247 个：`chuipaopao3`=泡泡出现、`jingyu`=鲸鱼、`maoshou2-7`=猫手…）—— 抑制表照此逐项核对 |
| **"素材名字像但不能混搭"的教训** | 如 `paopao4/5` 其实是蝴蝶结而非泡泡 —— 抑制表按同一原则分类核对 |

**未复制其代码**（它是 zip 分发的成品，仓库内只有 bridge 插件与文档）。

#### ② `A8Chann/dsh-pet-live2d`
<https://github.com/A8Chann/dsh-pet-live2d> · MIT + 模型另有授权

| 借鉴内容 | 说明 |
|---|---|
| **Cubism Core 的合规处理** | "专有 → 不随包分发 → 首次从官方 CDN 取、校验后缓存"，本插件采用同一思路 |
| **NOTICE 的组织方式** | 本文件结构参考其 `NOTICE.md` |
| **双许可的表达方式** | 它用 `MIT + CC BY-NC-SA 4.0`；本插件是「代码 MIT + 模型原作者授权」，分开声明 |

**未复制其代码**：它是"宠物住在网页里"的 Web GUI 插件（要求 DSH ≥ 0.1.5-rc.1），
本插件是"宠物是独立 Electron 置顶窗口"，形态与运行方式不同。

#### ③ `vlln/whale-girl`
<https://github.com/vlln/whale-girl> · MIT, © Sam Gao (vlln)

| 借鉴内容 | 说明 |
|---|---|
| **服务端端点契约** | `state` / `sessions` / `interact` / `presence` 四端点形状，本插件以 `/dsh-whale-pet/*` 重实现，使桌宠侧可平滑换源 |
| **状态推导的数据源与判定** | `jobs.list()` 快照翻转 + `session/event` turn 边沿 |
| **事件字段是 `type` 不是 `kind`** | 该项目 bug-fix 记录明确写了（曾因用错字段导致 turn 边沿永不匹配）|
| **会话气泡的 activity 取值** | `thinking` / `waiting` / `tool:<工具名>` / `done` |
| **per-session 端点** | 由 [xiaoshihou514](https://github.com/xiaoshihou514) 贡献（PR #5，已合入上游 main）|
| **插件清单与 patch 写法** | `dsh.bundle.patch` + `cordis.patch.yml` 形式 |

**未复制其代码**：`lib/index.mjs` 是按数据源与契约**重写**的精简实现。
**它的 sprite 素材（`lib/assets/characters/whale-girl/*.png`）从未被使用也未被复制** ——
本项目已用 Live2D 形象取代。

> 本项目早期（前身桌面壳时代）曾依赖该插件的运行时端点与 sprite 素材；
> 形象换成 Live2D 后，该插件已于 **2026-09-30 从 DSH profile 中移除**。

#### ④ 前身：`whale-girl-desktop`（本项目自己的上一代）
本地目录，2026-09-30 删除，**未发布**。MIT, © 2026 Dee。

| 关系 | 说明 |
|---|---|
| 形态 | 用 whale-girl 插件的 15 张 sprite PNG 渲染的 Electron 桌面壳 |
| 遗留 | 形象换 Live2D 后，sprite 渲染路径、`sendManifest()`、assets 依赖**全部移除** |
| 去向 | 其有效代码已按 4.3.1 迁入本插件 `pet/` |

---

### 4.5 角色「鲸鱼娘」形象来源链

| 环节 | 作者 |
|---|---|
| 原作 | [上善](https://www.pixiv.net/users/62155430) |
| 二创设计 | [ZipZipPipe](https://space.bilibili.com/4168597) |
| Live2D 模型「DS鲸鱼娘」 | B站 [@氵六青](https://space.bilibili.com/11272072)（uid 11272072）|

---

## 第五节 · 本项目自身

| 项目 | 内容 |
|---|---|
| 插件名 | `dsh-whale-pet` |
| 代码许可 | **MIT**，见 [LICENSE](LICENSE) |
| 版权 | © 2026 **Dee** |

**MIT 只覆盖代码**：模型（第一节）、Cubism Core（第二节）、第三方 JS（第三节）
各自遵守原有许可，不因本项目的 MIT 声明而改变。

---

## 第六节 · 二次分发指引

| 你要做的事 | 需要遵守 |
|---|---|
| 转发整个插件 | 保留 `NOTICE.md` 与 `LICENSE`，**不要删掉第一节的模型声明** |
| 把模型单独拿出来发布 | **先取得 @氵六青 许可**（上游写明"不要把模型单独提取出来另行分发"）|
| 商业直播中使用 | 模型方允许（"可商用直播"）|
| 出售模型本身或插件里的模型 | **禁止** |
| 修改本插件代码后分发 | MIT 允许，保留版权声明即可 |
| 想分发 Cubism Core | Live2D Inc. 专有软件，请查 Live2D 官方 SDK 许可 |

---

## 第七节 · AI 生成声明

**本项目的全部内容均由 AI 生成。**

| 项目 | 说明 |
|---|---|
| 生成者 | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 AI agent（DeepSeek V4 模型）|
| 生成时间 | 2026-09 至 2026-10 |
| 生成范围 | **全部代码**（lib/ · pet/ · scripts/）· **全部文档**（README / NOTICE / CHANGELOG）· **图标**（由 Live2D 模型渲染生成）· 打包与配置 |
| 人工介入 | 需求提出 · 功能取舍 · 验收测试 · 效果反馈与调整决策 |

**这意味着什么**

1. **版权**：AI 生成部分的版权按本项目 LICENSE（MIT, © 2026 Dee）处理。
2. **上游资产不受影响**：模型（第一节）、Cubism Core（第二节）、第三方 JS（第三节）的版权与许可
   **不因本项目由 AI 生成而改变**。
3. **无担保**：代码虽经测试（含逻辑自测与界面验证），但按 MIT 条款**不提供任何担保**，
   使用者应自行审查后再投入生产环境。
4. **可追溯性**：尽管由 AI 生成，每一处来源都在本文件第四节逐项标注
   （【新写】/【改造】/【思路】/【分发】四类），可回溯到具体上游项目。

---
## 附 · 文件 → 来源速查

```
package.json · cordis.patch.yml · README* · LICENSE · NOTICE.md   →  【新写】

lib/index.mjs                      →  【新写】+【思路: vlln/whale-girl 契约与数据源】

pet/main.cjs                       →  【改造: whale-girl-desktop/main.cjs】
pet/preload.cjs                    →  【改造: whale-girl-desktop/preload.cjs】
pet/renderer/renderer.js           →  【改造: whale-girl-desktop/renderer/renderer.js】
pet/renderer/index.html            →  【改造: whale-girl-desktop/renderer/index.html】
pet/start-pet.vbs                  →  【改造: whale-girl-desktop/start-whale-girl.vbs】
pet/tests/mock-dsh.cjs             →  【改造: whale-girl-desktop/tests/mock-dsh.cjs】

pet/renderer/live2d-pet.js         →  【新写】
pet/renderer/menu.html · menu.js   →  【新写】
pet/menu-preload.cjs               →  【新写】
pet/package.json · pet/assets/*    →  【新写】
scripts/ensure-runtime.mjs         →  【新写】+【思路: A8Chann/dsh-pet-live2d】

pet/live2d/model/**                →  【分发: @氵六青「DS鲸鱼娘」 ← deanzhang2026-max/dsh-lived-pet】
pet/live2d/vendor/pixi.min.js      →  【分发: pixijs/pixijs  MIT】
pet/live2d/vendor/cubism4.min.js   →  【分发: guansss/pixi-live2d-display  MIT】
pet/live2d/vendor/live2dcubismcore.min.js
                                   →  【分发: Live2D Inc. 专有 · 不入库 · 首次从官方 CDN 获取】
```
