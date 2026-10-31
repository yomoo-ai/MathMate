/**
 * resolve.ts —— 场景解析的"补全"阶段（阶段 5）
 *
 * 模型写几何图时最自然的两件事，协议原本都不支持：
 *   ① 线段直接写点 id：{"type":"segment","from":"A","to":"B"}
 *   ② 派生点：E 是垂足、F 是交点、M 是中点——坐标让程序算
 *
 * 这个模块把这两种写法**翻译成表达式字符串**（不是算成数字），
 * 所以拖滑杆、拖点时坐标依然跟着变——参数化不会被破坏。
 *
 * 关键认识：模型算几何公式的能力很弱（实测三次重试给出同一个错的垂足），
 * 但它"声明关系"的能力很强。让它声明、让我们计算，这是分工问题，不是智商问题。
 */

import type { DeriveSpec, PointObject, Scene, SceneObject, Vec2Like } from './scene';
import { normalizeExpr, splitTopLevel } from './expr';

/** 一个坐标的两半表达式（x 表达式、y 表达式） */
type Parts = [string, string];

const p = (s: string) => `(${s})`;

function subE(a: Parts, b: Parts): Parts {
  return [`${p(a[0])} - ${p(b[0])}`, `${p(a[1])} - ${p(b[1])}`];
}

function addE(a: Parts, b: Parts): Parts {
  return [`${p(a[0])} + ${p(b[0])}`, `${p(a[1])} + ${p(b[1])}`];
}

/** 标量 × 坐标 */
function scaleE(k: string, a: Parts): Parts {
  return [`${p(k)} * ${p(a[0])}`, `${p(k)} * ${p(a[1])}`];
}

/** 点积（标量表达式） */
function dotE(a: Parts, b: Parts): string {
  return `${p(a[0])} * ${p(b[0])} + ${p(a[1])} * ${p(b[1])}`;
}

/** 把坐标字段拆成两半表达式；拆不出来返回 null */
export function atParts(at: Vec2Like | undefined): Parts | null {
  if (at === undefined || at === null) return null;
  if (Array.isArray(at)) {
    if (at.length !== 2) return null;
    return [String(at[0]), String(at[1])];
  }
  const parts = splitTopLevel(normalizeExpr(String(at)))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length === 2 ? [parts[0], parts[1]] : null;
}

/**
 * 按 derive 声明生成坐标表达式。
 * 每个分支都是教科书公式，写成字符串——括号全部显式加满，避免优先级歧义。
 */
function computeDerive(
  d: DeriveSpec,
  coordOf: (id: string) => Parts | null,
): Parts | null {
  switch (d.kind) {
    case 'midpoint': {
      const A = coordOf(d.a);
      const B = coordOf(d.b);
      if (!A || !B) return null;
      return [
        `(${p(A[0])} + ${p(B[0])}) / 2`,
        `(${p(A[1])} + ${p(B[1])}) / 2`,
      ];
    }
    case 'foot': {
      // E = A + k·(B−A)，k = ((P−A)·(B−A)) / |B−A|²
      const A = coordOf(d.line[0]);
      const B = coordOf(d.line[1]);
      const P0 = coordOf(d.p);
      if (!A || !B || !P0) return null;
      const ab = subE(B, A);
      const ap = subE(P0, A);
      const k = `(${p(dotE(ap, ab))} / ${p(dotE(ab, ab))})`;
      return addE(A, scaleE(k, ab));
    }
    case 'intersect': {
      // P = P1 + t·(P2−P1)，t = cross(Q1−P1, s) / cross(r, s)
      const P1 = coordOf(d.l1[0]);
      const P2 = coordOf(d.l1[1]);
      const Q1 = coordOf(d.l2[0]);
      const Q2 = coordOf(d.l2[1]);
      if (!P1 || !P2 || !Q1 || !Q2) return null;
      const r = subE(P2, P1);
      const s = subE(Q2, Q1);
      const w = subE(Q1, P1);
      const cross = (u: Parts, v: Parts) =>
        `${p(u[0])} * ${p(v[1])} - ${p(u[1])} * ${p(v[0])}`;
      const t = `(${p(cross(w, s))} / ${p(cross(r, s))})`;
      return addE(P1, scaleE(t, r));
    }
    case 'section': {
      // P = A + t·(B−A)。t=1/3 → 靠近 A 的三等分点（AB 分成 AP:PB = 1:2）
      const A = coordOf(d.a);
      const B = coordOf(d.b);
      if (!A || !B) return null;
      const k = String(d.t);
      return addE(A, scaleE(k, subE(B, A)));
    }
    default:
      return null;
  }
}

/** 点 id 在表达式里出现的正则（只替换完整标识符） */
function replacePointIds(
  expr: string,
  coordOf: (id: string) => Parts | null,
): string {
  return expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) => {
    const parts = coordOf(name);
    if (!parts) return name;
    // 点 id 展开成 "x, y" 两段——正好配合 dist(A,B)、ang(B,A,C) 这类函数签名
    return `${p(parts[0])}, ${p(parts[1])}`;
  });
}

/**
 * 补全一份场景：解出派生点坐标、把点 id 引用换成坐标表达式。
 *
 * 返回**新对象**，不修改入参（保持"场景是纯数据"的性质）。
 */
export function resolveScene(scene: Scene): Scene {
  const points = new Map<string, PointObject>();
  for (const o of scene.objects) {
    if (o.type === 'point') points.set(o.id, o as PointObject);
  }
  if (points.size === 0) return scene;

  const cache = new Map<string, Parts>();
  const visiting = new Set<string>();

  const coordOf = (id: string): Parts | null => {
    const key = id?.trim();
    if (!key) return null;
    const hit = cache.get(key);
    if (hit) return hit;
    const pt = points.get(key);
    if (!pt || visiting.has(key)) return null;
    visiting.add(key);
    let parts: Parts | null = null;
    if (pt.derive) {
      parts = computeDerive(pt.derive, coordOf);
    } else {
      parts = atParts(pt.at);
      // at 直接写成了另一个点的 id（"at": "A"）
      if (!parts && typeof pt.at === 'string' && points.has(pt.at.trim())) {
        parts = coordOf(pt.at.trim());
      }
    }
    visiting.delete(key);
    if (parts) cache.set(key, parts);
    return parts;
  };

  /** 非点对象的坐标字段：整串就是某个点 id 时替换掉 */
  const resolveCoord = (v: Vec2Like | undefined): Vec2Like | undefined => {
    if (typeof v !== 'string') return v;
    const key = v.trim();
    if (!points.has(key)) return v;
    const parts = coordOf(key);
    return parts ? ([parts[0], parts[1]] as Vec2Like) : v;
  };

  const objects: SceneObject[] = scene.objects.map((obj) => {
    if (obj.type === 'point') {
      const parts = coordOf(obj.id);
      // 派生点算不出来时写成 NaN，让体检器明确报错（而不是悄悄画在原点）
      return {
        ...obj,
        at: parts ? ([parts[0], parts[1]] as Vec2Like) : ([NaN, NaN] as Vec2Like),
      } as PointObject;
    }
    switch (obj.type) {
      case 'segment':
      case 'vector':
        return { ...obj, from: resolveCoord(obj.from)!, to: resolveCoord(obj.to)! };
      case 'polygon':
        return { ...obj, points: obj.points.map((q) => resolveCoord(q)!) };
      case 'circle':
      case 'arc':
        return { ...obj, center: resolveCoord(obj.center)! };
      default:
        return obj;
    }
  });

  // readouts 里允许直接写 dist(A,F)、ang(B,A,C) —— 点 id 展开成坐标两段
  const readouts = scene.readouts?.map((r) => ({
    ...r,
    expr: replacePointIds(r.expr, coordOf),
  }));

  // constraints 里的「定值」expr 保持原样：体检器在求值那一刻才把点 id 换成数值，
  // 这样报错里能显示用户/模型原本写的 "dist(C,D)"，而不是一串展开后的坐标。
  return { ...scene, objects, readouts };
}
