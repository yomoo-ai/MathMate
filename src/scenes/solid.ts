/**
 * solid.ts —— 立体几何演示场景（正方体 / 正四面体 / 旋转体）
 *
 * 这几个场景的作用不是"好看"，是**验证 3D 渲染管线的能力**：
 *   1. 透视与取景：尺寸大改时画面不能被裁掉；
 *   2. 遮挡虚线：转到任何角度，背面棱/椭圆都该是虚线；
 *   3. 自由棱（体对角线）：没有邻接面，走射线求交判断；
 *   4. 旋转体：椭圆 + 母线，虚实分界点随视角连续变化。
 *
 * 坐标约定：数学坐标 (x 右, y 向里, z 向上)，与课本一致。
 * 底面放在 z = 0 平面上，这样"高"读起来就是 z。
 */

import type { Scene3D, Scene3DObject } from '../protocol/scene3d';
import { resolveScene3D } from '../protocol/resolve3d';

export const cubeDefaults = { a: 2 };

export function buildCube(params: Record<string, number>): Scene3D {
  const a = params.a ?? 2;

  // 底面 A B C D（逆时针），顶面 A1 B1 C1 D1
  const coords: Record<string, [number, number, number]> = {
    A: [0, 0, 0],
    B: [a, 0, 0],
    C: [a, a, 0],
    D: [0, a, 0],
    A1: [0, 0, a],
    B1: [a, 0, a],
    C1: [a, a, a],
    D1: [0, a, a],
  };

  const objects: Scene3DObject[] = [];

  for (const [id, p] of Object.entries(coords)) {
    objects.push({ id, type: 'point3', label: id, at: p });
  }

  // 六个面（半透明）。顶点顺序无所谓——渲染器按形心判朝向，不依赖绕序
  const faceDefs = [
    ['A', 'B', 'C', 'D'],
    ['A1', 'B1', 'C1', 'D1'],
    ['A', 'B', 'B1', 'A1'],
    ['B', 'C', 'C1', 'B1'],
    ['C', 'D', 'D1', 'C1'],
    ['D', 'A', 'A1', 'D1'],
  ];
  for (const [i, pts] of faceDefs.entries()) {
    objects.push({ id: `f${i}`, type: 'face3', points: pts, opacity: 0.45 });
  }

  const edgePairs: [string, string][] = [
    ['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A'],
    ['A1', 'B1'], ['B1', 'C1'], ['C1', 'D1'], ['D1', 'A1'],
    ['A', 'A1'], ['B', 'B1'], ['C', 'C1'], ['D', 'D1'],
  ];
  for (const [i, [x, y]] of edgePairs.entries()) {
    objects.push({ id: `e${i}`, type: 'edge3', a: x, b: y });
  }

  // 体对角线：两侧没有面，走射线求交判断。它穿过实体内部，应该永远是虚线。
  // 特意选 A₁C 而不是 AC₁——AC₁ 的一端 A 在默认视角下正好被挡在图形内部，
  // 标签会和 C₁ 挤在一起。A₁ 和 C 都在外轮廓上，两端都清楚。
  objects.push({ id: 'diag', type: 'edge3', a: 'A1', b: 'C' });

  // 演示场景也走同一条补全流程（resolveScene3D）：
  // 这样 readouts 里能直接写 dist3(A,B)，和 LLM 生成的场景行为完全一致
  return resolveScene3D({
    space: '3d',
    meta: {
      title: '正方体 ABCD-A₁B₁C₁D₁',
      subtitle: `棱长 ${a.toFixed(2)} · 拖动可旋转 · 体对角线 A₁C 在内部（虚线）· 空间对角线长 ${(a * Math.sqrt(3)).toFixed(2)}`,
    },
    params: [
      { name: 'a', label: '棱长 a', min: 0.6, max: 4, step: 0.1, value: 2 },
    ],
    camera: { azimuth: 32, elevation: 16 },
    objects,
    readouts: [
      { label: 'AB', expr: 'dist3(A,B)' },
      { label: 'AC₁（体对角线）', expr: 'dist3(A,C1)' },
    ],
    constraints: [
      { type: 'equal-length', a: ['A', 'B'], b: ['B', 'C'] },
      { type: 'equal-length', a: ['A', 'B'], b: ['A', 'A1'] },
      { type: 'perp-lines', a: ['A', 'B'], b: ['A', 'A1'] },
      { type: 'coplanar', points: ['A', 'B', 'C', 'D'] },
    ],
  });
}

export const tetraDefaults = { a: 2.4 };

export function buildTetra(params: Record<string, number>): Scene3D {
  const a = params.a ?? 2.4;
  // 正四面体：底面等边三角形边长 a，顶点在重心正上方
  const h = a * Math.sqrt(2 / 3);

  const coords: Record<string, [number, number, number]> = {
    A: [0, 0, 0],
    B: [a, 0, 0],
    C: [a / 2, (a * Math.sqrt(3)) / 2, 0],
    S: [a / 2, (a * Math.sqrt(3)) / 6, h],
  };

  const objects: Scene3DObject[] = [];
  for (const [id, p] of Object.entries(coords)) {
    objects.push({ id, type: 'point3', label: id, at: p });
  }

  for (const [i, pts] of [
    ['A', 'B', 'C'],
    ['A', 'B', 'S'],
    ['B', 'C', 'S'],
    ['C', 'A', 'S'],
  ].entries()) {
    objects.push({ id: `f${i}`, type: 'face3', points: pts as string[], opacity: 0.45 });
  }

  for (const [i, [x, y]] of [
    ['A', 'B'], ['B', 'C'], ['C', 'A'],
    ['A', 'S'], ['B', 'S'], ['C', 'S'],
  ].entries()) {
    objects.push({ id: `e${i}`, type: 'edge3', a: x as string, b: y as string });
  }

  // 高（从 S 到底面重心）：辅助线，强制虚线。
  // G 用 derive 的重心算——演示场景也要用"让程序算"的写法，
  // 否则演示和生成出来的场景是两套做法，容易误导
  objects.push({ id: 'G', type: 'point3', derive: { kind: 'centroid', points: ['A', 'B', 'C'] }, color: '#a32d2d' });
  objects.push({
    id: 'h',
    type: 'edge3',
    a: 'S',
    b: 'G',
    dashed: true,
    color: '#a32d2d',
  });

  return resolveScene3D({
    space: '3d',
    meta: {
      title: '正四面体 S-ABC',
      subtitle: `棱长 ${a.toFixed(2)} · 高 h = a·√(2/3) = ${h.toFixed(2)} · 红色虚线为高 SO`,
    },
    params: [
      { name: 'a', label: '棱长 a', min: 1, max: 5, step: 0.1, value: 2.4 },
    ],
    camera: { azimuth: 42, elevation: 16 },
    objects,
    readouts: [
      { label: 'SA', expr: 'dist3(S,A)' },
      { label: '高 SG', expr: 'dist3(S,G)' },
      { label: 'S△ABC', expr: 'area3(A,B,C)' },
    ],
    constraints: [
      { type: 'equal-length', a: ['S', 'A'], b: ['S', 'B'] },
      { type: 'equal-length', a: ['S', 'B'], b: ['S', 'C'] },
      { type: 'perp-lines', a: ['S', 'G'], b: ['A', 'B'] },
      { type: 'coplanar', points: ['A', 'B', 'C', 'G'] },
    ],
  });
}

/* ================================================================
 * 旋转体：圆柱 / 圆锥 / 球
 *
 * 这一组存在的理由很具体：之前"画一个半径为 2 高为 4 的圆柱"会出棱柱，
 * 因为协议里没有曲面对象，prompt 让模型"用 12 棱柱近似"。
 * 现在有了 cylinder3 / cone3 / sphere3，这几个演示就是渲染层的验收样本。
 * ================================================================ */

export const cylinderDefaults = { r: 2, h: 4 };

export function buildCylinder(params: Record<string, number>): Scene3D {
  const r = params.r ?? 2;
  const h = params.h ?? 4;

  const objects: Scene3DObject[] = [
    { id: 'O', type: 'point3', label: 'O', at: [0, 0, 0] },
    { id: 'O1', type: 'point3', label: 'O₁', at: [0, 0, h] },
    // 轴端点用顶点 id：这样 O、O₁ 能标字母，也能被 readouts 和约束引用
    { id: 'cyl', type: 'cylinder3', a: 'O', b: 'O1', radius: 'r', opacity: 0.2 },
    // 轴：在实体内部，永远虚线
    { id: 'axis', type: 'edge3', a: 'O', b: 'O1', dashed: true, color: '#a32d2d' },
  ];

  return resolveScene3D({
    space: '3d',
    meta: {
      title: '圆柱 OO₁',
      subtitle: `底面半径 r = ${r.toFixed(2)} · 高 h = ${h.toFixed(2)} · 拖动可旋转`,
    },
    params: [
      { name: 'r', label: '底面半径 r', min: 0.4, max: 3, step: 0.1, value: 2 },
      { name: 'h', label: '高 h', min: 0.5, max: 6, step: 0.1, value: 4 },
    ],
    camera: { azimuth: 26, elevation: 14 },
    objects,
    readouts: [
      { label: '高 OO₁', expr: 'dist3(O,O1)' },
      { label: '底面积 S底', expr: 'PI * r^2' },
      { label: '侧面积 S侧', expr: '2 * PI * r * h' },
      { label: '体积 V', expr: 'PI * r^2 * h' },
    ],
    constraints: [{ type: 'value', expr: 'dist3(O,O1)', equals: h }],
    // 两步足够验证曲面在分步里的行为：高亮（其余压暗）+ 渐显（轴一开始藏起来）
    steps: [
      {
        title: '看形状',
        text: '圆柱由两个全等的底面圆和一个侧面围成。侧面展开是一个矩形，宽是底面周长 $2\\pi r$，高是 $h$。',
        highlight: ['cyl'],
      },
      {
        title: '找高',
        text: '两个底面圆心的连线 $OO_1$ 就是圆柱的轴，它的长就是高 $h$。轴在实体内部，所以画成虚线。',
        highlight: ['O1', 'axis'],
        reveal: ['O1', 'axis'],
      },
    ],
  });
}

export const revDefaults = { r: 1.6, h: 3 };

/** 圆锥 + 球放在同一个场景里：顺便验证"一个场景多个旋转体" */
export function buildRevolution(params: Record<string, number>): Scene3D {
  const r = params.r ?? 1.6;
  const h = params.h ?? 3;

  const objects: Scene3DObject[] = [
    { id: 'O', type: 'point3', label: 'O', at: [0, 0, 0] },
    { id: 'P', type: 'point3', label: 'P', at: [0, 0, h] },
    {
      id: 'cone',
      type: 'cone3',
      apex: 'P',
      base: 'O',
      radius: 'r',
      opacity: 0.2,
    },
    { id: 'PO', type: 'edge3', a: 'P', b: 'O', dashed: true, color: '#a32d2d' },
    // 球：圆心写坐标，验证"坐标写法"这条分支
    { id: 'S', type: 'point3', label: 'O′', at: [4.2, 0, r] },
    { id: 'ball', type: 'sphere3', center: 'S', radius: 'r', opacity: 0.18 },
  ];

  return resolveScene3D({
    space: '3d',
    meta: {
      title: '圆锥 PO 与球 O′',
      subtitle: `底面半径 r = ${r.toFixed(2)} · 圆锥高 h = ${h.toFixed(2)} · 红色虚线为轴`,
    },
    params: [
      { name: 'r', label: '半径 r', min: 0.5, max: 2.5, step: 0.1, value: 1.6 },
      { name: 'h', label: '圆锥高 h', min: 1, max: 5, step: 0.1, value: 3 },
    ],
    camera: { azimuth: 30, elevation: 14 },
    objects,
    readouts: [
      { label: '母线 l', expr: 'sqrt(r^2 + h^2)' },
      { label: '圆锥体积', expr: 'PI * r^2 * h / 3' },
      { label: '球体积', expr: '4/3 * PI * r^3' },
    ],
    constraints: [{ type: 'value', expr: 'dist3(P,O)', equals: h }],
  });
}

/* ================================================================
 * 三棱锥 V-ABC 的外接球与内切球
 *
 * 这一组是为了用户真机跑挂的那道题建的：
 *   三棱锥 V-ABC 中，VA⊥底面 ABC，∠BAC = 90°，AB = AC = AV = 2，
 *   求内切球半径与外接球半径之和。
 *
 * 之前这张图只能画出棱锥，球一个都没有——原因不是渲染器不会画球，
 * 而是**模型算不出球心**：外接球心要解 3×3 方程组，内心要按对面面积加权，
 * 手写坐标必错，模型索性把球省掉。
 * 现在球心交给 derive 的 circumcenter / incenter，半径交给 circumR3 / inR3，
 * 都变成程序现算的表达式，滑杆拖动也跟着变。
 *
 * 顺带这也是"墙角模型"的标准摆法：A 为原点，AB、AC、AV 正好压在三条坐标轴上，
 * 所以坐标轴一开，"三条棱两两垂直"就是看一眼的事。
 * ================================================================ */

export const tetraSpheresDefaults = { a: 2 };

export function buildTetraSpheres(params: Record<string, number>): Scene3D {
  const a = params.a ?? 2;

  const objects: Scene3DObject[] = [
    // 墙角：三条棱分别沿 x、y、z 轴
    { id: 'A', type: 'point3', label: 'A', at: [0, 0, 0] },
    { id: 'B', type: 'point3', label: 'B', at: [a, 0, 0] },
    { id: 'C', type: 'point3', label: 'C', at: [0, a, 0] },
    { id: 'V', type: 'point3', label: 'V', at: [0, 0, a] },

    { id: 'fABC', type: 'face3', points: ['A', 'B', 'C'], opacity: 0.34 },
    { id: 'fVAB', type: 'face3', points: ['V', 'A', 'B'], opacity: 0.3 },
    { id: 'fVAC', type: 'face3', points: ['V', 'A', 'C'], opacity: 0.3 },
    { id: 'fVBC', type: 'face3', points: ['V', 'B', 'C'], opacity: 0.3 },

    { id: 'AB', type: 'edge3', a: 'A', b: 'B' },
    { id: 'BC', type: 'edge3', a: 'B', b: 'C' },
    { id: 'CA', type: 'edge3', a: 'C', b: 'A' },
    { id: 'VA', type: 'edge3', a: 'V', b: 'A' },
    { id: 'VB', type: 'edge3', a: 'V', b: 'B' },
    { id: 'VC', type: 'edge3', a: 'V', b: 'C' },

    // 两个球心：坐标由程序解出来，这里只声明"它是这四个点的外心/内心"
    {
      id: 'O',
      type: 'point3',
      label: 'O',
      derive: { kind: 'circumcenter', points: ['A', 'B', 'C', 'V'] },
      color: '#3a62a8',
    },
    {
      id: 'I',
      type: 'point3',
      label: 'I',
      derive: { kind: 'incenter', points: ['A', 'B', 'C', 'V'] },
      color: '#a32d2d',
    },

    // 外接球把整个棱锥包在里面，所以填充要极淡；不淡就只剩一团色块
    {
      id: 'ballOut',
      type: 'sphere3',
      center: 'O',
      radius: 'circumR3(A,B,C,V)',
      opacity: 0.06,
      color: '#3a62a8',
    },
    // 内切球在内部，与四个面都相切，可以稍浓一点
    {
      id: 'ballIn',
      type: 'sphere3',
      center: 'I',
      radius: 'inR3(A,B,C,V)',
      opacity: 0.22,
      color: '#a32d2d',
    },
  ];

  return resolveScene3D({
    space: '3d',
    meta: {
      title: '三棱锥 V-ABC 的内切球与外接球',
      subtitle: `VA⊥底面 · ∠BAC = 90° · AB = AC = AV = ${a.toFixed(2)} · 蓝色外接球，红色内切球`,
    },
    params: [{ name: 'a', label: '侧棱长 a', min: 1, max: 4, step: 0.1, value: 2 }],
    camera: { azimuth: 32, elevation: 16 },
    objects,
    readouts: [
      { label: '外接球半径 R', expr: 'circumR3(A,B,C,V)' },
      { label: '内切球半径 r', expr: 'inR3(A,B,C,V)' },
      { label: 'R + r', expr: 'circumR3(A,B,C,V) + inR3(A,B,C,V)' },
    ],
    constraints: [
      { type: 'value', expr: 'dist3(A,B)', equals: a },
      { type: 'value', expr: 'dist3(A,V)', equals: a },
      { type: 'perp-lines', a: ['V', 'A'], b: ['A', 'B'] },
      { type: 'perp-lines', a: ['V', 'A'], b: ['A', 'C'] },
      { type: 'perp-lines', a: ['A', 'B'], b: ['A', 'C'] },
    ],
    steps: [
      {
        title: '把直角放到原点上',
        text: 'VA⊥底面 ABC，而 ∠BAC = 90°，所以 $AB$、$AC$、$AV$ 三条棱**两两垂直**。以 A 为原点，它们正好落在三条坐标轴上。',
        highlight: ['AB', 'AC', 'VA'],
      },
      {
        title: '外接球：补成长方体',
        text: '三条两两垂直的棱能补成一个长方体，它的体对角线就是外接球的直径：$2R=\\sqrt{AB^2+AC^2+AV^2}=\\sqrt{12}=2\\sqrt3$，所以 $R=\\sqrt3$。球心 O 由程序按"到四点等距"算出。',
        highlight: ['ballOut', 'O'],
      },
      {
        title: '内切球：等体积法',
        text: '$V=\\dfrac13\\cdot\\dfrac12\\cdot2\\cdot2\\cdot2=\\dfrac43$；四个面的面积依次是 $2,2,2,2\\sqrt3$，总和 $S=6+2\\sqrt3$。由 $r=\\dfrac{3V}{S}$ 得 $r=\\dfrac{3-\\sqrt3}{3}$。',
        highlight: ['ballIn', 'I'],
      },
      {
        title: '求和',
        text: '$R+r=\\sqrt3+\\dfrac{3-\\sqrt3}{3}=\\dfrac{3+2\\sqrt3}{3}\\approx2.15$，选 D。',
        highlight: ['ballOut', 'ballIn'],
      },
    ],
  });
}

/* ================================================================
 * 平面斜切圆柱 → 椭圆
 *
 * 这是为了「旋转体斜截面」建的第一个演示：圆柱底面半径 r、高 h，
 * 一个与轴成 60° 的平面过轴上中点 M，交线是一个椭圆。
 *
 * 交线（椭圆）和半透明平面都由程序算——截面是三次方程的根，
 * 手写圆周点几乎必错，这正是"模型声明关系、程序负责计算"的又一处。
 * 与轴成 60° 的写法：法向量的 z 分量占比 = sin60° = √3/2，
 * 所以 normal 取 [1, 0, sqrt(3)]（|n| = 2）。
 * ================================================================ */

export const cylSectionDefaults = { r: 2, h: 6 };

export function buildCylSection(params: Record<string, number>): Scene3D {
  const r = params.r ?? 2;
  const h = params.h ?? 6;
  const alpha = 60; // 平面与轴的夹角（度）
  // 半长轴 = r/sin60°，半短轴 = r，面积 = π·a·b —— 都由程序从图上量出来
  const objects: Scene3DObject[] = [
    { id: 'O', type: 'point3', label: 'O', at: [0, 0, 0] },
    { id: 'O1', type: 'point3', label: "O'", at: [0, 0, 'h'] },
    // M：平面穿过的轴上点（半高）
    { id: 'M', type: 'point3', label: 'M', at: [0, 0, 'h/2'], color: '#8a3f6b' },
    { id: 'Q', type: 'point3', label: 'Q', at: ['r', 0, 0] },

    { id: 'cyl', type: 'cylinder3', a: 'O', b: 'O1', radius: 'r', opacity: 0.16 },
    {
      id: 'sec',
      type: 'section3',
      label: 'α',
      cut: 'cyl',
      p: 'M',
      normal: [1, 0, 'sqrt(3)'],
    },

    { id: 'OM', type: 'edge3', a: 'O', b: 'M', dashed: true },
  ];

  return resolveScene3D({
    space: '3d',
    meta: {
      title: '平面斜截圆柱',
      subtitle: `底面半径 ${r.toFixed(2)} · 高 ${h.toFixed(2)} · 平面 α 过轴上中点 M，与轴成 ${alpha}°`,
    },
    params: [
      { name: 'r', label: '底面半径 r', min: 1, max: 3, step: 0.1, value: 2 },
      { name: 'h', label: '高 h', min: 4, max: 8, step: 0.2, value: 6 },
    ],
    camera: { azimuth: 38, elevation: 14 },
    objects,
    readouts: [
      { label: '半长轴 a = r/sin60°', expr: 'secA3(sec)' },
      { label: '半短轴 b = r', expr: 'secB3(sec)' },
      { label: '截面面积 πab', expr: 'secArea3(sec)' },
    ],
    constraints: [
      { type: 'value', expr: 'dist3(O,O1)', equals: h },
      { type: 'on-segment', p: 'M', ends: ['O', 'O1'] },
    ],
    steps: [
      {
        title: '认清截面',
        text: '平面 α 与圆柱的轴**斜交**（成 $60°$），且只切侧面、不碰到两端面——所以交线是一个**完整的椭圆**。紫色半透明面就是 α，深紫红色曲线就是交线。',
        highlight: ['cyl', 'sec'],
      },
      {
        title: '半短轴就是半径',
        text: '椭圆的**半短轴** $b=r=2$（垂直于纸面方向的"宽度"没被拉伸）。**半长轴**被斜角拉长：$a=\\dfrac{r}{\\sin 60°}=\\dfrac{4}{\\sqrt3}\\approx 2.31$。右侧的读数就是程序从图上量出来的，可拖滑杆验证。',
        highlight: ['cyl', 'sec', 'Q'],
      },
      {
        title: '面积',
        text: '$S=\\pi ab=\\pi\\cdot\\dfrac{4}{\\sqrt3}\\cdot 2=\\dfrac{8\\pi}{\\sqrt3}\\approx 14.51$。平面越斜（角越小），椭圆越扁长；转一转视角看看虚实线分界怎么跟着走。',
        highlight: ['cyl', 'sec'],
      },
    ],
  });
}

/* ================================================================
 * 正方体截面：过 D、M、N 的平面截正方体（五边形）
 *
 * 用户真机跑的那道题（人教版必修二 例 1）：
 *   正方体 ABCD-A₁B₁C₁D₁ 中，M 是 A₁B₁ 的中点，N 在棱 CC₁ 上且 CN = 2NC₁，
 *   作出过 D、M、N 的平面截正方体所得的截面，写出作法。
 *
 * 为什么单独做这个演示：它证明"截面"不只属于旋转体。
 * 之前的 section3 只能切圆柱/圆锥/球（截面是椭圆），一遇到正方体就画不出来——
 * 而正方体截面恰恰是立体几何里最高频的作图题。
 *
 * 做法上有个课本反复强调的要点：**截面是逐面求交"串"出来的**，
 * 不是直接连 D、M、N 三点（这三点的连线大部分在正方体内部，不在表面）。
 * 所以程序逐面算，串出五边形 M-P-N-D-Q：
 *   Q 在 AA₁ 上（A₁Q = a/3）、P 在 B₁C₁ 上（B₁P = a/2）。
 * 这两个点是"算"出来的，不是"写"出来的——P、Q 用 derive 的 section 声明，
 * 坐标由程序按定比给出，拖滑杆时不会跑偏。
 * ================================================================ */

export const cubeSectionDefaults = { a: 4 };

export function buildCubeSection(params: Record<string, number>): Scene3D {
  const a = params.a ?? 4;

  // 按课本插图摆：ABCD 在上、A₁B₁C₁D₁ 在下（z = 0）
  const objects: Scene3DObject[] = [
    { id: 'A', type: 'point3', label: 'A', at: [0, 0, 'a'] },
    { id: 'B', type: 'point3', label: 'B', at: ['a', 0, 'a'] },
    { id: 'C', type: 'point3', label: 'C', at: ['a', 'a', 'a'] },
    { id: 'D', type: 'point3', label: 'D', at: [0, 'a', 'a'] },
    { id: 'A1', type: 'point3', label: 'A₁', at: [0, 0, 0] },
    { id: 'B1', type: 'point3', label: 'B₁', at: ['a', 0, 0] },
    { id: 'C1', type: 'point3', label: 'C₁', at: ['a', 'a', 0] },
    { id: 'D1', type: 'point3', label: 'D₁', at: [0, 'a', 0] },

    // M：A₁B₁ 的中点（题面）
    { id: 'M', type: 'point3', label: 'M', derive: { kind: 'midpoint', a: 'A1', b: 'B1' } },
    // N：CC₁ 上且 CN = 2NC₁ → 从 C 往 C₁ 走到 2/3
    {
      id: 'N',
      type: 'point3',
      label: 'N',
      derive: { kind: 'section', a: 'C', b: 'C1', t: '2/3' },
    },
    // P、Q：截面与棱的交点（程序算，不是题面给的）
    {
      id: 'P',
      type: 'point3',
      label: 'P',
      derive: { kind: 'section', a: 'B1', b: 'C1', t: '1/2' },
      color: '#8a3f6b',
    },
    {
      id: 'Q',
      type: 'point3',
      label: 'Q',
      derive: { kind: 'section', a: 'A1', b: 'A', t: '1/3' },
      color: '#8a3f6b',
    },

    { id: 'fTop', type: 'face3', points: ['A', 'B', 'C', 'D'], opacity: 0.28 },
    { id: 'fBottom', type: 'face3', points: ['A1', 'B1', 'C1', 'D1'], opacity: 0.28 },
    { id: 'fFront', type: 'face3', points: ['A', 'B', 'B1', 'A1'], opacity: 0.28 },
    { id: 'fRight', type: 'face3', points: ['B', 'C', 'C1', 'B1'], opacity: 0.28 },
    { id: 'fBack', type: 'face3', points: ['C', 'D', 'D1', 'C1'], opacity: 0.28 },
    { id: 'fLeft', type: 'face3', points: ['D', 'A', 'A1', 'D1'], opacity: 0.28 },
  ];

  const edgePairs: [string, string][] = [
    ['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A'],
    ['A1', 'B1'], ['B1', 'C1'], ['C1', 'D1'], ['D1', 'A1'],
    ['A', 'A1'], ['B', 'B1'], ['C', 'C1'], ['D', 'D1'],
  ];
  for (const [i, [x, y]] of edgePairs.entries()) {
    objects.push({ id: `e${i}`, type: 'edge3', a: x, b: y });
  }

  // 截面：过 D、M、N 三点，切的是这个正方体（用顶点集合指认）
  objects.push({
    id: 'sec',
    type: 'section3',
    label: 'α',
    cut: { vertices: ['A', 'B', 'C', 'D', 'A1', 'B1', 'C1', 'D1'] },
    plane: ['D', 'M', 'N'],
    opacity: 0.18,
  });

  return resolveScene3D({
    space: '3d',
    meta: {
      title: '过 D、M、N 截正方体（五边形截面）',
      subtitle: `棱长 ${a.toFixed(1)} · M 为 A₁B₁ 中点 · CN = 2NC₁ · 截面为五边形 M-P-N-D-Q`,
    },
    params: [{ name: 'a', label: '棱长 a', min: 2, max: 6, step: 0.5, value: 4 }],
    // 机位说明：截面平面的法向量大约是 (2,−2,3)，所以相机从 −y 侧偏上俯视
    // （azimuth 负、elevation 偏高）才能"正对"截面，看到完整五边形；
    // 用默认的 +x/+y 视角会几乎沿平面看过去，截面变成一条窄带
    camera: { azimuth: 140, elevation: 26 },
    objects,
    readouts: [
      { label: '截面边数', expr: 'secN3(sec)' },
      { label: '截面面积', expr: 'secArea3(sec)' },
      { label: '截面周长', expr: 'secPerim3(sec)' },
    ],
    constraints: [
      { type: 'midpoint', m: 'M', ends: ['A1', 'B1'] },
      { type: 'on-segment', p: 'N', ends: ['C', 'C1'] },
      { type: 'length-ratio', a: ['C', 'N'], b: ['N', 'C1'], ratio: 2 },
      // 截面上的五个点必须共面——这一条最能证明"逐面求交"算对了
      { type: 'coplanar', points: ['D', 'M', 'P', 'N', 'Q'] },
      { type: 'on-segment', p: 'P', ends: ['B1', 'C1'] },
      { type: 'on-segment', p: 'Q', ends: ['A1', 'A'] },
    ],
    steps: [
      {
        title: '三个点定一个平面',
        text: '过 $D$、$M$、$N$ 三点的平面唯一确定。但**截面不是三角形 $DMN$**——$DM$ 这条连线大部分跑在正方体内部，不在表面上。截面是"平面与正方体各个面的交线"，所以要逐面求。',
        // 四个关键点（M/N 题面给、P/Q 算出来的）也要一起高亮：
        // 只高亮面的话，它们的字母会被压暗到 22%，深紫红色几乎看不见
        highlight: ['fTop', 'fBottom', 'fFront', 'fRight', 'fBack', 'fLeft', 'sec', 'M', 'N', 'P', 'Q', 'D'],
      },
      {
        title: '在 ABCD 面上：交线是 DQ',
        text: '平面与上面 $ABCD$ 相交，除了 $D$ 还交出另一个点：在 $AA_1$ 上，$A_1Q=\\\\dfrac{a}{3}$。于是上面那段交线是 $DQ$（$Q$ 由程序按定比算出）。',
        highlight: ['sec', 'Q', 'D', 'fTop'],
      },
      {
        title: '在 A₁B₁C₁D₁ 面上：交线是 MP',
        text: '与下底面的交线是 $MP$，$P$ 在 $B_1C_1$ 上且 $B_1P=\\\\dfrac{a}{2}$。注意 $M$ 是题面给的中点，$P$ 是算出来的——这类"落点"在课本作法里叫"延长找交点"。',
        highlight: ['sec', 'M', 'P', 'fBottom'],
      },
      {
        title: '在 BCC₁B₁ 面上：交线是 PN',
        text: '$P$ 与 $N$ 都在面 $BCC_1B_1$ 上（$P$ 在 $B_1C_1$ 棱上、$N$ 在 $CC_1$ 棱上），所以这个面上的交线就是 $PN$。同理，前面 $ABB_1A_1$ 上得到 $MQ$。',
        highlight: ['sec', 'P', 'N', 'fRight'],
      },
      {
        title: '收口：五边形 M-P-N-D-Q',
        text: '五个点首尾相连，截面是五边形 $MPNDQ$。面积与周长由程序从图上量出（右侧读数）——拖棱长滑杆，形状会相似缩放，边数永远是 5。',
        highlight: ['sec'],
      },
    ],
  });
}
