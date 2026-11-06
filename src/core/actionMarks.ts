/**
 * actionMarks.ts —— 把一个「几何动作」翻译成可逐帧演出的覆盖图形
 *
 * 分工很明确：
 *   action.ts      只管"是什么动作、坐标在哪"（纯几何，不碰渲染）
 *   actionMarks.ts 只管"这个动作画出来长什么样"（弧、刻度、数字、标签）
 *   renderer.ts    只管"按进度把这些折线画出来"（不关心语义）
 *
 * 这样拆的好处：以后要把同一套讲解导出成 SVG 或视频，换掉渲染器就行，
 * 动作和图形的对应关系不用重写。
 *
 * 数字从哪来：优先取题目 constraints 里的真值（题说 30° 就写 30°），
 * 拿不到才用图形实测值。模型把图画出 18° 时，标注依然写 30°——
 * 图形错是图形的事，标注不跟着一起错。
 */
import type { Constraint } from '../protocol/scene';
import type { Action, Pt } from './action';
import { angleAt, fmtNum } from './action';
import type { OverlayShape } from './renderer';

export interface MarkContext {
  pos: Map<string, Pt>;
  constraints: Constraint[];
  /** 全图重心：决定长度标签往哪一侧偏（背离重心） */
  centroid: Pt;
  /** 覆盖线宽（世界单位）。由调用方按"若干屏幕像素"折算，保证不同缩放下粗细一致 */
  lineWidth: number;
  /** 辅助线宽度（比标注粗，它是讲解的主线） */
  helperWidth: number;
}

const EPS = 1e-9;
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const len = (a: Pt): number => Math.hypot(a[0], a[1]);
const norm = (a: Pt): Pt | null => {
  const l = len(a);
  return l < EPS ? null : [a[0] / l, a[1] / l];
};

/** 两点距离 */
export function dist(a: Pt, b: Pt): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function centroidOf(pos: Map<string, Pt>): Pt {
  if (pos.size === 0) return [0, 0];
  let cx = 0;
  let cy = 0;
  for (const p of pos.values()) {
    cx += p[0];
    cy += p[1];
  }
  return [cx / pos.size, cy / pos.size];
}

/** 在顶点 v 处、从 p0 转向 p2 画一段圆弧（短弧） */
function arcPoints(v: Pt, p0: Pt, p2: Pt, radius: number): Pt[] | null {
  const u = norm(sub(p0, v));
  const w = norm(sub(p2, v));
  if (!u || !w) return null;
  const a0 = Math.atan2(u[1], u[0]);
  const a1 = Math.atan2(w[1], w[0]);
  let d = a1 - a0;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  const n = 20;
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (d * i) / n;
    pts.push([v[0] + radius * Math.cos(a), v[1] + radius * Math.sin(a)]);
  }
  return pts;
}

/** 角平分线方向上的文字位置（弧外侧） */
function bisectorPos(v: Pt, p0: Pt, p2: Pt, radius: number): Pt | null {
  const u = norm(sub(p0, v));
  const w = norm(sub(p2, v));
  if (!u || !w) return null;
  const bis = norm([u[0] + w[0], u[1] + w[1]]);
  if (!bis) return null;
  return [v[0] + bis[0] * radius, v[1] + bis[1] * radius];
}

/** 背离重心的法向：长度标签往图外偏，不会压在图形里 */
function outwardNormal(a: Pt, b: Pt, centroid: Pt): Pt {
  const d = sub(b, a);
  const n = norm([-d[1], d[0]]) ?? [0, 1];
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const away = sub(mid, centroid);
  return n[0] * away[0] + n[1] * away[1] >= 0 ? n : [-n[0], -n[1]];
}

/** constraints 里登记的角度真值（顶点与两边顺序无关） */
export function constraintDeg(
  constraints: Constraint[],
  at: string,
  arm1: string,
  arm2: string,
): number | null {
  for (const c of constraints) {
    if (c.type === 'angle-value') {
      const [i0, iv, i2] = c.points;
      if (iv === at && ((i0 === arm1 && i2 === arm2) || (i0 === arm2 && i2 === arm1))) {
        return c.deg;
      }
    }
    if (c.type === 'perp') {
      const [i0, iv, i2] = c.points;
      if (iv === at && ((i0 === arm1 && i2 === arm2) || (i0 === arm2 && i2 === arm1))) {
        return 90;
      }
    }
  }
  return null;
}

/** constraints 里登记的线段长度真值 */
export function constraintLength(
  constraints: Constraint[],
  a: string,
  b: string,
): number | null {
  for (const c of constraints) {
    if (c.type !== 'value') continue;
    const m = /^dist\(\s*(\w+)\s*,\s*(\w+)\s*\)$/.exec(c.expr.trim());
    if (!m) continue;
    if ((m[1] === a && m[2] === b) || (m[1] === b && m[2] === a)) return c.equals;
  }
  return null;
}

/**
 * 动作 → 这一帧要画的图形。
 *
 * p = 0 时返回空数组（还没动笔）。调用方每帧调用一次。
 * key 前缀由调用方给（通常是 "b12a0"：第 12 句第 0 个动作），
 * 加上动作自己的序号，保证同一动作在每帧都用同一个 key，渲染器才能复用几何体。
 */
export function actionShapes(
  action: Action,
  ctx: MarkContext,
  p: number,
  keyBase: string,
): OverlayShape[] {
  const prog = Math.min(1, Math.max(0, p));
  if (prog <= 0) return [];
  const P = (id: string) => ctx.pos.get(id);

  switch (action.kind) {
    case 'draw': {
      const a = P(action.from);
      const b = P(action.to);
      if (!a || !b) return [];
      return [
        {
          key: `${keyBase}-line`,
          points: [a, b],
          progress: prog,
          dashed: action.dashed ?? true,
          width: ctx.helperWidth,
          color: '#c2410c',
        },
      ];
    }

    case 'newpoint': {
      const v = P(action.id);
      if (!v) return [];
      // 一个小方框：像老师用粉笔在点上圈一下
      const r = Math.max(ctx.lineWidth * 4, 0.12);
      const pts: Pt[] = [
        [v[0] - r, v[1] - r],
        [v[0] + r, v[1] - r],
        [v[0] + r, v[1] + r],
        [v[0] - r, v[1] + r],
        [v[0] - r, v[1] - r],
      ];
      return [
        {
          key: `${keyBase}-pt`,
          points: pts,
          progress: prog,
          text: action.id,
          textAt: [v[0] + r * 2.2, v[1] + r * 2.2],
          textProgress: Math.max(0, (prog - 0.5) / 0.5),
        },
      ];
    }

    case 'angle': {
      const v = P(action.at);
      const p0 = P(action.arm1);
      const p2 = P(action.arm2);
      if (!v || !p0 || !p2) return [];
      const r = Math.max(Math.min(dist(p0, v), dist(p2, v)) * 0.22, 0.4);
      const arc = arcPoints(v, p0, p2, r);
      if (!arc) return [];
      const deg =
        constraintDeg(ctx.constraints, action.at, action.arm1, action.arm2) ??
        angleAt(ctx.pos, action.at, action.arm1, action.arm2);
      return [
        {
          key: `${keyBase}-arc`,
          points: arc,
          progress: prog,
          text: deg === null ? undefined : `${fmtNum(Math.round(deg))}°`,
          textAt: bisectorPos(v, p0, p2, r * 1.8) ?? undefined,
          textProgress: Math.max(0, (prog - 0.6) / 0.4),
        },
      ];
    }

    case 'length': {
      const a = P(action.from);
      const b = P(action.to);
      if (!a || !b) return [];
      const l = dist(a, b);
      if (l < EPS) return [];
      const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const n = outwardNormal(a, b, ctx.centroid);
      const half = Math.max(l * 0.1, 0.22);
      // 一道短的"测量线"横跨这条边：从 -n 侧扫到 +n 侧，正好由 progress 控制
      const tick: Pt[] = [
        [mid[0] - n[0] * half, mid[1] - n[1] * half],
        [mid[0] + n[0] * half, mid[1] + n[1] * half],
      ];
      const v = constraintLength(ctx.constraints, action.from, action.to) ?? l;
      const off = Math.max(l * 0.1, 0.26);
      return [
        {
          key: `${keyBase}-tick`,
          points: tick,
          progress: prog,
          text: fmtNum(v),
          textAt: [mid[0] + n[0] * (half + off), mid[1] + n[1] * (half + off)],
          textProgress: Math.max(0, (prog - 0.5) / 0.5),
        },
      ];
    }

    case 'equal': {
      const segs: Array<[string, string]> = [
        [action.a1, action.a2],
        [action.b1, action.b2],
      ];
      const out: OverlayShape[] = [];
      segs.forEach(([ia, ib], i) => {
        const a = P(ia);
        const b = P(ib);
        if (!a || !b) return;
        const dir = norm(sub(b, a));
        if (!dir) return;
        const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const half = Math.max(dist(a, b) * 0.1, 0.22);
        const n: Pt = [-dir[1], dir[0]];
        out.push({
          key: `${keyBase}-eq${i}`,
          points: [
            [mid[0] - n[0] * half, mid[1] - n[1] * half],
            [mid[0] + n[0] * half, mid[1] + n[1] * half],
          ],
          progress: prog,
        });
      });
      return out;
    }

    // emphasize 不画东西（靠渲染器的聚焦/染色表达），board 是文字，也不画
    default:
      return [];
  }
}
