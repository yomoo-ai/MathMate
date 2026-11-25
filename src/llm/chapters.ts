/**
 * chapters.ts —— 题目章节归类（题库 / 组卷功能的标签来源）
 *
 * 三层来源里这一层负责两个：
 *   1. 标签集定义：LLM 只许从这里选，不许自由发挥——
 *      自由发挥会写出「相似三角形探究专题（一）」这种没法筛选的东西；
 *   2. 程序反推（deriveChapter）：保存题本那一刻就得有标签可用，
 *      不能等知识点的 LLM 调用慢慢回来（可能失败、可能没填 Key）。
 *      反推依据是场景里已经核验过的约束类型，永不瞎编，代价只是粒度粗。
 */

import type { Scene, SceneObject } from '../protocol/scene';
import type { Scene3D } from '../protocol/scene3d';

/** 人教版粗分章节。顺序即筛选栏显示顺序，「其他」永远在最后 */
export const CHAPTERS = [
  '三角形',
  '四边形',
  '圆',
  '函数与图象',
  '立体几何',
  '代数与推导',
  '其他',
] as const;

export type Chapter = (typeof CHAPTERS)[number];

const CHAPTER_SET = new Set<string>(CHAPTERS);

/** LLM 返回的章节必须在集合内，否则丢弃（返回空串 = 未分类） */
export function normalizeChapter(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  // 容错：模型爱写「第X章 圆」这种前缀，把不含结构词的部分再试一次
  if (CHAPTER_SET.has(s)) return s;
  for (const c of CHAPTERS) {
    if (s && s.includes(c)) return c;
  }
  return '';
}

function constraintTypes(scene: Scene | Scene3D): Set<string> {
  const set = new Set<string>();
  for (const c of scene.constraints ?? []) {
    const t = (c as { type?: string }).type;
    if (typeof t === 'string') set.add(t);
  }
  return set;
}

/** 对象里有没有某种形状（circle / curve 都挂在 type 字段上） */
function hasObjectKind(objects: SceneObject[], kind: string): boolean {
  return objects.some((o) => o.type === kind);
}

/**
 * 从已核验的约束反推章节。判定顺序就是特异性顺序：
 *   3D → 圆 → 函数 → 四边形 → 三角形 → 其他
 * 前面的命中就停，因为「三角形内切圆」这类题两边的特征都有，
 * 按教材习惯归入圆的章节更符合老师找题的方式。
 */
export function deriveChapter(scene: Scene | Scene3D): string {
  if ((scene as Scene3D).space === '3d') return '立体几何';

  const types = constraintTypes(scene);
  const objects = (scene.objects ?? []) as SceneObject[];

  // 圆：显式圆对象，或切线约束
  if (hasObjectKind(objects, 'circle') || types.has('tangent')) return '圆';

  // 函数：有曲线对象且不是圆弧（arc 算几何）；parametric 多用于圆锥曲线，也归函数
  const hasFnCurve =
    hasObjectKind(objects, 'curve') ||
    types.has('parametric') ||
    objects.some((o) => (o as { derive?: { kind?: string } }).derive?.kind === 'curve-point');
  if (hasFnCurve) return '函数与图象';

  const ptCount = objects.filter((o) => o.type === 'point').length;

  // 四边形：平行约束 + 4 个以上点（平行四边形 / 梯形的典型指纹）
  if (types.has('parallel') && ptCount >= 4) return '四边形';

  // 三角形：角平分线 / 中点 / 比例，或少量点 + 垂直/等长（内切圆外的常见指纹）
  if (
    types.has('angle-bisector') ||
    types.has('midpoint') ||
    types.has('length-ratio') ||
    (ptCount >= 3 && ptCount <= 6 && (types.has('perp') || types.has('equal-length') || types.has('angle-value')))
  ) {
    return '三角形';
  }

  // 有解析式读数 / value 约束，多半是代数推导题
  if (types.has('value') || types.has('curve')) return '代数与推导';

  return '其他';
}

/** 筛选栏里「未分类」怎么显示 */
export function chapterLabel(chapter: string | undefined): string {
  return chapter && CHAPTER_SET.has(chapter) ? chapter : '未分类';
}
