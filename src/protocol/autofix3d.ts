/**
 * autofix3d.ts —— 程序代改层（体检打回之前先自己修）
 *
 * 为什么需要它：数值体检发现的错误里，有一类是**程序自己已经算出正确答案**的
 * （截面实际边数、两条线的交点坐标、定比错的比值），按老流程却要退回模型
 * "看着答案抄"——实测模型连抄都抄不对（2026-11-06，同一道题连续 3 轮裁在同一批
 * 错误上），每轮都是一次完整的大 prompt 调用，最后把 DeepSeek 的频率额度烧出 429。
 *
 * 原则：**只修程序能证明的，修不动的原样留给模型**。
 *   ① 截面结论：边数/顶点串照实测改；顶点里"棱上的落点"模型没声明的，
 *      程序自动补 point3（按实测坐标），并给它取个不冲突的字母名；
 *   ② length-ratio：比例写反了（actual ≈ 1/ratio）就对调 a/b——保留模型想表达的
 *      原始比值；其余情况只在"相关点里有派生点"（坐标是程序算的，位置更可信）
 *      时才把 ratio 改成实测值，手写坐标的点不碰——那可能是点放错了，不该迁就；
 *   ③ 正文点名但图上没有的点：从句式推断关系（"延长 DM 交 AA₁ 于 P"、
 *      "PQ ∩ AB = R"、"M 是 AB 的中点"），推断得出来就补 point3 + derive
 *      让程序算坐标，推断不出来留给模型。
 *
 * 修完返回新场景 + 改动清单；由调用方重新体检，通过了就直接放行（省一次调用）。
 */

import type { Point3Object, Scene3D, Scene3DObject, Vec3 } from './scene3d';
import { resolveScene3D } from './resolve3d';
import { evalVec3Detailed } from './expr';
import { normalizeVertexToken, sectionFacts3D } from './verifier3d';

type V3 = Vec3;

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dist3 = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** 中文数字 ↔ 阿拉伯数字（与 verifier3d 的 CN_NUM/NUM_CN 保持一致） */
const CN_NUM: Record<string, number> = { 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8 };
const NUM_CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八'];

export interface AutoFix3DResult {
  scene: Scene3D;
  /** 每一处代改的人类可读描述（给用户看"程序替你改了什么"） */
  fixes: string[];
}

// ---------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------

/** 把名字渲染成下标风格（正文用 ₁ 时新点也用 ₁，保持排版一致） */
function toSubscript(name: string): string {
  return name.replace(/\d/g, (d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)]);
}

/** 场景里已声明的顶点 id 集合（归一化成 D1 风格） */
function declaredPointIds(objects: Scene3DObject[]): Set<string> {
  const set = new Set<string>();
  for (const o of objects) {
    if (o.type === 'point3') set.add(normalizeVertexToken(o.id));
  }
  return set;
}

/** 按当前参数值把所有顶点算成数字坐标（算不出的点跳过） */
function numericPoints(scene: Scene3D): Map<string, V3> {
  const scope: Record<string, number> = {};
  for (const p of scene.params) scope[p.name] = p.value;
  const map = new Map<string, V3>();
  for (const o of scene.objects) {
    if (o.type !== 'point3') continue;
    const r = evalVec3Detailed(o.at ?? '', scope);
    if (r.value) map.set(normalizeVertexToken(o.id), r.value);
  }
  return map;
}

/** 找一个没被占用的大写字母名：先避开已声明 id，再避开正文出现过的记号 */
function pickFreshName(
  taken: Set<string>,
  textTokens: Set<string>,
  used: Set<string>,
): string | null {
  const CANDIDATES = ['P', 'Q', 'R', 'S', 'E', 'F', 'G', 'H', 'U', 'V', 'W', 'T'];
  for (const c of CANDIDATES) {
    if (!taken.has(c) && !textTokens.has(c) && !used.has(c)) return c;
  }
  return null;
}

/** 收集讲解正文里出现过的"独立大写记号"（取名时避开，防止跟题面记号撞车） */
function textTokensOf(scene: Scene3D): Set<string> {
  const set = new Set<string>();
  for (const step of scene.steps ?? []) {
    const norm = normalizeVertexToken(String(step.text ?? ''));
    const re = /(^|[^A-Za-z0-9])([A-Z]\d?)(?![A-Za-z0-9])/g;
    for (const m of norm.matchAll(re)) set.add(m[2]);
  }
  return set;
}

/** 把 actual 近似成小分母分数（1/2、2/3…），找不到就保留 3 位小数 */
function niceRatio(x: number): number {
  for (let q = 1; q <= 12; q++) {
    const p = Math.round(x * q);
    if (p >= 1 && Math.abs(p / q - x) < 1e-9) return p / q;
  }
  return Number(x.toFixed(3));
}

// ---------------------------------------------------------------
// 修法 ①：截面结论（边数 + 顶点串）
// ---------------------------------------------------------------

function fixSectionClaims(scene: Scene3D, fixes: string[]): void {
  if (!(scene.steps ?? []).length) return;
  const facts = sectionFacts3D(scene);
  if (!facts) return;

  // 顶点里有模型没声明的"棱上落点"→ 补 point3，正文才能写全顶点
  const taken = declaredPointIds(scene.objects);
  const tokens = textTokensOf(scene);
  const nameFor = new Map<number, string>(); // 匿名顶点序号 → 新名字
  for (let i = 0; i < facts.names.length; i++) {
    if (facts.names[i]) continue;
    const name = pickFreshName(taken, tokens, new Set(nameFor.values()));
    if (!name) break; // 字母用光了：放弃补名，只改边数
    nameFor.set(i, name);
    taken.add(name);
  }

  const allNamed = [...facts.names].every((n, i) => n || nameFor.has(i));
  if (nameFor.size > 0) {
    for (const [i, name] of nameFor) {
      const v = facts.positions[i];
      scene.objects.push({
        id: name,
        type: 'point3',
        // 实测坐标写死：截面顶点是"平面 × 棱"的交点，表达式化要解平面与
        // 12 条棱的交线，收益配不上复杂度；参数滑动时该点不跟随，可接受。
        at: [v[0], v[1], v[2]],
      });
      facts.names[i] = name;
    }
    fixes.push(
      `补出截面顶点 ${[...nameFor.values()].map(toSubscript).join('、')}（按实测坐标，程序代声明）`,
    );
  }

  const fullNames = facts.names.map((n) => n!);
  let changed = false;
  (scene.steps ?? []).forEach((step) => {
    const text = String(step.text ?? '');
    if (!text.includes('截面')) return;
    const re = /([三四五六七八])\s*边形(\s*[A-Z][A-Za-z0-9₀-₉]{1,9})?/g;
    const next = text.replace(re, (whole, cn: string, listed?: string) => {
      if (CN_NUM[cn] === facts.n) return whole;
      changed = true;
      // 下标风格跟正文走：正文写 D₁ 就别突然冒出 D1
      const sub = /[₀-₉]/.test(whole);
      const names = sub ? fullNames.map(toSubscript) : fullNames;
      const tail = allNamed ? names.join('') : (listed ?? '');
      return `${NUM_CN[facts.n]}边形${tail ? ' ' + tail : ''}`;
    });
    if (changed) step.text = next;
  });

  if (changed) {
    fixes.push(
      `截面结论改为「${NUM_CN[facts.n]}边形` +
        (allNamed ? ` ${fullNames.map(toSubscript).join('')}」` : '」（顶点串保持原文）'),
    );
  }
}

// ---------------------------------------------------------------
// 修法 ②：length-ratio 比值
// ---------------------------------------------------------------

function fixLengthRatios(scene: Scene3D, fixes: string[]): void {
  const pts = numericPoints(scene);
  if (pts.size === 0) return;
  const constraints = scene.constraints ?? [];
  for (let i = 0; i < constraints.length; i++) {
    const c = constraints[i];
    if (c.type !== 'length-ratio') continue;
    const [a1, a2] = c.a ?? [];
    const [b1, b2] = c.b ?? [];
    const A1 = a1 ? pts.get(normalizeVertexToken(a1)) : undefined;
    const A2 = a2 ? pts.get(normalizeVertexToken(a2)) : undefined;
    const B1 = b1 ? pts.get(normalizeVertexToken(b1)) : undefined;
    const B2 = b2 ? pts.get(normalizeVertexToken(b2)) : undefined;
    if (!A1 || !A2 || !B1 || !B2) continue;
    const l1 = dist3(A1, A2);
    const l2 = dist3(B1, B2);
    if (l2 < 1e-9) continue;
    const actual = l1 / l2;
    const rel = (x: number, y: number) => Math.abs(x - y) / Math.max(1, Math.abs(y));
    if (rel(actual, c.ratio) <= 1e-3) continue; // 本来就对

    // 比例写反了（actual ≈ 1/ratio）：对调 a/b，保留模型想表达的原始比值
    if (c.ratio > 0 && rel(actual, 1 / c.ratio) <= 1e-3) {
      const a = c.a;
      c.a = c.b;
      c.b = a;
      fixes.push(`约束 ${i + 1}（|${a1}${a2}| : |${b1}${b2}|）写反了，已对调两条线段`);
      continue;
    }

    // 保守改值：四个点里至少一个是派生点（坐标是程序算的，位置可信）才改
    const derived = [a1, a2, b1, b2].some((id) => {
      const obj = scene.objects.find(
        (o) => o.type === 'point3' && normalizeVertexToken(o.id) === normalizeVertexToken(String(id)),
      ) as Point3Object | undefined;
      return !!obj?.derive;
    });
    if (!derived) continue; // 可能是点放错了，交给模型判断
    const old = c.ratio;
    c.ratio = niceRatio(actual);
    fixes.push(`约束 ${i + 1}（|${a1}${a2}| : |${b1}${b2}|）的比值 ${old} 改为实测值 ${c.ratio}`);
  }
}

// ---------------------------------------------------------------
// 修法 ③：正文点名但图上没有的点 → 从句式推断关系补 point3
// ---------------------------------------------------------------

const CLAUSE_SPLIT = /[。；;\n]/;
const POINT_CONTEXT = /[点交连延作取设过恰即]/;
/** 独立出现的"大写字母 + 可选下标数字"（与 checkStepPointRefs 同一把尺子） */
const TOKEN_RE = /(^|[^A-Za-z0-9])([A-Z]\d?)(?![A-Za-z0-9])/g;

interface Candidate {
  /** 要补的点 */
  name: string;
  derive: Point3Object['derive'];
  /** 推断时顺手算好的数值坐标——链式推断（P 依赖刚补的 M）全靠它 */
  at: V3;
  /** 人类可读的推断依据（放进步骤清单） */
  why: string;
}

/** 从一句讲解里推断"NAME 是怎么来的"；推断不出返回 null */
function inferDerivation(
  clause: string,
  name: string,
  declared: Set<string>,
  pts: Map<string, V3>,
): Candidate | null {
  // 下标归一 + 去空格，正则才好写：D₁ → D1
  const t = normalizeVertexToken(clause);
  const N = name;

  // ①「（延长）AB 交 CD 于 N」/「连接 AB 交 CD 于 N」
  let m = t.match(new RegExp(`[A-Z]\\d{0,2}[A-Z]\\d{0,2}交[A-Z]\\d{0,2}[A-Z]\\d{0,2}于${N}(?![A-Za-z0-9])`));
  if (m) {
    const seg = m[0].replace(/^(?:延长|连接|作|取)/, '');
    const mm = seg.match(/^([A-Z]\d{0,2})([A-Z]\d{0,2})交([A-Z]\d{0,2})([A-Z]\d{0,2})/);
    if (mm) {
      return intersectCandidate([mm[1], mm[2]], [mm[3], mm[4]], N, declared, pts, `延长 ${mm[1]}${mm[2]} 交 ${mm[3]}${mm[4]}`);
    }
  }

  // ②「AB ∩ CD = N」/「N 是 AB ∩ CD 的交点」/「AB ∩ CD 的交点为 N」
  m = t.match(new RegExp(`([A-Z]\\d{0,2})([A-Z]\\d{0,2})∩([A-Z]\\d{0,2})([A-Z]\\d{0,2})(?:的交点)?(?:为|是|=|＝)${N}(?![A-Za-z0-9])`));
  if (m) {
    return intersectCandidate([m[1], m[2]], [m[3], m[4]], N, declared, pts, `${m[1]}${m[2]} ∩ ${m[3]}${m[4]}`);
  }
  m = t.match(new RegExp(`${N}(?:是|为)[A-Z]\\d{0,2}[A-Z]\\d{0,2}∩[A-Z]\\d{0,2}[A-Z]\\d{0,2}的?交点`));
  if (m) {
    const mm = m[0].replace(new RegExp(`^${N}(?:是|为)`), '').match(/^([A-Z]\d{0,2})([A-Z]\d{0,2})∩([A-Z]\d{0,2})([A-Z]\d{0,2})/);
    if (mm) {
      return intersectCandidate([mm[1], mm[2]], [mm[3], mm[4]], N, declared, pts, `${mm[1]}${mm[2]} ∩ ${mm[3]}${mm[4]}`);
    }
  }

  // ③「N 是 AB 的中点」/「取 AB 的中点 N」（前后缀都可有可无）
  m = t.match(new RegExp(`(?:${N}(?:是|为))?([A-Z]\\d{0,2})([A-Z]\\d{0,2})的?中点(?:为|是)?${N}(?![A-Za-z0-9])`));
  if (m) {
    return midpointCandidate(m[1], m[2], N, declared, pts, `${m[1]}${m[2]} 的中点`);
  }
  m = t.match(new RegExp(`${N}(?:是|为)[A-Z]\\d{0,2}[A-Z]\\d{0,2}的?中点`));
  if (m) {
    const mm = m[0].replace(new RegExp(`^${N}(?:是|为)`), '').replace(/的中点$/, '').match(/^([A-Z]\d{0,2})([A-Z]\d{0,2})$/);
    if (mm) {
      return midpointCandidate(mm[1], mm[2], N, declared, pts, `${mm[1]}${mm[2]} 的中点`);
    }
  }
  return null;
}

/** 两线求交候选：端点都得已声明，且两线真的共面不平行（否则算出假点） */
function intersectCandidate(
  l1: [string, string],
  l2: [string, string],
  name: string,
  declared: Set<string>,
  pts: Map<string, V3>,
  why: string,
): Candidate | null {
  const ids = [...l1, ...l2];
  for (const id of ids) {
    if (!declared.has(id) || !pts.get(id)) return null;
  }
  const A = pts.get(l1[0])!;
  const B = pts.get(l1[1])!;
  const C = pts.get(l2[0])!;
  const D = pts.get(l2[1])!;
  const r = sub3(B, A);
  const w = sub3(D, C);
  const n: V3 = [
    r[1] * w[2] - r[2] * w[1],
    r[2] * w[0] - r[0] * w[2],
    r[0] * w[1] - r[1] * w[0],
  ];
  const nl = Math.hypot(...n);
  if (nl < 1e-9) return null; // 平行/重合
  let scale = 1;
  for (const p of pts.values()) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const gap = Math.abs(
    (C[0] - A[0]) * n[0] + (C[1] - A[1]) * n[1] + (C[2] - A[2]) * n[2],
  ) / nl;
  if (gap > 1e-4 * scale) return null; // 异面
  // 交点数值：P = A + t·r，t = [(C−A)×w · (r×w)] / |r×w|²
  //（体检器 checkIntersectDerives 已确认共面不平行，这里的 t 必然有效）
  const w0 = sub3(C, A);
  const cw: V3 = [
    w0[1] * w[2] - w0[2] * w[1],
    w0[2] * w[0] - w0[0] * w[2],
    w0[0] * w[1] - w0[1] * w[0],
  ];
  const n2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
  if (n2 < 1e-18) return null;
  const t = (cw[0] * n[0] + cw[1] * n[1] + cw[2] * n[2]) / n2;
  const at: V3 = [A[0] + t * r[0], A[1] + t * r[1], A[2] + t * r[2]];
  return { name, derive: { kind: 'intersect', l1, l2 }, at, why };
}

function midpointCandidate(
  a: string,
  b: string,
  name: string,
  declared: Set<string>,
  pts: Map<string, V3>,
  why: string,
): Candidate | null {
  if (!declared.has(a) || !declared.has(b)) return null;
  const A = pts.get(a);
  const B = pts.get(b);
  if (!A || !B) return null;
  const at: V3 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
  return { name, derive: { kind: 'midpoint', a, b }, at, why };
}

function fixMissingPoints(scene: Scene3D, fixes: string[]): void {
  const steps = scene.steps ?? [];
  if (steps.length === 0) return;
  const declared = declaredPointIds(scene.objects);
  const pts = numericPoints(scene);
  if (pts.size < 3) return;

  // 先收集所有"被点名但不存在"的点
  const missing = new Set<string>();
  for (const step of steps) {
    for (const clause of String(step.text ?? '').split(CLAUSE_SPLIT)) {
      if (!POINT_CONTEXT.test(clause)) continue;
      const norm = normalizeVertexToken(clause);
      for (const m of norm.matchAll(TOKEN_RE)) {
        if (!declared.has(m[2])) missing.add(m[2]);
      }
    }
  }
  if (missing.size === 0) return;

  // 逐个推断；推断成功就补 point3 + derive。
  // 多轮循环：先补的点立刻进 declared，"先定义 P、再用 P 定义 R"
  // 这种链式定义无论 Set 顺序如何都能接上（最多 3 轮，防意外死循环）。
  const added: string[] = [];
  for (let pass = 0; pass < 3 && missing.size > 0; pass++) {
    let progressed = false;
    for (const name of [...missing]) {
      let candidate: Candidate | null = null;
      for (const step of steps) {
        for (const clause of String(step.text ?? '').split(CLAUSE_SPLIT)) {
          candidate = inferDerivation(clause, name, declared, pts);
          if (candidate) break;
        }
        if (candidate) break;
      }
      if (!candidate) continue;
      scene.objects.push({ id: candidate.name, type: 'point3', derive: candidate.derive });
      declared.add(candidate.name);
      // 数值坐标立刻进 pts：链式推断（P 依赖刚补的 M）在下一轮就能接上
      pts.set(candidate.name, candidate.at);
      missing.delete(name);
      added.push(`${candidate.name}（${candidate.why}，交点/中点由程序计算）`);
      progressed = true;
    }
    if (!progressed) break;
  }
  if (added.length > 0) {
    fixes.push(`补出讲解里点名但图上没有的点：${added.join('、')}`);
  }
}

// ---------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------

/**
 * 程序代改：按上面的三个修法过一遍场景。
 *
 * 返回的是**深拷贝**（绝不改调用方手里的原场景），派生点的坐标表达式
 * 由 resolveScene3D 统一补齐——和解析器产出保持同一形态，体检/渲染都能直接吃。
 */
export function autoFix3D(scene: Scene3D): AutoFix3DResult {
  // 先 resolve 一遍：派生点的 at 表达式要在这里补齐，
  // 后面所有"按数值坐标推断"才有据可依（对已 resolve 的场景是幂等的）
  const next = resolveScene3D(structuredClone(scene));
  const fixes: string[] = [];

  fixSectionClaims(next, fixes);
  fixLengthRatios(next, fixes);
  fixMissingPoints(next, fixes);

  if (fixes.length > 0) {
    return { scene: resolveScene3D(next), fixes };
  }
  return { scene: next, fixes };
}
