/**
 * annotations3d.ts —— 从 3D constraints 推算"空间题图标注"
 *
 * 和 core/annotations.ts（2D 版）是并列的两套，思路完全一致：
 * 讲解视频里镜头几乎不动，靠什么告诉观众"现在讲的是哪个角、哪条边"？
 * 答案是课本记号：角度弧 + 度数、直角小方块、长度数字、等长刻度。
 *
 * 这些记号全是**已知条件的几何投影**：约束段（scene3d.ts 的 Constraint3）里
 * 恰好写着「∠ABC = 60°」「VA ⊥ AB」「dist3(A,B) = 2」——题目给的真值。
 * 所以这里不调模型、不猜数字，直接把 constraints 翻译成空间图形记号。
 * 模型把 60° 的图画成 45° 时，标注依然写 60°（真相在数据里）；
 * 体检器会单独把画错的图打回重做——「标注」和「体检」互相独立。
 *
 * ===== 3D 与 2D 的三个本质差别 =====
 *
 * 1. 角度弧是**真空间圆弧**：在两条棱张成的平面内画（那个平面天然唯一），
 *    相机慢转时能看到它是空间里的扇形，而不是贴在某个面上的假弧。
 * 2. 直角方块同样画在两直线张成的平面内——两线垂直时这个平面才存在，
 *    所以"异面垂直"（两线不相交）画不出方块，直接跳过（画在投影交点会误导）。
 * 3. "外侧"没有全局约定：长度文字往哪偏？取「垂直于线段、背离场景形心」
 *    的方向，退化时（线段穿过形心）用叉积兜底随便选一个垂直方向。
 *
 * 输出是纯几何（空间折线 + 文字 + 锚点），不含任何 Three.js 概念；
 * 渲染器（renderer3d）负责画线贴字。挑选规则（pickAnnotations3D）与 2D 同款：
 * 一句讲 ∠A 的话不能把全图的度数都勾出来。
 */
import type { Scene3D, Vec3 } from '../protocol/scene3d';
import { evalVec3 } from '../protocol/expr';

/** 一条空间标注：若干折线 + 可选文字 */
export interface AnnotationMark3D {
  /** 要画的折线（数学坐标）。角度弧、直角方块、刻度线都是折线 */
  polylines: Vec3[][];
  /** 文字内容，如 "60°"、"6"、"BD=2AD" */
  text?: string;
  /** 文字锚点（数学坐标）。文字永远面向相机，位置固定在世界坐标 */
  at?: Vec3;
  /**
   * 主目标 id（顶点 id）：判断"这一句在讲它吗"的强证据。
   * 角类标注是顶点；长度类标注是那条线段的两个端点。
   */
  primary: string[];
  /** 信息量权重：角度/直角 3 > 比例 2 > 单个长度/刻度 1 */
  weight: number;
}

const EPS = 1e-9;

/**
 * 顶点 id 转成课本写法：末尾数字变下标（C1 → C₁）。
 *
 * 为什么必须转：顶点标签用的是模型写的 label（本来就带 ₁），而标注式子
 * 是拿 constraints 里的 id 拼字符串——不转的话式子里会硬生生多出一个
 * 普通数字「CN=2NC1」，跟图上的 NC₁ 对不上（2026-11-06 用户实测反馈）。
 * 已经是下标写法（C₁）的 id 不含 ASCII 数字，原样返回。
 */
const subId = (id: string): string => id.replace(/\d/g, (d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)]);


// ---- Vec3 小工具（与 2D annotations.ts 的 Pt 工具同族，只是多一维）----
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a: Vec3): Vec3 | null => {
  const l = len3(a);
  return l < EPS ? null : scale3(a, 1 / l);
};

/** 数字去掉多余小数：6.0 → 6，2.50 → 2.5 */
function fmt(v: number): string {
  return String(Number(v.toFixed(2)));
}

/**
 * 给一条线段贴长度文字时，锚点放在哪？
 * 中点 + 「垂直于线段、背离场景形心」方向偏一段距离。
 * 为什么不直接朝外（2D 的 outwardNormal）？空间里"外"有无穷多个方向，
 * 必须先投掉沿线分量，剩下的才是既垂直又不往图里钻的那个。
 */
function sideAnchor(a: Vec3, b: Vec3, centroid: Vec3, sceneR: number): Vec3 | null {
  const mid = scale3(add3(a, b), 0.5);
  const dir = norm3(sub3(b, a));
  if (!dir) return null;
  const l = len3(sub3(b, a));
  let n = sub3(sub3(mid, centroid), scale3(dir, dot3(sub3(mid, centroid), dir)));
  if (len3(n) < EPS) {
    // 线段穿过形心：随便取一个垂直方向（先 z 轴叉积，竖直线段再换 x 轴）
    n = cross3(dir, [0, 0, 1]);
    if (len3(n) < EPS) n = cross3(dir, [1, 0, 0]);
  }
  const nn = norm3(n);
  if (!nn) return null;
  const off = Math.max(l * 0.14, sceneR * 0.07);
  return add3(mid, scale3(nn, off));
}

/**
 * 把一份 3D 场景的 constraints 全部翻译成空间标注。
 * 求不出来的（点不存在、两臂共线、异面垂直……）直接跳过——
 * 标注是锦上添花，绝不能因为一条脏数据让整个视频报错。
 */
export function buildAnnotations3D(
  scene: Scene3D,
  params: Record<string, number>,
): AnnotationMark3D[] {
  const constraints = scene.constraints;
  if (!constraints || constraints.length === 0) return [];

  // 点 id → 坐标（只认有 at 的点；派生点在 resolve3d 阶段已算好写回 at）
  const scope: Record<string, number> = { x: 0, y: 0, z: 0, t: 0, ...params };
  const pos = new Map<string, Vec3>();
  for (const obj of scene.objects) {
    if (obj.type !== 'point3' || obj.at === undefined) continue;
    const p = evalVec3(obj.at, scope);
    if (p) pos.set(obj.id, p);
  }
  if (pos.size === 0) return [];

  // 场景形心与包围半径：所有"偏多少、画多大"都以它为尺度
  // （2D 用固定 0.45 个世界单位兜底，3D 的题图尺寸差异大，必须按场景比例来）
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of pos.values()) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  const centroid: Vec3 = [cx / pos.size, cy / pos.size, cz / pos.size];
  let sceneR = 0.5;
  for (const p of pos.values()) sceneR = Math.max(sceneR, len3(sub3(p, centroid)));

  const marks: AnnotationMark3D[] = [];
  const P = (id: string) => pos.get(id);

  for (const c of constraints) {
    switch (c.type) {
      case 'angle-value': {
        const [i0, iv, i2] = c.points;
        const p0 = P(i0);
        const v = P(iv);
        const p2 = P(i2);
        if (!p0 || !v || !p2) break;
        const u = norm3(sub3(p0, v));
        const wRaw = sub3(p2, v);
        if (!u || len3(wRaw) < EPS) break;
        const w = norm3(wRaw)!;
        // 在 u、w 张成的平面内建正交基：e1 沿第一臂，e2 是第二臂的垂直分量。
        // 两臂共线（0° 或 180°）时 e2 不存在，画不出有意义的弧，跳过。
        const cosT = Math.max(-1, Math.min(1, dot3(u, w)));
        const e2 = norm3(sub3(w, scale3(u, cosT)));
        if (!e2) break;
        const theta = Math.acos(cosT); // 实际几何角（弧画的是图上的真实角度）
        // 弧半径：短臂的 26%，太短时按场景半径兜底（2D 的 0.45 ≈ 半径的 9%）
        const r = Math.max(
          Math.min(len3(sub3(p0, v)), len3(wRaw)) * 0.26,
          sceneR * 0.09,
        );
        const n = 16;
        const arc: Vec3[] = [];
        for (let i = 0; i <= n; i++) {
          const a = (theta * i) / n;
          arc.push(add3(v, add3(scale3(u, r * Math.cos(a)), scale3(e2, r * Math.sin(a)))));
        }
        // 度数文字放角平分线方向、弧的外侧一点（2.1r：太近会压在弧上，
        // 也太容易和顶点字母撞在一起）
        const bis = norm3(add3(u, e2));
        marks.push({
          polylines: [arc],
          text: `${fmt(c.deg)}°`,
          at: bis ? add3(v, scale3(bis, r * 2.1)) : undefined,
          primary: [iv],
          weight: 3,
        });
        break;
      }

      case 'perp-lines': {
        // 直角小方块画在两直线张成的平面内——前提是两线**相交**。
        // 异面垂直（最短距离 > 0）没有公共点，方块画在哪都会误导，跳过。
        const a1 = P(c.a[0]);
        const a2 = P(c.a[1]);
        const b1 = P(c.b[0]);
        const b2 = P(c.b[1]);
        if (!a1 || !a2 || !b1 || !b2) break;
        const d1 = sub3(a2, a1);
        const d2 = sub3(b2, b1);
        const A = dot3(d1, d1);
        const E = dot3(d2, d2);
        if (A < EPS || E < EPS) break;
        // 无限长直线最近点（标准公式）：异面时两点不重合
        const rv = sub3(a1, b1);
        const B = dot3(d1, d2);
        const C = dot3(d1, rv);
        const F = dot3(d2, rv);
        const den = A * E - B * B;
        if (den < EPS * A * E) break; // 平行：没有交点
        const t = (B * F - C * E) / den;
        const s = (A * F - B * C) / den;
        const pa = add3(a1, scale3(d1, t));
        const pb = add3(b1, scale3(d2, s));
        if (len3(sub3(pa, pb)) > sceneR * 1e-3) break; // 异面：体检器管，标注不画
        const u = norm3(d1)!;
        const w = norm3(d2)!;
        // 方块边长：离交点最近的端点距离的 22%（2D 是 18%，3D 稍大更抗远看）
        const minArm = Math.min(
          len3(sub3(a1, pa)),
          len3(sub3(a2, pa)),
          len3(sub3(b1, pa)),
          len3(sub3(b2, pa)),
        );
        const size = Math.max(minArm * 0.22, sceneR * 0.05);
        const q1 = add3(pa, scale3(u, size));
        const q2 = add3(q1, scale3(w, size));
        const q3 = add3(pa, scale3(w, size));
        // 主目标：有公共端点就只认它（VA⊥AB 的主角是 A），
        // 两条对角线在半路相交这种，就把四个端点都带上
        const shared = c.a.filter((id) => c.b.includes(id));
        const primary = shared.length > 0 ? shared : [...new Set([...c.a, ...c.b])];
        marks.push({ polylines: [[q1, q2, q3]], primary, weight: 3 });
        break;
      }

      case 'value': {
        // 只认 dist3(A,B) 这一种写法；"CD = 2" 这类定长最常用
        const m = /^dist3\(\s*(\w+)\s*,\s*(\w+)\s*\)$/.exec(c.expr.trim());
        if (!m) break;
        const a = P(m[1]);
        const b = P(m[2]);
        if (!a || !b) break;
        marks.push({
          polylines: [],
          text: fmt(c.equals),
          at: sideAnchor(a, b, centroid, sceneR) ?? undefined,
          primary: [m[1], m[2]],
          weight: 1,
        });
        break;
      }

      case 'length-ratio': {
        // BD=2AD 这种倍数关系，把式子写在 c.a 那条线段外侧
        const a = P(c.a[0]);
        const b = P(c.a[1]);
        if (!a || !b) break;
        const ratio = c.ratio === 1 ? '' : fmt(c.ratio);
        marks.push({
          polylines: [],
          // 下标要跟图上顶点标签一致：CN=2NC₁，而不是 CN=2NC1
          text: `${subId(c.a[0])}${subId(c.a[1])}=${ratio}${subId(c.b[0])}${subId(c.b[1])}`,
          at: sideAnchor(a, b, centroid, sceneR) ?? undefined,
          primary: [c.a[0], c.a[1]],
          weight: 2,
        });
        break;
      }

      case 'equal-length': {
        // 两条线段各加一道垂直短杠（课本的"单杠"记法）。
        // 刻度方向：与线段垂直、大致朝场景外（线段穿过形心时用叉积兜底）。
        const segs: Array<[string, string]> = [c.a, c.b];
        const polylines: Vec3[][] = [];
        const ids: string[] = [];
        for (const [ia, ib] of segs) {
          const a = P(ia);
          const b = P(ib);
          if (!a || !b) continue;
          const dir = norm3(sub3(b, a));
          if (!dir) continue;
          const mid = scale3(add3(a, b), 0.5);
          let n = cross3(dir, sub3(mid, centroid));
          if (len3(n) < EPS) n = cross3(dir, [0, 0, 1]);
          if (len3(n) < EPS) n = cross3(dir, [1, 0, 0]);
          const nn = norm3(n);
          if (!nn) continue;
          const half = Math.max(len3(sub3(b, a)) * 0.09, sceneR * 0.04);
          polylines.push([add3(mid, scale3(nn, half)), sub3(mid, scale3(nn, half))]);
          ids.push(ia, ib);
        }
        if (polylines.length === 0) break;
        marks.push({ polylines, primary: ids, weight: 1 });
        break;
      }

      // parallel-lines / collinear / coplanar / midpoint / on-segment 不做标记：
      // 这几类在题图上本来就不画记号，硬画反而把图弄乱（与 2D 的取舍一致）。
      default:
        break;
    }
  }

  return marks;
}

/**
 * 挑出"这一句该显示哪些标注"。规则：
 *
 *   ① **主目标集合与本句重点完全一致** → 只留这类（最多 2 条）。
 *      这是最强的相关性证据："棱 AB 的长度等于 2"那句的 focus 正好是 {A,B}，
 *      而长度标注的主目标就是 {A,B}——它就是这句话要标的东西。
 *      不先认这一档的话，会被权重更高的直角方块（主目标只有 A）挤掉，
 *      结果讲长度的那句只画了个用不上的直角。
 *   ② 主目标全部命中本句重点 → 全留（最多 2 条，按权重）
 *   ③ 都没有全命中 → 只留 1 条命中最多的（按权重）
 *   ④ 都没命中 → 不标（"先看图形"的句子不该满屏度数）
 *
 * 调用方注意：focus 里传的是**顶点 id**。视频的高亮集合是对象 id
 * （棱 AB、面 fTop、球 ballOut），需要先经 videoStudio 的
 * focusPointIds 翻译成顶点 id 再传进来。
 */
export function pickAnnotations3D(
  marks: AnnotationMark3D[],
  focus: string[],
): AnnotationMark3D[] {
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
    // ① 主目标集合 === 本句重点：最精确的那一档
    const same = exact.filter(
      (s) => s.m.primary.length === set.size && s.m.primary.every((id) => set.has(id)),
    );
    const pool = same.length > 0 ? same : exact;
    return pool
      .sort((a, b) => b.m.weight - a.m.weight)
      .slice(0, 2)
      .map((s) => s.m);
  }

  return scored
    .sort((a, b) => b.m.weight - a.m.weight || b.hit - a.hit)
    .slice(0, 1)
    .map((s) => s.m);
}
