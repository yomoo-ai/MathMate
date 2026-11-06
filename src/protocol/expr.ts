/**
 * expr.ts —— 表达式求值器（教学版）
 *
 * 场景里的 "a*(x-h)^2+k"、"sin(t)" 这类字符串，在这里变成数字。
 *
 * 做法：
 *   1. 把 ^ 替换成 JS 的 **（JS 不把 ^ 当乘方）；
 *   2. 用 new Function 生成一个函数，只注入白名单数学函数和已知参数名；
 *   3. 调用它求值。编译结果按「表达式 + 参数名」缓存，避免重复编译。
 *
 * 安全提醒（重要）：
 *   这是教学骨架的简化实现。将来如果求值 LLM 输出的表达式，
 *   不要直接 new Function——请先做正则白名单校验（只允许数字、运算符、
 *   参数名、白名单函数），或换沙箱方案（如把 quickjs 编译成 wasm 跑）。
 */

import type { Vec2Like } from './scene';
import type { Vec3Like } from './scene3d';

// ---------------------------------------------------------------
// 四面体的特殊点：外接球心与内心
//
// 为什么要在求值器里把公式写死？
//   这两类是立体几何压轴题的常客，但它们的坐标**根本没法目测**：
//   外接球心要解 3×3 线性方程组，内心要按"对面面积"加权。
//   模型写这种坐标必错（而且错得很像对），但它会一句话说清
//   「V-ABC 的外接球心」。所以：**模型声明关系，公式由这里负责**。
//
// 参数顺序统一是 4 个点 × 3 坐标 = 12 个数：A(x,y,z) B(x,y,z) C(x,y,z) D(x,y,z)。
// ---------------------------------------------------------------

/** 空间三点围成的三角形面积（叉积模长的一半） */
function triArea3(
  px: number, py: number, pz: number,
  qx: number, qy: number, qz: number,
  rx: number, ry: number, rz: number,
): number {
  const ux = qx - px, uy = qy - py, uz = qz - pz;
  const vx = rx - px, vy = ry - py, vz = rz - pz;
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

interface TetraSpecial {
  /** 外接球心 */
  o: [number, number, number];
  /** 外接球半径 */
  R: number;
  /** 内心（内切球心） */
  i: [number, number, number];
  /** 内切球半径 */
  r: number;
}

/**
 * 四面体 A B C D 的外接球 + 内切球。
 * 退化（四点共面）时相应字段是 NaN，让体检器去点名，不在这里抛异常。
 */
function tetraSpecial(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
): TetraSpecial {
  const out: TetraSpecial = { o: [NaN, NaN, NaN], R: NaN, i: [NaN, NaN, NaN], r: NaN };

  // 以 A 为原点：u = B−A, v = C−A, w = D−A
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const wx = dx - ax, wy = dy - ay, wz = dz - az;

  const uu = ux * ux + uy * uy + uz * uz;
  const vv = vx * vx + vy * vy + vz * vz;
  const ww = wx * wx + wy * wy + wz * wz;
  const uv = ux * vx + uy * vy + uz * vz;
  const uw = ux * wx + uy * wy + uz * wz;
  const vw = vx * wx + vy * wy + vz * wz;

  // ---- 外接球心 ----
  // 设 O = A + αu + βv + γw。|O−A|² = |O−B|² 展开后 u² 项抵消，得
  //   α·uu + β·uv + γ·uw = uu/2，对 v、w 同理。
  // 所以解 M·(α,β,γ)ᵀ = (uu,vv,ww)ᵀ/2，用克拉默法则。
  const det =
    uu * (vv * ww - vw * vw) - uv * (uv * ww - vw * uw) + uw * (uv * vw - vv * uw);

  if (Math.abs(det) > 1e-12) {
    const b1 = uu / 2, b2 = vv / 2, b3 = ww / 2;
    // 依次把第 1/2/3 列换成右端项
    const d1 = b1 * (vv * ww - vw * vw) - uv * (b2 * ww - vw * b3) + uw * (b2 * vw - vv * b3);
    const d2 = uu * (b2 * ww - vw * b3) - b1 * (uv * ww - vw * uw) + uw * (uv * b3 - b2 * uw);
    const d3 = uu * (vv * b3 - b2 * vw) - uv * (uv * b3 - b2 * uw) + b1 * (uv * vw - vv * uw);
    const al = d1 / det, be = d2 / det, ga = d3 / det;
    const ox = al * ux + be * vx + ga * wx;
    const oy = al * uy + be * vy + ga * wy;
    const oz = al * uz + be * vz + ga * wz;
    out.o = [ax + ox, ay + oy, az + oz];
    out.R = Math.hypot(ox, oy, oz);
  }

  // ---- 内心 ----
  // 到四个面等距的点，重心坐标 ∝ 对面三角形的面积。
  const sa = triArea3(bx, by, bz, cx, cy, cz, dx, dy, dz); // A 对面是 BCD
  const sb = triArea3(ax, ay, az, cx, cy, cz, dx, dy, dz); // B 对面是 ACD
  const sc = triArea3(ax, ay, az, bx, by, bz, dx, dy, dz); // C 对面是 ABD
  const sd = triArea3(ax, ay, az, bx, by, bz, cx, cy, cz); // D 对面是 ABC
  const sum = sa + sb + sc + sd;

  if (sum > 1e-12) {
    out.i = [
      (sa * ax + sb * bx + sc * cx + sd * dx) / sum,
      (sa * ay + sb * by + sc * cy + sd * dy) / sum,
      (sa * az + sb * bz + sc * cz + sd * dz) / sum,
    ];
    // r = 3V / S，而 V = |det(u,v,w)| / 6
    const vol6 = Math.abs(
      ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx),
    );
    out.r = vol6 / (2 * sum);
  }

  return out;
}

/** 把 12 个平铺参数收成一个调用（表达式里只能传标量，没法传点） */
function tetraOf(a: number[]): TetraSpecial {
  return tetraSpecial(
    a[0], a[1], a[2], a[3], a[4], a[5],
    a[6], a[7], a[8], a[9], a[10], a[11],
  );
}

/** 白名单：表达式里可以调用的函数与常量 */
const NATIVE: Record<string, unknown> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sqrt: Math.sqrt,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  log: Math.log,
  exp: Math.exp,
  /**
   * 符号函数：sign(正数)=1、sign(0)=0、sign(负数)=−1。
   *
   * 加它是为了让「随参数切换分支」能写成闭式表达式，而不需要条件语句。
   * 典型用法（圆锥曲线焦点随 m 换轴）：
   *   s = (1+sign(8-m))/2  —— m<8 时 s=1，m>8 时 s=0
   *   F₁ = [c*s, c*(1-s)]  —— 焦点自动落在 y 轴或 x 轴
   * 没有它就只能给两种情形各画一遍，没法做连续动画。
   */
  sign: Math.sign,
  /** 把 v 夹在 [lo, hi] 之间（写端点附近的扫参时很好用） */
  clamp: (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
  PI: Math.PI,
  /** 弧度 → 角度 */
  deg: (r: number) => (r * 180) / Math.PI,
  /** 两点距离 */
  dist: (x1: number, y1: number, x2: number, y2: number) =>
    Math.hypot(x2 - x1, y2 - y1),
  /** 从 (x1,y1) 指向 (x2,y2) 的角度（弧度） */
  ang: (x1: number, y1: number, x2: number, y2: number) =>
    Math.atan2(y2 - y1, x2 - x1),
  /**
   * 三点夹角（度）：angle(P1, P2, P3) = ∠P1P2P3，P2 是顶点。
   * 配合"readouts 里点 id 自动展开"用起来最顺：{"expr":"angle(D,E,A)"}。
   * 注意别用 deg(ang(...)) 凑——ang 返回的是方向角，不是夹角。
   */
  angle: (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
  ) => {
    const ux = x1 - x2;
    const uy = y1 - y2;
    const vx = x3 - x2;
    const vy = y3 - y2;
    const c =
      (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1e-12);
    return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  },
  /**
   * 三点围成的三角形面积：area(x1,y1,x2,y2,x3,y3)。
   *
   * 为什么要它？——"求 △ACD 的面积"这类题，最终答案是个数值，
   * 而图形本身只画了线段，程序无从判断答案对不对。
   * 有了 area()，把结论写成 readouts 就能让程序**从图上量出来**，
   * 再跟 steps 里写的数对照：一致才说明图和推导自洽。
   * 取绝对值，点的顺/逆时针顺序不影响结果。
   */
  area: (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) =>
    Math.abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)) / 2,
  /** 格式化成 "(1.20, -0.50)"，用于数值输出 */
  pt: (x: number, y: number) => `(${x.toFixed(2)}, ${y.toFixed(2)})`,

  // ---- 三维版本（立体几何）----
  // 命名带 3 后缀，不和 2D 的 dist/angle/area 抢名字：
  // 同一份表达式里混用两种维度必然出错，名字分开反而能立刻发现写错了。

  /** 空间两点距离 */
  dist3: (
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
  ) => Math.hypot(x2 - x1, y2 - y1, z2 - z1),
  /** 空间三点夹角（度）：angle3(A, B, C) = ∠ABC，B 是顶点 */
  angle3: (
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    x3: number,
    y3: number,
    z3: number,
  ) => {
    const ux = x1 - x2;
    const uy = y1 - y2;
    const uz = z1 - z2;
    const vx = x3 - x2;
    const vy = y3 - y2;
    const vz = z3 - z2;
    const c =
      (ux * vx + uy * vy + uz * vz) /
      (Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz) || 1e-12);
    return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  },
  /** 空间三角形面积：叉积模长的一半 */
  area3: (
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    x3: number,
    y3: number,
    z3: number,
  ) => {
    const ux = x2 - x1;
    const uy = y2 - y1;
    const uz = z2 - z1;
    const vx = x3 - x1;
    const vy = y3 - y1;
    const vz = z3 - z1;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    return Math.hypot(cx, cy, cz) / 2;
  },
  /** 格式化三维点，用于数值输出 */
  pt3: (x: number, y: number, z: number) =>
    `(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`,

  // ---- 四面体特殊点（外接球心 / 内心）----
  // 调用时点 id 会被自动展开成坐标，所以模型可以写 circumR3(V,A,B,C)。
  // 名字拆成 X/Y/Z/R 是因为表达式只能返回标量，没法一次给一个点。
  circumX3: (...a: number[]) => tetraOf(a).o[0],
  circumY3: (...a: number[]) => tetraOf(a).o[1],
  circumZ3: (...a: number[]) => tetraOf(a).o[2],
  /** 外接球半径 */
  circumR3: (...a: number[]) => tetraOf(a).R,
  inX3: (...a: number[]) => tetraOf(a).i[0],
  inY3: (...a: number[]) => tetraOf(a).i[1],
  inZ3: (...a: number[]) => tetraOf(a).i[2],
  /** 内切球半径 */
  inR3: (...a: number[]) => tetraOf(a).r,
};

const NATIVE_NAMES = Object.keys(NATIVE);

/** 求值作用域：参数名 → 数值；x/t 有默认值 0 */
export type Scope = Record<string, number | undefined>;

// ---------------------------------------------------------------
// 规范化：把「人写的数学」翻译成「JS 能算的数学」
//
// 模型（尤其从 Word/教材抄来的）经常写出这些字符：
//   全角逗号「，」    → 坐标拆不开（split(',') 只得到 1 段）
//   全角括号（）      → new Function 直接语法错
//   乘号 ×、点乘 ·    → JS 不认识
//   减号 − (U+2212)   → 和 ASCII "-" 不是一个字符，看起来一样但算不出来
// 这些错误在报错信息里几乎看不出来（"坐标求值结果不是有限数字"），
// 所以在求值前统一翻译一遍，把一整类事故直接消灭。
// ---------------------------------------------------------------
const SYMBOL_MAP: Array<[RegExp, string]> = [
  [/[\u00A0\u3000]/g, ' '], // 不换行空格 / 全角空格
  [/[，、]/g, ','], // 全角逗号、顿号
  [/（/g, '('],
  [/）/g, ')'],
  [/[×·∙⋅＊]/g, '*'],
  [/[÷／]/g, '/'],
  [/[−–—－]/g, '-'], // 数学减号、短横、全角减号
  [/[＋]/g, '+'],
  [/π/g, 'PI'],
];

/**
 * 整词 `pi` → `PI`。
 *
 * 常量表里登记的是大写 PI，但模型（和人）几乎一律写小写 `pi`：
 * 真实事故——curve-point 的 t 写成 "pi/2"，坐标直接算成 NaN，
 * 报错却说"pi is not defined"，看着像模型没定义参数，实际是别名缺失。
 * 只换完整标识符，`pix`、`pi_1` 这类名字不受影响。
 *
 * 代价：参数不能取名 pi（会被当成常量）。这个撞名没有实际意义，
 * 不值得为它引入作用域感知的替换。
 */
const PI_ALIAS_RE = /(^|[^A-Za-z0-9_])pi(?![A-Za-z0-9_])/g;

/** 规范化一个表达式字符串（不改变语义，只统一符号） */
export function normalizeExpr(s: string): string {
  // 容忍运行时传进来数字：arc 的 from/to、radius 这类字段模型常写成纯数字
  // （{"from": 0} 而不是 {"from": "0"}）。以前会一路走到这里炸
  // "s.replace is not a function"，报错还完全指不到真正的字段。
  let out = String(s);
  for (const [re, rep] of SYMBOL_MAP) out = out.replace(re, rep);
  out = out.replace(PI_ALIAS_RE, '$1PI');
  return out;
}

/**
 * 按「顶层逗号」拆分：只拆不在括号里的逗号。
 *
 * 为什么需要？坐标字符串 "dist(ax,ay,bx,by), 0" 里有一堆逗号，
 * 直接 split(',') 会拆成 5 段。必须跳过括号内的逗号才能正确拆出 x 和 y。
 */
export function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** 正则里认标识符用（注意排除 1e3 这种科学计数法里的 e3） */
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * 找出表达式里「没登记过」的名字。
 *
 * 这是最有用的诊断信息：模型写 "fx, fy" 但忘了定义 fx 时，
 * 报"算不出数"毫无帮助；报"未定义名称 fx" 一眼就知道该怎么改。
 */
export function unknownNames(expr: string, scope: Scope): string[] {
  const allowed = new Set<string>([
    ...Object.keys(scope),
    ...NATIVE_NAMES,
    'x',
    't',
  ]);
  const found = new Set<string>();
  const src = normalizeExpr(expr);
  for (const m of src.matchAll(IDENT_RE)) {
    const name = m[0];
    if (allowed.has(name)) continue;
    // 前面紧挨着数字 = 科学计数法的一部分（1e3 的 e3），跳过
    const prev = src[m.index! - 1];
    if (prev && /[0-9.]/.test(prev)) continue;
    // 后面紧挨着 '(' = 函数名，未登记的函数另报（这里也归入未定义）
    found.add(name);
  }
  return [...found];
}

const cache = new Map<string, Function>();

function compile(expr: string, paramNames: string[]): Function {
  const key = `${expr}|${paramNames.join(',')}`;
  let fn = cache.get(key);
  if (!fn) {
    const js = normalizeExpr(expr).replace(/\^/g, '**');
    const argNames = [
      'x',
      't',
      ...NATIVE_NAMES,
      // 过滤掉与白名单/x/t 重名的参数，避免注入重复参数名
      ...paramNames.filter(
        (n) => n !== 'x' && n !== 't' && !NATIVE_NAMES.includes(n),
      ),
    ];
    fn = new Function(...argNames, `"use strict"; return (${js});`);
    cache.set(key, fn);
  }
  return fn;
}

/** 通用求值：返回 number 或 string（表达式里可以写三元返回文字） */
export function evalAny(expr: string, scope: Scope): unknown {
  // 表达式字段被写成纯数字是合法意图，直接当常量返回（别让它走到编译环节才炸）
  if (typeof expr !== 'string') {
    const num = Number(expr);
    return isFinite(num) ? num : NaN;
  }
    // 只取真正的场景参数：x/t 由系统单独传，函数名不能当参数
  const names = Object.keys(scope).filter(
    (n) => n !== 'x' && n !== 't' && !NATIVE_NAMES.includes(n),
  );

  const fn = compile(expr, names);
  const values: unknown[] = [
    scope.x ?? 0,
    scope.t ?? 0,
    ...NATIVE_NAMES.map((n) => NATIVE[n]),
    ...names.map((n) => scope[n] ?? 0),
  ];
  return (fn as (...args: unknown[]) => unknown)(...values);
}

/** 求值为数字；不是数字时返回 NaN */
export function evalNumber(expr: string, scope: Scope): number {
  const v = evalAny(expr, scope);
  return typeof v === 'number' ? v : NaN;
}

/**
 * 解析「坐标字段」：
 *   - 数组 [x, y]：直接使用；
 *   - 字符串 "h, k"：按顶层逗号拆成两个表达式分别求值；
 * 任何非有限值返回 null（渲染器会跳过该对象，保证画面不崩）。
 *
 * 想拿到"为什么失败"的说明（给体检器用），调用 evalVec2Detailed。
 */
export function evalVec2(v: Vec2Like, scope: Scope): [number, number] | null {
  return evalVec2Detailed(v, scope).value;
}

export interface Vec2EvalResult {
  value: [number, number] | null;
  /** 失败原因（人话，直接能贴进报告给模型看） */
  reason?: string;
}

/** 带诊断信息的坐标求值：失败时说明是哪一半坏、坏成什么值 */
export function evalVec2Detailed(v: Vec2Like, scope: Scope): Vec2EvalResult {
  if (Array.isArray(v)) {
    // 数组里的元素**允许是表达式字符串**。
    // 为什么放宽？模型经常写 at: [0, a]（把变量塞进数组），而协议原本只允许
    // 纯数字数组或 "0, a" 字符串，这类输出会被判"含非法数字"整条打回——
    // 但它表达的意思完全正确。与其硬性拒绝，不如直接支持：求值规则一致，成本为零。
    const out: number[] = [];
    for (let i = 0; i < v.length; i++) {
      const axis = i === 0 ? 'x' : 'y';
      const rawEl = v[i] as unknown;
      const src =
        typeof rawEl === 'number' ? String(rawEl) : normalizeExpr(String(rawEl));
      let num: number;
      // 纯数字直接采信：以前这里也会走一遍求值，NaN 被转成字符串 "NaN"
      // 再当成变量名，报出"未定义的名称 NaN"——看着像模型引用了什么变量，
      // 实际只是上一阶段（派生点解算）没算出坐标。
      if (typeof rawEl === 'number') {
        num = rawEl;
      } else {
        try {
          num = evalNumber(src, scope);
        } catch (err) {
          return {
            value: null,
            reason: `坐标数组的 ${axis} 分量「${src}」求值抛异常：${(err as Error).message}`,
          };
        }
      }
      if (!isFinite(num)) {
        return {
          value: null,
          reason: `坐标数组的 ${axis} 分量「${src}」算出来是 ${num}`,
        };
      }
      out.push(num);
    }
    if (out.length !== 2) {
      return { value: null, reason: `坐标数组应有 2 个元素（x, y），实际 ${out.length} 个` };
    }
    return { value: [out[0], out[1]] };
  }

  const raw = String(v);
  const parts = splitTopLevel(normalizeExpr(raw))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length !== 2) {
    return {
      value: null,
      reason:
        `坐标字符串「${raw}」按逗号拆出 ${parts.length} 段（应为 2 段：x, y）` +
        (parts.length > 2 ? '——可能函数参数里的逗号被误当成了分割符' : ''),
    };
  }

  const out: number[] = [];
  for (const [i, part] of parts.entries()) {
    const axis = i === 0 ? 'x' : 'y';
    let num: number;
    try {
      num = evalNumber(part, scope);
    } catch (err) {
      return {
        value: null,
        reason: `${axis} 分量「${part}」求值抛异常：${(err as Error).message}`,
      };
    }
    if (!isFinite(num)) {
      return {
        value: null,
        reason: `${axis} 分量「${part}」算出来是 ${num}（分母为 0、负数开方或参数取值越界）`,
      };
    }
    out.push(num);
  }
  return { value: [out[0], out[1]] };
}

// ---------------------------------------------------------------
// 三维坐标求值（立体几何）
// ---------------------------------------------------------------

export interface Vec3EvalResult {
  value: [number, number, number] | null;
  reason?: string;
}

const AXIS3 = ['x', 'y', 'z'] as const;

/**
 * 三维坐标求值。与 evalVec2Detailed 同构：数组、字符串两种写法都接受，
 * 失败时点名是哪个轴、坏成什么值。
 * 这条"报错必须指名道姓"的规矩，是 2D 那边用一整轮调试换来的，别退化。
 */
export function evalVec3Detailed(
  v: Vec3Like,
  scope: Scope,
): Vec3EvalResult {
  const evalAxis = (raw: unknown, axis: string): { num?: number; reason?: string } => {
    const src = typeof raw === 'number' ? String(raw) : normalizeExpr(String(raw));
    let num: number;
    try {
      num = evalNumber(src, scope);
    } catch (err) {
      return { reason: `${axis} 分量「${src}」求值抛异常：${(err as Error).message}` };
    }
    if (!isFinite(num)) {
      return {
        reason: `${axis} 分量「${src}」算出来是 ${num}（分母为 0、负数开方或参数取值越界）`,
      };
    }
    return { num };
  };

  if (Array.isArray(v)) {
    // 转成 unknown[] 再判断长度：协议里的三元组类型长度恒为 3，
    // TS 会把 `v.length !== 3` 判成永假并把 v 缩窄成 never，
    // 但运行时的数据来自 JSON，长度完全可能不对，必须真检查
    const arr = v as unknown[];
    if (arr.length !== 3) {
      return { value: null, reason: `坐标数组应有 3 个元素（x, y, z），实际 ${arr.length} 个` };
    }
    const out: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = evalAxis(arr[i], AXIS3[i]);
      if (r.reason) return { value: null, reason: `坐标数组的 ${r.reason}` };
      out.push(r.num!);
    }
    return { value: [out[0], out[1], out[2]] };
  }

  const raw = String(v);
  const parts = splitTopLevel(normalizeExpr(raw))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length !== 3) {
    return {
      value: null,
      reason: `坐标字符串「${raw}」按逗号拆出 ${parts.length} 段（应为 3 段：x, y, z）`,
    };
  }
  const out: number[] = [];
  for (const [i, part] of parts.entries()) {
    const r = evalAxis(part, AXIS3[i]);
    if (r.reason) return { value: null, reason: r.reason };
    out.push(r.num!);
  }
  return { value: [out[0], out[1], out[2]] };
}

/** 只要值不要诊断，同 evalVec2 */
export function evalVec3(
  v: Vec3Like,
  scope: Scope,
): [number, number, number] | null {
  return evalVec3Detailed(v, scope).value;
}
