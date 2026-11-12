/**
 * antCylinder.ts —— 课件 03：蚂蚁爬圆柱（初中数学 · 展开与勾股）
 *
 * 题目：圆柱底面半径 r、高 h=4。蚂蚁从下底面圆上的 A 点出发，
 *       沿侧面爬到上底面圆上的 B 点（B 在 A 的正对面，绕了半圈）。
 *       求最短路程。
 * 教学结构（四个视图动作）：
 *   ① 情境      ：3D 圆柱 + 蚂蚁的起点终点。"绕半圈还得往上爬"——凭直觉比划不出最短路
 *   ② 侧面展开 ：把侧面剪开摊平成矩形：宽 = 半周长 πr，高 = h。曲面上的"最短"
 *              在平面上就是两点连线——螺旋线变成对角线
 *   ③ 勾股定理 ：宽和高是直角边，最短路是斜边
 *   ④ 结论     ：L = √((πr)² + h²)，拖 r 看最短路怎么跟着变
 *
 * ===== 为什么用 24 段折线模拟螺旋线，而不是给渲染器加"螺旋线对象" =====
 * 螺旋线只在这一个课件里出现；为它给 Scene3D 协议加类型、给渲染器加
 * 采样逻辑，是一笔只有一次使用的架构债。24 段 edge3 的采样数据由本文件
 * 循环生成，协议和渲染器零改动——数据层能表达的事就不动协议层。
 *
 * ===== 为什么 3D pane 没有可拖点 =====
 * 这道题的自由度是 r，它同时驱动 3D 圆柱和 2D 展开图；拖拽的自然落点
 * 是底部滑杆。3D 视图保持"轨道旋转"（拖拽转视角，那是 Scene3DRenderer
 * 自带的能力），教学注意力放在"展开"这件事上。
 */
import type { Scene, StepDef } from '../protocol/scene';
import type { Scene3D } from '../protocol/scene3d';
import type { CoursewareSpec } from './spec';

const H = 4;
const P_COLOR = '#ea580c';
const CYL_COLOR = '#38bdf8';
const SPIRAL_COLOR = '#ea580c';
const MEET_COLOR = '#34d399';

/** 半周长 πr（表达式引擎里 PI 就是 Math.PI） */
const ARC = 'PI * r';
/** 最短路程 L = √((πr)² + h²) */
const L_EXPR = `sqrt((PI * r)^2 + ${H * H})`;

/**
 * 螺旋线采样：从 A(r,0,0) 绕半圈到 B(−r,0,h)。
 * 25 个隐藏点 + 24 条棱；θ 从 0 匀速到 π，z 从 0 匀速到 h。
 */
function spiral(): { points: string[]; edges: { a: string; b: string }[] } {
  const N = 24;
  const ids: string[] = [];
  for (let i = 0; i <= N; i++) ids.push(`sp${i}`);
  const edges = [];
  for (let i = 0; i < N; i++) edges.push({ a: `sp${i}`, b: `sp${i + 1}` });
  return { points: ids, edges };
}

const { points: SP_IDS, edges: SP_EDGES } = spiral();

const stepsScene3d: StepDef[] = [
  {
    title: '情境',
    text: '蚂蚁在 $A$ 点，要去正对面的 $B$ 点：绕半圈 + 爬一层高。哪条路最短？',
    highlight: ['cyl', 'A', 'B'],
  },
  {
    title: '侧面展开',
    text: '把侧面剪开摊平——曲面上那条"最短路"就是右图展开矩形里的对角线。',
    reveal: SP_EDGES.map((_, i) => `seg${i}`),
    highlight: ['spiral'],
  },
  {
    title: '勾股定理',
    text: '展开后：宽 $\\pi r$、高 $h$，对角线就是斜边。',
    highlight: ['spiral'],
  },
  {
    title: '结论',
    text: '最短路程 $L=\\sqrt{(\\pi r)^2+h^2}$。拖动 r，看最短路怎么变。',
    highlight: ['spiral', 'A', 'B'],
  },
];

const stepsFlat: StepDef[] = [
  {
    title: '情境',
    text: '先记住 3D 图里的 A 和 B——下一步把圆柱侧面摊平，它们的位置不变。',
    highlight: ['A', 'B'],
  },
  {
    title: '侧面展开',
    text: '侧面展开是矩形：宽 = 半周长 $\\pi r$，高 = $h$。曲面上的螺旋线变成平面对角线。',
    reveal: ['rect', 'diag'],
    highlight: ['rect', 'diag'],
  },
  {
    title: '勾股定理',
    text: '两条直角边：宽 $\\pi r$ 和高 $h$；斜边就是最短路程。',
    reveal: ['legW', 'legH'],
    highlight: ['legW', 'legH', 'diag'],
  },
  {
    title: '结论',
    text: '$L=\\sqrt{(\\pi r)^2+16}$。拖动 r：宽变了，斜边跟着变——勾股定理在动。',
    highlight: ['diag'],
  },
];

/** 3D 视图：圆柱 + 起终点 + 螺旋线（最短路的曲面形态） */
function sceneCylinder(params: Record<string, number>): Scene3D {
  const r = params.r;
  return {
    space: '3d',
    meta: { title: '圆柱情境', subtitle: '蚂蚁从 A 爬到正对面的 B' },
    params: [
      { name: 'r', label: '底面半径 r', min: 0.6, max: 1.6, step: 0.02, value: r, slider: false },
    ],
    camera: { azimuth: 38, elevation: 16, distance: 10.5 },
    axes: true,
    objects: [
      { type: 'cylinder3', id: 'cyl', a: '0, 0, 0', b: `0, 0, ${H}`, radius: 'r', color: CYL_COLOR, opacity: 0.16 },
      { type: 'point3', id: 'A', at: 'r, 0, 0', label: 'A', color: MEET_COLOR },
      { type: 'point3', id: 'B', at: `-r, 0, ${H}`, label: 'B', color: MEET_COLOR },
      // 螺旋线：24 段棱（引用隐藏采样点），第三步前的"谜面"
      ...SP_IDS.map((id, i) => ({
        type: 'point3' as const,
        id,
        at: atOf(i),
        hidden: true,
      })),
      ...SP_EDGES.map((e, i) => ({
        type: 'edge3' as const,
        id: `seg${i}`,
        a: e.a,
        b: e.b,
        color: SPIRAL_COLOR,
      })),
    ],
    readouts: [
      { label: '半周长 πr', expr: ARC },
      { label: '柱高 h', expr: String(H) },
      { label: '最短路程 L', expr: L_EXPR },
    ],
    steps: stepsScene3d,
  };
}

/** 第 i 个采样点的坐标表达式（与 spiral() 的 ids 一一对应） */
function atOf(i: number): string {
  const N = 24;
  const th = (Math.PI * i) / N;
  const z = (H * i) / N;
  return `r*cos(${th.toFixed(4)}), r*sin(${th.toFixed(4)}), ${z.toFixed(3)}`;
}

/** 展开图：矩形 + 对角线，勾股的三条边都在这张图上 */
function sceneFlat(params: Record<string, number>): Scene {
  const r = params.r;
  return {
    meta: { title: '侧面展开图', subtitle: '宽 πr，高 h，对角线就是最短路' },
    view: { xMin: -0.9, xMax: 5.7, yMin: -0.9, yMax: 4.9 },
    params: [
      { name: 'r', label: '底面半径 r', min: 0.6, max: 1.6, step: 0.02, value: r, slider: false },
    ],
    objects: [
      // —— 第二步 reveal：矩形与对角线 ——
      {
        type: 'polygon',
        id: 'rect',
        points: [
          [0, 0],
          ['PI*r', 0],
          ['PI*r', H],
          [0, H],
        ],
        fill: true,
        fillOpacity: 0.35,
        color: '#155e75',
      },
      { type: 'segment', id: 'diag', from: [0, 0], to: ['PI*r', H], color: P_COLOR, glow: true },
      { type: 'point', id: 'A', at: [0, 0], label: 'A', color: MEET_COLOR, glow: true },
      { type: 'point', id: 'B', at: ['PI*r', H], label: 'B', color: MEET_COLOR, glow: true },
      // —— 第三步 reveal：勾股的两条直角边 ——
      { type: 'segment', id: 'legW', from: [0, 0], to: ['PI*r', 0], color: '#a78bfa' },
      { type: 'segment', id: 'legH', from: ['PI*r', 0], to: ['PI*r', H], color: '#22d3ee' },
    ],
    readouts: [
      { label: '宽 πr', expr: ARC },
      { label: '高 h', expr: String(H) },
      { label: '斜边 L', expr: L_EXPR },
    ],
    steps: stepsFlat,
  };
}

// ---------------------------------------------------------------
// 步骤卡片缩略图（88×58 内联 SVG）
// ---------------------------------------------------------------
function thumbCyl(spiralOn: boolean): string {
  const cxs = [44, 44];
  return `<svg viewBox="0 0 88 58" aria-hidden="true">
    <ellipse cx="${cxs[0]}" cy="14" rx="16" ry="5" fill="none" stroke="#38bdf8" stroke-width="1"/>
    <line x1="28" y1="14" x2="28" y2="44" stroke="#38bdf8" stroke-width="1"/>
    <line x1="60" y1="14" x2="60" y2="44" stroke="#38bdf8" stroke-width="1"/>
    <ellipse cx="44" cy="44" rx="16" ry="5" fill="none" stroke="#38bdf8" stroke-width="1"/>
    ${
      spiralOn
        ? `<path d="M 60 44 C 72 36, 16 28, 28 14" fill="none" stroke="#ea580c" stroke-width="1.4"/>`
        : ''
    }
    <circle cx="60" cy="44" r="2.2" fill="#34d399"/><circle cx="28" cy="14" r="2.2" fill="#34d399"/>
  </svg>`;
}

function thumbFlat(diag: boolean, legs: boolean): string {
  return `<svg viewBox="0 0 88 58" aria-hidden="true">
    <rect x="20" y="12" width="44" height="30" fill="rgba(21,94,117,.25)" stroke="#38bdf8" stroke-width="1"/>
    ${diag ? `<line x1="20" y1="42" x2="64" y2="12" stroke="#ea580c" stroke-width="1.4"/>` : ''}
    ${legs ? `<line x1="20" y1="46" x2="64" y2="46" stroke="#a78bfa" stroke-width="1"/><line x1="68" y1="12" x2="68" y2="42" stroke="#22d3ee" stroke-width="1"/>` : ''}
    <circle cx="20" cy="42" r="2.2" fill="#34d399"/><circle cx="64" cy="12" r="2.2" fill="#34d399"/>
  </svg>`;
}

export const ANT_CYLINDER: CoursewareSpec = {
  id: 'ant-cylinder',
  subject: '初中数学',
  chapter: '展开与勾股',
  code: '探究案 03',
  title: '蚂蚁爬圆柱',
  subtitle: '把圆柱侧面摊平，让曲面上的"最短"变成平面上的"两点连线"',
  question: '蚂蚁绕半圈爬到正对面，最短要走多远？',
  hint: '"曲面上的最短"没法直接想，但摊平了就是"两点之间线段最短"。凡是圆柱/圆锥侧面上的路径问题，先展开——勾股定理会把答案直接送到你手上。',
  primary: { name: 'r', label: '底面半径 r', min: 0.6, max: 1.6, step: 0.02 },
  params: { r: 1 },
  panes: [
    {
      key: 'cyl',
      badge: '01',
      title: '圆柱情境',
      hint: '拖拽旋转视角，滑杆改半径',
      kind: '3d',
      scene: sceneCylinder,
    },
    {
      key: 'flat',
      badge: '03',
      title: '侧面展开图',
      hint: '曲面最短 → 平面直线',
      scene: sceneFlat,
    },
  ],
  readouts: [
    { label: '半周长 πr', expr: ARC, barMax: 6, color: '#38bdf8' },
    { label: '柱高 h', expr: String(H), barMax: 6, color: '#22d3ee' },
    { label: '最短路程 L', expr: L_EXPR, barMax: 8, color: P_COLOR },
  ],
  steps: [
    {
      no: '1',
      title: '情境',
      caption: '绕半圈，还要爬一层',
      params: { r: 1 },
      thumb: thumbCyl(false),
    },
    {
      no: '2',
      title: '侧面展开',
      caption: '螺旋线变成对角线',
      params: { r: 1 },
      thumb: thumbFlat(true, false),
    },
    {
      no: '3',
      title: '勾股定理',
      caption: '宽 πr，高 h，斜边 L',
      params: { r: 1.2 },
      thumb: thumbFlat(true, true),
    },
    {
      no: '4',
      title: '结论',
      caption: 'L = √((πr)² + h²)',
      params: { r: 1 },
      thumb: thumbFlat(false, true),
    },
  ],
  duration: 24,
  captions: [
    { at: 0, text: '蚂蚁在 A，要去正对面的 B：绕半圈，还要往上爬 4。' },
    { at: 6, text: '把侧面剪开摊平：宽是半周长 πr，高是 h。' },
    { at: 12, text: '曲面上的最短，摊平后就是矩形的对角线。' },
    { at: 18, text: '勾股定理：L = √((πr)² + h²)。拖动 r 试试。' },
  ],
  track: (t: number) => {
    // 0–6 秒：讲情境，圆柱转着看（r 不动，视角由用户/默认相机）
    if (t < 6) return { params: { r: 1 }, step: 0 };
    // 6–12 秒：r 扫描——展开图上矩形变宽变窄，对角线跟着摆
    if (t < 12) {
      const k = easeInOut((t - 6) / 6);
      return { params: { r: 0.6 + k * 1.0 }, step: 1 };
    }
    // 12–18 秒：回到 r=1.2，勾股三条边齐了
    if (t < 18) {
      const k = easeInOut((t - 12) / 3);
      return { params: { r: 1.6 - k * 0.4 }, step: 2 };
    }
    // 18 秒后：结论，r 回到 1
    const k = easeInOut(Math.min(1, (t - 18) / 3));
    return { params: { r: 1.2 - k * 0.2 }, step: 3 };
  },
};

/** 三次缓入缓出：自动演示用，比线性自然 */
function easeInOut(k: number): number {
  const x = Math.min(1, Math.max(0, k));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
