/**
 * scene3d.ts —— 三维场景协议（立体几何）
 *
 * 和 2D 的 scene.ts 是**并列**的两套，不是父子关系。
 * 为什么另起一套？因为立体几何的对象根本不同：
 *   2D 有曲线、抛物线、参数方程；3D 要的是顶点、棱、面。
 *   硬塞进同一个对象类型里，两边都会被对方的字段污染。
 *
 * ===== 三条约定（立体几何题的标准画法）=====
 *
 * 1. 顶点（point3）只声明坐标，棱（edge3）只声明"连哪两个顶点"。
 *    这和 2D 里 derive 的思路一致：让程序负责计算，人只负责说关系。
 *
 * 2. 面的顶点顺序**不重要**（渲染器用形心判断朝向，不依赖绕序）。
 *    这是故意的——LLM 极容易把绕序写反，依赖绕序会让一半的图翻面。
 *
 * 3. 被遮挡的棱自动画虚线，规则是"这条棱两侧的面都背对相机"。
 *    edge3.dashed 可以强制覆盖：true = 永远虚线，false = 永远实线。
 */

import type { Expr, ParamDef, ReadoutDef, SceneMeta, StepDef } from './scene';

/** 三维坐标 [x, y, z] */
export type Vec3 = [number, number, number];

/** 三轴坐标：字符串 "a, 0, 0" 或数组 [a, 0, 0]，规则与 Vec2Like 一致 */
export type Vec3Like = Expr | [Expr | number, Expr | number, Expr | number];

interface Base3D {
  id: string;
  label?: string;
  /** CSS 颜色串；不传用默认色 */
  color?: string;
  /** 标签位置微调（世界单位，三轴） */
  labelOffset?: [number, number, number];
}

/** 顶点 */
export interface Point3Object extends Base3D {
  type: 'point3';
  /** 手写坐标；用 derive 时可省略 */
  at?: Vec3Like;
  /**
   * 派生点：坐标由程序算。和 2D 一样的理由——
   * 模型算空间几何公式（重心、垂足、定比分点）几乎必错，但它会声明关系。
   */
  derive?: Derive3Spec;
}

/**
 * 3D 派生点。
 * 与 2D 版本的区别：多一个 centroid（三角形重心），少一个 intersect
 * （空间中两条直线多数是异面直线，没有交点，"求交"在立体几何里不常用）。
 */
export type Derive3Spec =
  | { kind: 'midpoint'; a: string; b: string }
  /** 三角形 A B C 的重心 = 三顶点坐标的平均 */
  | { kind: 'centroid'; points: [string, string, string] }
  /** P = A + t·(B−A)，t 是数字或表达式（"1/3"） */
  | { kind: 'section'; a: string; b: string; t: Expr | number }
  /** 空间点 P 到直线 AB 的垂足（含在直线延长线上的情况） */
  | { kind: 'foot'; p: string; line: [string, string] }
  /**
   * 四面体 A B C D 的外接球心（到四点等距的点）。
   *
   * 为什么要专门设一个 kind？——这个点**没有任何四则运算写法**：
   * 得解一个 3×3 线性方程组。模型手写坐标必错，但它会说"这四个点的外接球"。
   * 展开成 circumX3/circumY3/circumZ3(...) 由表达式引擎算，参数化照样成立。
   */
  | { kind: 'circumcenter'; points: [string, string, string, string] }
  /** 四面体 A B C D 的内心（内切球心，到四个面等距） */
  | { kind: 'incenter'; points: [string, string, string, string] };

/** 棱：连接两个已声明的顶点 */
export interface Edge3Object extends Base3D {
  type: 'edge3';
  /** 起点顶点 id */
  a: string;
  /** 终点顶点 id */
  b: string;
  /**
   * 虚线控制：
   *   true  = 永远虚线（辅助线、体对角线常这么要求）
   *   false = 永远实线
   *   不传  = 按遮挡关系自动判断（最常用）
   */
  dashed?: boolean;
}

/** 面：填充多边形，用于表现"实体"的可见表面 */
export interface Face3Object extends Base3D {
  type: 'face3';
  /** 顶点 id 列表（3 个以上）*/
  points: string[];
  /** 填充不透明度，0~1；不传 = 不填充（纯线框） */
  opacity?: number;
}

/**
 * 旋转体引用的"点"：已声明顶点的 id，或者直接给坐标。
 *
 * 为什么允许两种写法？
 *   - 写 id（"O"、"O1"）是本命用法：能标字母、能被 readouts 引用、能参与约束；
 *   - 写坐标（"0, 0, 0"）是为了让"随手画个圆柱"不必先声明两个点。
 * 判别方式很笨但很稳：**含逗号或就是数组 → 坐标；否则 → 顶点 id**。
 * 顶点 id 不可能含逗号（那是坐标分段符），所以这个判别不会误伤。
 */
export type PointRef = string | [Expr | number, Expr | number, Expr | number];

/**
 * 圆柱。
 *
 * 为什么用"两个轴端点 + 半径"而不是"中心 + 高 + 方向"？
 * 因为课本就这么说话：「圆柱 OO₁」「以其对角线为轴旋转」。
 * 端点式写法把方向、长度、位置一次说清，还能让 O、O₁ 直接标字母。
 */
export interface Cylinder3Object extends Base3D {
  type: 'cylinder3';
  /** 轴的一个端点（通常是下底面圆心）*/
  a: PointRef;
  /** 轴的另一个端点（通常是上底面圆心）*/
  b: PointRef;
  /** 底面半径，可写表达式（如 "r"、"a/2"）*/
  radius: Expr | number;
  /** 曲面填充不透明度，0~1；不传 = 0.18 */
  opacity?: number;
}

/** 圆锥：锥尖 + 底面圆心 + 半径 */
export interface Cone3Object extends Base3D {
  type: 'cone3';
  /** 锥尖 */
  apex: PointRef;
  /** 底面圆心 */
  base: PointRef;
  radius: Expr | number;
  opacity?: number;
}

/** 球：球心 + 半径 */
export interface Sphere3Object extends Base3D {
  type: 'sphere3';
  center: PointRef;
  radius: Expr | number;
  opacity?: number;
}

/**
 * 截面：用一个平面去切某个旋转体，画出交线（椭圆/圆）和半透明的平面。
 *
 * 为什么交线让程序算，而不是让模型给一串截椭圆圆周上的点？
 *   椭圆是三次方程的根，模型手算圆周点几乎必错——
 *   这和"球心交给 derive"是同一条原则：模型声明关系，程序负责计算。
 * 模型只需要说清两件事：**切谁**（cut）和**平面在哪**（plane 三点，或 p+normal）。
 *
 * "平面与轴成 60°"这类条件用 p + normal 最顺手：
 *   轴沿 z 时，与轴成 60° 的平面法向量满足 nz/|n| = sin60°，
 *   写 normal: [1, 0, "sqrt(3)"] 即可（|n|=2, nz/|n|=√3/2）。
 */
/**
 * 被切的目标，两种写法：
 *   "cyl"                        —— 旋转体（cylinder3 / cone3 / sphere3）的 id
 *   { vertices: [...], faces? }  —— 多面体：列出它的全部顶点，面从场景里已有的
 *                                   face3 自动挑（也可用 faces 显式指定）
 */
export type SectionCut =
  | string
  | {
      /** 多面体的全部顶点 id（正方体 8 个、三棱锥 4 个） */
      vertices: string[];
      /** 显式指定各个面（每个面是按环绕顺序排的顶点 id）；不写则用 face3 */
      faces?: string[][];
    };

export interface Section3Object extends Base3D {
  type: 'section3';
  cut: SectionCut;
  /** 定平面方式一：平面上三个点（顶点 id 或 "x, y, z" 坐标） */
  plane?: [PointRef, PointRef, PointRef];
  /** 定平面方式二：平面过的一点 + 法向量（不必单位化） */
  p?: PointRef;
  normal?: [Expr | number, Expr | number, Expr | number];
  /** 截面填充的不透明度（默认 0.14；交线不受它控制，跟随 color） */
  opacity?: number;
}

/** 曲面体（旋转体）：渲染器要按视角算轮廓，不能像多面体那样靠面判断 */
export type Curved3Object = Cylinder3Object | Cone3Object | Sphere3Object;

export type Scene3DObject =
  | Point3Object
  | Edge3Object
  | Face3Object
  | Cylinder3Object
  | Cone3Object
  | Sphere3Object
  | Section3Object;

/**
 * 立体几何约束：把题面给的关系声明出来，让程序**真的验算**。
 *
 * 和 2D 的 constraints 是两套：3D 里"垂直"必须说清是**两条线**垂直
 * （空间中两条直线垂直可以不共面），"共面"也才有意义。
 * 引用的都是 point3 的 id。
 */
export type Constraint3 =
  /** |AB| = |CD| */
  | { type: 'equal-length'; a: [string, string]; b: [string, string] }
  /** |AB| : |CD| = ratio */
  | { type: 'length-ratio'; a: [string, string]; b: [string, string]; ratio: number }
  /** 直线 AB ⊥ 直线 CD（异面垂直也算，只看方向向量） */
  | { type: 'perp-lines'; a: [string, string]; b: [string, string] }
  /** 直线 AB ∥ 直线 CD */
  | { type: 'parallel-lines'; a: [string, string]; b: [string, string] }
  /** 三点共线（空间中） */
  | { type: 'collinear'; points: string[] }
  /** 四点（可更多）共面——立体几何最核心的关系之一 */
  | { type: 'coplanar'; points: string[] }
  /** M 是 AB 的中点 */
  | { type: 'midpoint'; m: string; ends: [string, string] }
  /** P 在线段 AB 上（含端点） */
  | { type: 'on-segment'; p: string; ends: [string, string] }
  /** ∠ABC = deg（顶点在中间） */
  | { type: 'angle-value'; points: [string, string, string]; deg: number }
  /** 题面给的定值：expr 里可以写 dist3(A,B) / angle3(A,B,C) / area3(A,B,C) */
  | { type: 'value'; expr: string; equals: number };

/** 相机初始视角 */
export interface Camera3D {
  /** 相机到原点的距离；不传则按包围盒自动算 */
  distance?: number;
  /** 方位角（度）：绕竖直轴转，0 = 正前方 */
  azimuth?: number;
  /** 仰角（度）：0 = 平视，90 = 俯视 */
  elevation?: number;
  /** 透视视场角（度），默认 45 */
  fov?: number;
}

export interface Scene3D {
  /** 判别字段：main.ts 靠它决定交给哪个渲染器 */
  space: '3d';
  meta: SceneMeta;
  params: ParamDef[];
  objects: Scene3DObject[];
  camera?: Camera3D;
  /**
   * 是否画坐标轴（x/y/z 三根带箭头的方向轴）。
   *
   * 默认**开**。理由：立体图最容易被看错的就是"高到底在哪"，
   * 有了 z 轴，"底面在 z=0、顶点在 z=h"这件事立刻看得见。
   * 题目不需要（比如纯欣赏用的几何体）就写 false 关掉。
   */
  axes?: boolean;
  /** 实时数值（长度/角度/面积），表达式里可直接写点 id */
  readouts?: ReadoutDef[];
  /** 分步讲解，与 2D 同一套语义（highlight 高亮、reveal 渐显） */
  steps?: StepDef[];
  constraints?: Constraint3[];
}

/**
 * 类型守卫：区分 2D / 3D 场景。
 * 参数写成 unknown 是有意的——2D 的 Scene 压根没有 space 字段，
 * 声明成 `{ space?: string }` 会让 Scene 因为"没有共同属性"而传不进来。
 */
/** 类型守卫：是不是旋转体（圆柱/圆锥/球） */
export function isCurved3(o: Scene3DObject): o is Curved3Object {
  return o.type === 'cylinder3' || o.type === 'cone3' || o.type === 'sphere3';
}

export function isScene3D(s: unknown): s is Scene3D {
  return (
    typeof s === 'object' &&
    s !== null &&
    (s as { space?: string }).space === '3d'
  );
}
