/**
 * sectionMath.ts —— 平面截旋转体（截面曲线）的纯数学
 *
 * 回答一个问题：**给定一个平面和一个旋转体（圆柱/圆锥/球），交线长什么样？**
 *
 * 为什么单独成模块（而不放进 curved3d）：
 *   - 这份数据有三类消费者——渲染器（画椭圆）、体检器（判断"切没切到/切穿了"）、
 *     读数求值（椭圆的半长轴/半短轴/面积）。放在 core/ 里会让 protocol 反向依赖
 *     core；放在 protocol/ 用纯坐标数组（V3 三元组）实现，谁都依赖得起。
 *   - 不 import three：体检器跑在回归测试里，没必要为此拉进整个渲染库。
 *
 * ===== 三种旋转体的交线方程（全部参数化采样，不写闭式椭圆公式）=====
 *
 *   球：   到球心距离 sd 的平面截出圆，半径 ρ=√(r²−sd²)——解析式直接给。
 *   圆柱： 侧面上的点 = A + s·u + r·v(φ)。代入平面方程 n·x=d 解出
 *          s(φ) = (d − n·A − r·n·v(φ)) / (n·u)。s(φ)∈[0,h] 时交线是完整椭圆。
 *   圆锥： 侧面上的点 = V + λ·g(φ)（V 锥尖，g(φ) 指向底面圆周）。代入得
 *          λ(φ) = (d − n·V) / (n·g(φ))。λ∈[0,1] 时是完整椭圆。
 *
 * 采样法的好处：圆柱/圆锥/球三种体走同一个出口（算出 loop + 每点的曲面外法线），
 * 而且半长轴/半短轴直接取「到形心距离的最大/最小」——椭圆的形心就是椭圆中心，
 * 这个性质让三种体连"算长短轴"的代码都共用，不用各自推公式。
 *
 * ===== 第一版明确不支持的四种退化情况（ok=false，给出原因）=====
 *
 *   平面与圆柱轴平行  → 截面是矩形（两条母线）
 *   平面平行于圆锥母线 → 截面是抛物线
 *   平面过锥尖        → 截面退化为三角形
 *   截面穿出端面/底面  → 交线不闭合（画面会出现悬空的半截椭圆）
 */

export type V3 = [number, number, number];

export type SolidKind = 'cylinder' | 'cone' | 'sphere';

/** 解析好的旋转体：a/b 是轴端点（球时 a=b=球心），r 半径。与 SolidGeom 同构但纯数值 */
export interface SolidSpec {
  kind: SolidKind;
  a: V3;
  b: V3;
  r: number;
}

/** 平面：过点 p、法向量 n（n 不必单位化） */
export interface PlaneSpec {
  p: V3;
  n: V3;
}

export interface SectionSolution {
  /** false = 切不出完整截面，reason 里说明原因（体检器会原话报给模型） */
  ok: boolean;
  /** true = 平面与体相交但交线穿出了端面/底面 */
  partial: boolean;
  reason?: string;
  /**
   * 截面形状：
   *   conic   —— 旋转体的截面，是椭圆/圆（有长短轴）
   *   polygon —— 多面体的截面，是三角形/四边形/五边形/六边形（没有长短轴）
   * 两者共用 loop/normals/center/area，但读数函数不同：
   * conic 能问 secA3/secB3，polygon 只能问 secArea3/secPerim3/secN3。
   */
  shape: 'conic' | 'polygon';
  /** 交线采样点（闭合，首尾不重复）。旋转体是 96 点采样，多面体是多边形顶点 */
  loop: V3[];
  /** 每个点处**承载它的那个面**的外法线（渲染分虚实用：法线朝向相机 → 实线） */
  normals: V3[];
  /** 截面中心（椭圆中心 / 圆心 / 多边形形心） */
  center: V3;
  /** 截面平面内的正交基（画填充多边形时给渲染器参照） */
  e1: V3;
  e2: V3;
  /** 半长轴 / 半短轴（球截面时相等；多边形截面为 NaN） */
  a: number;
  b: number;
  /** 截面面积 */
  area: number;
  /** 截面周长（多边形是边长之和；椭圆用 Ramanujan 近似） */
  perimeter: number;
  /** 多边形的顶点数（3=三角形、5=五边形…）；旋转体为 0 */
  n: number;
}

const TAU = Math.PI * 2;
/** 交线采样段数：96 段与 curved3d 的轮廓精度一致 */
const SEG = 96;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const dist = (a: V3, b: V3) => len(sub(a, b));

/** 与 u 垂直的单位向量：跟"最不平行的坐标轴"叉乘，避免退化（与 curved3d 同一套） */
function perp(u: V3): V3 {
  const [x, y, z] = u;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  const axis: V3 =
    ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  const c = cross(u, axis);
  return mul(c, 1 / (len(c) || 1e-12));
}

function fail(reason: string, partial = false): SectionSolution {
  return {
    ok: false,
    partial,
    reason,
    shape: 'conic',
    loop: [],
    normals: [],
    center: [0, 0, 0],
    e1: [1, 0, 0],
    e2: [0, 1, 0],
    a: NaN,
    b: NaN,
    area: NaN,
    perimeter: NaN,
    n: 0,
  };
}

/** 求平面与旋转体的交线。任何输入退化都返回 ok=false + 人话原因，不抛异常 */
export function solveSection(g: SolidSpec, plane: PlaneSpec): SectionSolution {
  const nl = len(plane.n);
  if (!(nl > 1e-12)) {
    return fail('平面法向量长度为 0（三点共线，或 normal 写成了全 0）');
  }
  const n = mul(plane.n, 1 / nl);
  const d = dot(n, plane.p);
  const e1 = perp(n);
  const e2 = cross(n, e1);

  if (g.kind === 'sphere') return sphereSection(g, n, d, e1, e2);
  if (g.kind === 'cylinder') return cylinderSection(g, n, d, e1, e2);
  return coneSection(g, n, d, e1, e2);
}

// ---------------------------------------------------------------
// 球：解析解
// ---------------------------------------------------------------

function sphereSection(
  g: SolidSpec,
  n: V3,
  d: number,
  e1: V3,
  e2: V3,
): SectionSolution {
  const C = g.a;
  // 球心到平面的有向距离
  const sd = dot(n, C) - d;
  if (Math.abs(sd) >= g.r) {
    return fail(
      `平面与球不相交（球心到平面距离 ${Math.abs(sd).toFixed(2)} ≥ 半径 ${g.r.toFixed(2)}）——把平面平移到与球相交`,
    );
  }
  const rho = Math.sqrt(g.r * g.r - sd * sd);
  const F = add(C, mul(n, -sd)); // 截面圆心 = 球心在平面上的投影

  const loop: V3[] = [];
  const normals: V3[] = [];
  for (let i = 0; i < SEG; i++) {
    const t = (i / SEG) * TAU;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const p: V3 = [
      F[0] + rho * (c * e1[0] + s * e2[0]),
      F[1] + rho * (c * e1[1] + s * e2[1]),
      F[2] + rho * (c * e1[2] + s * e2[2]),
    ];
    loop.push(p);
    normals.push(mul(sub(p, C), 1 / g.r));
  }
  return finish(loop, normals, e1, e2, rho, rho);
}

// ---------------------------------------------------------------
// 圆柱：s(φ) = (d − n·A − r·n·v(φ)) / (n·u)
// ---------------------------------------------------------------

function cylinderSection(
  g: SolidSpec,
  n: V3,
  d: number,
  e1: V3,
  e2: V3,
): SectionSolution {
  const A = g.a;
  const axis = sub(g.b, A);
  const h = len(axis);
  if (!(h > 1e-9)) return fail('圆柱轴长为 0');
  const u = mul(axis, 1 / h);
  const nu = dot(n, u);
  const w1 = perp(u);
  const w2 = cross(u, w1);

  // 平面与轴平行：交线是两条母线（或空），都不是"截面"
  if (Math.abs(nu) < 1e-9) {
    const dist = Math.abs(dot(n, A) - d);
    if (dist > g.r) {
      return fail(
        `平面与圆柱不相交（轴到平面距离 ${dist.toFixed(2)} > 半径 ${g.r.toFixed(2)}）`,
      );
    }
    return fail(
      '平面与圆柱的轴平行，截面是矩形（两条母线加两段端面弦）——暂不支持。' +
        '请让平面与轴斜交（法向量不要与轴垂直）',
    );
  }

  const loop: V3[] = [];
  const normals: V3[] = [];
  let sMin = Infinity;
  let sMax = -Infinity;
  for (let i = 0; i < SEG; i++) {
    const t = (i / SEG) * TAU;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const nv = dot(n, w1) * c + dot(n, w2) * s; // n·v(φ)
    const sphi = (d - dot(n, A) - g.r * nv) / nu;
    const v: V3 = [
      w1[0] * c + w2[0] * s,
      w1[1] * c + w2[1] * s,
      w1[2] * c + w2[2] * s,
    ];
    loop.push([
      A[0] + sphi * u[0] + g.r * v[0],
      A[1] + sphi * u[1] + g.r * v[1],
      A[2] + sphi * u[2] + g.r * v[2],
    ]);
    normals.push(v); // 圆柱侧面外法线 = 径向
    sMin = Math.min(sMin, sphi);
    sMax = Math.max(sMax, sphi);
  }
  // 沿轴位置超出 [0, h] → 交线穿出端面，画面会出现悬空的半截椭圆
  const tol = 1e-6 * Math.max(1, h);
  if (sMin < -tol || sMax > h + tol) {
    return fail(
      `截面穿出了圆柱端面（交线沿轴位置 ${sMin.toFixed(2)} ~ ${sMax.toFixed(2)}，轴长 ${h.toFixed(2)}）——` +
        '目前只支持完整截面：把平面往轴中部平移，或减小平面与轴的夹角',
      true,
    );
  }
  // 长短轴不走闭式公式（半长轴 = r/sinα、半短轴 = r 虽然能推出来），
  // 统一交给 finish() 按"到形心距离的最大/最小"算——圆柱/圆锥/球共用一段代码
  return finish(loop, normals, e1, e2, NaN, NaN);
}

// ---------------------------------------------------------------
// 圆锥：λ(φ) = (d − n·V) / (n·g(φ))
// ---------------------------------------------------------------

function coneSection(
  g: SolidSpec,
  n: V3,
  d: number,
  e1: V3,
  e2: V3,
): SectionSolution {
  const V = g.b; // 锥尖
  const C = g.a; // 底面圆心
  const axis = sub(V, C);
  const h = len(axis);
  if (!(h > 1e-9)) return fail('圆锥轴长为 0');
  const u = mul(axis, 1 / h); // 底面 → 锥尖
  const w1 = perp(u);
  const w2 = cross(u, w1);

  const apexDist = Math.abs(dot(n, V) - d);
  if (apexDist < 1e-9 * Math.max(1, g.r + h)) {
    return fail('平面过锥尖，截面退化为三角形——暂不支持。请把平面平移离开锥尖');
  }

  const loop: V3[] = [];
  const normals: V3[] = [];
  let lamMin = Infinity;
  let lamMax = -Infinity;
  for (let i = 0; i < SEG; i++) {
    const t = (i / SEG) * TAU;
    const c = Math.cos(t);
    const s = Math.sin(t);
    // g(φ)：从锥尖指向底面圆周的向量
    const gv: V3 = [
      C[0] - V[0] + g.r * (w1[0] * c + w2[0] * s),
      C[1] - V[1] + g.r * (w1[1] * c + w2[1] * s),
      C[2] - V[2] + g.r * (w1[2] * c + w2[2] * s),
    ];
    const ng = dot(n, gv);
    if (Math.abs(ng) < 1e-9 * Math.max(1, g.r + h)) {
      return fail(
        '平面平行于某条母线，截面是抛物线——暂不支持。请调整平面倾角',
      );
    }
    const lam = (d - dot(n, V)) / ng;
    loop.push([
      V[0] + lam * gv[0],
      V[1] + lam * gv[1],
      V[2] + lam * gv[2],
    ]);
    // 圆锥侧面外法线 ∝ h·径向 + r·轴向（与 curved3d 的 coneRuns 同一套）
    const radial: V3 = [w1[0] * c + w2[0] * s, w1[1] * c + w2[1] * s, w1[2] * c + w2[2] * s];
    normals.push(add(mul(radial, h), mul(u, g.r)));
    lamMin = Math.min(lamMin, lam);
    lamMax = Math.max(lamMax, lam);
  }
  const tol = 1e-6;
  if (lamMin < -tol || lamMax > 1 + tol) {
    return fail(
      `截面穿出了圆锥底面或锥尖（λ 范围 ${lamMin.toFixed(2)} ~ ${lamMax.toFixed(2)}，应在 0~1）——` +
        '目前只支持完整截面：把平面往锥体中部平移',
      true,
    );
  }
  return finish(loop, normals, e1, e2, NaN, NaN);
}

// ---------------------------------------------------------------
// 收尾：形心、长短轴、面积、平面尺寸（三种体共用）
// ---------------------------------------------------------------

function finish(
  loop: V3[],
  normals: V3[],
  e1: V3,
  e2: V3,
  aIn: number,
  bIn: number,
): SectionSolution {
  const center: V3 = [0, 0, 0];
  for (const p of loop) {
    center[0] += p[0];
    center[1] += p[1];
    center[2] += p[2];
  }
  center[0] /= loop.length;
  center[1] /= loop.length;
  center[2] /= loop.length;

  // 椭圆的形心就是椭圆中心：到中心距离的最大/最小值 = 半长轴/半短轴。
  // 这个性质让三种体共用一段代码，也天然覆盖"球截面是圆"（a=b）。
  let a = aIn;
  let b = bIn;
  if (!isFinite(a) || !isFinite(b)) {
    a = 0;
    b = Infinity;
    for (const p of loop) {
      const dd = dist(p, center);
      a = Math.max(a, dd);
      b = Math.min(b, dd);
    }
  }

  return {
    ok: true,
    partial: false,
    shape: 'conic',
    loop,
    normals,
    center,
    e1,
    e2,
    a,
    b,
    area: Math.PI * a * b,
    // 椭圆周长没有初等公式，用 Ramanujan 近似（相对误差 < 1e-4，教学够用）：
    //   P ≈ π[3(a+b) − √((3a+b)(a+3b))]
    perimeter: Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))),
    n: 0,
  };
}

// ===============================================================
// 平面截多面体（正方体、棱锥、棱柱的截面）
// ===============================================================
//
// 与旋转体完全不同的算法：多面体的截面一定是**多边形**，边数取决于平面
// 穿过几个面。做法是逐面求交，再把各面上的线段首尾串成环：
//
//   ① 每个面（凸多边形）与平面求交，得到 0、1 或 2 个交点；
//      2 个 → 这个面上有一段截面边，方向沿用该面的外法线（决定虚实）；
//   ② 所有线段按端点坐标配对串起来，形成闭合多边形；
//   ③ 去掉共线的中间点（截平面正好穿过某个顶点时，会在一条边中段
//      多产生一个点，几何上它不该算作新的截面顶点）。
//
// 「一条边中段多出点」是这类题的关键细节：课本里"过 D、M、N 作截面"，
// D 本身就是顶点，交线在 D 处拐弯但 D 前后不能算成两条边。
//
// ===== 明确不支持的退化情况 =====
//   平面与某个面重合       → 截面不是多边形，是那个面本身
//   平面只碰到一个顶点/一条棱 → 截面退化成点/线段
//   平面与多面体不相交     → 没有截面

/** 凸多面体：faces 是各个面的顶点（按环绕顺序，顺时针逆时针都行） */
export interface PolySolidSpec {
  faces: V3[][];
}

/**
 * 从协议里的 cut 描述构造多面体的面。
 *
 * 面从哪来？优先用 cut.faces（显式写），否则从场景里已有的 face3 自动挑：
 * 顶点全在 cut.vertices 里的面，就是这个多面体的面。
 * —— 让模型少写一遍，它声明 face3 时已经写过一次了。
 */
export function buildPolySpec(
  vertices: string[],
  explicitFaces: string[][] | undefined,
  lookup: (id: string) => V3 | undefined,
  sceneFaces: Array<{ points: string[] }>,
): { spec: PolySolidSpec } | { error: string } {
  if (!Array.isArray(vertices) || vertices.length < 4) {
    return {
      error:
        'cut 的 vertices 至少要 4 个顶点——多面体截面要列出这个多面体的全部顶点，' +
        '例如 cut: { "vertices": ["A","B","C","D","A1","B1","C1","D1"] }',
    };
  }
  const set = new Set<string>();
  const coords = new Map<string, V3>();
  for (const id of vertices) {
    const p = lookup(id);
    if (!p) return { error: `cut 的顶点「${id}」不存在或坐标算不出来` };
    set.add(id);
    coords.set(id, p);
  }

  const toFace = (ids: string[]): V3[] | null => {
    if (!Array.isArray(ids) || ids.length < 3) return null;
    const pts: V3[] = [];
    for (const id of ids) {
      const p = coords.get(id);
      if (!p) return null; // 面里有顶点不在 vertices 里：不是这个多面体的面
      pts.push(p);
    }
    return pts;
  };

  const faces: V3[][] = [];
  if (Array.isArray(explicitFaces) && explicitFaces.length > 0) {
    for (const ids of explicitFaces) {
      const f = toFace(ids);
      if (!f) {
        return { error: `cut.faces 里的 [${ids.join(',')}] 有顶点不在 vertices 中，或不足 3 个点` };
      }
      faces.push(f);
    }
  } else {
    for (const f of sceneFaces) {
      if (f.points.every((id) => set.has(id))) {
        const poly = toFace(f.points);
        if (poly) faces.push(poly);
      }
    }
  }

  if (faces.length < 4) {
    return {
      error:
        `只找到 ${faces.length} 个面，构不成封闭多面体。` +
        '要么给每个面声明 face3（顶点都在 vertices 里），要么在 cut 里显式写 faces: [["A","B","B1","A1"], …]',
    };
  }
  return { spec: { faces } };
}

export function solvePolySection(g: PolySolidSpec, plane: PlaneSpec): SectionSolution {
  const nl = len(plane.n);
  if (!(nl > 1e-12)) {
    return fail('平面法向量长度为 0（三点共线，或 normal 写成了全 0）');
  }
  const n = mul(plane.n, 1 / nl);
  const d = dot(n, plane.p);
  const e1 = perp(n);
  const e2 = cross(n, e1);

  // 尺度相关的容差：边长 4 的正方体与边长 0.4 的模型不能用同一个绝对阈值，
  // 否则一个"太松"（把临近顶点误判在平面上）、一个"太紧"（本该在平面上却没认出来）
  let scale = 0;
  for (const f of g.faces) {
    for (const v of f) scale = Math.max(scale, Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
  }
  const eps = 1e-7 * Math.max(1, scale);

  // 形心：凸多面体的形心必在内部，用来判断"哪个方向是外"
  const centroid: V3 = [0, 0, 0];
  let cnt = 0;
  for (const f of g.faces) {
    for (const v of f) {
      centroid[0] += v[0];
      centroid[1] += v[1];
      centroid[2] += v[2];
      cnt++;
    }
  }
  if (cnt === 0) return fail('多面体没有任何顶点');
  centroid[0] /= cnt;
  centroid[1] /= cnt;
  centroid[2] /= cnt;

  type Seg = { a: V3; b: V3; nrm: V3 };
  const segs: Seg[] = [];
  let coplanarFace = false;
  let minAbs = Infinity;
  let crossed = false;

  for (const face of g.faces) {
    const m = face.length;
    if (m < 3) continue;

    // Newell 法求面法线（对非严格平面的四边形也稳），再掰成朝外
    let fn: V3 = [0, 0, 0];
    for (let i = 0; i < m; i++) {
      const a = face[i];
      const b = face[(i + 1) % m];
      fn[0] += (a[1] - b[1]) * (a[2] + b[2]);
      fn[1] += (a[2] - b[2]) * (a[0] + b[0]);
      fn[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const fnLen = len(fn);
    if (!(fnLen > 1e-12)) continue; // 退化面（三点共线）
    fn = mul(fn, 1 / fnLen);
    const fc: V3 = [0, 0, 0];
    for (const v of face) {
      fc[0] += v[0] / m;
      fc[1] += v[1] / m;
      fc[2] += v[2] / m;
    }
    if (dot(fn, sub(fc, centroid)) < 0) fn = mul(fn, -1);

    const fv = face.map((v) => dot(n, v) - d);
    for (const x of fv) {
      minAbs = Math.min(minAbs, Math.abs(x));
      if (x > eps) crossed = true;
    }

    // 整个面都落在平面上：截面就是那个面，不存在"交线"
    if (fv.every((x) => Math.abs(x) <= eps)) {
      coplanarFace = true;
      continue;
    }

    const pts: V3[] = [];
    const push = (p: V3) => {
      if (!pts.some((q) => dist(q, p) < eps * 10)) pts.push(p);
    };
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const fi = fv[i];
      const fj = fv[j];
      // 顶点正好在平面上：它本身就是一个交点
      if (Math.abs(fi) <= eps) push(face[i]);
      // 这条棱穿过平面
      if (fi * fj < 0) {
        const t = fi / (fi - fj);
        push(add(face[i], mul(sub(face[j], face[i]), t)));
      }
    }

    if (pts.length === 2) {
      segs.push({ a: pts[0], b: pts[1], nrm: fn });
    } else if (pts.length > 2) {
      // 数值噪声下罕见：取最远的一对
      let bi = 0;
      let bj = 1;
      let best = -1;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dd = dist(pts[i], pts[j]);
          if (dd > best) {
            best = dd;
            bi = i;
            bj = j;
          }
        }
      }
      segs.push({ a: pts[bi], b: pts[bj], nrm: fn });
    }
  }

  if (coplanarFace) {
    return fail(
      '平面与多面体的某个面完全重合，截面就是这个面本身，不存在"截出来的多边形"——把平面平移开',
    );
  }
  if (segs.length === 0) {
    // 顶点正好落在平面上、但没有穿过任何面 → 只"碰到"一个顶点（或一条棱），
    // 截面退化成点/线段。这跟"根本不相交"是两回事，报错要分开：
    // 前者是题要讨论的临界情形，后者是平面放错了。
    if (minAbs <= eps * 10) {
      return fail(
        '平面只碰到多面体的一个顶点或一条棱，截面退化成点/线段，画不出多边形——把平面平行平移一点，切进内部',
      );
    }
    return fail(
      crossed
        ? '平面切过多面体，但交线不构成封闭多边形（面可能不是凸的，或 faces 写得不成环）'
        : `平面与多面体不相交（所有顶点在平面同侧，最近距离 ${minAbs.toFixed(3)}）——把平面移近图形`,
    );
  }
  if (segs.length < 3) {
    return fail(
      '平面只碰到多面体的一个顶点或一条棱，截面退化成点/线段。请让平面真正切进内部',
    );
  }

  // 串环：按端点坐标分组，逐段接下去
  const kOf = (p: V3) => p.map((x) => Math.round(x / (eps * 10))).join('|');
  const atKey = new Map<string, number[]>();
  segs.forEach((s, i) => {
    for (const k of [kOf(s.a), kOf(s.b)]) {
      const list = atKey.get(k);
      if (list) list.push(i);
      else atKey.set(k, [i]);
    }
  });

  const used = new Set<number>([0]);
  let loop: V3[] = [segs[0].a];
  const normals: V3[] = [segs[0].nrm];
  let cur = 0;
  let tail = segs[0].b;
  let closed = false;
  for (let guard = 0; guard <= segs.length; guard++) {
    if (dist(tail, loop[0]) < eps * 10) {
      closed = true;
      break;
    }
    loop.push(tail);
    normals.push(segs[cur].nrm);
    const next = (atKey.get(kOf(tail)) ?? []).filter((i) => !used.has(i));
    if (next.length === 0) break;
    const idx = next[0];
    used.add(idx);
    const s = segs[idx];
    tail = dist(s.a, tail) < dist(s.b, tail) ? s.b : s.a;
    cur = idx;
  }

  if (!closed) {
    return fail(
      '截面的各段没能连成一个闭合多边形（有面缺失或顶点顺序不对）——检查多面体的 face3 是否把每个面都声明了',
    );
  }
  if (used.size < segs.length) {
    // 出现了第二个环：说明"多面体"其实是由两个不相连的部分组成的
    return fail('截面算出了不止一个闭合环——这个多面体可能不是单一凸体（顶点集合不连通）');
  }

  // 去掉共线的中间点：截平面正好穿过顶点时，会在一条边的中段多出一个点
  const kept: V3[] = [];
  const keptN: V3[] = [];
  for (let i = 0; i < loop.length; i++) {
    const prev = loop[(i - 1 + loop.length) % loop.length];
    const next = loop[(i + 1) % loop.length];
    const v1 = sub(loop[i], prev);
    const v2 = sub(next, loop[i]);
    const cr = len(cross(v1, v2));
    const straight = cr < eps * (len(v1) + len(v2)) && dot(v1, v2) > 0;
    if (straight && kept.length > 0) continue;
    kept.push(loop[i]);
    keptN.push(normals[i]);
  }
  loop = kept;
  normals.length = 0;
  normals.push(...keptN);

  if (loop.length < 3) {
    return fail('截面退化成了线段（少于 3 个顶点）——把平面移进图形内部');
  }

  const center: V3 = [0, 0, 0];
  for (const p of loop) {
    center[0] += p[0] / loop.length;
    center[1] += p[1] / loop.length;
    center[2] += p[2] / loop.length;
  }

  // 面积：把多边形投影到平面基上算鞋带公式（等价于 Σ cross · n / 2）
  let area2 = 0;
  let perim = 0;
  for (let i = 0; i < loop.length; i++) {
    const j = (i + 1) % loop.length;
    area2 += dot(cross(loop[i], loop[j]), n);
    perim += dist(loop[i], loop[j]);
  }

  return {
    ok: true,
    partial: false,
    shape: 'polygon',
    loop,
    normals,
    center,
    e1,
    e2,
    a: NaN,
    b: NaN,
    area: Math.abs(area2) / 2,
    perimeter: perim,
    n: loop.length,
  };
}

/** 截面的目标：旋转体或多面体，统一出口 */
export type SectionTarget =
  | { kind: 'solid'; spec: SolidSpec }
  | { kind: 'poly'; spec: PolySolidSpec };

export function solveSectionOn(t: SectionTarget, plane: PlaneSpec): SectionSolution {
  return t.kind === 'solid' ? solveSection(t.spec, plane) : solvePolySection(t.spec, plane);
}
