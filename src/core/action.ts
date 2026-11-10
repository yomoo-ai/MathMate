/**
 * action.ts —— 「几何动作」数据模型（讲题式视频的核心）
 *
 * ===== 为什么要有这一层？ =====
 * 之前一节课的模型是「一句话 + 高亮一个对象」。这套模型的问题不是不好看，
 * 而是它在结构上就等于翻页：这一句讲 A，下一句讲 B，画面是「换主角」，
 * 不是「长出新东西」。学生看到的永远是同一张图在变色。
 *
 * 真正的讲题是**动作**：作一条辅助线、把一个角标出来、在边上写个长度、
 * 往黑板上添一行推导。动作会**留在图上**，所以讲到第五句时，
 * 前四句的痕迹都还在——那才像黑板。
 *
 * 所以这里把「讲什么」拆成两层：
 *   say     —— 嘴上说的（口语，交给 TTS）
 *   actions —— 手上做的（几何动词，交给渲染器逐帧演出来）
 *
 * ===== 设计上的两条硬规矩 =====
 *   ① 动作只引用 id，不带坐标。模型最不擅长的就是算坐标（垂足算歪、
 *      分点比例取反是常态），让它只声明几何关系，坐标由这里解算。
 *   ② 动作是"可被拒绝"的：解析阶段逐条校验，不合法的直接丢掉。
 *      宁可少演一个动作，也不能让画面指向一个不存在的点。
 */
import type { Scene } from '../protocol/scene';
import { evalVec2 } from '../protocol/expr';

export type Pt = [number, number];

/**
 * 一个几何动作。
 *
 * newpoint 必须在同一步的 draw 之前出现——它负责"凭空"造出一个点
 * （垂足、分点）。没有它，模型想说"作 BD⊥AC 于 D"就只能编一个 D 的坐标。
 */
export type Action =
  /** 造点：D 在 AB 上且 AD:DB = t:(1-t)，或 D 是 P 到直线 AB 的垂足 */
  | {
      kind: 'newpoint';
      id: string;
      /** 分点形式：D 在 a→b 上，t=0 在 a，t=1 在 b */
      on?: [string, string];
      t?: number;
      /** 垂足形式：from 点到 line 两点连线的垂足 */
      foot?: { from: string; line: [string, string] };
    }
  /** 作线：从 from 画到 to（两端必须是已有点，可以是 newpoint 造的） */
  | { kind: 'draw'; from: string; to: string; dashed?: boolean }
  /** 标角：顶点 at，两边指向 arm1 / arm2；度数由 constraints 或图形本身决定 */
  | { kind: 'angle'; at: string; arm1: string; arm2: string }
  /** 标长度：在 from→to 这条边旁边写长度 */
  | { kind: 'length'; from: string; to: string }
  /** 等长记号：a1a2 与 b1b2 各打一道短杠 */
  | { kind: 'equal'; a1: string; a2: string; b1: string; b2: string }
  /** 强调：把注意力放到这些对象上（不改变图形，只改视觉权重） */
  | { kind: 'emphasize'; ids: string[] }
  /**
   * 扫参数：把滑杆 name 从 from 连续推到 to。
   *
   * 为什么需要它？——含参数的题（椭圆 x²/(m+9)+y²/(25−m)=1 求焦点位置）
   * 的核心就是"m 变了，图形怎么变"。没有这个动作，视频只能对着
   * 一张定死的图念 m 的范围，图和话天然对不上。
   * 只推已登记在 scene.params 里的参数，区间超界会被夹回滑杆范围。
   */
  | { kind: 'param'; name: string; from: number; to: number }
  /** 板书：往右侧黑板添一行推导。text 里可以用 $...$ 写公式 */
  | { kind: 'board'; text: string; accent?: boolean }
  /**
   * 折起（**仅立体题**）：把场景声明的 fold 从"完全展开"折到折起角。
   *
   * 为什么动作里不带折痕和角度：那些都在 scene.fold 里声明过一次了，
   * 这层只负责"什么时候折"。让模型再抄一遍折痕 id，等于给它一次抄错的机会
   * （真实事故：报错文案里的示例被照抄成上一题的答案）。
   */
  | { kind: 'fold' }
  /**
   * 转到视角（**仅立体题**）：
   *   face      —— 转到正对某个面（讲"看底面 ABCD"时用）
   *   azimuth/elevation —— 直接指一个视角（两人都省略就退化成原位停一下）
   *
   * 不转的话，讲"从上面看"只能对着斜视角干说，学生没法把话和图对上。
   */
  | { kind: 'view'; face?: string; azimuth?: number; elevation?: number };

/** 每种动作的默认演出时长（毫秒）。写在这里而不是散在各处，方便统一调节奏 */
export const ACTION_MS: Record<Action['kind'], number> = {
  newpoint: 260,
  draw: 720,
  angle: 460,
  length: 380,
  equal: 420,
  emphasize: 320,
  param: 1600,
  board: 300,
  // 折起要"看得见过程"：太快像跳帧，太慢会拖住讲解
  fold: 1900,
  // 转向是纯运镜，1.2 秒刚好——再快会晕，再慢会让人觉得卡住了
  view: 1200,
};

/** 同一句里多个动作之间的错峰间隔：像老师边说边画，不是一起蹦出来 */
export const ACTION_STAGGER_MS = 110;

const EPS = 1e-9;

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const len = (a: Pt): number => Math.hypot(a[0], a[1]);

/** 数字去掉多余小数：6.0 → 6，2.50 → 2.5 */
export function fmtNum(v: number): string {
  return String(Number(v.toFixed(2)));
}

/**
 * 把场景里的点解析成坐标表。
 *
 * 只认 type==='point' 且有 at 的对象——派生点（derive）在 resolveScene
 * 阶段已经把算好的坐标写回 at 了，这里不需要再算一遍几何关系。
 */
export function resolvePoints(
  scene: Scene,
  params: Record<string, number>,
): Map<string, Pt> {
  const scope: Record<string, number> = { x: 0, t: 0, ...params };
  const pos = new Map<string, Pt>();
  for (const obj of scene.objects) {
    if (obj.type !== 'point' || !obj.at) continue;
    const p = evalVec2(obj.at, scope);
    if (p) pos.set(obj.id, p);
  }
  return pos;
}

/** 点到直线 (a,b) 的垂足 */
function footOf(p: Pt, a: Pt, b: Pt): Pt | null {
  const d = sub(b, a);
  const l2 = d[0] * d[0] + d[1] * d[1];
  if (l2 < EPS) return null;
  const ap = sub(p, a);
  const t = (ap[0] * d[0] + ap[1] * d[1]) / l2;
  return [a[0] + d[0] * t, a[1] + d[1] * t];
}

/**
 * 解算一个 newpoint 的坐标。成功后写进 pos（后续动作就能引用它）。
 * 解不出来返回 null——调用方据此丢弃这条动作以及依赖它的 draw。
 */
export function applyNewPoint(action: Action, pos: Map<string, Pt>): Pt | null {
  if (action.kind !== 'newpoint') return null;
  let p: Pt | null = null;

  if (action.foot) {
    const from = pos.get(action.foot.from);
    const a = pos.get(action.foot.line[0]);
    const b = pos.get(action.foot.line[1]);
    if (from && a && b) p = footOf(from, a, b);
  } else if (action.on) {
    const a = pos.get(action.on[0]);
    const b = pos.get(action.on[1]);
    const t = typeof action.t === 'number' && isFinite(action.t) ? action.t : 0.5;
    // t 夹在 (0,1)：端点位置造点没有意义（等于重复已有的点）
    const tt = Math.min(1, Math.max(0, t));
    if (a && b) p = [a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt];
  }

  if (!p || !isFinite(p[0]) || !isFinite(p[1])) return null;
  pos.set(action.id, p);
  return p;
}

/** 从场景坐标算一个角的度数（0~180） */
export function angleAt(pos: Map<string, Pt>, at: string, arm1: string, arm2: string): number | null {
  const v = pos.get(at);
  const p0 = pos.get(arm1);
  const p2 = pos.get(arm2);
  if (!v || !p0 || !p2) return null;
  const u = sub(p0, v);
  const w = sub(p2, v);
  const lu = len(u);
  const lw = len(w);
  if (lu < EPS || lw < EPS) return null;
  const cos = Math.min(1, Math.max(-1, (u[0] * w[0] + u[1] * w[1]) / (lu * lw)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * 动作的中文短标签——底部"当前动作"提示条用它。
 *
 * 为什么不直接显示 say：一句讲解二三十个字，横在画面下方就是一整条字幕，
 * 又回到"看字幕不看图"的老路。标签只交代"手上在干什么"，细节交给语音。
 */
export function actionLabel(action: Action): string {
  switch (action.kind) {
    case 'newpoint':
      return action.foot ? `作垂足 ${action.id}` : `取点 ${action.id}`;
    case 'draw':
      return `作线 ${action.from}${action.to}`;
    case 'angle':
      return `标 ∠${action.arm1}${action.at}${action.arm2}`;
    case 'length':
      return `标 ${action.from}${action.to} 的长`;
    case 'equal':
      return `标等长 ${action.a1}${action.a2} = ${action.b1}${action.b2}`;
    case 'emphasize':
      return action.ids.length > 0 ? `看 ${action.ids.join('、')}` : '';
    case 'param':
      return `调 ${action.name}`;
    case 'board':
      return '';
    case 'fold':
      return '折起';
    case 'view':
      return action.face ? `转到看 ${action.face}` : '换视角';
    default:
      return '';
  }
}

/**
 * 立体题的动作提示条：只有"折起 / 转到视角"两种值得写出来。
 *
 * 3D 里 draw / angle / length 这些平面几何动作画不出来（它们算的是二维坐标），
 * 所以提示条不能像 2D 那样拿第一个动作凑——会出现"标 ∠BAC"写在画面上、
 * 图上却什么都没有。宁可不提示，也不能报假动作。
 */
export function motionLabel(actions: Action[]): string {
  for (const a of actions) {
    if (a.kind === 'fold') return '折起';
    if (a.kind === 'view') return a.face ? `转到看 ${a.face}` : '换视角';
  }
  return '';
}

/** 一组动作里最值得显示在提示条上的那一条（优先"手上动作"，其次强调） */
export function firstVisibleLabel(actions: Action[]): string {
  for (const a of actions) {
    if (a.kind === 'newpoint' || a.kind === 'board') continue;
    const l = actionLabel(a);
    if (l) return l;
  }
  for (const a of actions) {
    const l = actionLabel(a);
    if (l) return l;
  }
  return '';
}
