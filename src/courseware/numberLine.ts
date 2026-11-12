/**
 * numberLine.ts —— 课件 02：数轴双动点（初中数学 · 数轴与动点）
 *
 * 题目：数轴上 A(−4)、B(6)。动点 P 从 A 出发沿数轴向右匀速运动，
 *       速度 3 单位/秒；动点 Q 从 B 同时出发向左匀速运动，速度 1 单位/秒。
 *       设运动时间为 t 秒（0 ≤ t ≤ 5）。
 * 教学结构（四个视图动作）：
 *   ① 读题      ：两个起点、两个方向、两个速度，先"看见"运动本身
 *   ② 用 t 表示 ：P = −4+3t，Q = 6−t —— 数轴上的坐标就是路程的语言
 *   ③ 建立方程 ：P、Q 相遇 ⇔ 坐标相等 ⇔ PQ = 0 ⇔ |10−4t| = 0
 *   ④ 解与验证 ：t = 2.5 秒，相遇点 x = 3.5（P 恰好越过 Q，距离先减后增）
 *
 * ===== 为什么距离-时间图要单独一个 pane =====
 * "距离先减后增、相遇那一刻等于 0"这件事，在数轴上只有"两点贴住"一个瞬间；
 * 搬到距离-时间图上就变成一条 V 形折线——同一个事实的两种表示，
 * 互相印证。这正是双视图联动的价值：情境图给直觉，函数图给结构。
 *
 * ===== 为什么拖不了 P/Q，只能拖 t =====
 * P 和 Q 的位置都由同一个 t 决定（P 拖到 x 处对应的 t 是 (x+4)/3，
 * 不是 x 本身——dragBind 只会把指针坐标写回参数）。
 * 硬做"拖点反解 t"会把拖拽逻辑特判塞进壳里，不值。
 * 时间滑块本身就是这道题的自然操作对象（和轻页Lab 的数轴课件一致）。
 */
import type { Scene, StepDef } from '../protocol/scene';
import type { CoursewareSpec } from './spec';

const A: [number, number] = [-4, 0];
const B: [number, number] = [6, 0];
const P_X = '-4 + 3*t';
const Q_X = '6 - t';
const PQ = 'abs(10 - 4*t)';
const T_MEET = 2.5;
const X_MEET = 3.5;

const P_COLOR = '#ea580c';
const Q_COLOR = '#22d3ee';
const AXIS_COLOR = '#7f8db0';
const MEET_COLOR = '#34d399';

const stepsAxis: StepDef[] = [
  {
    title: '读题',
    text: 'P 从 $A(-4)$ 向右、速度 3；Q 从 $B(6)$ 向左、速度 1。同时出发。',
    highlight: ['A', 'B', 'P', 'Q', 'PQ'],
  },
  {
    title: '用 t 表示位置',
    text: '走 $t$ 秒：$P=-4+3t$，$Q=6-t$。坐标随时间线性变化。',
    highlight: ['P', 'Q', 'PQ'],
  },
  {
    title: '建立方程',
    text: '相遇 = 两点坐标相等 = $PQ=0$，即 $|10-4t|=0$。',
    reveal: ['M', 'Mline'],
    highlight: ['M', 'Mline', 'PQ'],
  },
  {
    title: '解与验证',
    text: '$10-4t=0 \\Rightarrow t=2.5$。此刻 $P=Q=3.5$——相遇在 $x=3.5$。',
    highlight: ['M', 'P', 'Q'],
  },
];

const stepsGraph: StepDef[] = [
  {
    title: '读题',
    text: '先看两点在数轴上怎么动，距离的事下一步再说。',
    highlight: [],
  },
  {
    title: '用 t 表示位置',
    text: '距离 $PQ=|10-4t|$ 是 $t$ 的函数——把它画出来。',
    reveal: ['curve'],
    highlight: ['curve', 'dot'],
  },
  {
    title: '建立方程',
    text: 'V 形的最低点就是 $PQ=0$ 的时刻——方程的解藏在图上。',
    reveal: ['Tline'],
    highlight: ['Tline', 'dot'],
  },
  {
    title: '解与验证',
    text: '最低点 $t=2.5$，距离回到 0；$t>2.5$ 后 P 越过 Q，距离重新增大。',
    highlight: ['dot'],
  },
];

/** 数轴现场：一条线、四个点、一段距离 */
function sceneAxis(params: Record<string, number>): Scene {
  const t = params.t;
  return {
    meta: { title: '数轴现场', subtitle: 'P 从 A 向右 3 格/秒，Q 从 B 向左 1 格/秒' },
    view: { xMin: -8, xMax: 10, yMin: -2.2, yMax: 2.6 },
    params: [
      { name: 't', label: '时间 t（秒）', min: 0, max: 5, step: 0.02, value: t, slider: false },
    ],
    objects: [
      { type: 'segment', id: 'axis', from: [-8, 0], to: [10, 0], color: AXIS_COLOR },
      // 两点的"老家"标记：小旗杆，动点走远后仍能看出起点
      { type: 'segment', id: 'Aflag', from: [-4, 0], to: [-4, 0.55], color: '#64748b' },
      { type: 'segment', id: 'Bflag', from: [6, 0], to: [6, 0.55], color: '#64748b' },
      {
        type: 'segment',
        id: 'PQ',
        from: `${P_X}, 0`,
        to: `${Q_X}, 0`,
        color: '#a78bfa',
        glow: true,
      },
      { type: 'point', id: 'A', at: A, label: 'A', color: '#93c5fd' },
      { type: 'point', id: 'B', at: B, label: 'B', color: '#93c5fd' },
      { type: 'point', id: 'P', at: `${P_X}, 0`, label: 'P', color: P_COLOR, glow: true },
      { type: 'point', id: 'Q', at: `${Q_X}, 0`, label: 'Q', color: Q_COLOR, glow: true },
      // —— 第三步 reveal：相遇点与标线 ——
      { type: 'point', id: 'M', at: [X_MEET, 0], label: '相遇 3.5', color: MEET_COLOR, glow: true },
      {
        type: 'segment',
        id: 'Mline',
        from: [X_MEET, 0],
        to: [X_MEET, 1.5],
        color: MEET_COLOR,
        dashed: true,
      },
    ],
    readouts: [
      { label: 'P 位置', expr: P_X },
      { label: 'Q 位置', expr: Q_X },
      { label: 'PQ 距离', expr: PQ },
    ],
    steps: stepsAxis,
  };
}

/** 距离-时间图：V 形折线，最低点就是相遇 */
function sceneGraph(params: Record<string, number>): Scene {
  const t = params.t;
  return {
    meta: { title: '距离-时间图', subtitle: 'PQ = |10 − 4t|，V 形的底就是相遇' },
    view: { xMin: -0.4, xMax: 5.6, yMin: -0.9, yMax: 11.5 },
    params: [
      { name: 't', label: '时间 t（秒）', min: 0, max: 5, step: 0.02, value: t, slider: false },
    ],
    objects: [
      // —— 第二步 reveal：距离函数本身 ——
      {
        type: 'curve',
        id: 'curve',
        expr: PQ,
        domain: [0, 5],
        color: '#a78bfa',
      },
      // 当前时刻的竖直探针 + 动点
      { type: 'segment', id: 'probe', from: 't, 0', to: `t, ${PQ}`, color: '#64748b', dashed: true },
      { type: 'point', id: 'dot', at: `t, ${PQ}`, label: 'PQ', color: P_COLOR, glow: true },
      // —— 第三步 reveal：最低点标线 ——
      { type: 'segment', id: 'Tline', from: [T_MEET, -0.6], to: [T_MEET, 8], color: MEET_COLOR, dashed: true },
    ],
    readouts: [{ label: 'PQ 距离', expr: PQ }],
    steps: stepsGraph,
  };
}

// ---------------------------------------------------------------
// 步骤卡片缩略图（88×58 内联 SVG，数轴横贯中部）
// ---------------------------------------------------------------
const sx = (x: number) => 6 + ((x + 8) / 18) * 76;
const sy = (y: number) => 8 + (2.4 - y) * 9;

function thumb(extra: string): string {
  return `<svg viewBox="0 0 88 58" aria-hidden="true">
    <line x1="4" y1="${sy(0)}" x2="84" y2="${sy(0)}" stroke="#7f8db0" stroke-width="1" opacity=".55"/>
    ${extra}
  </svg>`;
}
const dot = (x: number, color: string, r = 2.4) =>
  `<circle cx="${sx(x)}" cy="${sy(0)}" r="${r}" fill="${color}"/>`;

export const NUMBER_LINE: CoursewareSpec = {
  id: 'number-line',
  subject: '初中数学',
  chapter: '数轴与动点',
  code: '探究案 02',
  title: '数轴双动点',
  subtitle: '两个动点同时出发，用 t 写下位置，让"相遇"变成一个方程',
  question: '出发后几秒，P 与 Q 相遇？相遇点在哪里？',
  hint: '"相遇"翻译成数学就是"两个坐标相等"。动点问题三步走：先用 t 写位置，再列等式，最后解出来代回验证——图上的 V 形最低点就是方程的解。',
  primary: { name: 't', label: '时间 t（秒）', min: 0, max: 5, step: 0.02 },
  params: { t: 0.3 },
  panes: [
    {
      key: 'axis',
      badge: '01',
      title: '数轴现场',
      hint: '拖动时间看两点运动',
      scene: sceneAxis,
    },
    {
      key: 'graph',
      badge: '03',
      title: '距离-时间图',
      hint: 'V 形的底就是相遇',
      scene: sceneGraph,
    },
  ],
  readouts: [
    { label: 'P 位置 (−4+3t)', expr: P_X, barMax: 14, color: P_COLOR },
    { label: 'Q 位置 (6−t)', expr: Q_X, barMax: 14, color: Q_COLOR },
    { label: 'PQ 距离 |10−4t|', expr: PQ, barMax: 12, color: '#a78bfa' },
    { label: '相遇时刻', expr: String(T_MEET), barMax: 6, color: MEET_COLOR },
  ],
  steps: [
    {
      no: '1',
      title: '读题',
      caption: '两个起点 · 两个方向',
      params: { t: 0.3 },
      thumb: thumb(`${dot(-4, '#93c5fd')}${dot(6, '#93c5fd')}${dot(-3.1, P_COLOR)}${dot(5.7, Q_COLOR)}`),
    },
    {
      no: '2',
      title: '用 t 表示',
      caption: 'P=−4+3t，Q=6−t',
      params: { t: 1.6 },
      thumb: thumb(`${dot(-4, '#93c5fd')}${dot(6, '#93c5fd')}${dot(0.8, P_COLOR)}${dot(4.4, Q_COLOR)}<line x1="${sx(0.8)}" y1="${sy(0)}" x2="${sx(4.4)}" y2="${sy(0)}" stroke="#a78bfa" stroke-width="1.4"/>`),
    },
    {
      no: '3',
      title: '建立方程',
      caption: '相遇 ⇔ PQ = 0',
      params: { t: 2.1 },
      thumb: thumb(`${dot(-4, '#93c5fd')}${dot(6, '#93c5fd')}${dot(2.3, P_COLOR)}${dot(3.9, Q_COLOR)}<line x1="${sx(2.3)}" y1="${sy(0)}" x2="${sx(3.9)}" y2="${sy(0)}" stroke="#a78bfa" stroke-width="1.4"/><line x1="${sx(3.5)}" y1="${sy(1.5)}" x2="${sx(3.5)}" y2="${sy(0)}" stroke="#34d399" stroke-width="1" stroke-dasharray="2 2"/>`),
    },
    {
      no: '4',
      title: '解与验证',
      caption: 't=2.5，相遇于 3.5',
      params: { t: T_MEET },
      thumb: thumb(`${dot(-4, '#93c5fd')}${dot(6, '#93c5fd')}${dot(X_MEET, MEET_COLOR, 3)}<line x1="${sx(3.5)}" y1="${sy(1.5)}" x2="${sx(3.5)}" y2="${sy(0)}" stroke="#34d399" stroke-width="1" stroke-dasharray="2 2"/>`),
    },
  ],
  duration: 22,
  captions: [
    { at: 0, text: 'P 从 A 向右每秒 3 格，Q 从 B 向左每秒 1 格，同时出发。' },
    { at: 5, text: '用 t 表示位置：P = −4+3t，Q = 6−t。' },
    { at: 10, text: '距离 |10−4t| 先减后增——最低点意味着什么？' },
    { at: 15, text: '令 PQ = 0：t = 2.5 秒相遇，相遇点 x = 3.5。' },
  ],
  track: (t: number) => {
    // 0–5 秒：讲情境，两点各走一小步
    if (t < 5) return { params: { t: 0.3 + t * 0.05 }, step: 0 };
    // 5–11 秒：t 从 0 扫到 5，完整看一遍"接近—贴住—越过"
    if (t < 11) {
      const k = easeInOut((t - 5) / 6);
      return { params: { t: k * 5 }, step: 1 };
    }
    // 11–15 秒：慢放逼近相遇，让"贴住"的瞬间被看清
    if (t < 15) {
      const k = easeInOut((t - 11) / 4);
      return { params: { t: 1.2 + k * (T_MEET - 1.2) }, step: 2 };
    }
    // 15 秒后：停在相遇点，等方程的结论
    return { params: { t: T_MEET }, step: 3 };
  },
  best: { t: T_MEET },
  bestNote: 't = 2.5 秒相遇，相遇点 x = 3.5（此刻 P = Q）',
};

/** 三次缓入缓出：自动演示用，比线性自然 */
function easeInOut(k: number): number {
  const x = Math.min(1, Math.max(0, k));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
