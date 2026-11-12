/**
 * scene.ts —— GeometryJSON 协议（类型定义）
 *
 * ===== 设计思想（先读这段，再看代码）=====
 *
 * 一个数学场景 = 一份「纯数据」。
 * 数据里只描述「场景中有什么」，不描述「怎么画」：
 *   - 坐标计算、采样、网格全部由渲染器（core/renderer.ts）完成；
 *   - 表达式（Expr）只做声明式引用，例如 "a*(x-h)^2+k"。
 *
 * 为什么这样设计？
 * 将来接入 LLM 时，模型只需要产出这份数据。
 * 即使模型把某个数算错了，渲染引擎也不会崩——画面只会显示得"不太对"，
 * 而不会白屏。错误边界清晰，这也是 MathMate 那篇文章的核心思路。
 *
 * ===== 场景的一生 =====
 * build(params) 产出 Scene（纯数据） → parseScene 校验（可选，面向 LLM 输出）
 *   → renderer.setScene(scene, params) 画出画面
 *   → 用户拖拽/拉滑杆改变 params → 重新 build → 重新渲染
 */

/** 二维坐标 [x, y] */
export type Vec2 = [number, number];

/**
 * 表达式字符串：在「参数作用域」中求值。
 * 支持：参数名（a/h/k/t/ax...）、曲线变量 x、白名单数学函数、^ 表示乘方。
 * 例："a*(x-h)^2+k"、"sin(t)"、"dist(ax,ay,bx,by)"
 */
export type Expr = string;

/**
 * 既可以是坐标数组，也可以是表达式字符串 "h, k"（两个表达式用逗号分隔）。
 * 数组元素允许写表达式字符串（如 [0, "a"]）——求值规则与字符串写法完全一致，
 * 只是模型经常这么写，与其打回不如接受。
 */
export type Vec2Like = Expr | [Expr | number, Expr | number];

export interface SceneMeta {
  title: string;
  subtitle?: string;
}

/** 坐标系可视范围（世界坐标） */
export interface ViewRange {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/** 参数定义：滑杆绑定 + 表达式变量，二合一 */
export interface ParamDef {
  /** 在表达式里引用的变量名，如 "a" */
  name: string;
  /** 滑杆显示名，如 "a（开口方向与大小）" */
  label: string;
  min: number;
  max: number;
  step: number;
  /** 默认值 */
  value: number;
  /** false 表示只参与计算、不显示滑杆（如三角形顶点坐标，靠拖拽修改） */
  slider?: boolean;
}

interface BaseObject {
  id: string;
  label?: string;
  /** 标签位置微调 [dx, dy]（世界坐标单位）。用于多个标签挤在一起时手动错开 */
  labelOffset?: [number, number];
  /** CSS 颜色串，如 "#185fa5"；不传则用该类型的默认色 */
  color?: string;
  dashed?: boolean;
  /**
   * 光晕：给关键对象叠一圈柔光（点=同色光环，线段=同色宽带）。
   * 为什么放在 BaseObject 而不是各自类型上？——"要不要强调"是内容决策，
   * 点和线段的语义一致（"这是主角"），渲染器各自决定怎么画光晕。
   * 课件里只给 1~3 个核心对象开 glow：满屏光晕 = 没有光晕。
   */
  glow?: boolean;
}

/**
 * 派生点：坐标不手写，而是由几何关系算出来。
 *
 * 为什么需要？——让模型手算"垂足""交点"的坐标公式，是它最容易出错的地方
 * （实测：垂足参数取错、交点算歪，三次重试给同样错的数）。
 * 与其纠正它，不如别让它算：它只声明"E 是 D 到 AB 的垂足"，
 * 公式由程序生成，坐标天然满足关系。
 *
 * 引用的都是 point 对象的 id。
 */
export type DeriveSpec =
  /** 中点：M = (A + B) / 2 */
  | { kind: 'midpoint'; a: string; b: string }
  /** 垂足：p 到直线 (line[0], line[1]) 的垂足 */
  | { kind: 'foot'; p: string; line: [string, string] }
  /** 交点：直线 (l1[0], l1[1]) 与直线 (l2[0], l2[1]) 的交点 */
  | { kind: 'intersect'; l1: [string, string]; l2: [string, string] }
  /**
   * 分点：P = A + t·(B−A)。
   *
   * t = 1/3 表示"从 A 出发、把 AB 分成 1:2 的那个点"。
   * 凡是题面出现「BD = 2AD」「D 是 AB 的三等分点」这类条件，
   * 都应该用 section 而不是手写坐标——比例关系天然成立，不用算。
   * t 可以是数字，也可以是表达式字符串（如 "1/3"、"2/(1+sqrt(5))"）。
   */
  | { kind: 'section'; a: string; b: string; t: number | string }
  /**
   * 曲线上的点：P = 曲线 curve 在参数 t 处的那个点。
   *
   * 为什么需要？——曲线题里的动点（"P 是椭圆上一点"）以前只能手写坐标，
   * 而手写的坐标几乎不可能真的落在曲线上，程序也无从验证。
   * 真实事故：椭圆题上的 P 飘在曲线外，焦点 F1/F2 也是随手写的数，
   * 图与讲解从第一句就是对不上的。
   *
   * 用 curve-point 声明后，坐标直接取曲线在这点的表达式：
   *   - 曲线随参数动（滑杆推 m），P 跟着一起动；
   *   - 位置天然在曲线上，on-curve 一定成立，也不会被当成"孤点"；
   *   - t 可以写表达式，如 "pi/2"、"m*pi/4"。
   *
   * curve 支持 parametric / curve / circle 三种对象：
   *   parametric → (xExpr(t), yExpr(t))
   *   curve      → (t, expr(t))   即把 t 当 x 用
   *   circle     → (cx + r·cos t, cy + r·sin t)
   */
  | { kind: 'curve-point'; curve: string; t: number | string };

/** 点：可拖拽，拖拽时把坐标写回参数 */
export interface PointObject extends BaseObject {
  type: 'point';
  /** 坐标。派生点（写了 derive）可以省略，由 resolveScene 填上 */
  at?: Vec2Like;
  /** 派生点：坐标由几何关系算出，而不是手写 */
  derive?: DeriveSpec;
  draggable?: boolean;
  /** 拖拽时把 x/y/角度 写回哪个参数 */
  dragBind?: { x?: string; y?: string; angle?: string };
  /** 拖拽约束：锁在某个圆上（如单位圆上的动点，只能沿圆周动） */
  constraint?: { type: 'circle'; center: Vec2; radius: number };
}

export interface SegmentObject extends BaseObject {
  type: 'segment';
  from: Vec2Like;
  to: Vec2Like;
}

/** 向量：线段 + 箭头 */
export interface VectorObject extends BaseObject {
  type: 'vector';
  from: Vec2Like;
  to: Vec2Like;
}

export interface PolygonObject extends BaseObject {
  type: 'polygon';
  points: Vec2Like[];
  /** 是否填充半透明色 */
  fill?: boolean;
  /**
   * 填充不透明度，0~1；不传 = 0.12（题面区域图的老默认值）。
   *
   * 为什么要能调？——课件里的"水面""草地"这类环境元素需要实一些的填充，
   * 0.12 的老默认是为"不等式区域"设计的，那种图恰恰要求填充越淡越好，
   * 免得盖住网格。两类需求的合适值差一个数量级，不能共用一个写死的数。
   */
  fillOpacity?: number;
}

export interface CircleObject extends BaseObject {
  type: 'circle';
  center: Vec2Like;
  radius: Expr;
}

/** 圆弧：from/to 为起始/终止角（弧度），走最短路径 */
export interface ArcObject extends BaseObject {
  type: 'arc';
  center: Vec2Like;
  radius: Expr;
  from: Expr;
  to: Expr;
}

/** 函数曲线：y 关于 x 的表达式，渲染时自动采样 */
export interface CurveObject extends BaseObject {
  type: 'curve';
  /** y 关于 x 的表达式，如 "a*(x-h)^2+k" */
  expr: Expr;
  /** x 范围，默认使用当前视图范围；数字或表达式字符串均可（渲染器统一转字符串） */
  domain?: [Expr | number, Expr | number];
  /** 采样点数，默认 256 */
  samples?: number;
}

/**
 * 参数曲线：x 和 y 都是关于 t 的表达式。
 * 能表达"同一个 x 对应多个 y"的封闭曲线——爱心、五角星、椭圆、利萨茹图形
 * （这些用 y=f(x) 是表达不了的，这正是新增它的原因）。
 * 例：爱心 = x: "16*sin(t)^3", y: "13*cos(t)-5*cos(2*t)-2*cos(3*t)-cos(4*t)"
 */
export interface ParametricObject extends BaseObject {
  type: 'parametric';
  /** x 关于 t 的表达式 */
  xExpr: Expr;
  /** y 关于 t 的表达式 */
  yExpr: Expr;
  /** t 范围，数字或表达式字符串，默认 [0, 2π] */
  tRange?: [Expr | number, Expr | number];
  /** 采样点数，默认 256 */
  samples?: number;
}

export type SceneObject =
  | PointObject
  | SegmentObject
  | VectorObject
  | PolygonObject
  | CircleObject
  | ArcObject
  | CurveObject
  | ParametricObject;

/** 实时数值输出：表达式求值为数字后显示（保留两位小数） */
export interface ReadoutDef {
  label: string;
  expr: Expr;
  /** 显示单位，如 "°" */
  unit?: string;
}

/**
 * 分步讲解：阶段 2 的核心扩展。
 * 一份场景可以带若干步骤，每步"讲到哪，图里哪段就亮"：
 *   - highlight：本步要强调的对象 id（其余变淡）；
 *   - reveal：到本步才出现的对象 id（如"解出根之后交点才出现"）。
 * 只要场景里任何一步定义了 reveal，未 reveal 的对象默认隐藏。
 */
export interface StepDef {
  title: string;
  /** 讲解正文；公式用 $...$ 包裹（LaTeX），如 "$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$" */
  text: string;
  highlight?: string[];
  reveal?: string[];
}

/**
 * 几何约束（阶段 5 核心）：把「题面给的关系」声明出来，让程序能真的验算。
 *
 * 为什么需要？——没有它，图只是"看起来像"：
 * 题目说 CA⊥CB，模型目测写了个坐标，画出来是 68°，程序和人都不容易发现。
 * 有了约束段，体检器会按坐标逐条验算，不成立就带着实测值打回重做。
 *
 * 引用的都是 point 对象的 id（不是字母本身）。
 */
export type Constraint =
  /** 垂直：points = [A, 顶点, B]，表示 ∠AVB = 90° */
  | { type: 'perp'; points: [string, string, string] }
  /** 平行：线段 AB ∥ 线段 CD */
  | { type: 'parallel'; a: [string, string]; b: [string, string] }
  /** 三点共线（不要求在中间） */
  | { type: 'collinear'; points: [string, string, string] }
  /** 点在线段上：p 落在 ends 两点连成的线段内（含端点） */
  | { type: 'on-segment'; p: string; ends: [string, string] }
  /** 等长：|AB| = |CD| */
  | { type: 'equal-length'; a: [string, string]; b: [string, string] }
  /** 中点：m 是 ends 两点连线的中点 */
  | { type: 'midpoint'; m: string; ends: [string, string] }
  /** 角平分线：从 vertex 出发、过 ray 的射线平分 ∠(sides[0], vertex, sides[1]) */
  | { type: 'angle-bisector'; vertex: string; sides: [string, string]; ray: string }
  /**
   * 定角：∠(points[0], points[1], points[2]) 必须等于 deg 度，顶点是 points[1]。
   *
   * 为什么需要？——解三角形题（尤其是"判断形状"）的核心结论全是角度：
   * ∠A=30°、∠B=60°、∠C=90°。以前只能用 perp 表达 90°，
   * 30°/60° 无从声明，图对不对完全没人管。
   */
  | { type: 'angle-value'; points: [string, string, string]; deg: number }
  /**
   * 定比：|a| / |b| = ratio（两边都是点 id 对，如 a=[B,D]、b=[A,D]、ratio=2 表示 BD = 2AD）。
   *
   * 对应题面里的「BD = 2AD」「AE = EC」这类倍数关系（相等请用 equal-length）。
   */
  | { type: 'length-ratio'; a: [string, string]; b: [string, string]; ratio: number }
  /**
   * 定值：表达式在**默认参数下**必须等于 equals。
   *
   * 对应题面给的具体数值条件——「CD = 2」「AB = 6」。
   * 它也是唯一能管住"缩放"的约束：坐标可以任意放大缩小，
   * 只有题面给定的长度能把比例定死。表达式里可以直接写点 id（如 "dist(C,D)"）。
   * tol 是相对容差，默认 0.005（0.5%）。
   */
  | { type: 'value'; expr: string; equals: number; tol?: number }
  /**
   * 点在曲线上：p 到曲线 curve 的**最近距离**必须小于 tol（缺省按曲线尺寸取）。
   *
   * 为什么需要？——上面所有约束都只管"点和直线"的关系，圆锥曲线题一个也套不上，
   * 于是提示词里只能写"圆锥曲线不走 constraints"。结果是曲线上的点（动点 P、
   * 顶点、与坐标轴的交点）位置完全没人验证，全靠模型目测。
   *
   * curve 可以是 parametric / curve / circle 的 id。
   * 曲线题里的动点优先用 derive 的 curve-point（位置天然正确），
   * 这个约束用于验证"我确实想让它落在这条曲线上"的既有点。
   */
  | { type: 'on-curve'; p: string; curve: string; tol?: number };

/**
 * 出图还是出板书。
 *
 * 为什么需要它？——不是所有题都能画。解方程、不等式、数列、参数范围这类题
 * 的"图"只能是装饰：把 m 的取值讨论硬配一张曲线，图和讲解从第一句起就是
 * 两回事（真实事故：x²/(m+9)+y²/(25−m)=1 画成了一张与 m 无关的椭圆）。
 *
 * 与其画一张会误导的图，不如老实排推导板书。
 *   'figure' —— 结论能落在图上，正常渲染
 *   'board'  —— 不画图，改用推导板（主画布与视频都走这条路）
 * 缺省时由 core/visualMode 推断（有步骤但零对象 → board）。
 */
export type VisualMode = 'figure' | 'board';

/** 一份完整的场景描述 */
export interface Scene {
  meta: SceneMeta;
  view: ViewRange;
  params: ParamDef[];
  objects: SceneObject[];
  readouts?: ReadoutDef[];
  steps?: StepDef[];
  /** 几何关系声明（可选）。写了的会被体检器逐条验算 */
  constraints?: Constraint[];
  /** 出图还是出板书；省略时按对象数量推断 */
  visual?: VisualMode;
}
