/**
 * 核验清单：把「体检到底验了什么」摊开给人看。
 *
 * 为什么需要？
 *   体检只在失败时说话——成功了什么都不显示。老师看到一张对的图，
 *   手里没有任何证据说明它「真的被验过」，而不是模型随手填的坐标。
 *   这里把每条约束翻成一句人话，标明通过 / 未通过，挂在画布角上。
 *
 * 判定口径刻意与体检保持一致：只看 verifyScene / verifyScene3D 里
 * where 以 `constraints[i]` 开头的 issue —— 没有 issue 就是通过。
 * 不另算一遍，是为了避免出现「清单说通过、体检说错」的两套标准。
 *
 * 两种不可信的情况单独标出来：
 *   empty   —— 一条约束都没有，这张图完全没被验过（只有坐标）
 *   tainted —— 存在非约束类的 error（整图退化、对象算不出坐标…），
 *              此时逐条核验的结论已经不可信，不能拿绿色糊弄人
 */

import type { Issue } from './verifier';

export interface CoverageItem {
  /** 人话描述，如「AB ⊥ CD」 */
  text: string;
  /** 通过 / 未通过（未通过的 reason 来自体检原文） */
  ok: boolean;
  /** 未通过的原因，截到第一句——后面那句「修法：…」是给模型看的，老师不需要 */
  reason?: string;
  /** 体检原文，鼠标悬停时给出 */
  reasonFull?: string;
}

export interface CoverageResult {
  total: number;
  passed: number;
  failed: number;
  items: CoverageItem[];
  /** 一条约束都没有：这张图没被验过 */
  empty: boolean;
  /** 有非约束类的致命问题：逐条结论不可信 */
  tainted: boolean;
}

/** 约束对象是任意形状（来自 JSON），这里只按已知字段取，取不到就写 ? */
type AnyConstraint = Record<string, unknown>;

function pair(v: unknown): [string, string] {
  if (!Array.isArray(v)) return ['?', '?'];
  return [String(v[0] ?? '?'), String(v[1] ?? '?')];
}

function trip(v: unknown): [string, string, string] {
  if (!Array.isArray(v)) return ['?', '?', '?'];
  return [String(v[0] ?? '?'), String(v[1] ?? '?'), String(v[2] ?? '?')];
}

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function numStr(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '?';
}

/** 把一条约束翻成一句人话；字段缺失时退化成「（类型）」，不抛错 */
export function describeConstraint(c: AnyConstraint): string {
  const type = String(c?.type ?? '?');
  switch (type) {
    // ---- 2D / 3D 同名，但 2D 的 perp 是三点式 ----
    case 'perp': {
      // points = [A, 顶点V, B]：∠AVB = 90°，即 VA ⊥ VB
      const [a, v, b] = trip(c.points);
      return `${a}${v} ⊥ ${b}${v}`;
    }
    case 'perp-lines': {
      const [a1, a2] = pair(c.a);
      const [b1, b2] = pair(c.b);
      return `${a1}${a2} ⊥ ${b1}${b2}`;
    }
    case 'parallel':
    case 'parallel-lines': {
      const [a1, a2] = pair(c.a);
      const [b1, b2] = pair(c.b);
      return `${a1}${a2} ∥ ${b1}${b2}`;
    }
    case 'collinear':
      return `${ids(c.points).join('、')} 共线`;
    case 'coplanar':
      return `${ids(c.points).join('、')} 共面`;
    case 'on-segment': {
      const [e1, e2] = pair(c.ends);
      return `${String(c.p ?? '?')} 在线段 ${e1}${e2} 上`;
    }
    case 'equal-length': {
      const [a1, a2] = pair(c.a);
      const [b1, b2] = pair(c.b);
      return `|${a1}${a2}| = |${b1}${b2}|`;
    }
    case 'midpoint': {
      const [e1, e2] = pair(c.ends);
      return `${String(c.m ?? '?')} 是 ${e1}${e2} 的中点`;
    }
    case 'angle-value': {
      const [p1, v, p2] = trip(c.points);
      return `∠${p1}${v}${p2} = ${numStr(c.deg)}°`;
    }
    case 'length-ratio': {
      const [a1, a2] = pair(c.a);
      const [b1, b2] = pair(c.b);
      return `|${a1}${a2}| : |${b1}${b2}| = ${numStr(c.ratio)}`;
    }
    case 'value':
      return `${String(c.expr ?? '?')} = ${numStr(c.equals)}`;
    // ---- 2D 专有 ----
    case 'angle-bisector': {
      const [s1, s2] = pair(c.sides);
      return `${String(c.ray ?? '?')} 平分 ∠${s1}${String(c.vertex ?? '?')}${s2}`;
    }
    case 'on-curve':
      return `${String(c.p ?? '?')} 在 ${String(c.curve ?? '?')} 上`;
    default:
      return `（${type} 约束）`;
  }
}

/** 把体检长文案压成一句：第一句就够说清「哪条不成立、实测多少」 */
function firstSentence(msg: string): string {
  const cut = msg.split('。')[0];
  const s = cut.length > 0 ? `${cut}。` : msg;
  return s.length > 110 ? `${s.slice(0, 108)}…` : s;
}

/** 会让「逐条核验」失去意义的结构性错误出现在哪些位置 */
const STRUCTURAL_ERROR = /^(objects|view|visual|params|constraints|-)/;

/**
 * 生成核验清单。
 *
 * @param constraints 场景里的约束数组（2D 的 scene.constraints / 3D 的 scene.constraints）
 * @param issues      对应 verifyScene / verifyScene3D 的结果
 */
export function auditCoverage(
  constraints: ReadonlyArray<unknown> | undefined,
  issues: ReadonlyArray<Issue>,
): CoverageResult {
  const list = Array.isArray(constraints) ? constraints : [];
  const failMap = new Map<number, string>();
  let tainted = false;

  for (const issue of issues) {
    const m = /^constraints\[(\d+)\]/.exec(issue.where ?? '');
    if (m) {
      const idx = Number(m[1]);
      // 一条约束可能报多条，留第一条——最靠前的那条通常就是根因
      if (!failMap.has(idx)) failMap.set(idx, issue.message);
      continue;
    }
    // 只有「结构层面」的错误才会让逐条结论失真：
    // 整图退化（where='objects'）、视野无效、声明要出图却没对象、参数范围非法。
    // 而「孤点」「步骤点名没对上」「读数算错」这类问题只影响别处，
    // 约束该验的还是验了，不该把整张清单标成不可信——那会让提示失去指向性。
    if (issue.level === 'error' && STRUCTURAL_ERROR.test(issue.where ?? '')) tainted = true;
  }

  const items: CoverageItem[] = list.map((c, i) => {
    const obj = (c && typeof c === 'object' ? c : {}) as AnyConstraint;
    const text = describeConstraint(obj);
    const reason = failMap.get(i);
    return reason
      ? { text, ok: false, reason: firstSentence(reason), reasonFull: reason }
      : { text, ok: true };
  });

  const failed = items.filter((it) => !it.ok).length;
  return {
    total: items.length,
    passed: items.length - failed,
    failed,
    items,
    empty: items.length === 0,
    tainted,
  };
}
