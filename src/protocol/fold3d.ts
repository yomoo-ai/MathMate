/**
 * fold3d.ts —— 折起（翻折）的纯几何：绕折痕轴转一块平面
 *
 * ===== 这一层只做三件事 =====
 *   ① 把场景里的 fold 声明核成一个"能演的"计划（折痕轴、会动的顶点、折起角）
 *   ② 给一个角度，算出这一帧每个顶点在哪（绕轴旋转，Rodrigues 公式）
 *   ③ 给出"完全展开"那一堆点，用于取景——展开态通常比折好态更宽，
 *      相机按折好态取景的话，一开始折之前的图会被裁掉一角
 *
 * ===== 为什么场景坐标是"折好之后" =====
 * 模型没法可靠地写两套坐标（折前 + 折后）：那等于让它手算一遍刚体变换，
 * 而它连垂足都算歪。所以只让它声明折好之后的图 + 折痕 + 折起角，
 * 展开态由这里把 moving 绕折痕转回去 −deg 得到。数学上这是同一个刚体变换的逆，
 * 只要 moving 真的是一块平面，展开态就精确等于"没折过"。
 *
 * 唯一的前提条件（体检器会核）：折痕必须**在 moving 这块平面上**。
 * 不在平面上时"转回去"得到的是扭过的曲面片，不是展开图——
 * 那种数据宁可整条 fold 丢掉，让视频退化成静态折好图，也不要演一个假动作。
 */
import type { FoldSpec, Vec3 } from './scene3d';

export type { Vec3 };

/** 一个可以演的翻折计划 */
export interface FoldPlan {
  /** 折痕两端（数学坐标）。旋转轴就是这条线 */
  a: Vec3;
  b: Vec3;
  /** 折起角（度）。场景声明的那个角，也就是"折到头"的位置 */
  deg: number;
  /**
   * 展开对应的那个偏移量（+deg 或 −deg）。
   *
   * 为什么会有符号问题：绕折痕转 deg 度，往左转和往右转都能回到"某个平面里"，
   * 只凭折好的图形没法知道当初是从哪一边折上来的。转错边的后果是
   * **折起的那块会摊到另一半身上**（看起来像两块纸叠在一起）。
   * 所以这里按物理直觉挑：往"另一半的反方向"摊，那才是原来的平铺图。
   */
  flatOffset: number;
  /** 会跟着动的顶点 id（折痕上的端点也在里面也没关系，它们本来就不动） */
  ids: string[];
  /** 每个动顶点的**声明坐标**（折好状态）。每帧都从它出发算，避免误差累积 */
  base: Map<string, Vec3>;
}

const sub = (p: Vec3, q: Vec3): Vec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (p: Vec3, q: Vec3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross = (p: Vec3, q: Vec3): Vec3 => [
  p[1] * q[2] - p[2] * q[1],
  p[2] * q[0] - p[0] * q[2],
  p[0] * q[1] - p[1] * q[0],
];
const len = (p: Vec3) => Math.hypot(p[0], p[1], p[2]);

/**
 * 绕轴 a→b 旋转 deg 度（右手定则：拇指指 a→b，四指卷曲方向为正）。
 *
 * 用 Rodrigues 公式而不是构造旋转矩阵：一次算完没有中间状态，
 * 也不依赖任何全局约定（坐标轴顺序、y 朝上还是 z 朝上都不影响）。
 */
export function rotateAboutAxis(p: Vec3, a: Vec3, b: Vec3, deg: number): Vec3 {
  const axis = sub(b, a);
  const l = len(axis);
  if (l < 1e-12) return [p[0], p[1], p[2]];
  const u: Vec3 = [axis[0] / l, axis[1] / l, axis[2] / l];
  const v = sub(p, a);
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const uv = cross(u, v);
  const ud = dot(u, v);
  const r: Vec3 = [
    v[0] * c + uv[0] * s + u[0] * ud * (1 - c),
    v[1] * c + uv[1] * s + u[1] * ud * (1 - c),
    v[2] * c + uv[2] * s + u[2] * ud * (1 - c),
  ];
  return [a[0] + r[0], a[1] + r[1], a[2] + r[2]];
}

/** 平面法向：三个不共线的点定不出法向就返回 null */
function planeNormal(p: Vec3[]): Vec3 | null {
  if (p.length < 3) return null;
  const n = cross(sub(p[1], p[0]), sub(p[2], p[0]));
  const l = len(n);
  if (l < 1e-9) return null;
  return [n[0] / l, n[1] / l, n[2] / l];
}

/**
 * 把 fold 声明核成计划。核不过返回 null + 原因——调用方据此"安静地不演"，
 * 而不是把整个场景判死（翻折只是讲解效果，图本身可能是对的）。
 */
export function planFold(
  fold: FoldSpec | undefined,
  pts: Map<string, Vec3>,
): { plan: FoldPlan | null; why?: string } {
  if (!fold) return { plan: null };
  const [c0, c1] = fold.crease ?? [];
  if (!c0 || !c1) return { plan: null, why: '折痕缺少端点' };
  if (c0 === c1) return { plan: null, why: '折痕两端是同一个点' };
  const pa = pts.get(c0);
  const pb = pts.get(c1);
  if (!pa || !pb) return { plan: null, why: `折痕端点 ${!pa ? c0 : c1} 不存在（或坐标算不出来）` };
  if (len(sub(pb, pa)) < 1e-9) return { plan: null, why: '折痕两端重合，定不出转轴' };

  const ids: string[] = [];
  const base = new Map<string, Vec3>();
  const list: Vec3[] = [];
  for (const id of fold.moving ?? []) {
    const p = pts.get(id);
    if (!p) continue; // 不存在的点直接跳过：少转一个点比整条动作丢掉轻
    ids.push(id);
    base.set(id, [p[0], p[1], p[2]]);
    list.push(p);
  }
  if (ids.length < 3) return { plan: null, why: '跟着折的顶点少于 3 个，折不出平面' };

  // 平面取"第一个能定出法向的三元组"，再检查**全部** moving 点是否在这一平面上。
  // 只查前三点的平面是不够的：真实事故是把另一块的点也写进 moving，
  // 那样凑出来的平面照样有法向、折痕也照样在平面上，一路绿灯，
  // 结果折起来时整张图一起转——所以必须逐点核共面。
  let n: Vec3 | null = null;
  for (let i = 2; i < list.length && !n; i++) {
    n = planeNormal([list[0], list[1], list[i]]);
  }
  if (!n) return { plan: null, why: '跟着折的顶点共线，不成平面' };

  const scale = Math.max(1, ...list.map((p) => len(p)));
  const tol = 1e-3 * scale;
  for (let i = 0; i < list.length; i++) {
    const d = Math.abs(dot(sub(list[i], list[0]), n));
    if (d > tol) {
      return {
        plan: null,
        why: `顶点 ${ids[i]} 不在"跟着折的那一块"平面内（偏离 ${d.toFixed(3)}），它不该写进 moving`,
      };
    }
  }

  // 折痕必须在 moving 平面上——不在的话"转回去"得到的是扭曲的形状，不是展开图
  const d0 = Math.abs(dot(sub(pa, list[0]), n));
  const d1 = Math.abs(dot(sub(pb, list[0]), n));
  if (d0 > tol || d1 > tol) {
    return {
      plan: null,
      why: `折痕 ${c0}${c1} 不在"跟着折的那一块"平面上（端点偏离 ${Math.max(d0, d1).toFixed(3)}），折起来会扭`,
    };
  }

  return {
    plan: {
      a: pa,
      b: pb,
      deg: fold.deg,
      flatOffset: pickFlatOffset(pa, pb, fold.deg, ids, base, pts),
      ids,
      base,
    },
  };
}

/**
 * 挑"展开到哪一边"。
 *
 * 判据：摊平以后，折起来的那块应该落在**另一半的反方向**
 * （矩形沿对角线折，两条腿在折痕两侧，摊平了也是两侧）。
 * 往错的一边摊，那块平面会正好压在另一半上——画面上看就是两块纸叠着。
 *
 * 做法：把折起那块的代表点绕折痕分别往两边转 deg，看哪一个转完以后
 * 它的"垂直分量"更接近另一半的垂直分量取反。取不到的（另一半没有点、
 * 或者点全在折痕上）就按 −deg 走，反正此时两边长得一样。
 */
function pickFlatOffset(
  a: Vec3,
  b: Vec3,
  deg: number,
  ids: string[],
  base: Map<string, Vec3>,
  pts: Map<string, Vec3>,
): number {
  const fallback = -deg;
  const axis = sub(b, a);
  const l = len(axis);
  if (l < 1e-12) return fallback;
  const u: Vec3 = [axis[0] / l, axis[1] / l, axis[2] / l];
  /** 垂直分量（单位化）：把点投到"垂直于折痕"的平面上 */
  const perp = (p: Vec3): Vec3 | null => {
    const v = sub(p, a);
    const d = dot(v, u);
    const w: Vec3 = [v[0] - u[0] * d, v[1] - u[1] * d, v[2] - u[2] * d];
    const wl = len(w);
    if (wl < 1e-9) return null;
    return [w[0] / wl, w[1] / wl, w[2] / wl];
  };

  // 折起那块里离折痕最远的点最有代表性（靠近折痕的点垂直分量太短，噪声大）
  const movingSet = new Set(ids);
  let sample: Vec3 | null = null;
  let best = 0;
  for (const [id, p] of base) {
    if (!movingSet.has(id)) continue;
    const w = perp(p);
    if (!w) continue;
    const d = len(sub(p, a));
    if (d > best) {
      best = d;
      sample = p;
    }
  }
  if (!sample) return fallback;

  // 另一半的代表点：不在 moving 里、也不在折痕上的点
  let fixed: Vec3 | null = null;
  let fbest = 0;
  for (const [id, p] of pts) {
    if (movingSet.has(id)) continue;
    const w = perp(p);
    if (!w) continue;
    const d = len(sub(p, a));
    if (d > fbest) {
      fbest = d;
      fixed = p;
    }
  }
  const wf = fixed ? perp(fixed) : null;
  if (!wf) return fallback;

  let pick = fallback;
  let bestDot = 2;
  for (const off of [-deg, deg]) {
    const w = perp(rotateAboutAxis(sample, a, b, off));
    if (!w) continue;
    // 目标：与另一半的方向**相反**（点积越接近 −1 越好）
    const d = dot(w, wf);
    if (d < bestDot) {
      bestDot = d;
      pick = off;
    }
  }
  return pick;
}

/**
 * 折到 offset 度（相对**声明状态**）：0 = 场景原样（折好），plan.flatOffset = 完全展开。
 *
 * 只返回"变了的顶点"，没变的一律不动——调用方拿去就地改渲染对象，
 * 每帧重建整张图的代价这台机器扛不住。
 */
export function foldPositions(plan: FoldPlan, offsetDeg: number): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  if (Math.abs(offsetDeg) < 1e-9) {
    for (const [id, p] of plan.base) out.set(id, p);
    return out;
  }
  for (const [id, p] of plan.base) {
    out.set(id, rotateAboutAxis(p, plan.a, plan.b, offsetDeg));
  }
  return out;
}

/** 完全展开时的顶点位置：取景要按它算，否则折之前那块会被裁掉 */
export function foldExtent(plan: FoldPlan): Vec3[] {
  return [...foldPositions(plan, plan.flatOffset).values()];
}

/**
 * 实测折起角（度）：折起的那一块与"另一块"的二面角，再用 180° 减掉。
 *
 * 为什么要量：声明写 90°，图却只折了 60°，展开再折回去的过程就会"多折 30°"，
 * 看起来像那块平面自己往上翘。体检器拿这个数和 fold.deg 对一下就能发现。
 *
 * 算法避开"法向量夹角"那套（同一个角度有两个候选值，靠符号挑容易挑反）：
 * 把两个样本点各自投影到垂直于折痕的平面上，直接量两个方向的夹角。
 * 平放（没折）时得 180°，折成直角得 90°。
 *
 * fixedSample 由调用方给（通常取折痕之外的任意固定顶点）。取不到就给 null。
 */
export function dihedralAt(plan: FoldPlan, movingSample: Vec3, fixedSample: Vec3): number | null {
  const axis = sub(plan.b, plan.a);
  const l = len(axis);
  if (l < 1e-12) return null;
  const u: Vec3 = [axis[0] / l, axis[1] / l, axis[2] / l];
  const perp = (p: Vec3): Vec3 | null => {
    const v = sub(p, plan.a);
    const d = dot(v, u);
    const w: Vec3 = [v[0] - u[0] * d, v[1] - u[1] * d, v[2] - u[2] * d];
    const wl = len(w);
    if (wl < 1e-9) return null;
    return [w[0] / wl, w[1] / wl, w[2] / wl];
  };
  const w1 = perp(movingSample);
  const w2 = perp(fixedSample);
  if (!w1 || !w2) return null;
  const c = Math.min(1, Math.max(-1, dot(w1, w2)));
  return (Math.acos(c) * 180) / Math.PI;
}

/** 折起角 = 180° − 二面角（平放 = 0°，折成直角 = 90°） */
export function foldAngleFrom(plan: FoldPlan, movingSample: Vec3, fixedSample: Vec3): number | null {
  const d = dihedralAt(plan, movingSample, fixedSample);
  return d === null ? null : 180 - d;
}

