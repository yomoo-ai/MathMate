/**
 * annotations.ts —— 从 constraints 推算"题图标注"
 *
 * ===== 为什么单独一个文件？ =====
 * 讲解视频改成"镜头完全不动"之后，靠什么告诉观众"现在讲的是哪个角、哪条边"？
 * 答案是课本早就用了几十年的东西：角度弧 + 度数、直角小方块、等长刻度、长度数字。
 *
 * 这些记号有个共同点：它们**全都是已知条件的几何投影**。
 * 而约束段（protocol/scene.ts 的 Constraint）里恰好写着
 * 「∠BAD = 30°」「CA ⊥ CB」「BD = 2AD」——题目给的真值。
 *
 * 所以这里不调模型、不猜数字：直接把 constraints 翻译成图形记号。
 * 模型把 30° 的图画成 18° 时，标注依然写 30°（真相在数据里），
 * 而体检器会单独把这张图打回重做——「标注」和「体检」互相独立。
 *
 * 输出的是纯几何（折线 + 文字 + 位置），不含任何 Three.js 概念。
 * 渲染器拿到之后只负责画线贴字，将来要做 SVG/静态图导出也能直接复用。
 */
import type { Scene } from '../protocol/scene';
import { evalVec2 } from '../protocol/expr';

type Pt = [number, number];

/** 一条标注：若干折线 + 可选文字 */
export interface AnnotationMark {
  /** 要画的折线（世界坐标）。角度弧、直角方块、刻度线都是折线 */
  polylines: Pt[][];
  /** 文字内容，如 "30°"、"6"、"BD=2AD" */
  text?: string;
  /** 文字锚点（世界坐标） */
  at?: Pt;
  /**
   * 主目标 id：判断"这一句在讲它吗"的强证据。
   * 角类标注是顶点（∠BAD 的主角是 B 角，不是 A、D）；
   * 长度类标注是那条线段的两个端点。
   */
  primary: string[];
  /** 信息量权重：角度/直角 3 > 比例 2 > 单个长度/刻度 1。用于并列时挑更有用的 */
  weight: number;
}

const EPS = 1e-9;

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const len = (a: Pt): number => Math.hypot(a[0], a[1]);
const norm = (a: Pt): Pt | null => {
  const l = len(a);
  return l < EPS ? null : [a[0] / l, a[1] / l];
};

/** 数字去掉多余小数：6.0 → 6，2.50 → 2.5 */
function fmt(v: number): string {
  return String(Number(v.toFixed(2)));
}

/**
 * 给一条线段贴标注时，标签往哪一侧偏？
 * 规则：背离全图重心的一侧。否则靠近原点的边会把字标到图形里面去。
 */
function outwardNormal(a: Pt, b: Pt, centroid: Pt): Pt {
  const d = sub(b, a);
  const n = norm([-d[1], d[0]]) ?? [0, 1];
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const away = sub(mid, centroid);
  return n[0] * away[0] + n[1] * away[1] >= 0 ? n : [-n[0], -n[1]];
}

/** 在顶点 v 处、从 p0 转向 p2 画一段圆弧，返回折线 */
function arcPoints(v: Pt, p0: Pt, p2: Pt, radius: number): Pt[] | null {
  const u = norm(sub(p0, v));
  const w = norm(sub(p2, v));
  if (!u || !w) return null;
  const a0 = Math.atan2(u[1], u[0]);
  const a1 = Math.atan2(w[1], w[0]);
  // 取短弧：角差归一化到 (-π, π]
  let d = a1 - a0;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;

  const n = 16;
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (d * i) / n;
    pts.push([v[0] + radius * Math.cos(a), v[1] + radius * Math.sin(a)]);
  }
  return pts;
}

/** 角平分线方向上的文字位置（弧外侧） */
function bisectorLabelPos(v: Pt, p0: Pt, p2: Pt, radius: number): Pt | null {
  const u = norm(sub(p0, v));
  const w = norm(sub(p2, v));
  if (!u || !w) return null;
  const bis = norm([u[0] + w[0], u[1] + w[1]]);
  if (!bis) return null; // 180° 平角：没有平分方向，交给调用方跳过
  return [v[0] + bis[0] * radius, v[1] + bis[1] * radius];
}

/**
 * 把一份 2D 场景的 constraints 全部翻译成标注。
 * 求不出来的（引用了不存在的点、表达式不是 dist(...)）直接跳过——
 * 标注是锦上添花，绝不能因为一条脏数据让整个视频报错。
 */
export function buildAnnotations(
  scene: Scene,
  params: Record<string, number>,
): AnnotationMark[] {
  const constraints = scene.constraints;
  if (!constraints || constraints.length === 0) return [];

  // 点 id → 坐标（只认有 at 的点；派生点在 resolve 阶段已经算好写回 at）
  const scope: Record<string, number> = { x: 0, t: 0, ...params };
  const pos = new Map<string, Pt>();
  for (const obj of scene.objects) {
    if (obj.type !== 'point' || !obj.at) continue;
    const p = evalVec2(obj.at, scope);
    if (p) pos.set(obj.id, p);
  }
  if (pos.size === 0) return [];

  // 全图重心：给"标签往哪偏"定方向
  let cx = 0;
  let cy = 0;
  for (const p of pos.values()) {
    cx += p[0];
    cy += p[1];
  }
  const centroid: Pt = [cx / pos.size, cy / pos.size];

  const marks: AnnotationMark[] = [];
  const P = (id: string) => pos.get(id);

  for (const c of constraints) {
    switch (c.type) {
      case 'angle-value': {
        const [i0, iv, i2] = c.points;
        const p0 = P(i0);
        const v = P(iv);
        const p2 = P(i2);
        if (!p0 || !v || !p2) break;
        // 弧半径：取较短那一边的 26%，短边太短时至少给 0.5 个世界单位，
        // 否则退化成一段看不清的小点
        const r = Math.max(Math.min(len(sub(p0, v)), len(sub(p2, v))) * 0.26, 0.45);
        const arc = arcPoints(v, p0, p2, r);
        if (!arc) break;
        const labelPos = bisectorLabelPos(v, p0, p2, r * 1.75);
        marks.push({
          polylines: [arc],
          text: `${fmt(c.deg)}°`,
          at: labelPos ?? undefined,
          primary: [iv],
          weight: 3,
        });
        break;
      }

      case 'perp': {
        // points = [A, 顶点, B]，画课本上的小方块
        const [i0, iv, i2] = c.points;
        const p0 = P(i0);
        const v = P(iv);
        const p2 = P(i2);
        if (!p0 || !v || !p2) break;
        const u = norm(sub(p0, v));
        const w = norm(sub(p2, v));
        if (!u || !w) break;
        const s = Math.max(Math.min(len(sub(p0, v)), len(sub(p2, v))) * 0.18, 0.3);
        const q1: Pt = [v[0] + u[0] * s, v[1] + u[1] * s];
        const q2: Pt = [q1[0] + w[0] * s, q1[1] + w[1] * s];
        const q3: Pt = [v[0] + w[0] * s, v[1] + w[1] * s];
        marks.push({ polylines: [[q1, q2, q3]], primary: [iv], weight: 3 });
        break;
      }

      case 'value': {
        // 只认 dist(A,B) 这一种写法；"CD = 2" 这类定长最常用
        const m = /^dist\(\s*(\w+)\s*,\s*(\w+)\s*\)$/.exec(c.expr.trim());
        if (!m) break;
        const a = P(m[1]);
        const b = P(m[2]);
        if (!a || !b) break;
        const l = len(sub(b, a));
        if (l < EPS) break;
        const n = outwardNormal(a, b, centroid);
        const off = Math.max(l * 0.12, 0.3);
        marks.push({
          polylines: [],
          text: fmt(c.equals),
          at: [
            (a[0] + b[0]) / 2 + n[0] * off,
            (a[1] + b[1]) / 2 + n[1] * off,
          ],
          primary: [m[1], m[2]],
          weight: 1,
        });
        break;
      }

      case 'length-ratio': {
        // BD=2AD 这种倍数关系，直接把式子写在长的那条边上
        const a = P(c.a[0]);
        const b = P(c.a[1]);
        const c0 = P(c.b[0]);
        const d0 = P(c.b[1]);
        if (!a || !b || !c0 || !d0) break;
        const l = len(sub(b, a));
        if (l < EPS) break;
        const n = outwardNormal(a, b, centroid);
        const off = Math.max(l * 0.12, 0.3);
        const ratio = c.ratio === 1 ? '' : fmt(c.ratio);
        marks.push({
          polylines: [],
          text: `${c.a[0]}${c.a[1]}=${ratio}${c.b[0]}${c.b[1]}`,
          at: [
            (a[0] + b[0]) / 2 + n[0] * off,
            (a[1] + b[1]) / 2 + n[1] * off,
          ],
          primary: [c.a[0], c.a[1]],
          weight: 2,
        });
        break;
      }

      case 'equal-length': {        // 两条边各加一道垂直短杠（课本的"单杠"记法）
        const segs: Array<[string, string]> = [c.a, c.b];
        const polylines: Pt[][] = [];
        for (const [ia, ib] of segs) {
          const a = P(ia);
          const b = P(ib);
          if (!a || !b) continue;
          const dir = norm(sub(b, a));
          if (!dir) continue;
          const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          const half = Math.max(len(sub(b, a)) * 0.09, 0.22);
          const n: Pt = [-dir[1], dir[0]];
          polylines.push([
            [mid[0] + n[0] * half, mid[1] + n[1] * half],
            [mid[0] - n[0] * half, mid[1] - n[1] * half],
          ]);
        }
        if (polylines.length === 0) break;
        marks.push({
          polylines,
          primary: [c.a[0], c.a[1], c.b[0], c.b[1]],
          weight: 1,
        });
        break;
      }

      // parallel / collinear / on-segment / midpoint / angle-bisector 不做标记：
      // 这几类在题图上本来就不画记号（共线、中点在图上已经由位置本身表达），
      // 硬画反而把图弄乱。
      default:
        break;
    }
  }

  return marks;
}

/**
 * 挑出"这一句该显示哪些标注"。
 *
 * 规则（按优先级）：
 *   ① 主目标全部命中本句重点 → 这些是"确实在讲它"，全留（最多 2 条）
 *   ② 一条都没有全部命中 → 只留 1 条命中最多的（按信息量挑，宁可少标）
 *   ③ 都没命中 → 不标（"先看图形"这种句子不该满屏都是度数）
 *
 * 为什么不能简单地"有交集就显示"：三角形里每个角都共用顶点，
 * 一句讲 ∠A 的话会把 ∠A、∠B、∠C、BD=2AD 全勾出来，等于没标。
 */
export function pickAnnotations(
  marks: AnnotationMark[],
  focus: string[],
): AnnotationMark[] {
  if (marks.length === 0 || focus.length === 0) return [];
  const set = new Set(focus);

  const scored = marks
    .map((m) => {
      const hit = m.primary.filter((id) => set.has(id)).length;
      return { m, hit, score: m.primary.length ? hit / m.primary.length : 0 };
    })
    .filter((s) => s.score >= 0.5);

  if (scored.length === 0) return [];

  const exact = scored.filter((s) => s.score === 1);
  if (exact.length > 0) {
    return exact
      .sort((a, b) => b.m.weight - a.m.weight)
      .slice(0, 2)
      .map((s) => s.m);
  }

  // 部分命中：只留最有信息量的一条，避免"两个都沾一点"导致标错重点
  return scored
    .sort((a, b) => b.m.weight - a.m.weight || b.hit - a.hit)
    .slice(0, 1)
    .map((s) => s.m);
}
