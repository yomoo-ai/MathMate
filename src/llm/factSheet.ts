/**
 * factSheet.ts —— 把「已核验的场景」翻译成一段给模型看的事实底稿。
 *
 * 为什么需要它：
 *   知识点整理和答疑都必须**贴在这张图上**说话。但直接把 GeometryJSON
 *   丢给模型，它会看到一堆 id 和表达式，既费 token 又容易看错；反过来
 *   只给题目原文，它就只能凭想象讲——这正是以前"断言对、图是错的"那类
 *   事故的温床。所以这里做一层翻译：顶点坐标是程序算过的、约束是程序
 *   验过的，落成中文短句喂过去。
 *
 * 两个使用方：
 *   - knowledge.ts：整理知识点时，用它判断"本题到底用了哪条定理"；
 *   - chatAgent.ts：答疑时，用它压住"另起一套坐标系自己算"的冲动。
 *
 * 纯函数，不碰 DOM，可进回归。
 */

import type { Constraint, Scene } from '../protocol/scene';
import type { Constraint3, Point3Object, Scene3D } from '../protocol/scene3d';
import { resolveScene3D } from '../protocol/resolve3d';
import { resolvePoints } from '../core/action';
import { evalVec3 } from '../protocol/expr';

export interface FactSheet {
  /** 给模型看的中文事实清单（已截断，控制在千余字内） */
  text: string;
  /** 场景里真实存在的对象 id —— 聊天里的「高亮」只允许从这里挑 */
  ids: string[];
  /** 有没有翻折声明（知识点要单独提二面角） */
  hasFold: boolean;
}

/** 事实清单的长度上限：再长就开始挤占对话历史的位置了 */
const MAX_FACT_CHARS = 1400;

function num(v: number): string {
  if (!isFinite(v)) return '?';
  const s = v.toFixed(2);
  return s.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function p2(a: [number, number]): string {
  return `(${num(a[0])}, ${num(a[1])})`;
}

function p3(a: [number, number, number]): string {
  return `(${num(a[0])}, ${num(a[1])}, ${num(a[2])})`;
}

/** 两个点 id 拼成人看的线段名：AB */
function seg(a: string, b: string): string {
  return `${a}${b}`;
}

/** 二维约束 → 一句中文 */
export function describeConstraint(c: Constraint): string {
  switch (c.type) {
    case 'perp':
      return `∠${c.points[0]}${c.points[1]}${c.points[2]} = 90°（${seg(c.points[0], c.points[1])} ⊥ ${seg(c.points[2], c.points[1])}）`;
    case 'parallel':
      return `${seg(c.a[0], c.a[1])} ∥ ${seg(c.b[0], c.b[1])}`;
    case 'collinear':
      return `${c.points.join('、')} 三点共线`;
    case 'on-segment':
      return `${c.p} 在线段 ${seg(c.ends[0], c.ends[1])} 上`;
    case 'equal-length':
      return `|${seg(c.a[0], c.a[1])}| = |${seg(c.b[0], c.b[1])}|`;
    case 'midpoint':
      return `${c.m} 是 ${seg(c.ends[0], c.ends[1])} 的中点`;
    case 'angle-bisector':
      return `${seg(c.vertex, c.ray)} 平分 ∠${c.sides[0]}${c.vertex}${c.sides[1]}`;
    case 'angle-value':
      return `∠${c.points[0]}${c.points[1]}${c.points[2]} = ${num(c.deg)}°`;
    case 'length-ratio':
      return `|${seg(c.a[0], c.a[1])}| : |${seg(c.b[0], c.b[1])}| = ${num(c.ratio)}`;
    case 'value':
      return `${c.expr} = ${num(c.equals)}`;
    case 'on-curve':
      return `${c.p} 在曲线 ${c.curve} 上`;
    default:
      return '';
  }
}

/** 三维约束 → 一句中文 */
export function describeConstraint3(c: Constraint3): string {
  switch (c.type) {
    case 'equal-length':
      return `|${seg(c.a[0], c.a[1])}| = |${seg(c.b[0], c.b[1])}|`;
    case 'length-ratio':
      return `|${seg(c.a[0], c.a[1])}| : |${seg(c.b[0], c.b[1])}| = ${num(c.ratio)}`;
    case 'perp-lines':
      return `${seg(c.a[0], c.a[1])} ⊥ ${seg(c.b[0], c.b[1])}`;
    case 'parallel-lines':
      return `${seg(c.a[0], c.a[1])} ∥ ${seg(c.b[0], c.b[1])}`;
    case 'collinear':
      return `${c.points.join('、')} 共线`;
    case 'coplanar':
      return `${c.points.join('、')} 共面`;
    case 'midpoint':
      return `${c.m} 是 ${seg(c.ends[0], c.ends[1])} 的中点`;
    case 'on-segment':
      return `${c.p} 在线段 ${seg(c.ends[0], c.ends[1])} 上`;
    case 'angle-value':
      return `∠${c.points[0]}${c.points[1]}${c.points[2]} = ${num(c.deg)}°`;
    case 'value':
      return `${c.expr} = ${num(c.equals)}`;
    default:
      return '';
  }
}

/**
 * 三维顶点坐标表。
 *
 * 走 resolveScene3D 而不是直接读 at：derive（中点/交点/折后点…）在解析后
 * 会展开成自洽的表达式，evalVec3 一算就是真坐标。隐藏点（折前位置）
 * 不算进图里，也不该出现在给模型的事实里——否则它会拿折前的 A 去讲折后的图。
 */
function vertexTable(scene: Scene3D, params: Record<string, number>): string[] {
  const resolved = resolveScene3D(scene);
  const scope: Record<string, number> = { ...params };
  const out: string[] = [];
  for (const o of resolved.objects) {
    if (o.type !== 'point3') continue;
    const p = o as Point3Object;
    if (p.hidden) continue;
    const v = evalVec3(p.at ?? '', scope);
    if (!v) continue;
    // 标签优先用 label（A₁ 这种带上标的写法），没有就用 id
    out.push(`${p.label ?? p.id}${p3(v as [number, number, number])}`);
  }
  return out;
}

function objectSummary(scene: Scene3D): string {
  const count = (t: string) => scene.objects.filter((o) => o.type === t).length;
  const parts: string[] = [];
  const e = count('edge3');
  const f = count('face3');
  const s = count('section3');
  const c = count('curved3');
  if (e) parts.push(`棱/线段 ${e} 条`);
  if (f) parts.push(`面 ${f} 个`);
  if (s) parts.push(`截面 ${s} 个`);
  if (c) parts.push(`曲面体 ${c} 个`);
  return parts.join('、') || '（只有顶点）';
}

/** 组装事实底稿 */
export function buildFactSheet(
  scene: Scene | Scene3D,
  params: Record<string, number>,
): FactSheet {
  const lines: string[] = [];
  const ids: string[] = [];
  for (const o of scene.objects) ids.push(o.id);

  const hasFold = (scene as Scene3D).space === '3d' && !!(scene as Scene3D).fold;

  if ((scene as Scene3D).space === '3d') {
    const s3 = scene as Scene3D;
    lines.push(`【图形】${s3.meta.title}${s3.meta.subtitle ? ` —— ${s3.meta.subtitle}` : ''}`);
    lines.push(`【构成】${objectSummary(s3)}`);
    const vs = vertexTable(s3, params);
    if (vs.length) lines.push(`【顶点坐标（程序已算好，直接引用，不要另算）】${vs.join('；')}`);
    const cs = (s3.constraints ?? []).map(describeConstraint3).filter(Boolean);
    if (cs.length) lines.push(`【已核验的几何条件】${cs.join('；')}`);
    if (s3.fold) {
      const f = s3.fold;
      lines.push(
        `【翻折】沿 ${seg(f.crease[0], f.crease[1])} 折起，跟着动的是 ${f.moving.join('、')}，折起角 ${num(f.deg)}°`,
      );
    }
  } else {
    const s2 = scene as Scene;
    lines.push(`【图形】${s2.meta.title}${s2.meta.subtitle ? ` —— ${s2.meta.subtitle}` : ''}`);
    const ptIds = s2.objects.filter((o) => o.type === 'point').map((o) => o.id);
    if (ptIds.length) {
      const pos = resolvePoints(s2, params);
      const list = ptIds
        .map((id) => {
          const p = pos.get(id);
          return p ? `${id}${p2(p)}` : null;
        })
        .filter(Boolean);
      if (list.length) lines.push(`【点的位置（按当前参数算出）】${list.join('；')}`);
    }
    if (s2.params?.length) {
      lines.push(
        `【参数】${s2.params
          .map((p) => `${p.label ?? p.name}=${num(params[p.name] ?? p.value)}`)
          .join('；')}`,
      );
    }
    const cs = (s2.constraints ?? []).map(describeConstraint).filter(Boolean);
    if (cs.length) lines.push(`【已核验的几何条件】${cs.join('；')}`);
  }

  let text = lines.join('\n');
  if (text.length > MAX_FACT_CHARS) text = `${text.slice(0, MAX_FACT_CHARS)}…（已截断）`;
  return { text, ids, hasFold };
}
