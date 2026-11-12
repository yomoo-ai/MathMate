/**
 * generalHorse.ts —— 课件 01：将军饮马（初中数学 · 轴对称与最短路径）
 *
 * 这道题的教学结构（四个视图动作）：
 *   ① 情境      ：A 在岸边营地，B 是目的地，P 是河岸上的饮马点，路程 = AP + PB
 *   ② 拖动     ：拖 P 找最短 —— 学生会先试出"大概在中间偏左"
 *   ③ 作对称点  ：A 关于河岸的对称点 A′，于是 AP = A′P，路程 = A′P + PB
 *   ④ 解释     ：A′P + PB ≥ A′B（两点之间线段最短），共线时取等号
 *
 * ===== 为什么坐标写死、只留一个参数 p =====
 * 这是**课件**，不是生成式题目：题目条件固定，"可交互的只有 P"。
 * 只暴露一个自由度，学生才不会在参数面板里迷路；
 * 也让"拖动 → 数字变 → 结论浮现"这条因果链只有一个原因。
 */
import type { Scene, StepDef } from '../protocol/scene';
import type { CoursewareSpec } from './spec';

/** 营地 A：河岸同侧的一点 */
const A: [number, number] = [-3, 2];
/** 目的地 B */
const B: [number, number] = [3, 3];
/** A 关于河岸（y = 0）的对称点 */
const A1: [number, number] = [A[0], -A[1]];

/**
 * 最短饮马点 = 直线 A′B 与河岸的交点。
 * 这里现算而不是写死 -0.6：将来改 A/B 坐标，结论自动跟着对。
 */
function bankCross(from: [number, number], to: [number, number]): number {
  const t = (0 - from[1]) / (to[1] - from[1]);
  return from[0] + t * (to[0] - from[0]);
}
const P_STAR = Number(bankCross(A1, B).toFixed(3));
/** 理论最短总路程 = |A′B| */
const BEST = Math.hypot(B[0] - A1[0], B[1] - A1[1]).toFixed(3);

// ---------------------------------------------------------------
// 读数表达式：全部由 A/B 坐标生成，避免"图上改了数、面板没改"
// ---------------------------------------------------------------
const AP_EXPR = `sqrt((p - ${A[0]})^2 + ${A[1] * A[1]})`;
const PB_EXPR = `sqrt((p - ${B[0]})^2 + ${B[1] * B[1]})`;

const BANK_COLOR = '#0f766e';
const PATH_COLOR = '#ea580c';
const POINT_COLOR = '#185fa5';

/** 两张图共用的四个步骤（reveal 只写在各图自己的对象上，所以两套 steps 分开写） */
const stepsScene: StepDef[] = [
  {
    title: '观察情境',
    text: '从营地 $A$ 出发，先到河边某点 $P$ 饮马，再去目的地 $B$。总路程就是 $AP+PB$。',
    highlight: ['A', 'B', 'P', 'AP', 'PB'],
  },
  {
    title: '拖动探索',
    text: '拖动 $P$ 点，看总路程怎么变。停在你觉得最短的位置——先别急着算。',
    highlight: ['P', 'AP', 'PB'],
  },
  {
    title: '作对称点',
    text: '$A$ 关于河岸的对称点记作 $A\'$。轴对称保证 $AP=A\'P$，所以 $AP+PB=A\'P+PB$。',
    highlight: ['A', 'B', 'P', 'AP', 'PB'],
  },
  {
    title: '解释最短',
    text: '$A\'P+PB \\ge A\'B$，当 $P$ 落在 $A\'B$ 上时取等号。所以最短位置就是 $A\'B$ 与河岸的交点。',
    highlight: ['A', 'B', 'P', 'AP', 'PB'],
  },
];

const stepsProof: StepDef[] = [
  {
    title: '观察情境',
    text: '这一步只看路程：$AP+PB$ 随 $P$ 的位置变化。',
    highlight: ['A', 'B', 'P', 'AP', 'PB'],
  },
  {
    title: '拖动探索',
    text: '把 $P$ 拖到你觉得最短的地方，记住这个位置。',
    highlight: ['P', 'AP', 'PB'],
  },
  {
    title: '作对称点',
    text: '作 $A$ 关于河岸的对称点 $A\'$，连 $A\'P$。因为 $AP=A\'P$，折线 $A\\!-\\!P\\!-\\!B$ 的长度 = 折线 $A\'\\!-\\!P\\!-\\!B$ 的长度。',
    reveal: ['A1', 'AA1', 'A1P'],
    highlight: ['A1', 'A1P', 'AA1'],
  },
  {
    title: '解释最短',
    text: '两点之间线段最短：$A\'P+PB \\ge A\'B$。当 $P$ 是 $A\'B$ 与河岸的交点 $P_0$ 时取等号，最短路程 $= A\'B = ' + BEST + '$。',
    reveal: ['A1', 'AA1', 'A1P', 'A1B', 'P0'],
    highlight: ['A1B', 'P0'],
  },
];

/** 情境图：河岸 + 两点 + 折线路径 */
function sceneSituation(params: Record<string, number>): Scene {
  const p = params.p;
  // 水面：上边缘做正弦波纹（静态但"是水"），下边缘沿视图底。
  // 波幅刻意小（±0.09）：动画感靠波纹形状暗示，靠大幅晃动只会显得廉价。
  const wavePts: [number, number][] = [];
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const x = -6.8 + (13.6 * i) / N;
    const y = -0.075 * Math.sin((x / 13.6) * Math.PI * 14) - 0.02;
    wavePts.push([x, y]);
  }
  return {
    meta: { title: '真实情境', subtitle: '岸边营地 A、目的地 B、饮马点 P' },
    view: { xMin: -6.8, xMax: 6.8, yMin: -2.1, yMax: 4.4 },
    params: [
      { name: 'p', label: '饮马点 P 的位置', min: -6, max: 6, step: 0.02, value: p, slider: false },
    ],
    objects: [
      {
        type: 'polygon',
        id: 'water',
        points: [...wavePts, [6.8, -2.1], [-6.8, -2.1]],
        fill: true,
        fillOpacity: 0.55,
        color: '#0e7490',
      },
      { type: 'segment', id: 'bank', from: [-6.8, 0], to: [6.8, 0], color: '#38bdf8', label: '河岸' },
      { type: 'segment', id: 'AP', from: A, to: 'p, 0', color: PATH_COLOR, glow: true },
      { type: 'segment', id: 'PB', from: 'p, 0', to: B, color: '#22d3ee', dashed: true },
      { type: 'point', id: 'A', at: A, label: 'A', color: '#93c5fd' },
      { type: 'point', id: 'B', at: B, label: 'B', color: '#93c5fd' },
      {
        type: 'point',
        id: 'P',
        at: 'p, 0',
        label: 'P',
        draggable: true,
        dragBind: { x: 'p' },
        color: PATH_COLOR,
        glow: true,
      },
    ],
    readouts: [
      { label: 'AP', expr: AP_EXPR },
      { label: 'PB', expr: PB_EXPR },
      { label: '总路程', expr: `${AP_EXPR} + ${PB_EXPR}` },
    ],
    steps: stepsScene,
  };
}

/** 定理图：同一道题搬到抽象平面，加入对称点与"一条线段" */
function sceneProof(params: Record<string, number>): Scene {
  const p = params.p;
  return {
    meta: { title: '几何探究', subtitle: '把折线拉成一条线段' },
    view: { xMin: -6.8, xMax: 6.8, yMin: -3.4, yMax: 4.4 },
    params: [
      { name: 'p', label: '饮马点 P 的位置', min: -6, max: 6, step: 0.02, value: p, slider: false },
    ],
    objects: [
      { type: 'segment', id: 'bank', from: [-6.8, 0], to: [6.8, 0], color: '#38bdf8' },
      { type: 'segment', id: 'AP', from: A, to: 'p, 0', color: PATH_COLOR },
      { type: 'segment', id: 'PB', from: 'p, 0', to: B, color: '#22d3ee', dashed: true },
      { type: 'point', id: 'A', at: A, label: 'A', color: '#93c5fd' },
      { type: 'point', id: 'B', at: B, label: 'B', color: '#93c5fd' },
      {
        type: 'point',
        id: 'P',
        at: 'p, 0',
        label: 'P',
        draggable: true,
        dragBind: { x: 'p' },
        color: PATH_COLOR,
        glow: true,
      },
      // —— 以下对象在第三步才出现（reveal）——
      { type: 'point', id: 'A1', at: A1, label: 'A′', color: '#c4b5fd' },
      { type: 'segment', id: 'AA1', from: A, to: A1, color: '#64748b', dashed: true },
      { type: 'segment', id: 'A1P', from: A1, to: 'p, 0', color: '#a78bfa', dashed: true },
      { type: 'segment', id: 'A1B', from: A1, to: B, color: PATH_COLOR, glow: true },
      { type: 'point', id: 'P0', at: [P_STAR, 0], label: 'P₀', color: '#34d399', glow: true },
    ],
    readouts: [
      { label: 'A′P+PB', expr: `${AP_EXPR} + ${PB_EXPR}` },
      { label: 'A′B', expr: `sqrt(${(B[0] - A1[0]) ** 2} + ${(B[1] - A1[1]) ** 2})` },
    ],
    steps: stepsProof,
  };
}

// ---------------------------------------------------------------
// 步骤卡片缩略图：内联 SVG，坐标直接从世界坐标缩到 88×58 的小画布
// ---------------------------------------------------------------
const sx = (x: number) => 4 + ((x + 6) / 12) * 80;
const sy = (y: number) => 4 + ((4.2 - y) / 6.4) * 44;

function thumb(extra: string): string {
  return `<svg viewBox="0 0 88 58" aria-hidden="true">
    <line x1="4" y1="${sy(0)}" x2="84" y2="${sy(0)}" stroke="#0f766e" stroke-width="1" opacity=".55"/>
    ${extra}
  </svg>`;
}
const dot = (x: number, y: number, color: string) =>
  `<circle cx="${sx(x)}" cy="${sy(y)}" r="2.2" fill="${color}"/>`;

export const GENERAL_HORSE: CoursewareSpec = {
  id: 'general-horse',
  subject: '初中数学',
  chapter: '轴对称与最短路径',
  code: '探究案 01',
  title: '将军饮马',
  subtitle: '拖动饮马点、比较路线并验证，用轴对称和两点之间线段最短寻找最短路径',
  question: '在哪里饮马，走的总路程最短？',
  hint: '对称不是为了好看——它把"两段折线"换成了"一条线段"。凡是"一条动线上找一点，使两段路程之和最小"，都可以先试着把其中一段翻过去。',
  primary: { name: 'p', label: '饮马点 P', min: -6, max: 6, step: 0.02 },
  params: { p: -4.2 },
  panes: [
    {
      key: 'scene',
      badge: '01',
      title: '真实情境',
      hint: '拖动饮马点 P',
      scene: sceneSituation,
    },
    {
      key: 'proof',
      badge: '03',
      title: '几何探究',
      hint: '把折线拉成线段',
      scene: sceneProof,
    },
  ],
  readouts: [
    { label: 'AP', expr: AP_EXPR, barMax: 10, color: PATH_COLOR },
    { label: 'PB', expr: PB_EXPR, barMax: 10, color: BANK_COLOR },
    { label: '总路程', expr: `${AP_EXPR} + ${PB_EXPR}`, barMax: 12, color: '#1b2130' },
    { label: '理论最短 A′B', expr: `sqrt(${(B[0] - A1[0]) ** 2} + ${(B[1] - A1[1]) ** 2})`, barMax: 12, color: '#0e7a4f' },
  ],
  steps: [
    {
      no: '1',
      title: '观察情境',
      caption: '路程 = AP + PB',
      params: { p: -4.2 },
      thumb: thumb(
        `<line x1="${sx(-3)}" y1="${sy(2)}" x2="${sx(-4.2)}" y2="${sy(0)}" stroke="#ea580c" stroke-width="1.2"/>
         <line x1="${sx(-4.2)}" y1="${sy(0)}" x2="${sx(3)}" y2="${sy(3)}" stroke="#0f766e" stroke-width="1.2" stroke-dasharray="2 2"/>
         ${dot(-3, 2, '#185fa5')}${dot(3, 3, '#185fa5')}${dot(-4.2, 0, '#ea580c')}`,
      ),
    },
    {
      no: '2',
      title: '拖动探索',
      caption: '找一个最短位置',
      params: { p: 1.8 },
      thumb: thumb(
        `<line x1="${sx(-3)}" y1="${sy(2)}" x2="${sx(1.8)}" y2="${sy(0)}" stroke="#ea580c" stroke-width="1.2"/>
         <line x1="${sx(1.8)}" y1="${sy(0)}" x2="${sx(3)}" y2="${sy(3)}" stroke="#0f766e" stroke-width="1.2" stroke-dasharray="2 2"/>
         <line x1="${sx(-4.2)}" y1="${sy(0)}" x2="${sx(-4.2)}" y2="${sy(0)}" stroke="none"/>
         ${dot(-3, 2, '#185fa5')}${dot(3, 3, '#185fa5')}${dot(1.8, 0, '#ea580c')}
         <circle cx="${sx(-4.2)}" cy="${sy(0)}" r="2" fill="none" stroke="#ea580c" stroke-width="1" opacity=".5"/>`,
      ),
    },
    {
      no: '3',
      title: '作对称点',
      caption: 'A′ 替换掉 A',
      params: { p: 1.8 },
      thumb: thumb(
        `<line x1="${sx(-3)}" y1="${sy(2)}" x2="${sx(-3)}" y2="${sy(-2)}" stroke="#9aa3b2" stroke-width="1" stroke-dasharray="2 2"/>
         <line x1="${sx(-3)}" y1="${sy(-2)}" x2="${sx(1.8)}" y2="${sy(0)}" stroke="#ea580c" stroke-width="1.2" stroke-dasharray="2 2"/>
         <line x1="${sx(1.8)}" y1="${sy(0)}" x2="${sx(3)}" y2="${sy(3)}" stroke="#0f766e" stroke-width="1.2" stroke-dasharray="2 2"/>
         ${dot(-3, 2, '#185fa5')}${dot(3, 3, '#185fa5')}${dot(1.8, 0, '#ea580c')}${dot(-3, -2, '#185fa5')}`,
      ),
    },
    {
      no: '4',
      title: '解释最短',
      caption: '共线时最短',
      params: { p: P_STAR },
      thumb: thumb(
        `<line x1="${sx(-3)}" y1="${sy(-2)}" x2="${sx(3)}" y2="${sy(3)}" stroke="#ea580c" stroke-width="1.4"/>
         <line x1="${sx(-3)}" y1="${sy(2)}" x2="${sx(-3)}" y2="${sy(-2)}" stroke="#9aa3b2" stroke-width="1" stroke-dasharray="2 2"/>
         ${dot(-3, 2, '#185fa5')}${dot(3, 3, '#185fa5')}${dot(-3, -2, '#185fa5')}${dot(P_STAR, 0, '#0e7a4f')}`,
      ),
    },
  ],
  duration: 26,
  captions: [
    { at: 0, text: '从营地出发，先到河边饮马，再去目的地。' },
    { at: 6, text: '拖动饮马点：总路程一直在变，哪里最短？' },
    { at: 13, text: '把 A 翻到河对岸：AP 变成了 A′P，长度没变。' },
    { at: 19, text: 'A′P + PB 至少等于 A′B——共线那一刻最短。' },
  ],
  track: (t: number) => {
    // 0–6 秒：停在初始位置，讲情境
    if (t < 6) return { params: { p: -4.2 }, step: 0 };
    // 6–12 秒：把 P 从左边扫到右边，让"总路程先减后增"被看见
    if (t < 12) {
      const k = easeInOut((t - 6) / 6);
      return { params: { p: -4.2 + k * 7 }, step: 1 };
    }
    // 12–16 秒：回到最短位置附近
    if (t < 16) {
      const k = easeInOut((t - 12) / 4);
      return { params: { p: 2.8 + k * (P_STAR - 2.8) }, step: 1 };
    }
    // 16–21 秒：作对称点
    if (t < 21) return { params: { p: P_STAR }, step: 2 };
    // 21 秒后：共线取等
    return { params: { p: P_STAR }, step: 3 };
  },
  best: { p: P_STAR },
  bestNote: `最短总路程 ${BEST}（A′P+PB 恰好等于 A′B）`,
};

/** 三次缓入缓出：自动演示用，比线性自然 */
function easeInOut(k: number): number {
  const x = Math.min(1, Math.max(0, k));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
