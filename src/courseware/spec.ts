/**
 * spec.ts —— 课件规格（Courseware Spec）
 *
 * ===== 它和 Scene 的区别 =====
 * Scene 是「一张图」，CoursewareSpec 是「一堂课的课件」：
 *   一个课件 = 若干并排的视图（panes）+ 一组实时读数 + 四步引导 + 一段自动演示。
 *
 * 为什么单独定义这一层，而不是往 Scene 里加字段？
 *   Scene 是 2D/3D 渲染器的共同入口，也是 LLM 要产出的格式。
 *   课件专属的东西（步骤卡片、条形对比图、演示时间轴）与"怎么画图"无关，
 *   塞进去会让 LLM 的提示词变复杂，也会让渲染器承担它不该管的事。
 *
 * 所以分层是：
 *   CoursewareSpec（课件编排） → 多个 Scene（纯几何数据） → SceneRenderer（画）
 *
 * ===== 为什么 pane 的 scene 是函数不是常量 =====
 * 拖动 P 点会改 params，几何要跟着重算。函数式写法让每个 pane 都从
 * 同一份 params 生成自己的 Scene，天然联动、不需要手写同步逻辑。
 */
import type { Scene } from '../protocol/scene';
import type { Scene3D } from '../protocol/scene3d';

/** 一个并排视图（左侧情境、右侧几何探究…） */
export interface CwPane {
  /** DOM id 后缀，全局唯一 */
  key: string;
  /** 角标序号，如 "01" */
  badge: string;
  title: string;
  /** 标题右侧的小字提示 */
  hint: string;
  /** 用哪套渲染器：默认 2D；'3d' 走 Scene3DRenderer（轨道旋转、灯光、实心体） */
  kind?: '2d' | '3d';
  /** 由当前参数生成这张图（3D 视图返回 Scene3D，配合 kind 区分） */
  scene: (params: Record<string, number>) => Scene | Scene3D;
}

/** 右侧「路径分析」里的一行读数 */
export interface CwReadout {
  label: string;
  /** 在 params 作用域里求值，可直接用参数名 p */
  expr: string;
  unit?: string;
  /** 条形图满格对应的数值 */
  barMax: number;
  color?: string;
}

/** 底部一张步骤卡片 */
export interface CwStep {
  /** 卡片左上角序号 */
  no: string;
  title: string;
  /** 一句话说明（卡片上） */
  caption: string;
  /** 点这张卡片时把参数设成什么（让画面回到这一步该有的样子） */
  params?: Record<string, number>;
  /** 步骤卡片里的小缩略图（内联 SVG，避免额外请求） */
  thumb: string;
}

/** 自动演示中的一句字幕 */
export interface CwCaption {
  /** 起始时刻（秒） */
  at: number;
  text: string;
}

export interface CoursewareSpec {
  id: string;
  /** 学科标签，如 "初中数学" */
  subject: string;
  /** 章节路径，如 "轴对称与最短路径" */
  chapter: string;
  /** 探究案编号，如 "探究案 01" */
  code: string;
  title: string;
  subtitle: string;
  /** 主视图底部的问题卡 */
  question: string;
  /** 想一想提示 */
  hint: string;
  /**
   * 课件唯一暴露的自由度（底部滑杆拖的就是它）。
   * 为什么要显式声明？——"只留一个参数"是课件设计纪律，
   * 把它的名字/范围写进协议，外壳就不用猜（旧版把 p 的范围写死在 shell 里）。
   */
  primary: { name: string; label: string; min: number; max: number; step: number };
  /** 初始参数 */
  params: Record<string, number>;
  panes: CwPane[];
  readouts: CwReadout[];
  steps: CwStep[];
  /** 自动演示总时长（秒） */
  duration: number;
  captions: CwCaption[];
  /**
   * 自动演示的第 t 秒应该是什么状态。
   * 返回参数覆盖 + 当前步骤下标；纯函数，和 timeline.ts 的 sample(t) 同一条思路。
   */
  track: (t: number) => { params: Record<string, number>; step: number };
  /** 「验证」按钮点击后要到达的最优参数（没有就是 undefined） */
  best?: Record<string, number>;
  /** 验证后给学生的反馈文案，{value} 会被替换成实际数值 */
  bestNote?: string;
}
