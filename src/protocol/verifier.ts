/**
 * verifier.ts —— 场景数值体检器（阶段 3 核心）
 *
 * ===== 为什么需要它？=====
 *
 * parseScene 只检查「格式」：字段在不在、类型对不对。
 * 但格式对 ≠ 数学对。LLM 完全可能输出这样的场景：
 *   - 某个点的坐标是 "h, k/0"（除零 → NaN）；
 *   - 表达式里用了没登记在 params 里的变量名；
 *   - readout 公式求值直接抛异常；
 *   - steps 高亮了一个根本不存在的对象 id。
 *
 * 渲染器对坏值的态度是「静默跳过」——画面不崩，但你会莫名少一个点。
 * 体检器的态度相反：把问题一条条列出来，error 级的打回给 LLM 重做。
 *
 * 怎么体检？没有魔法：用默认参数把每个表达式**真的求值一遍**。
 * 算得出有限数字 = 通过；NaN / Infinity / 抛异常 = 记一条问题。
 *
 * 两级问题：
 *   error —— 致命，画面必然缺东西，必须处理；
 *   warn  —— 提醒，不影响渲染，但通常意味着模型没按约定写。
 */

import type { Constraint, Scene, SceneObject, Vec2Like } from './scene';
import {
  evalAny,
  evalNumber,
  evalVec2Detailed,
  unknownNames,
  type Scope,
} from './expr';

export interface Issue {
  level: 'error' | 'warn';
  /** 哪个对象出的问题（顶层检查为 '-'） */
  where: string;
  message: string;
}

/** 用场景自带的默认参数值构造求值作用域 */
function defaultScope(scene: Scene): Record<string, number> {
  const scope: Record<string, number> = {};
  for (const p of scene.params) scope[p.name] = p.value;
  return scope;
}

/** 把「未定义名称」写成提示后缀——这条信息比"算不出数"有用一百倍 */
function unknownHint(expr: string, scope: Scope): string {
  const names = unknownNames(expr, scope);
  if (names.length === 0) return '';
  return `；表达式里出现了未定义的名称 ${names.join('、')}（没登记在 params 里，也没在前面定义过）`;
}

/** 求值一个坐标字段；失败返回一句人话描述 */
function checkVec2(v: Vec2Like, scope: Record<string, number>): string | null {
  const r = evalVec2Detailed(v, scope);
  if (!r.reason) return null;
  // 提示未定义名称时，数组写成 "0, a" 一样能查出来
  const raw = Array.isArray(v) ? v.join(', ') : String(v);
  return r.reason + unknownHint(raw, scope);
}

/** 求值一个数字表达式字段；失败返回一句人话描述 */
function checkNumber(expr: string, scope: Record<string, number>): string | null {
  let v: number;
  try {
    v = evalNumber(expr, scope);
  } catch (err) {
    return `表达式「${expr}」抛异常：${(err as Error).message}${unknownHint(expr, scope)}`;
  }
  if (isFinite(v)) return null;
  return `表达式「${expr}」算出来是 ${v}${unknownHint(expr, scope)}`;
}

/** 按对象类型收集所有「需要算一算」的字段 */
function checkObject(obj: SceneObject, scope: Record<string, number>): string[] {
  const problems: string[] = [];
  const push = (field: string, err: string | null) => {
    if (err) problems.push(`${field}：${err}`);
  };

  switch (obj.type) {
    case 'point': {
      const err = checkVec2(obj.at ?? '', scope);
      if (err) {
        // 派生点算不出来时要给出针对性的排查方向，别让它和普通坐标错误混在一起
        push(
          'at',
          obj.derive
            ? `${err}（派生点没算出来：检查 derive 里引用的点是否存在、两条线是否平行——平行线没有交点）`
            : err,
        );
      }
      break;
    }
    case 'segment':
    case 'vector':
      push('from', checkVec2(obj.from, scope));
      push('to', checkVec2(obj.to, scope));
      break;
    case 'polygon':
      obj.points.forEach((p, i) => push(`points[${i}]`, checkVec2(p, scope)));
      break;
    case 'circle':
    case 'arc': {
      push('center', checkVec2(obj.center, scope));
      push('radius', checkNumber(obj.radius, scope));
      if (obj.type === 'arc') {
        push('from', checkNumber(obj.from, scope));
        push('to', checkNumber(obj.to, scope));
      }
      break;
    }
    case 'curve': {
      // 曲线在几个采样点上试算：全 NaN 才报错（个别点无定义是正常的，
      // 比如 y=1/x 在 x=0 处）
      let valid = 0;
      for (const x of [-2, -1, 0, 1, 2]) {
        try {
          if (isFinite(evalNumber(obj.expr, { ...scope, x }))) valid++;
        } catch {
          /* 单点失败不计数 */
        }
      }
      if (valid === 0) {
        problems.push(
          'expr：在采样点 [-2,-1,0,1,2] 上全部无有效值' + unknownHint(obj.expr, scope),
        );
      }
      break;
    }
    case 'parametric': {
      let valid = 0;
      for (const t of [0, 1, 2, 3, 4]) {
        try {
          const x = evalNumber(obj.xExpr, { ...scope, t });
          const y = evalNumber(obj.yExpr, { ...scope, t });
          if (isFinite(x) && isFinite(y)) valid++;
        } catch {
          /* 同上 */
        }
      }
      if (valid === 0) {
        problems.push(
          'xExpr/yExpr：在采样 t 上全部无有效值' +
            unknownHint(`${obj.xExpr} ${obj.yExpr}`, scope),
        );
      }
      break;
    }
  }
  return problems;
}

/* ===============================================================
 * 几何约束验算（阶段 5）
 *
 * 数值体检能保证"每个坐标都算得出数"，但保证不了"这张图符合题意"。
 * constraints 段就是为此而生：模型把题面给的几何关系声明出来，
 * 这里按它自己写的坐标逐条验算 —— 说 CA⊥CB 就必须真的是直角。
 *
 * 验不出来时给出的不只是"错了"，而是**实测值 + 怎么改**：
 * 模型拿到"∠ACB 实测 68.2°，应为 90°"才知道该动哪个点。
 * =============================================================== */

type P2 = [number, number];

const sub2 = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const dot2 = (u: P2, v: P2) => u[0] * v[0] + u[1] * v[1];
const cross2 = (u: P2, v: P2) => u[0] * v[1] - u[1] * v[0];
const len2 = (u: P2) => Math.hypot(u[0], u[1]);
const fmtP = (p: P2) => `(${p[0].toFixed(2)}, ${p[1].toFixed(2)})`;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** 角度容差（度）。浮点误差远小于它，肉眼看不出的偏差不报 */
const ANG_TOL = 0.05;
/** 长度/距离的相对容差 */
const REL_TOL = 1e-3;

/** 两个方向向量的夹角，0~180 度 */
function angleBetween(u: P2, v: P2): number {
  const c = dot2(u, v) / (len2(u) * len2(v) || 1e-9);
  return toDeg(Math.acos(Math.max(-1, Math.min(1, c))));
}

/** 点 p 到直线 ab 的距离 */
function distToLine(p: P2, a: P2, b: P2): number {
  const d = sub2(b, a);
  const l = len2(d);
  if (l < 1e-12) return len2(sub2(p, a));
  return Math.abs(cross2(d, sub2(p, a))) / l;
}

interface ConstraintIssue {
  level: 'error' | 'warn';
  message: string;
}

/** 取点：不存在就返回一条提醒（说明是哪个 id 找不到） */
function getP(
  pts: Map<string, P2>,
  id: string,
  label: string,
): { p?: P2; issue?: ConstraintIssue } {
  const p = pts.get(id);
  if (!p) {
    return {
      issue: {
        level: 'warn',
        message: `${label}引用的点 id「${id}」不存在或坐标算不出来，这条几何关系没法验算`,
      },
    };
  }
  return { p };
}

/**
 * 验算一条约束。返回 null = 成立。
 * 消息写成"实测值 + 应该怎么改"，让模型能照着修，也让你能看懂。
 */
/**
 * 把表达式里的点 id 换成它的数值坐标（"dist(C,D)" → "dist((0.00), (0.00), ...)"）。
 *
 * 为什么不在解析阶段展开？因为报错要给人看：
 * 「dist(C,D) 应等于 2」比「dist((0), (0), ((0)+(...)), ...) 应等于 2」可读一百倍。
 * 所以只在求值这一瞬间替换，消息里仍然引用原始写法。
 */
function substitutePointIds(expr: string, pts: Map<string, P2>): string {
  return expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) => {
    const p = pts.get(name);
    return p ? `(${p[0]}) , (${p[1]})` : name;
  });
}

/** 把一条约束里提到的所有点 id 收进集合（用于判断"这个点有没有被任何约束管住"） */
function collectConstraintPointIds(c: Constraint, out: Set<string>) {
  const bag = c as unknown as Record<string, unknown>;
  const take = (v: unknown) => {
    if (typeof v === 'string') out.add(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.add(x);
  };
  for (const key of ['points', 'sides', 'ends', 'a', 'b', 'line', 'l1', 'l2', 'vertex', 'ray', 'p', 'm']) {
    if (key in bag) take(bag[key]);
  }
  // value 约束的 expr 里可以直接写点 id（如 "dist(C,D)"），其中的标识符也算被引用
  if (typeof bag.expr === 'string') {
    for (const m of bag.expr.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) out.add(m[0]);
  }
}

function checkConstraint(
  c: Constraint,
  pts: Map<string, P2>,
  where: string,
  scope: Record<string, number>,
): ConstraintIssue | null {
  const need = (id: string) => getP(pts, id, where);

  switch (c.type) {
    case 'perp': {
      const [aId, vId, bId] = c.points ?? [];
      const A = need(aId), V = need(vId), B = need(bId);
      if (A.issue) return A.issue;
      if (V.issue) return V.issue;
      if (B.issue) return B.issue;
      const ang = angleBetween(sub2(A.p!, V.p!), sub2(B.p!, V.p!));
      if (Math.abs(ang - 90) <= ANG_TOL) return null;
      return {
        level: 'error',
        message:
          `「${aId}${vId} ⊥ ${vId}${bId}」不成立：实测 ∠${aId}${vId}${bId} = ${ang.toFixed(1)}°（应为 90°）。` +
          `坐标是 ${aId}${fmtP(A.p!)}、${vId}${fmtP(V.p!)}、${bId}${fmtP(B.p!)}。` +
          `修法：把直角顶点 ${vId} 放在原点、两条直角边贴坐标轴（如 ${vId}=[0,0]、${aId}=[0,a]、${bId}=[b,0]），直角就自动成立`,
      };
    }
    case 'parallel': {
      const [a1, a2] = c.a ?? [];
      const [b1, b2] = c.b ?? [];
      const A1 = need(a1), A2 = need(a2), B1 = need(b1), B2 = need(b2);
      for (const x of [A1, A2, B1, B2]) if (x.issue) return x.issue;
      const u = sub2(A2.p!, A1.p!);
      const v = sub2(B2.p!, B1.p!);
      const ang = angleBetween(u, v);
      const dev = Math.min(ang, 180 - ang);
      if (dev <= ANG_TOL) return null;
      return {
        level: 'error',
        message: `「${a1}${a2} ∥ ${b1}${b2}」不成立：两线方向夹角 ${dev.toFixed(1)}°（平行应为 0°）。请把两条线写成同一方向（如都取水平）`,
      };
    }
    case 'collinear': {
      const [i1, i2, i3] = c.points ?? [];
      const P1 = need(i1), P2v = need(i2), P3 = need(i3);
      for (const x of [P1, P2v, P3]) if (x.issue) return x.issue;
      const d = distToLine(P3.p!, P1.p!, P2v.p!);
      const scale = Math.max(len2(sub2(P2v.p!, P1.p!)), 1);
      if (d / scale <= REL_TOL) return null;
      return {
        level: 'error',
        message: `「${i1}、${i2}、${i3} 共线」不成立：${i3}${fmtP(P3.p!)} 偏离直线 ${i1}${i2} 约 ${d.toFixed(2)}`,
      };
    }
    case 'on-segment': {
      const P = need(c.p);
      const E1 = need(c.ends?.[0] ?? '');
      const E2 = need(c.ends?.[1] ?? '');
      for (const x of [P, E1, E2]) if (x.issue) return x.issue;
      const a = E1.p!, b = E2.p!, p = P.p!;
      const d = sub2(b, a);
      const l2 = Math.max(dot2(d, d), 1e-12);
      const t = dot2(sub2(p, a), d) / l2;
      const off = distToLine(p, a, b);
      const scale = Math.max(len2(d), 1);
      const name = c.ends?.[0] + c.ends?.[1];
      if (off / scale > REL_TOL) {
        return {
          level: 'error',
          message:
            `「${c.p} 在线段 ${name} 上」不成立：${c.p}${fmtP(p)} 到直线 ${name} 的距离 ${off.toFixed(2)}（应为 0）。` +
            `修法：把 ${c.p} 写成 ${name} 上的点 —— ${c.p} = ${c.ends?.[0]} + k·(${c.ends?.[1]}−${c.ends?.[0]})，即 ` +
            `[${c.ends?.[0]}x + k*(${c.ends?.[1]}x − ${c.ends?.[0]}x), ${c.ends?.[0]}y + k*(${c.ends?.[1]}y − ${c.ends?.[0]}y)]，k 取 0~1 的常数`,
        };
      }
      if (t < -REL_TOL || t > 1 + REL_TOL) {
        return {
          level: 'error',
          message:
            `「${c.p} 在线段 ${name} 上」不成立：${c.p} 落在延长线上（参数 t = ${t.toFixed(2)}，应在 0~1 之间）。` +
            `坐标 ${c.p}${fmtP(p)}、${c.ends?.[0]}${fmtP(a)}、${c.ends?.[1]}${fmtP(b)}`,
        };
      }
      return null;
    }
    case 'equal-length': {
      const [a1, a2] = c.a ?? [];
      const [b1, b2] = c.b ?? [];
      const A1 = need(a1), A2 = need(a2), B1 = need(b1), B2 = need(b2);
      for (const x of [A1, A2, B1, B2]) if (x.issue) return x.issue;
      const l1 = len2(sub2(A2.p!, A1.p!));
      const l2v = len2(sub2(B2.p!, B1.p!));
      const rel = Math.abs(l1 - l2v) / Math.max(l1, l2v, 1);
      if (rel <= REL_TOL) return null;
      return {
        level: 'error',
        message: `「${a1}${a2} = ${b1}${b2}」不成立：实测 |${a1}${a2}| = ${l1.toFixed(2)}、|${b1}${b2}| = ${l2v.toFixed(2)}`,
      };
    }
    case 'midpoint': {
      const M = need(c.m);
      const E1 = need(c.ends?.[0] ?? '');
      const E2 = need(c.ends?.[1] ?? '');
      for (const x of [M, E1, E2]) if (x.issue) return x.issue;
      const a = E1.p!, b = E2.p!, m = M.p!;
      const mid: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const d = len2(sub2(m, mid));
      const scale = Math.max(len2(sub2(b, a)), 1);
      if (d / scale <= REL_TOL) return null;
      return {
        level: 'error',
        message:
          `「${c.m} 是 ${c.ends?.[0]}${c.ends?.[1]} 的中点」不成立：${c.m}${fmtP(m)}，` +
          `中点应为 ${fmtP(mid)}（偏离 ${d.toFixed(2)}）`,
      };
    }
    case 'angle-bisector': {
      const V = need(c.vertex), R = need(c.ray);
      const S1 = need(c.sides?.[0] ?? ''), S2 = need(c.sides?.[1] ?? '');
      for (const x of [V, R, S1, S2]) if (x.issue) return x.issue;
      const v = V.p!, r = R.p!, s1 = S1.p!, s2 = S2.p!;
      const a1 = angleBetween(sub2(s1, v), sub2(r, v));
      const a2 = angleBetween(sub2(r, v), sub2(s2, v));
      if (Math.abs(a1 - a2) <= ANG_TOL) return null;
      return {
        level: 'error',
        message:
          `「${c.vertex}${c.ray} 平分 ∠${c.sides?.[0]}${c.vertex}${c.sides?.[1]}」不成立：` +
          `实测 ∠${c.sides?.[0]}${c.vertex}${c.ray} = ${a1.toFixed(1)}°、∠${c.ray}${c.vertex}${c.sides?.[1]} = ${a2.toFixed(1)}°（应相等）。` +
          `修法：用角平分线定理把 ${c.ray} 写在 ${c.sides?.[0]}${c.sides?.[1]} 上，比例 |${c.sides?.[0]}${c.ray}| : |${c.ray}${c.sides?.[1]}| = |${c.vertex}${c.sides?.[0]}| : |${c.vertex}${c.sides?.[1]}|`,
      };
    }
    case 'angle-value': {
      const [aId, vId, bId] = c.points ?? [];
      const A = need(aId), V = need(vId), B = need(bId);
      for (const x of [A, V, B]) if (x.issue) return x.issue;
      const want = Number(c.deg);
      if (!isFinite(want)) {
        return { level: 'warn', message: `deg 不是有效数字（${String(c.deg)}），这条定角没法验算` };
      }
      const ang = angleBetween(sub2(A.p!, V.p!), sub2(B.p!, V.p!));
      if (Math.abs(ang - want) <= ANG_TOL) return null;
      return {
        level: 'error',
        message:
          `「∠${aId}${vId}${bId} 应为 ${want}°」不成立：实测 ${ang.toFixed(1)}°。` +
          `坐标是 ${aId}${fmtP(A.p!)}、${vId}${fmtP(V.p!)}、${bId}${fmtP(B.p!)}。` +
          `修法：以 ${vId} 为原点、让 ${vId}${aId} 沿 x 轴正方向，则 ${vId}${bId} 应写成 ` +
          `[L*cos(${want}*PI/180), L*sin(${want}*PI/180)]（L 是 ${vId}${bId} 的长度参数）`,
      };
    }
    case 'length-ratio': {
      const [a1, a2] = c.a ?? [];
      const [b1, b2] = c.b ?? [];
      const A1 = need(a1), A2 = need(a2), B1 = need(b1), B2 = need(b2);
      for (const x of [A1, A2, B1, B2]) if (x.issue) return x.issue;
      const want = Number(c.ratio);
      if (!isFinite(want) || want <= 0) {
        return { level: 'warn', message: `ratio 必须是正数（现在是 ${String(c.ratio)}），这条定比没法验算` };
      }
      const l1 = len2(sub2(A2.p!, A1.p!));
      const l2v = len2(sub2(B2.p!, B1.p!));
      if (l2v < 1e-9) {
        return {
          level: 'error',
          message: `「${b1}${b2}」长度为 0，定比 ${a1}${a2} : ${b1}${b2} = ${want} 无法验算（检查这两个点是否重合）`,
        };
      }
      const got = l1 / l2v;
      if (Math.abs(got - want) / want <= 5 * REL_TOL) return null;
      return {
        level: 'error',
        message:
          `「|${a1}${a2}| : |${b1}${b2}| = ${want}」不成立：实测 ${l1.toFixed(2)} : ${l2v.toFixed(2)} = ${got.toFixed(3)}。` +
          `修法：别手写这个点的坐标，用派生点 {"kind":"section","a":"${b1}","b":"${b2}","t":1/(1+${want})} ` +
          `——它表示从 ${b1} 出发把 ${b1}${b2} 分成 1:${want} 的那个点`,
      };
    }
    case 'value': {
      if (typeof c.expr !== 'string') {
        return { level: 'warn', message: 'expr 必须是表达式字符串，这条定值没法验算' };
      }
      const want = Number(c.equals);
      if (!isFinite(want)) {
        return { level: 'warn', message: `equals 不是有效数字（${String(c.equals)}），这条定值没法验算` };
      }
      const src = substitutePointIds(c.expr, pts);
      let got: number;
      try {
        got = evalNumber(src, scope);
      } catch (err) {
        return {
          level: 'error',
          message:
            `「${c.expr} = ${want}」算不出来：${(err as Error).message}。` +
            `检查 expr 里引用的点 id 是否都存在于 objects、参数是否已登记在 params`,
        };
      }
      if (!isFinite(got)) {
        return {
          level: 'error',
          message:
            `「${c.expr} = ${want}」算出来是 ${got}（除零或参数取值越界）。` +
            `检查 expr 里引用的点 id 是否都存在`,
        };
      }
      const tol = isFinite(Number(c.tol)) ? Number(c.tol) : 0.005;
      if (Math.abs(got - want) <= Math.max(Math.abs(want) * tol, 1e-6)) return null;
      return {
        level: 'error',
        message:
          `「${c.expr} 应等于 ${want}」不成立：实测 ${got.toFixed(3)}（差 ${(got - want).toFixed(3)}）。` +
          `修法：这是题面给的长度条件，作用是把整张图"定标"。正确做法是**反解**，不是逐点乘系数：` +
          `① 把与 ${c.expr} 相关的边写成含参数 a 的表达式（如 AC=a）；② 让 ${c.expr} 变成 a 的式子并解出 a；` +
          `③ 把 a 的默认值改成解出的数。直接给每个坐标乘 ${(want / (got || 1)).toFixed(4)} 会让其他约束一起失效，不要这么做`,
      };
    }
    default:
      return {
        level: 'warn',
        message: `类型「${(c as { type: string }).type}」不认识，已跳过（支持：perp/parallel/collinear/on-segment/equal-length/midpoint/angle-bisector/angle-value/length-ratio/value）`,
      };
  }
}

/**
 * 取场景里当前参数下各 readout 的实测值。
 *
 * 用途：喂给「证明复核」当事实基准——图形通过约束验算后，
 * 图上的距离/角度就是题目条件下的真值，比复核模型自己心算可靠得多。
 */
export function measureReadouts(scene: Scene): Array<{ label: string; value: string }> {
  const scope = defaultScope(scene);
  const out: Array<{ label: string; value: string }> = [];
  for (const r of scene.readouts ?? []) {
    try {
      const v = evalAny(r.expr, scope);
      if (typeof v === 'number' && isFinite(v)) {
        out.push({ label: r.label, value: v.toFixed(2) + (r.unit ?? '') });
      } else if (typeof v === 'string') {
        out.push({ label: r.label, value: v });
      }
    } catch {
      /* 显示为 —，不参与 */
    }
  }
  return out;
}

/** 体检主入口：返回问题清单（空数组 = 全部通过） */
export function verifyScene(scene: Scene): Issue[] {
  const issues: Issue[] = [];
  const add = (level: Issue['level'], where: string, message: string) =>
    issues.push({ level, where, message });
  const scope = defaultScope(scene);

  // ---- 顶层检查 ----
  if (scene.objects.length === 0) {
    add('warn', '-', '场景里没有任何对象，画布会是空的');
  }
  const spanX = scene.view.xMax - scene.view.xMin;
  const spanY = scene.view.yMax - scene.view.yMin;
  if (!(spanX > 0) || !(spanY > 0)) {
    add('error', 'view', `视野范围无效（宽 ${spanX} × 高 ${spanY}），xMax 必须大于 xMin、yMax 必须大于 yMin`);
  }

  // ---- 参数检查 ----
  const seen = new Set<string>();
  for (const p of scene.params) {
    if (seen.has(p.name)) {
      add('error', `params.${p.name}`, '参数名重复登记');
    }
    seen.add(p.name);
    if (p.min >= p.max) {
      add('warn', `params.${p.name}`, `滑杆范围无效（min ${p.min} ≥ max ${p.max}）`);
    }
  }

  // ---- 逐对象体检 ----
  const ids = new Set<string>();
  /** 点 id → 当前参数下的实际坐标（约束验算要用） */
  const pointCoords = new Map<string, [number, number]>();
  for (const obj of scene.objects) {
    if (ids.has(obj.id)) {
      add('error', obj.id, '对象 id 重复，步骤高亮和显示控制会串台');
    }
    ids.add(obj.id);
    for (const problem of checkObject(obj, scope)) {
      add('error', obj.id, problem);
    }
    if (obj.type === 'point') {
      const r = evalVec2Detailed(obj.at ?? '', scope);
      if (r.value) pointCoords.set(obj.id, r.value);
    }
    // label 约定 ≤10 字符，超长会在图上互相遮挡
    if (obj.label && obj.label.length > 10) {
      add('warn', obj.id, `label「${obj.label}」超过 10 个字符，容易和其他标签重叠（细节应放 readouts）`);
    }
  }

  // ---- 几何约束验算：模型自己声明的关系，必须在自己写的坐标上成立 ----
  (scene.constraints ?? []).forEach((c, i) => {
    if (!c || typeof (c as { type?: unknown }).type !== 'string') {
      add('warn', `constraints[${i}]`, '缺少 type，已跳过');
      return;
    }
    const issue = checkConstraint(c, pointCoords, `constraints[${i}]`, scope);
    if (issue) add(issue.level, `constraints[${i}]`, issue.message);
  });

  // ---- 图形完整性：约束管得了"角多大、边多长"，管不了"图长什么样" ----
  // 真实故障：答案全对、约束全过，但图上的点摆错了位置、或少了一条线，
  // 用户看到的就是"图和题目不符"。这里补两层，都只给 warn（不拦截，但让人看见）。

  // ① 没有任何约束管住的点 —— 它的坐标是模型随手写的，无从验证
  const watched = new Set<string>();
  for (const c of scene.constraints ?? []) collectConstraintPointIds(c, watched);
  for (const obj of scene.objects) {
    if (obj.type !== 'point') continue;
    if (obj.derive) continue; // 派生点：位置由定义锁定
    if (obj.dragBind) continue; // 可拖点：位置由用户调
    if (watched.has(obj.id)) continue;
    add(
      'warn',
      obj.id,
      '这个点的位置没被任何约束验证过，可能与题意不符。' +
        '如果它只是直角/等长之类的"标记点"，直接删掉，用 constraints（perp / equal-length）表达；' +
        '如果它是题面里真实存在的点，就在 constraints 里登记它参与的关系，或改用 derive 推出坐标',
    );
  }

  // ② 步骤文字里讲到的线段/三角形，图上必须真的连出来
  const segList: Array<[P2, P2]> = [];
  for (const obj of scene.objects) {
    if (obj.type === 'segment' || obj.type === 'vector') {
      const f = evalVec2Detailed(obj.from, scope).value;
      const t = evalVec2Detailed(obj.to, scope).value;
      if (f && t) segList.push([f, t]);
    } else if (obj.type === 'polygon') {
      const vs = obj.points.map((p) => evalVec2Detailed(p, scope).value);
      for (let k = 0; k < vs.length; k++) {
        const a = vs[k];
        const b = vs[(k + 1) % vs.length];
        if (a && b) segList.push([a, b]);
      }
    }
  }
  const samePt = (p: P2, q: P2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
  const hasSeg = (a: P2, b: P2) =>
    segList.some(
      ([f, t]) => (samePt(f, a) && samePt(t, b)) || (samePt(f, b) && samePt(t, a)),
    );

  for (let i = 0; i < (scene.steps?.length ?? 0); i++) {
    const text = scene.steps![i].text ?? '';
    /** 同一步里同一条边只报一次（△ACD 和 "CD=2" 会指向同一条线） */
    const said = new Set<string>();
    // 三字母以上的串（△ACD、△ABC）→ 检查三条边是否都画了
    for (const m of text.matchAll(/[A-Z]{3,}/g)) {
      const trio = m[0].slice(0, 3);
      const ps = [0, 1, 2].map((k) => pointCoords.get(trio[k]));
      if (ps.some((p) => !p)) continue; // 点都不全，另有检查管
      const missing: string[] = [];
      for (let k = 0; k < 3; k++) {
        const n = (k + 1) % 3;
        if (!hasSeg(ps[k]!, ps[n]!)) missing.push(`${trio[k]}${trio[n]}`);
      }
      const fresh = missing.filter((e) => !said.has(e.split('').sort().join('')));
      if (fresh.length > 0) {
        for (const e of fresh) said.add(e.split('').sort().join(''));
        add('warn', `steps[${i}]`, `讲到三角形「${trio}」，但图上缺边 ${fresh.join('、')}`);
      }
    }
    // 两字母的点对（"CD = 2"、"连接 EF"）→ 检查这条线段在不在
    const noTri = text.replace(/[A-Z]{3,}/g, (m) => ' '.repeat(m.length));
    for (const m of noTri.matchAll(/([A-Z])([A-Z])/g)) {
      const [pa, pb] = [m[1], m[2]];
      if (pa === pb) continue;
      const a = pointCoords.get(pa);
      const b = pointCoords.get(pb);
      if (!a || !b) continue;
      if (hasSeg(a, b)) continue;
      const key = [pa, pb].sort().join('');
      if (said.has(`${pa}${pb}`) || said.has(`${pb}${pa}`) || said.has(key)) continue;
      said.add(key);
      add(
        'warn',
        `steps[${i}]`,
        `讲到线段「${pa}${pb}」，但图上没有把 ${pa} 和 ${pb} 连起来（这两个点都在）`,
      );
    }
  }

  // ③ 整张几何图却一条约束都没登记 —— 说明模型放弃了自检，图怎么画都没人管。
  //    纯描述性场景（画个爱心）无所谓；但**解题场景**（有 steps）必须登记约束，
  //    否则"画对了"纯属运气——真实事故：模型图画对了却零约束，steps 里的 DF 算错，
  //    全靠证明复核用图形实测值兜底才发现。
  const nPoint = scene.objects.filter((o) => o.type === 'point').length;
  const nSeg = scene.objects.filter((o) => o.type === 'segment').length;
  if ((scene.constraints ?? []).length === 0 && nPoint >= 3 && nSeg >= 2) {
    const isProblem = (scene.steps ?? []).length > 0;
    add(
      isProblem ? 'error' : 'warn',
      'constraints',
      isProblem
        ? `这是一道几何题（${nPoint} 个点、${nSeg} 条线段、带分步讲解）却没有任何约束——` +
          `没有约束就无法自动核对图形是否画对，整张图不可信。` +
          `必须把题面的几何关系（直角/角平分/垂直/平行/定长等）逐条登记进 constraints`
        : `这是一张几何图（${nPoint} 个点、${nSeg} 条线段）却没有任何约束，图形的角度/长度无法自动核对。请把题面的几何关系逐条登记`,
    );
  }

  // ---- readouts 体检：每个公式真的算一遍 ----
  for (const r of scene.readouts ?? []) {
    try {
      const v = evalAny(r.expr, scope);
      if (typeof v !== 'number' && typeof v !== 'string') {
        add('error', `readouts.${r.label}`, '表达式结果既不是数字也不是文字');
      } else if (typeof v === 'number' && !isFinite(v)) {
        add('error', `readouts.${r.label}`, '表达式结果是 NaN 或 Infinity');
      }
    } catch (err) {
      add(
        'error',
        `readouts.${r.label}`,
        `表达式「${r.expr}」抛异常：${(err as Error).message}${unknownHint(r.expr, scope)}`,
      );
    }
  }

  // ---- steps 体检：高亮/揭示的 id 必须真实存在 ----
  for (let i = 0; i < (scene.steps?.length ?? 0); i++) {
    const s = scene.steps![i];
    for (const id of s.highlight ?? []) {
      if (!ids.has(id)) {
        add('warn', `steps[${i}]`, `highlight 引用了不存在的对象 id「${id}」，这一步会没有东西可高亮`);
      }
    }
    for (const id of s.reveal ?? []) {
      if (!ids.has(id)) {
        add('error', `steps[${i}]`, `reveal 引用了不存在的对象 id「${id}」，这一步要出现的东西永远不会出现`);
      }
    }
  }

  return issues;
}
