/**
 * knowledge.ts —— 由「题目 + 已核验的图」整理出本题的知识点。
 *
 * 为什么单独一次调用，而不是塞进场景生成：
 *   生成那一步已经在走「格式 / 数值 / 复核」三道关，再多加一个字段，
 *   一旦知识点部分写坏，整张图跟着被打回重做——代价太大。
 *   所以场景通过体检之后，再单独问一次，失败也只是抽屉空着。
 *
 * 输出必须清洗：模型很爱多写（7、8 条），也很爱写"$AB \perp CD$"
 * 这种正确答案但和本题无关的泛泛公式。
 * 这里的清洗规则都是实测撞出来的，不是洁癖。
 *
 * 知识点只做「罗列」，不标注对应第几步：学生要的是"这题用到什么"，
 * 打开抽屉扫一眼就够；把条目和步骤绑在一起，反而逼着模型去猜步号。
 */

import { callChat } from './stub';
import type { FactSheet } from './factSheet';
import type { Scene } from '../protocol/scene';
import type { Scene3D } from '../protocol/scene3d';
import { normalizeMathInput } from '../ui/mathText';

export interface KnowledgePoint {
  /** 定理 / 概念名，≤ 16 字 */
  name: string;
  /** 核心结论，$...$ 包裹；没有就空串 */
  formula: string;
  /** 本题里具体用在哪 */
  use: string;
  /** 易错点 */
  pitfall: string;
}

export interface KnowledgeResult {
  points: KnowledgePoint[];
  /** true = 模型给的；false = 本地兜底（约束类型反推） */
  fromModel: boolean;
  /** 给用户看的一句话（失败原因 / 兜底说明） */
  note?: string;
}

/** 最多几条：再多抽屉要滚两屏，学生反而不看 */
export const MAX_POINTS = 6;

const NAME_MAX = 16;
const USE_MAX = 80;
const PITFALL_MAX = 60;

function text(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // 去掉换行和连续空白：抽屉里是单行排版
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 公式归一：模型有时写 $...$，有时直接写 LaTeX 裸串，有时写"AB⊥CD"。
 * 统一成 renderFormula 能吃的形式——裸 LaTeX 套 $，纯文字原样返回。
 */
function formulaOf(v: unknown): string {
  const s = text(v, 120);
  if (!s) return '';
  if (s.includes('$')) return s;
  // 有反斜杠或上下标，基本可以断定是 LaTeX
  if (/\\[a-zA-Z]+|\^|_\{|\\perp|\\angle/.test(s)) return `$${s}$`;
  return s;
}

/**
 * 清洗模型输出。raw 可能是 {points:[...]}、[...]、甚至被包了一层的字符串。
 */
export function normalizeKnowledge(raw: unknown): KnowledgePoint[] {
  let arr: unknown = raw;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch {
      return [];
    }
  }
  if (arr && !Array.isArray(arr) && typeof arr === 'object') {
    const o = arr as Record<string, unknown>;
    arr = o.points ?? o.knowledge ?? o.items ?? [];
  }
  if (!Array.isArray(arr)) return [];

  const out: KnowledgePoint[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (out.length >= MAX_POINTS) break;
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = text(o.name ?? o.title, NAME_MAX);
    if (!name) continue;
    // 同名去重：模型会把"线面垂直"写两遍，一条带公式一条不带
    const key = name.replace(/[的地得\s]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      name,
      formula: formulaOf(o.formula ?? o.rule),
      use: text(o.use ?? o.where ?? o.application, USE_MAX),
      pitfall: text(o.pitfall ?? o.trap ?? o.warning, PITFALL_MAX),
    });
  }
  return out;
}

// ---------------------------------------------------------------
// 本地兜底：模型不可用时，按约束类型反推名词
//
// 它给不出"本题怎么用"，但至少让抽屉里不是空白一片，
// 也顺手告诉用户"这些是从图上条件反推的"。
// ---------------------------------------------------------------

const TYPE_NAME: Record<string, string> = {
  // 三维
  'perp-lines': '线线垂直',
  'parallel-lines': '线线平行',
  coplanar: '四点共面',
  // 二维
  perp: '线线垂直',
  parallel: '平行关系',
  'angle-bisector': '角平分线',
  // 两者共有的
  'equal-length': '等长与全等',
  'length-ratio': '定比与相似',
  'angle-value': '定角与解三角形',
  midpoint: '中点与中位线',
  collinear: '三点共线',
  'on-segment': '点在线段上',
  'on-curve': '点与曲线',
  value: '题设定值',
};

/** 从场景约束里能认出来的名词（去重、保持出现顺序） */
export function fallbackKnowledge(scene: Scene | Scene3D): KnowledgePoint[] {
  const names: string[] = [];
  for (const c of scene.constraints ?? []) {
    const n = TYPE_NAME[(c as { type: string }).type];
    if (n && !names.includes(n)) names.push(n);
  }
  if ((scene as Scene3D).space === '3d' && (scene as Scene3D).fold) {
    names.push('翻折与二面角');
  }
  return names.slice(0, MAX_POINTS).map((name) => ({
    name,
    formula: '',
    use: '',
    pitfall: '',
  }));
}

// ---------------------------------------------------------------
// 调用
// ---------------------------------------------------------------

function systemPrompt(): string {
  return `你是一位中学数学老师，正在给一道**已经画好图、并通过程序核验**的题整理知识点。

学生只想看"这道题用到了什么"，不想看公式大全。所以：
- 只写本题真正用到的知识点，3~5 条，按在解题中的出场顺序排；
- 不要写与本题无关的定理，哪怕它很重要；
- 每条包含四项：
  · name：知识点名称，不超过 14 字
  · formula：核心结论，用 $...$ 写 LaTeX，一行讲完；确实没有公式就写空字符串
  · use：这道题里**具体**用在哪，点出对象名（如"用到 $BE \perp A_1O$"），不超过 60 字
  · pitfall：学生最容易错的一点，不超过 50 字
- 知识点是**平铺罗列**的，不要标注"第几步"、也不要写"在第 N 步中"；
- 结论必须与给出的「已核验的几何条件」一致。条件里没有的关系，不许当已知；
- 不要编造题里没有的点、数值或结论。

只输出 JSON：{"points":[{"name":"","formula":"","use":"","pitfall":""}]}`;
}

function userPrompt(problem: string, facts: string, stepTitles: string[]): string {
  return [
    `【题目】${problem || '（无题面，只有图形）'}`,
    facts,
    stepTitles.length
      ? `【解题步骤标题】（只帮你理解题意，知识点里不要提第几步）\n${stepTitles
          .map((t, i) => `${i + 1}. ${t}`)
          .join('\n')}`
      : '',
    '请整理本题的知识点。',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 拉取知识点。失败抛错，由 UI 决定显示重试还是兜底。
 * 注意：调用方应先展示 skeleton，不要 await 到黑屏。
 */
export async function requestKnowledge(
  problem: string,
  facts: FactSheet,
  stepTitles: string[],
): Promise<KnowledgePoint[]> {
  const raw = await callChat([
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userPrompt(problem, facts.text, stepTitles) },
  ]);
  const points = normalizeKnowledge(raw);
  if (points.length === 0) throw new Error('模型没有给出可用的知识点');
  return points;
}

/** 缓存键：题目 + 图不同就要重新问 */
export function knowledgeKey(problem: string, scene: Scene | Scene3D): string {
  const title = scene.meta?.title ?? '';
  const n = scene.objects.length;
  const c = (scene.constraints ?? []).length;
  return `${title}|${n}|${c}|${problem.slice(0, 160)}`;
}

/** 抽屉里显示公式前统一走这里（和板书同一套渲染） */
export function knowledgeFormula(point: KnowledgePoint): string {
  return point.formula ? normalizeMathInput(point.formula) : '';
}
