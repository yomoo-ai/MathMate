# MathMate Web —— GeometryJSON 教学骨架

用**一份 JSON 数据**描述数学场景，由 Three.js 渲染成**可交互图形**的最小工程。
思路来自公众号文章里介绍的 MathMate（LLM → GeometryJSON → Canvas 渲染），
这里是 Web 复刻版的最小可运行骨架：**先不接 LLM，先把「数据驱动渲染」这条主链路跑通。**

## 快速开始

```bash
npm install
npm run dev        # 打开 http://127.0.0.1:5173
```

其他命令：

```bash
npm run typecheck   # 只做 TypeScript 检查
npm run build       # 类型检查 + 产出构建
npm run preview     # 预览构建产物
```

## 这个骨架能做什么

| 功能 | 说明 |
| --- | --- |
| 场景即数据 | 每个场景都是一份 `Scene` JSON：坐标系、参数、对象列表、实时数值 |
| 自动渲染 | 点 / 线段 / 向量 / 多边形 / 圆 / 圆弧 / 函数曲线，表达式自动采样 |
| 参数交互 | 滑杆调参数；拖拽画布中的圆点直接改参数（可约束在圆周上） |
| 三个演示场景 | 二次函数、单位圆与正弦、可拖拽三角形 |
| JSON 驱动演示 | 侧栏文本框里手改 JSON → 解析校验 → 立即渲染（模拟 LLM 输出） |
| LLM 预留桩 | `src/llm/stub.ts` 定义了接入形状，附接入步骤 |

不包含：真实 LLM 调用、拍照 OCR、手写笔记、后端账号（见下文「后续路线」）。

## 目录结构

```
mathmate-web/
├── index.html                  # 页面骨架（画布容器 + 侧栏）
├── src/
│   ├── main.ts                 # 入口：场景/滑杆/数值/JSON 演示 的 UI 串联
│   ├── styles.css              # 浅色主题样式
│   ├── protocol/               # ★ 核心资产：GeometryJSON 协议层
│   │   ├── scene.ts            #   协议类型定义（场景长什么样）
│   │   ├── expr.ts             #   表达式求值器（"a*(x-h)^2+k" → 数字）
│   │   ├── parser.ts           #   JSON 字符串 → Scene（带校验，面向 LLM 输出）
│   │   └── samples.ts          #   手写示例 JSON（侧栏默认加载）
│   ├── core/
│   │   ├── renderer.ts         # ★ 渲染器：Scene 数据 → Three.js 画面 + 拖拽
│   │   └── textSprite.ts       #   文字标签（canvas 贴图 → Sprite）
│   ├── scenes/                 # 三个演示场景（每个都是「参数的纯函数」）
│   │   ├── parabola.ts         #   二次函数 y = a(x-h)² + k
│   │   ├── unitCircle.ts       #   单位圆动点 ↔ 正弦曲线对应关系
│   │   ├── triangle.ts         #   可拖拽三角形（余弦定理实时解内角）
│   │   └── index.ts            #   场景注册表（加场景只改这里）
│   └── llm/
│       └── stub.ts             # LLM 接入预留位
└── README.md
```

## 核心概念：场景即数据

整个工程围绕一条流水线：

```
build(params) ──► Scene（纯数据 JSON）
                    │
                    ▼
              parseScene 校验（可选，面向 LLM 输出）
                    │
                    ▼
              renderer.setScene(scene, params) ──► 画布
                    ▲
                    │
          用户拖拽 / 拉滑杆 ──► 改 params ──┘
```

**关键设计**：数据里只描述「场景中有什么」（一个圆、一条曲线、一个可拖拽点），
不描述「怎么画」。坐标计算、采样、网格全部由渲染器确定性完成。
将来接入 LLM 时，模型即使把某个数算错，画面也只会显示得"不太对"，
不会白屏——错误边界清晰。

## 协议速查

```ts
{
  meta:   { title: "二次函数", subtitle: "..." },
  view:   { xMin: -6, xMax: 6, yMin: -5, yMax: 5 },   // 坐标系范围
  params: [{ name: "a", label: "开口", min: -2, max: 2, step: 0.1, value: 1 }],
  objects: [
    { type: "curve",   id: "f",  expr: "a*(x-h)^2+k" },          // 函数曲线
    { type: "point",   id: "v",  at: "h, k", draggable: true,
      dragBind: { x: "h", y: "k" } },                             // 可拖拽点
    { type: "circle",  id: "c",  center: [0, 0], radius: "1" },
    { type: "arc",     id: "a",  center: [0, 0], radius: "0.35",
      from: "0", to: "t" },                                       // 角度走最短路径
    { type: "polygon", id: "p",  points: ["ax, ay", "bx, by", "cx, cy"], fill: true },
    { type: "segment", id: "s",  from: [0, 0], to: "cos(t), sin(t)", dashed: true },
    { type: "vector",  id: "u",  from: [0, 0], to: "1, 1" },      // 带箭头
  ],
  readouts: [
    { label: "顶点", expr: 'pt(h, k)' },                          // 实时数值
    { label: "∠A",   expr: "deg(acos(...))", unit: "°" },
  ],
}
```

坐标字段的三种写法：`[x, y]`（常量）、`"h, k"`（两个表达式）、`"cos(t), sin(t)"`。
表达式里可用白名单函数：`sin/cos/tan/asin/acos/atan/atan2/sqrt/abs/min/max/
pow/log/exp/PI`，以及三个辅助函数 `deg(弧度→角度)`、`dist(两点距离)`、
`ang(方向角)`、`pt(格式化坐标对)`。`^` 表示乘方。

## 添加自己的场景（5 分钟）

1. 在 `src/scenes/` 新建 `myScene.ts`，导出 `defaults` 和 `build(params): Scene`；
2. 在 `src/scenes/index.ts` 的 `sceneRegistry` 里加一行；
3. 完成。标签页、滑杆、拖拽、数值面板全部自动生效。

## 接入 LLM（下一步）

`src/llm/stub.ts` 顶部注释里有完整步骤，摘要：

1. 选服务商（DeepSeek / 通义 / GLM / OpenAI 兼容接口均可），拿 API Key；
2. 把 `protocol/scene.ts` 的协议转成 JSON Schema 写进 system prompt，
   要求模型**只输出 JSON**；
3. 调用接口拿到文本 → `parseScene(text)` 校验；
4. 校验失败就把 `errors` 列表回传给模型重试（通常 1~2 次修好）；
5. 建议加 few-shot：prompt 里附一个 `parabola.ts` 产出的 JSON 作范例。

安全提醒：LLM 输出的表达式字符串**不要直接 eval**，
先过正则白名单校验或换沙箱方案（见 `expr.ts` 顶部注释）。

## 已知限制（教学骨架的取舍）

- **线段线宽恒为 1px**：Three.js 的 `LineBasicMaterial.linewidth` 在多数平台被忽略，
  需要粗线得改用 `TubeGeometry` 或网格，本骨架从简；
- **表达式求值非沙箱**：用 `new Function` 实现，仅适用于可信输入；
- **不做数学正确性校验**：LLM 解数学题的对错需要另外的验证机制；
- **无 OCR / 笔记 / 账号**：属「跑通之后」的功能。

## 建议的学习顺序

1. 先玩起来：切场景、拉滑杆、拖顶点，建立直觉；
2. 读 `protocol/scene.ts` + `scenes/parabola.ts`：理解「场景是参数的函数」；
3. 读 `core/renderer.ts` 的 `buildCurve` / `buildPoint`：理解数据怎么变成画面；
4. 自己加一个场景（推荐先做「圆幂定理」或「线性函数斜率」）；
5. 按 stub 注释接 LLM，体验完整的「一句话 → 交互图形」。
