/**
 * e2eSamples.ts —— 端到端「整题回放」样本
 *
 * 与 cases.ts 的分工：
 *   cases.ts       —— 单点用例。每条盯一个已发生的事故或一条设计要求，
 *                     最小复现、命名精确（「柱面交线：两段圆弧不是共面圆」）。
 *   e2eSamples.ts  —— 整题回放。样本长得和模型真实产出一模一样：
 *                     完整题面 + 完整场景 + 完整分步讲解 + 读数。
 *                     验的不是某一条规则，而是「这道题整体能不能立起来」。
 *
 * 为什么要整题样本？
 *   单点用例再多，也可能一起过、但拼成一道题就散。整题样本会同时压到
 *   格式关、数值关、约束关、步骤点名、读数求值——任何一环退化都会红。
 *
 * 这里没有真实模型的 Key，所以场景是手写/用场景工厂搭的，
 * 但它们走的是同一条链路：JSON.stringify → parseScene → verifyScene → 读数。
 * 换成真实产出只需要替换 scene 字段，断言不用改。
 */

import { parseScene } from '../protocol/parser';
import { parseScene3D } from '../protocol/parser3d';
import { measureReadouts, verifyScene, type Issue } from '../protocol/verifier';
import { measureReadouts3D, verifyScene3D } from '../protocol/verifier3d';
import {
  buildCube,
  cubeDefaults,
  buildTetra,
  tetraDefaults,
  buildCylinder,
  cylinderDefaults,
  buildRevolution,
  revDefaults,
  buildTetraSpheres,
  tetraSpheresDefaults,
  buildCylSection,
  cylSectionDefaults,
  buildCubeSection,
  cubeSectionDefaults,
} from '../scenes/solid';
import type { Scene3D } from '../protocol/scene3d';

export interface E2ESample {
  /** 样本名（题目简称） */
  name: string;
  /** 完整题面：就是老师会贴进输入框的那段话 */
  problem: string;
  space: '2d' | '3d';
  /** 这是 3D 工厂产物时，steps 由这里补上（工厂只管几何，不管讲解） */
  scene: unknown;
  expect: {
    /** 至少这么多个对象（防止场景偷偷变成空图） */
    minObjects: number;
    /** 步骤条数（严格相等） */
    steps: number;
    /** 期望读数：label → 精确字符串 */
    readouts?: Record<string, string>;
    /** 步骤正文里点名的点，必须在 objects 里真实存在 */
    mentions?: string[];
  };
}

export interface E2ERow {
  name: string;
  ok: boolean;
  detail: string;
}

/** 给 3D 工厂场景补上题面副标题与分步讲解 —— 工厂只管几何，讲解是我们加的 */
function s3d(
  base: Scene3D,
  problem: string,
  steps: Array<{ title: string; text: string }>,
): Scene3D {
  return {
    ...base,
    meta: { ...base.meta, subtitle: problem },
    steps,
  };
}

/** 三条通用讲解：3D 工厂样本用（正文不点具体顶点，免得撞上点名检查） */
const GENERIC_3D_STEPS = [
  { title: '看清已知条件', text: '先明确题面给了哪些长度、垂直、平行关系，它们决定了图形的形状与大小。' },
  { title: '把关系落到图上', text: '找出关键截面或直角三角形，把待求的量放进一个可以计算的位置。' },
  { title: '算出结果', text: '代入数值算出结果，并回看它是否符合题目给出的数量级。' },
];

export const E2E_SAMPLES: E2ESample[] = [
  /* ============================================================
   * 一、平面几何（8 条）
   * ============================================================ */
  {
    name: '等腰三角形三线合一',
    problem: '在 △ABC 中，AB = AC，D 是 BC 的中点。求证：AD ⊥ BC。',
    space: '2d',
    scene: {
      meta: { title: '等腰三角形三线合一', subtitle: 'AB = AC，D 为 BC 中点' },
      view: { xMin: -3.5, xMax: 3.5, yMin: -1.2, yMax: 4.2 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 3], label: 'A' },
        { type: 'point', id: 'B', at: [-2, 0], label: 'B' },
        { type: 'point', id: 'C', at: [2, 0], label: 'C' },
        { type: 'point', id: 'D', at: [0, 0], label: 'D' },
        { type: 'polygon', id: 'tri', points: [[0, 3], [-2, 0], [2, 0]], fill: true },
        { type: 'segment', id: 'AD', from: [0, 3], to: [0, 0] },
      ],
      constraints: [
        { type: 'equal-length', a: ['A', 'B'], b: ['A', 'C'] },
        { type: 'midpoint', m: 'D', ends: ['B', 'C'] },
        { type: 'perp', points: ['B', 'D', 'A'] },
      ],
      readouts: [
        { label: 'AB', expr: 'dist(A,B)' },
        { label: 'AD', expr: 'dist(A,D)' },
      ],
      steps: [
        { title: '由等腰得两腰相等', text: '因为 $AB = AC$，所以 $\\triangle ABC$ 是等腰三角形。' },
        { title: '用中点条件', text: '已知 $D$ 是 $BC$ 的中点，所以 $BD = DC$。' },
        { title: '结论', text: '等腰三角形底边上的中线也是高，所以 $AD \\perp BC$。' },
      ],
    },
    expect: { minObjects: 6, steps: 3, readouts: { AB: '3.61', AD: '3.00' }, mentions: ['A', 'B', 'C', 'D'] },
  },
  {
    name: '直径所对的圆周角是直角',
    problem: 'AB 是圆 O 的直径，点 C 在圆上。求证：∠ACB = 90°。',
    space: '2d',
    scene: {
      meta: { title: '直径所对的圆周角', subtitle: 'AB 为直径，C 在圆上' },
      view: { xMin: -3.2, xMax: 3.2, yMin: -1, yMax: 3.4 },
      params: [],
      objects: [
        { type: 'circle', id: 'c', center: [0, 0], radius: '2' },
        { type: 'point', id: 'O', at: [0, 0], label: 'O' },
        { type: 'point', id: 'A', at: [-2, 0], label: 'A' },
        { type: 'point', id: 'B', at: [2, 0], label: 'B' },
        { type: 'point', id: 'C', at: [0, 2], label: 'C' },
        { type: 'polygon', id: 'tri', points: [[-2, 0], [2, 0], [0, 2]], fill: true },
      ],
      constraints: [
        { type: 'on-curve', p: 'C', curve: 'c' },
        { type: 'perp', points: ['A', 'C', 'B'] },
      ],
      readouts: [{ label: 'AB', expr: 'dist(A,B)' }],
      steps: [
        { title: '连成三角形', text: '连接 $AC$、$BC$，得到圆周角 $\\angle ACB$。' },
        { title: '用直径性质', text: '直径所对的圆周角是直角，所以 $\\angle ACB = 90^{\\circ}$。' },
        { title: '勾股验证', text: '于是 $AC^2 + BC^2 = AB^2$，与图上读数一致。' },
      ],
    },
    expect: { minObjects: 6, steps: 3, readouts: { AB: '4.00' }, mentions: ['A', 'B', 'C'] },
  },
  {
    name: '抛物线的顶点',
    problem: '画出抛物线 y = (x−1)² + 2，并标出它的顶点。',
    space: '2d',
    scene: {
      meta: { title: '抛物线 y=(x−1)²+2', subtitle: '顶点式，开口向上' },
      view: { xMin: -2.5, xMax: 4.5, yMin: -1, yMax: 8 },
      params: [],
      objects: [
        { type: 'curve', id: 'par', expr: '(x-1)^2+2', domain: ['-2', '4'], label: 'y=(x−1)²+2' },
        { type: 'point', id: 'V', at: [1, 2], label: 'V' },
      ],
      constraints: [{ type: 'on-curve', p: 'V', curve: 'par' }],
      readouts: [],
      steps: [
        { title: '认顶点式', text: '函数写成 $y = a(x-h)^2 + k$ 时，顶点就是 $(h, k)$。' },
        { title: '读出顶点', text: '这里 $h = 1$、$k = 2$，所以顶点是 $V(1, 2)$。' },
        { title: '看开口方向', text: '因为 $a = 1 > 0$，抛物线开口向上，$V$ 是最低点。' },
      ],
    },
    expect: { minObjects: 2, steps: 3, mentions: ['V'] },
  },
  {
    name: '直角三角形与勾股定理',
    problem: '△ABC 中，∠A = 90°，AB = 4，AC = 3，求 BC。',
    space: '2d',
    scene: {
      meta: { title: '直角三角形求斜边', subtitle: '∠A=90°，AB=4，AC=3' },
      view: { xMin: -1, xMax: 5, yMin: -1, yMax: 4.2 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 0], label: 'A' },
        { type: 'point', id: 'B', at: [4, 0], label: 'B' },
        { type: 'point', id: 'C', at: [0, 3], label: 'C' },
        { type: 'polygon', id: 'tri', points: [[0, 0], [4, 0], [0, 3]], fill: true },
      ],
      constraints: [
        { type: 'perp', points: ['B', 'A', 'C'] },
        { type: 'value', expr: 'dist(A,B)', equals: 4 },
        { type: 'value', expr: 'dist(A,C)', equals: 3 },
      ],
      readouts: [{ label: 'BC', expr: 'dist(B,C)' }],
      steps: [
        { title: '确定直角与两直角边', text: '$\\angle A = 90^{\\circ}$，两条直角边是 $AB = 4$、$AC = 3$。' },
        { title: '套勾股定理', text: '$BC^2 = AB^2 + AC^2 = 16 + 9 = 25$。' },
        { title: '得出结论', text: '所以 $BC = 5$。' },
      ],
    },
    expect: { minObjects: 4, steps: 3, readouts: { BC: '5.00' }, mentions: ['A', 'B', 'C'] },
  },
  {
    name: '角平分线定理',
    problem: '在 △ABC 中，AB = AC，AD 平分 ∠BAC 且交 BC 于 D。说明 D 的位置。',
    space: '2d',
    scene: {
      meta: { title: '等腰三角形顶角平分线', subtitle: 'AD 平分 ∠BAC' },
      view: { xMin: -4, xMax: 4, yMin: -1.2, yMax: 4.2 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 3], label: 'A' },
        { type: 'point', id: 'B', at: [-3, 0], label: 'B' },
        { type: 'point', id: 'C', at: [3, 0], label: 'C' },
        { type: 'point', id: 'D', at: [0, 0], label: 'D' },
        { type: 'polygon', id: 'tri', points: [[0, 3], [-3, 0], [3, 0]], fill: true },
        { type: 'segment', id: 'AD', from: [0, 3], to: [0, 0] },
      ],
      constraints: [
        { type: 'equal-length', a: ['A', 'B'], b: ['A', 'C'] },
        { type: 'angle-bisector', vertex: 'A', sides: ['B', 'C'], ray: 'D' },
        { type: 'on-segment', p: 'D', ends: ['B', 'C'] },
      ],
      readouts: [
        { label: 'AB', expr: 'dist(A,B)' },
        { label: 'BD', expr: 'dist(B,D)' },
      ],
      steps: [
        { title: '两腰相等', text: '$AB = AC$，所以这是等腰三角形。' },
        { title: '角平分线落到对边', text: '$AD$ 平分 $\\angle BAC$，与 $BC$ 交于 $D$。' },
        { title: '结论', text: '等腰三角形顶角平分线也是底边中线，所以 $D$ 是 $BC$ 的中点，$BD = DC$。' },
      ],
    },
    expect: { minObjects: 6, steps: 3, readouts: { AB: '4.24', BD: '3.00' }, mentions: ['A', 'B', 'C', 'D'] },
  },
  {
    name: '矩形与中位线',
    problem: '矩形 ABCD 中，AB = 4，BC = 3，M、N 分别是 AB、CD 的中点。求证 MN ∥ BC。',
    space: '2d',
    scene: {
      meta: { title: '矩形中位线', subtitle: 'M、N 为对边中点' },
      view: { xMin: -1, xMax: 5, yMin: -1, yMax: 4.2 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 0], label: 'A' },
        { type: 'point', id: 'B', at: [4, 0], label: 'B' },
        { type: 'point', id: 'C', at: [4, 3], label: 'C' },
        { type: 'point', id: 'D', at: [0, 3], label: 'D' },
        { type: 'point', id: 'M', at: [2, 0], label: 'M' },
        { type: 'point', id: 'N', at: [2, 3], label: 'N' },
        { type: 'polygon', id: 'rect', points: [[0, 0], [4, 0], [4, 3], [0, 3]], fill: true },
        { type: 'segment', id: 'MN', from: [2, 0], to: [2, 3] },
      ],
      constraints: [
        { type: 'perp', points: ['B', 'A', 'D'] },
        { type: 'midpoint', m: 'M', ends: ['A', 'B'] },
        { type: 'midpoint', m: 'N', ends: ['D', 'C'] },
        { type: 'parallel', a: ['M', 'N'], b: ['B', 'C'] },
      ],
      readouts: [
        { label: 'MN', expr: 'dist(M,N)' },
        { label: 'BC', expr: 'dist(B,C)' },
      ],
      steps: [
        { title: '取出两个中点', text: '$M$ 是 $AB$ 的中点，$N$ 是 $CD$ 的中点。' },
        { title: '看方向', text: '在矩形里 $AD \\parallel BC$，而 $M$、$N$ 分别在两条对边上对应位置。' },
        { title: '结论', text: '所以 $MN \\parallel BC$，且 $MN = BC = 3$。' },
      ],
    },
    expect: { minObjects: 8, steps: 3, readouts: { MN: '3.00', BC: '3.00' }, mentions: ['M', 'N', 'B', 'C'] },
  },
  {
    name: '圆的弦与弦心距',
    problem: '圆 O 的半径为 2，弦 AB 的中点记为 M。求证 OM ⊥ AB。',
    space: '2d',
    scene: {
      meta: { title: '弦心距垂直平分弦', subtitle: 'M 为弦 AB 中点' },
      view: { xMin: -3, xMax: 3, yMin: -3, yMax: 3 },
      params: [],
      objects: [
        { type: 'circle', id: 'c', center: [0, 0], radius: '2' },
        { type: 'point', id: 'O', at: [0, 0], label: 'O' },
        { type: 'point', id: 'A', at: [-1.5, 1.32], label: 'A' },
        { type: 'point', id: 'B', at: [1.5, 1.32], label: 'B' },
        { type: 'point', id: 'M', at: [0, 1.32], label: 'M' },
        { type: 'segment', id: 'AB', from: [-1.5, 1.32], to: [1.5, 1.32] },
        { type: 'segment', id: 'OM', from: [0, 0], to: [0, 1.32] },
      ],
      constraints: [
        { type: 'on-curve', p: 'A', curve: 'c' },
        { type: 'on-curve', p: 'B', curve: 'c' },
        { type: 'midpoint', m: 'M', ends: ['A', 'B'] },
        { type: 'perp', points: ['A', 'M', 'O'] },
      ],
      readouts: [{ label: 'AB', expr: 'dist(A,B)' }],
      steps: [
        { title: '连半径', text: '连接 $OA$、$OB$，它们都是半径，所以 $OA = OB$。' },
        { title: '用中点', text: '$M$ 是 $AB$ 的中点，故 $AM = MB$。' },
        { title: '结论', text: '三角形 $OAB$ 是等腰三角形，底边上的中线 $OM$ 也是高，所以 $OM \\perp AB$。' },
      ],
    },
    expect: { minObjects: 7, steps: 3, readouts: { AB: '3.00' }, mentions: ['A', 'B', 'M', 'O'] },
  },
  {
    name: '三角形中位线定理',
    problem: '△ABC 中，D、E 分别是 AB、AC 的中点。求证 DE ∥ BC 且 DE = ½BC。',
    space: '2d',
    scene: {
      meta: { title: '三角形中位线', subtitle: 'D、E 为两边中点' },
      view: { xMin: -1, xMax: 5, yMin: -1, yMax: 4 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 0], label: 'A' },
        { type: 'point', id: 'B', at: [4, 0], label: 'B' },
        { type: 'point', id: 'C', at: [1, 3], label: 'C' },
        { type: 'point', id: 'D', at: [2, 0], label: 'D' },
        { type: 'point', id: 'E', at: [0.5, 1.5], label: 'E' },
        { type: 'polygon', id: 'tri', points: [[0, 0], [4, 0], [1, 3]], fill: true },
        { type: 'segment', id: 'DE', from: [2, 0], to: [0.5, 1.5] },
      ],
      constraints: [
        { type: 'midpoint', m: 'D', ends: ['A', 'B'] },
        { type: 'midpoint', m: 'E', ends: ['A', 'C'] },
        { type: 'parallel', a: ['D', 'E'], b: ['B', 'C'] },
      ],
      readouts: [
        { label: 'DE', expr: 'dist(D,E)' },
        { label: 'BC', expr: 'dist(B,C)' },
      ],
      steps: [
        { title: '取出两个中点', text: '$D$、$E$ 分别是 $AB$、$AC$ 的中点。' },
        { title: '用中位线定理', text: '三角形两边中点的连线平行于第三边，所以 $DE \\parallel BC$。' },
        { title: '长度关系', text: '并且 $DE = \\frac{1}{2}BC$，代入读数可验证。' },
      ],
    },
    expect: { minObjects: 7, steps: 3, readouts: { DE: '2.12', BC: '4.24' }, mentions: ['A', 'B', 'C', 'D', 'E'] },
  },
  {
    name: '圆的切线垂直于半径',
    problem: 'PA 切圆 O 于点 A，O 为圆心。求证：OA ⊥ PA。',
    space: '2d',
    scene: {
      meta: { title: '切线的性质', subtitle: 'PA 与圆切于 A' },
      view: { xMin: -2.6, xMax: 4.6, yMin: -2.6, yMax: 2.6 },
      params: [],
      objects: [
        { type: 'circle', id: 'c', center: [0, 0], radius: '2' },
        { type: 'point', id: 'O', at: [0, 0], label: 'O' },
        { type: 'point', id: 'A', at: [1, 1.732], label: 'A' },
        { type: 'point', id: 'P', at: [4, 0], label: 'P' },
        { type: 'segment', id: 'OA', from: [0, 0], to: [1, 1.732] },
        { type: 'segment', id: 'PA', from: [4, 0], to: [1, 1.732] },
      ],
      constraints: [
        { type: 'on-curve', p: 'A', curve: 'c' },
        { type: 'perp', points: ['O', 'A', 'P'] },
      ],
      readouts: [
        { label: 'OA', expr: 'dist(O,A)' },
        { label: 'PA', expr: 'dist(P,A)' },
      ],
      steps: [
        { title: '连半径', text: '连接 $OA$，$A$ 是切点，所以 $OA$ 是半径。' },
        { title: '用切线性质', text: '圆的切线垂直于过切点的半径，所以 $OA \\perp PA$。' },
        { title: '得到直角三角形', text: '于是 $\\triangle OAP$ 是直角三角形，可用勾股定理求 $PA$。' },
      ],
    },
    expect: { minObjects: 6, steps: 3, readouts: { OA: '2.00', PA: '3.46' }, mentions: ['O', 'A', 'P'] },
  },
  {
    name: '一次函数与坐标轴的交点',
    problem: '画出直线 y = 2x − 4，并标出它与两条坐标轴的交点。',
    space: '2d',
    scene: {
      meta: { title: '直线 y = 2x − 4', subtitle: '与坐标轴的两个交点' },
      view: { xMin: -1.5, xMax: 4.5, yMin: -5.5, yMax: 2.5 },
      params: [],
      objects: [
        { type: 'curve', id: 'line', expr: '2*x-4', domain: ['-1', '4'], label: 'y=2x−4' },
        { type: 'point', id: 'X', at: [2, 0], label: 'X' },
        { type: 'point', id: 'Y', at: [0, -4], label: 'Y' },
      ],
      constraints: [
        { type: 'on-curve', p: 'X', curve: 'line' },
        { type: 'on-curve', p: 'Y', curve: 'line' },
      ],
      readouts: [{ label: 'XY', expr: 'dist(X,Y)' }],
      steps: [
        { title: '求 x 轴交点', text: '令 $y = 0$，得 $2x - 4 = 0$，所以 $x = 2$，交点是 $X(2, 0)$。' },
        { title: '求 y 轴交点', text: '令 $x = 0$，得 $y = -4$，交点是 $Y(0, -4)$。' },
        { title: '描点连线', text: '过 $X$、$Y$ 两点作直线，就是 $y = 2x - 4$ 的图像。' },
      ],
    },
    expect: { minObjects: 3, steps: 3, readouts: { XY: '4.47' }, mentions: ['X', 'Y'] },
  },
  {
    name: '矩形的对角线相等',
    problem: '矩形 ABCD 中，AB = 4，BC = 3。求证：AC = BD。',
    space: '2d',
    scene: {
      meta: { title: '矩形对角线相等', subtitle: 'AB=4，BC=3' },
      view: { xMin: -1, xMax: 5, yMin: -1, yMax: 4.2 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 0], label: 'A' },
        { type: 'point', id: 'B', at: [4, 0], label: 'B' },
        { type: 'point', id: 'C', at: [4, 3], label: 'C' },
        { type: 'point', id: 'D', at: [0, 3], label: 'D' },
        { type: 'polygon', id: 'rect', points: [[0, 0], [4, 0], [4, 3], [0, 3]], fill: true },
        { type: 'segment', id: 'AC', from: [0, 0], to: [4, 3] },
        { type: 'segment', id: 'BD', from: [4, 0], to: [0, 3] },
      ],
      constraints: [
        { type: 'perp', points: ['B', 'A', 'D'] },
        { type: 'perp', points: ['A', 'B', 'C'] },
        { type: 'equal-length', a: ['A', 'C'], b: ['B', 'D'] },
      ],
      readouts: [
        { label: 'AC', expr: 'dist(A,C)' },
        { label: 'BD', expr: 'dist(B,D)' },
      ],
      steps: [
        { title: '写出坐标', text: '把 $A$ 放在原点，则 $B(4,0)$、$C(4,3)$、$D(0,3)$。' },
        { title: '分别算两条对角线', text: '$AC = \\sqrt{4^2 + 3^2} = 5$，$BD = \\sqrt{4^2 + 3^2} = 5$。' },
        { title: '结论', text: '两条对角线长度相等，即 $AC = BD$。' },
      ],
    },
    expect: { minObjects: 7, steps: 3, readouts: { AC: '5.00', BD: '5.00' }, mentions: ['A', 'B', 'C', 'D'] },
  },
  {
    name: '一元二次不等式（推导板书）',
    problem: '解不等式 x² − 3x + 2 > 0。',
    space: '2d',
    scene: {
      meta: { title: '解一元二次不等式', subtitle: 'x²−3x+2>0' },
      view: { xMin: -1, xMax: 4, yMin: -2, yMax: 6 },
      params: [],
      objects: [],
      visual: 'board',
      readouts: [],
      steps: [
        { title: '因式分解', text: '$x^2 - 3x + 2 = (x-1)(x-2)$。' },
        { title: '求零点', text: '令 $(x-1)(x-2) = 0$，得 $x_1 = 1$、$x_2 = 2$。' },
        { title: '定符号区间', text: '开口向上、两根之外为正，所以解集是 $x < 1$ 或 $x > 2$。' },
      ],
    },
    expect: { minObjects: 0, steps: 3 },
  },

  /* ============================================================
   * 二、立体几何（8 条）
   * ============================================================ */
  {
    name: '正方体（棱长 2）',
    problem: '画一个棱长为 2 的正方体 ABCD-A₁B₁C₁D₁。',
    space: '3d',
    scene: s3d(buildCube(cubeDefaults), '棱长 2 的正方体', GENERIC_3D_STEPS),
    expect: { minObjects: 20, steps: 3 },
  },
  {
    name: '正四面体（棱长 2.4）',
    problem: '画一个棱长为 2.4 的正四面体 S-ABC，并标出底面重心。',
    space: '3d',
    scene: s3d(buildTetra(tetraDefaults), '正四面体 S-ABC', GENERIC_3D_STEPS),
    expect: { minObjects: 10, steps: 3 },
  },
  {
    name: '圆柱（半径 2，高 4）',
    problem: '画一个底面半径 2、高 4 的圆柱。',
    space: '3d',
    scene: s3d(buildCylinder(cylinderDefaults), '圆柱 r=2，h=4', GENERIC_3D_STEPS),
    expect: { minObjects: 4, steps: 3 },
  },
  {
    name: '旋转体（圆锥）',
    problem: '画一个底面半径 1.6、高 3 的圆锥。',
    space: '3d',
    scene: s3d(buildRevolution(revDefaults), '圆锥 r=1.6，h=3', GENERIC_3D_STEPS),
    expect: { minObjects: 6, steps: 3 },
  },
  {
    name: '正四面体的外接球与内切球',
    problem: '正四面体棱长 2，求它的外接球与内切球半径。',
    space: '3d',
    scene: s3d(buildTetraSpheres(tetraSpheresDefaults), '棱长 2 的正四面体与两球', GENERIC_3D_STEPS),
    expect: { minObjects: 10, steps: 3 },
  },
  {
    name: '圆柱的斜截面',
    problem: '用斜平面去截一个底面半径 2、高 6 的圆柱，画出截面。',
    space: '3d',
    scene: s3d(buildCylSection(cylSectionDefaults), '圆柱斜截面', GENERIC_3D_STEPS),
    expect: { minObjects: 6, steps: 3 },
  },
  {
    name: '正方体的截面',
    problem: '棱长 4 的正方体，用过三个顶点的平面去截，画出截面。',
    space: '3d',
    scene: s3d(buildCubeSection(cubeSectionDefaults), '正方体截面', GENERIC_3D_STEPS),
    expect: { minObjects: 10, steps: 3 },
  },
  {
    name: '正四棱锥（参数化坐标）',
    problem: '正四棱锥 P-ABCD 的底面边长 2、高 3，求侧棱长。',
    space: '3d',
    scene: {
      space: '3d',
      meta: { title: '正四棱锥 P-ABCD', subtitle: '底面边长 2，高 3' },
      params: [
        { name: 'a', label: '底面边长 a', min: 1, max: 4, step: 0.1, value: 2 },
        { name: 'h', label: '高 h', min: 1, max: 5, step: 0.1, value: 3 },
      ],
      objects: [
        { type: 'point3', id: 'A', label: 'A', at: '0, 0, 0' },
        { type: 'point3', id: 'B', label: 'B', at: 'a, 0, 0' },
        { type: 'point3', id: 'C', label: 'C', at: 'a, a, 0' },
        { type: 'point3', id: 'D', label: 'D', at: '0, a, 0' },
        { type: 'point3', id: 'H', derive: { kind: 'midpoint', a: 'A', b: 'C' } },
        { type: 'point3', id: 'P', label: 'P', at: 'a/2, a/2, h' },
        { type: 'face3', id: 'fBase', points: ['A', 'B', 'C', 'D'], opacity: 0.4 },
        { type: 'face3', id: 'fPAB', points: ['P', 'A', 'B'], opacity: 0.4 },
        { type: 'face3', id: 'fPBC', points: ['P', 'B', 'C'], opacity: 0.4 },
        { type: 'face3', id: 'fPCD', points: ['P', 'C', 'D'], opacity: 0.4 },
        { type: 'face3', id: 'fPDA', points: ['P', 'D', 'A'], opacity: 0.4 },
        { type: 'edge3', id: 'AB', a: 'A', b: 'B' },
        { type: 'edge3', id: 'BC', a: 'B', b: 'C' },
        { type: 'edge3', id: 'CD', a: 'C', b: 'D' },
        { type: 'edge3', id: 'DA', a: 'D', b: 'A' },
        { type: 'edge3', id: 'PA', a: 'P', b: 'A' },
        { type: 'edge3', id: 'PB', a: 'P', b: 'B' },
        { type: 'edge3', id: 'PC', a: 'P', b: 'C' },
        { type: 'edge3', id: 'PD', a: 'P', b: 'D' },
        { type: 'edge3', id: 'PH', a: 'P', b: 'H', dashed: true },
      ],
      constraints: [
        { type: 'equal-length', a: ['P', 'A'], b: ['P', 'B'] },
        { type: 'coplanar', points: ['A', 'B', 'C', 'D'] },
        { type: 'perp-lines', a: ['P', 'H'], b: ['A', 'B'] },
      ],
      readouts: [{ label: 'PA', expr: 'dist3(P,A)' }],
      steps: [
        { title: '把高放到对称轴上', text: '底面是正方形，高 $PH$ 过底面中心，所以 $AH$ 是对角线的一半。' },
        { title: '算底面中心到顶点的距离', text: '边长 $a = 2$，对角线 $AC = 2\\sqrt{2}$，故 $AH = \\sqrt{2}$。' },
        { title: '勾股求侧棱', text: '$PA = \\sqrt{AH^2 + PH^2} = \\sqrt{2 + 9} = \\sqrt{11}$。' },
      ],
    },
    expect: { minObjects: 20, steps: 3, readouts: { PA: '3.32' }, mentions: ['P', 'A', 'H'] },
  },

  /* ============================================================
   * 三、两条「必须被拦下」的反向样本
   *    它们不在 20 条之内：整题样本集要的是"能不能立起来"，
   *    这两条验的是"立不起来的时候，会不会有人拦"。
   * ============================================================ */
];

export interface E2ENegative {
  name: string;
  problem: string;
  space: '2d' | '3d';
  scene: unknown;
  /** 期望报错里必然出现的一小段文字 */
  match: string;
}

export const E2E_NEGATIVES: E2ENegative[] = [
  {
    name: '直角声明与坐标不符',
    problem: '在 △ABC 中，∠A = 90°，AB = 4，AC = 3。',
    space: '2d',
    scene: {
      meta: { title: '直角写错', subtitle: '坐标与声明不一致' },
      view: { xMin: -1, xMax: 5, yMin: -1, yMax: 4 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 0], label: 'A' },
        { type: 'point', id: 'B', at: [4, 0], label: 'B' },
        { type: 'point', id: 'C', at: [3, 3], label: 'C' },
      ],
      constraints: [{ type: 'perp', points: ['B', 'A', 'C'] }],
      readouts: [],
      steps: [{ title: '按题意画图', text: '把 $A$ 放在原点，$AB$ 沿 $x$ 轴。' }],
    },
    match: '不成立',
  },
  {
    name: '立体图形被压扁（全部共面）',
    problem: '画一个棱长 2 的正方体。',
    space: '3d',
    scene: {
      space: '3d',
      meta: { title: '压扁的正方体', subtitle: '所有顶点 z 都是 0' },
      params: [],
      objects: [
        { type: 'point3', id: 'A', at: '0,0,0' },
        { type: 'point3', id: 'B', at: '2,0,0' },
        { type: 'point3', id: 'C', at: '2,2,0' },
        { type: 'point3', id: 'D', at: '0,2,0' },
        { type: 'point3', id: 'A1', at: '0,0,0' },
        { type: 'point3', id: 'B1', at: '2,0,0' },
        { type: 'point3', id: 'C1', at: '2,2,0' },
        { type: 'point3', id: 'D1', at: '0,2,0' },
        { type: 'edge3', id: 'AB', a: 'A', b: 'B' },
        { type: 'edge3', id: 'BC', a: 'B', b: 'C' },
        { type: 'edge3', id: 'AA1', a: 'A', b: 'A1' },
      ],
      readouts: [],
      steps: [{ title: '画正方体', text: '先把底面 $ABCD$ 画出来。' }],
    },
    match: '共面',
  },
];

/** 跑一条整题样本 */
function runSample(s: E2ESample): E2ERow {
  const json = JSON.stringify(s.scene);
  let scene: any;
  let issues: Issue[] = [];
  let measured: Array<{ label: string; value: string }> = [];

  if (s.space === '3d') {
    const parsed = parseScene3D(json);
    if (!parsed.ok) {
      return { name: s.name, ok: false, detail: `格式关拦下：${parsed.errors[0]}` };
    }
    scene = parsed.scene;
    issues = verifyScene3D(scene);
    measured = measureReadouts3D(scene);
  } else {
    const parsed = parseScene(json);
    if (!parsed.ok) {
      return { name: s.name, ok: false, detail: `格式关拦下：${parsed.errors[0]}` };
    }
    scene = parsed.scene;
    issues = verifyScene(scene);
    measured = measureReadouts(scene);
  }

  const errs = issues.filter((i) => i.level === 'error');
  if (errs.length > 0) {
    return {
      name: s.name,
      ok: false,
      detail: `${errs.length} 条错误，首条：${errs[0].where}：${errs[0].message.slice(0, 80)}`,
    };
  }

  const objects = Array.isArray(scene.objects) ? scene.objects : [];
  if (objects.length < s.expect.minObjects) {
    return {
      name: s.name,
      ok: false,
      detail: `对象数 ${objects.length} 少于期望的 ${s.expect.minObjects}`,
    };
  }

  const steps = Array.isArray(scene.steps) ? scene.steps : [];
  if (steps.length !== s.expect.steps) {
    return { name: s.name, ok: false, detail: `步骤 ${steps.length} 条，期望 ${s.expect.steps} 条` };
  }
  const emptyStep = steps.findIndex(
    (st: any) => !String(st?.title ?? '').trim() || !String(st?.text ?? '').trim(),
  );
  if (emptyStep >= 0) {
    return { name: s.name, ok: false, detail: `第 ${emptyStep + 1} 步标题或正文是空的` };
  }

  // 读数：既要能算出来，也要是数字（NaN / 空串都是求值器退化的信号）
  const badReadout = measured.find((r) => !/^\s*-?\d/.test(String(r.value ?? '')));
  if (badReadout) {
    return { name: s.name, ok: false, detail: `读数「${badReadout.label}」算出来是「${badReadout.value}」` };
  }
  if (s.expect.readouts) {
    for (const [label, want] of Object.entries(s.expect.readouts)) {
      const hit = measured.find((r) => r.label === label);
      if (!hit) return { name: s.name, ok: false, detail: `缺少读数「${label}」` };
      if (hit.value !== want) {
        return { name: s.name, ok: false, detail: `读数「${label}」= ${hit.value}，期望 ${want}` };
      }
    }
  }

  // 步骤点名的点必须在 objects 里 —— 这条以前靠人眼，现在每次回放都查
  if (s.expect.mentions) {
    const ids = new Set(objects.map((o: any) => String(o?.id ?? '')));
    const missing = s.expect.mentions.filter((m) => !ids.has(m));
    if (missing.length > 0) {
      return { name: s.name, ok: false, detail: `步骤点到但场景里没有的点：${missing.join('、')}` };
    }
  }

  return {
    name: s.name,
    ok: true,
    detail: `${objects.length} 个对象 / ${steps.length} 步 / ${measured.length} 个读数，零错误`,
  };
}

/** 跑一条反向样本：必须被拦下 */
function runNegative(n: E2ENegative): E2ERow {
  const json = JSON.stringify(n.scene);
  if (n.space === '3d') {
    const parsed = parseScene3D(json);
    if (!parsed.ok) {
      const text = parsed.errors.join('\n');
      return text.includes(n.match)
        ? { name: n.name, ok: true, detail: `格式关拦下：${parsed.errors[0]}` }
        : { name: n.name, ok: false, detail: '格式关拦下了，但报错内容和预期不符' };
    }
    const errs = verifyScene3D(parsed.scene).filter((i) => i.level === 'error');
    const hit = errs.find((i) => i.message.includes(n.match));
    return hit
      ? { name: n.name, ok: true, detail: `体检拦下：${hit.message.slice(0, 70)}` }
      : { name: n.name, ok: false, detail: `没拦下来（${errs.length} 条错误都不含「${n.match}」）` };
  }
  const parsed = parseScene(json);
  if (!parsed.ok) {
    const text = parsed.errors.join('\n');
    return text.includes(n.match)
      ? { name: n.name, ok: true, detail: `格式关拦下：${parsed.errors[0]}` }
      : { name: n.name, ok: false, detail: '格式关拦下了，但报错内容和预期不符' };
  }
  const errs = verifyScene(parsed.scene).filter((i) => i.level === 'error');
  const hit = errs.find((i) => i.message.includes(n.match));
  return hit
    ? { name: n.name, ok: true, detail: `体检拦下：${hit.message.slice(0, 70)}` }
    : { name: n.name, ok: false, detail: `没拦下来（${errs.length} 条错误都不含「${n.match}」）` };
}

/** 全部整题样本（正向 + 反向） */
export function runE2ESamples(): E2ERow[] {
  return [...E2E_SAMPLES.map(runSample), ...E2E_NEGATIVES.map(runNegative)];
}
