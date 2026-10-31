/**
 * resolve3d.ts —— 三维场景的"补全"阶段（与 resolve.ts 平行）
 *
 * 干什么：
 *   ① 派生点（中点 / 重心 / 定比分点 / 垂足）按声明算出坐标表达式；
 *   ② 读数里的点 id 展开成三坐标（"dist3(A,B)" → "dist3(ax,ay,az,bx,by,bz)"）。
 *
 * 为什么仍然翻译成**表达式字符串**而不是数字？
 *   滑杆拖 a 的时候，整张图要跟着变。一旦算成数字，参数化就断了。
 *
 * 与 2D 版本的唯一实质区别：一个坐标是"三半"而不是"两半"。
 */

import type {
  Derive3Spec,
  Point3Object,
  PointRef,
  Scene3D,
  Scene3DObject,
  Vec3,
  Vec3Like,
} from './scene3d';
import { evalVec3Detailed, normalizeExpr, splitTopLevel } from './expr';
import { isCurved3 } from './scene3d';

/** 一个空间坐标的三段表达式 (x, y, z) */
type Tri = [string, string, string];

const p = (s: string) => `(${s})`;

function subE(a: Tri, b: Tri): Tri {
  return [`${p(a[0])} - ${p(b[0])}`, `${p(a[1])} - ${p(b[1])}`, `${p(a[2])} - ${p(b[2])}`];
}

function addE(a: Tri, b: Tri): Tri {
  return [`${p(a[0])} + ${p(b[0])}`, `${p(a[1])} + ${p(b[1])}`, `${p(a[2])} + ${p(b[2])}`];
}

function scaleE(k: string, a: Tri): Tri {
  return [`${p(k)} * ${p(a[0])}`, `${p(k)} * ${p(a[1])}`, `${p(k)} * ${p(a[2])}`];
}

/** 点积（标量表达式） */
function dotE(a: Tri, b: Tri): string {
  return `${p(a[0])} * ${p(b[0])} + ${p(a[1])} * ${p(b[1])} + ${p(a[2])} * ${p(b[2])}`;
}

/** 把坐标字段拆成三段；拆不出来返回 null */
export function atParts3(at: Vec3Like | undefined): Tri | null {
  if (at === undefined || at === null) return null;
  if (Array.isArray(at)) {
    const arr = at as unknown[];
    if (arr.length !== 3) return null;
    return [String(arr[0]), String(arr[1]), String(arr[2])];
  }
  const parts = splitTopLevel(normalizeExpr(String(at)))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length === 3 ? [parts[0], parts[1], parts[2]] : null;
}

/**
 * 按 derive 声明生成坐标表达式。
 * 每个分支都是教科书公式；括号显式加满，避免优先级歧义。
 */
function computeDerive3(
  d: Derive3Spec,
  coordOf: (id: string) => Tri | null,
): Tri | null {
  switch (d.kind) {
    case 'midpoint': {
      const A = coordOf(d.a);
      const B = coordOf(d.b);
      if (!A || !B) return null;
      return [
        `(${p(A[0])} + ${p(B[0])}) / 2`,
        `(${p(A[1])} + ${p(B[1])}) / 2`,
        `(${p(A[2])} + ${p(B[2])}) / 2`,
      ];
    }
    case 'centroid': {
      // 重心 = 三顶点坐标的算术平均（空间和平面上都是这个式子）
      const [A, B, C] = d.points.map(coordOf);
      if (!A || !B || !C) return null;
      return [
        `(${p(A[0])} + ${p(B[0])} + ${p(C[0])}) / 3`,
        `(${p(A[1])} + ${p(B[1])} + ${p(C[1])}) / 3`,
        `(${p(A[2])} + ${p(B[2])} + ${p(C[2])}) / 3`,
      ];
    }
    case 'section': {
      // P = A + t·(B−A)
      const A = coordOf(d.a);
      const B = coordOf(d.b);
      if (!A || !B) return null;
      return addE(A, scaleE(String(d.t), subE(B, A)));
    }
    case 'foot': {
      // 垂足 = A + k·(B−A)，k = ((P−A)·(B−A)) / |B−A|²
      // 这个式子在平面上是"作垂线"，在空间里同样成立（点到直线的垂足唯一）
      const A = coordOf(d.line[0]);
      const B = coordOf(d.line[1]);
      const P0 = coordOf(d.p);
      if (!A || !B || !P0) return null;
      const ab = subE(B, A);
      const ap = subE(P0, A);
      const k = `(${p(dotE(ap, ab))} / ${p(dotE(ab, ab))})`;
      return addE(A, scaleE(k, ab));
    }
    case 'circumcenter':
    case 'incenter': {
      // 外接球心 / 内心：这里不推导公式，只把四个顶点摊平成 12 个标量，
      // 交给表达式引擎里的 circumX3 / inX3 等函数去算（见 expr.ts）。
      // 好处是**参数化不丢**：拖滑杆改 a 的时候球心跟着重新算。
      const ps = d.points.map(coordOf);
      if (ps.some((q) => !q)) return null;
      const [A, B, C, D] = ps as Tri[];
      const args = [A, B, C, D]
        .map((q) => `${p(q[0])}, ${p(q[1])}, ${p(q[2])}`)
        .join(', ');
      const pre = d.kind === 'circumcenter' ? 'circum' : 'in';
      return [`${pre}X3(${args})`, `${pre}Y3(${args})`, `${pre}Z3(${args})`];
    }
    default:
      return null;
  }
}

/**
 * 解析"点引用"：既可以是已声明顶点的 id，也可以是直接写的坐标。
 *
 * 判别靠"有没有逗号"：坐标必须写成 "x, y, z" 三段（含两个逗号），
 * 而顶点 id 里不可能出现逗号。这个规则简单到不需要试探，也不需要报歧义。
 *
 * 失败时返回原因字符串而不是 null——体检器要能原话告诉模型哪里错了。
 */
export function evalPointRef(
  ref: PointRef,
  lookup: (id: string) => Vec3 | undefined,
  scope: Record<string, number>,
): { value: Vec3 | null; reason?: string } {
  if (Array.isArray(ref)) {
    return evalVec3Detailed(ref as Vec3Like, scope);
  }
  const raw = String(ref ?? '').trim();
  if (raw === '') return { value: null, reason: '点引用是空的（要写顶点 id 或 "x, y, z"）' };
  if (raw.includes(',')) {
    const r = evalVec3Detailed(raw as Vec3Like, scope);
    return r.value ? { value: r.value } : { value: null, reason: `坐标「${raw}」算不出来：${r.reason}` };
  }
  const hit = lookup(raw);
  if (hit) return { value: hit };
  return {
    value: null,
    reason: `找不到顶点「${raw}」——要么它没在 objects 里声明，要么 id 写法不一致（如 O1 与 O₁）`,
  };
}

/** 把表达式里的点 id 换成它的三坐标 */
function replacePointIds3(expr: string, coordOf: (id: string) => Tri | null): string {
  return expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) => {
    const parts = coordOf(name);
    if (!parts) return name;
    return `${p(parts[0])}, ${p(parts[1])}, ${p(parts[2])}`;
  });
}

/**
 * 把读数里的截面量改写成占位变量：secA3(sec) → __sec_a_sec。
 *
 * 为什么不走普通函数白名单？截面量（半长轴/面积）依赖**整张图的几何**，
 * 没法像 sqrt 一样拿到参数就现算。做法是：表达式里只留一个占位名，
 * 求值现场（渲染器的滑杆回调、体检器的读数检查）用 solveSection 算出数值，
 * 塞进 scope 一起求值。这样滑杆一动，截面量跟着变，参数化不丢。
 */
function expandSectionReads(expr: string, sectionIds: Set<string>): string {
  return expr.replace(
    /\bsec(A|B|Area|Perim|N)3\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g,
    (m, kind: string, id: string) => {
      if (!sectionIds.has(id)) return m;
      const key = kind.toLowerCase(); // a / b / area / perim / n
      return `__sec_${key}_${id}`;
    },
  );
}

/** 补全一份三维场景；返回新对象，不修改入参 */
export function resolveScene3D(scene: Scene3D): Scene3D {
  const points = new Map<string, Point3Object>();
  for (const o of scene.objects) {
    if (o.type === 'point3') points.set(o.id, o as Point3Object);
  }
  // 截面量的展开不依赖顶点，放在提前返回之前——
  // 否则"只有旋转体 + 截面、没有声明顶点"的场景读数会漏展开
  const sectionIds = new Set(
    scene.objects.filter((o) => o.type === 'section3').map((o) => o.id),
  );
  const expandReads = (expr: string) =>
    expandSectionReads(expr, sectionIds);
  if (points.size === 0) {
    return {
      ...scene,
      readouts: scene.readouts?.map((r) => ({ ...r, expr: expandReads(r.expr) })),
    };
  }

  const cache = new Map<string, Tri>();
  const visiting = new Set<string>();

  const coordOf = (id: string): Tri | null => {
    const key = id?.trim();
    if (!key) return null;
    const hit = cache.get(key);
    if (hit) return hit;
    const pt = points.get(key);
    if (!pt || visiting.has(key)) return null;
    visiting.add(key);
    let parts: Tri | null = null;
    if (pt.derive) {
      parts = computeDerive3(pt.derive, coordOf);
    } else {
      parts = atParts3(pt.at);
      // "at": "A" —— 直接指向另一个顶点
      if (!parts && typeof pt.at === 'string' && points.has(pt.at.trim())) {
        parts = coordOf(pt.at.trim());
      }
    }
    visiting.delete(key);
    if (parts) cache.set(key, parts);
    return parts;
  };

  const objects: Scene3DObject[] = scene.objects.map((obj) => {
    if (obj.type !== 'point3') {
      // 旋转体的半径也要展开点 id：这样球可以写
      //   "radius": "circumR3(V,A,B,C)" —— 半径由程序算，模型不用会解方程。
      // 纯参数半径（"r"、"a/2"）会原样通过：查不到同名顶点就保留原文。
      if (isCurved3(obj) && typeof obj.radius === 'string') {
        return { ...obj, radius: replacePointIds3(obj.radius, coordOf) } as Scene3DObject;
      }
      return obj;
    }
    const parts = coordOf(obj.id);
    // 算不出来写 NaN，让体检器点名报错——不要悄悄画到原点去（那里会挤一堆假点）
    return {
      ...obj,
      at: parts ? ([parts[0], parts[1], parts[2]] as Vec3Like) : ([NaN, NaN, NaN] as Vec3Like),
    } as Point3Object;
  });

  const readouts = scene.readouts?.map((r) => ({
    ...r,
    // 先展开截面量（secA3(sec) → __sec_a_sec），再展开点 id——
    // 占位变量以 __ 开头，不会被点 id 替换误伤
    expr: replacePointIds3(expandReads(r.expr), coordOf),
  }));

  // constraints 的 expr 保持原样：体检器求值那一刻才展开，
  // 这样报错里显示的仍是 "dist3(A,B)" 而不是一串坐标
  return { ...scene, objects, readouts };
}
