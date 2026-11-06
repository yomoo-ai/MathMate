/**
 * cases.ts —— 回归测试用例清单
 *
 * ===== 这个文件是干什么的 =====
 *
 * 每一条用例都对应一件「真实发生过的事故」或一条「必须永远成立的设计要求」。
 * 以后不管改 prompt、改求值器、改体检器、改约束验算，跑一遍测试页就知道
 * 有没有把原来好的东西改坏——不需要再手动"生成一次看看运气"。
 *
 * ===== 为什么这么写 =====
 *
 * scene 直接写成对象（不手写 JSON 字符串），运行时会被 JSON.stringify 再走
 * 完整流程：parseScene（格式关）→ verifyScene（数值关 + 约束关）→ measureReadouts。
 * 也就是说，测的是「LLM 真正会经过的那条路」，而不是某个孤立函数。
 *
 * ===== 加新用例的方法 =====
 *
 * 从踩过的坑里挑一个最小复现，写进下面的数组：
 *   - 期望能跑通的：expect = { kind: 'pass', readouts: { 读数名: '期望值' } }
 *   - 期望被拦下的：expect = { kind: 'fail', match: '报错里必然出现的一小段文字' }
 * match 用最短的独特片段（比如 '「fx」'），别整句抄——文案以后可能会微调。
 */

import {
  buildCube,
  cubeDefaults,
  buildTetra,
  tetraDefaults,
  buildCylinder,
  cylinderDefaults,
  buildRevolution,
  revDefaults,
  buildCylSection,
  cylSectionDefaults,
  buildCubeSection,
  cubeSectionDefaults,
} from '../scenes/solid';

export interface TestCase {
  /** 用例名：一句话说清测什么 */
  name: string;
  /** 为什么有这条用例（对应哪个事故 / 哪个设计要求） */
  why: string;
  /** 测的是哪一关 */
  gate: '综合' | '格式关' | '数值关' | '约束关';
  /** 场景数据 */
  scene: unknown;
  expect: Expect;
}

export type Expect =
  | {
      kind: 'pass';
      /** 期望的读数：label → 精确字符串（如 { DF: '2.50' }） */
      readouts?: Record<string, string>;
      /** 期望至少出现一条含这段文字的提醒（提醒不拦截，但必须出现） */
      warn?: string;
      /** 期望不出现含这段文字的提醒（防止检查误报好图） */
      noWarn?: string;
    }
  | {
      kind: 'fail';
      /** 期望的报错里含这段文字 */
      match: string;
    };

export const CASES: TestCase[] = [
  /* ============================================================
   * 一、金标准：整条链路
   * ============================================================ */
  {
    name: '金标准：角平分线 + 垂足 + 交点，DF = 2.50',
    why:
      '这是真实卡了好几轮的那道题（∠ACB=90°、AD 平分 ∠BAC、DE⊥AB、CE 交 AD 于 F、' +
      '∠BAC=60°、AD=10 求 DF）。它同时用到派生点（foot/intersect）、点 id 引用、' +
      '5 条几何约束和读数验算——链路里任何一环坏了，这条立刻变红。',
    gate: '综合',
    scene: {
      meta: { title: '角平分线与垂足' },
      view: { xMin: -1, xMax: 16, yMin: -1, yMax: 10 },
      params: [
        // a = 5√3 ≈ 8.6603（AC），b = 15（BC）→ 保证 ∠BAC = 60°、AD = 10
        { name: 'a', label: 'AC', min: 5, max: 12, step: 0.01, value: 8.660254 },
        { name: 'b', label: 'BC', min: 10, max: 20, step: 0.01, value: 15 },
      ],
      objects: [
        { type: 'point', id: 'C', at: [0, 0], label: 'C' },
        { type: 'point', id: 'A', at: [0, 'a'], label: 'A' },
        { type: 'point', id: 'B', at: ['b', 0], label: 'B' },
        // 角平分线定理：CD/DB = AC/AB
        {
          type: 'point',
          id: 'D',
          at: ['b*a/(a + sqrt(a*a + b*b))', 0],
          label: 'D',
        },
        // E 是 D 到 AB 的垂足——由程序算，不许模型手写公式
        { type: 'point', id: 'E', derive: { kind: 'foot', p: 'D', line: ['A', 'B'] }, label: 'E' },
        // F 是 AD 与 CE 的交点
        {
          type: 'point',
          id: 'F',
          derive: { kind: 'intersect', l1: ['A', 'D'], l2: ['C', 'E'] },
          label: 'F',
        },
        { type: 'segment', id: 'AB', from: 'A', to: 'B' },
        { type: 'segment', id: 'BC', from: 'B', to: 'C' },
        { type: 'segment', id: 'CA', from: 'C', to: 'A' },
        { type: 'segment', id: 'AD', from: 'A', to: 'D' },
        { type: 'segment', id: 'DE', from: 'D', to: 'E', dashed: true },
        { type: 'segment', id: 'CE', from: 'C', to: 'E' },
      ],
      constraints: [
        { type: 'perp', points: ['A', 'C', 'B'] },
        { type: 'on-segment', p: 'D', ends: ['B', 'C'] },
        { type: 'angle-bisector', vertex: 'A', sides: ['B', 'C'], ray: 'D' },
        { type: 'perp', points: ['D', 'E', 'A'] },
        { type: 'midpoint', m: 'F', ends: ['C', 'E'] },
      ],
      readouts: [
        { label: 'CD', expr: 'dist(C,D)' },
        { label: 'AD', expr: 'dist(A,D)' },
        { label: 'DF', expr: 'dist(D,F)' },
        { label: '∠DEA', expr: 'angle(D,E,A)', unit: '°' },
      ],
    },
    // DF = CD²/AD = 25/10 = 2.5 —— 程序从图上量出来的，不是写死的
    expect: {
      kind: 'pass',
      readouts: { CD: '5.00', AD: '10.00', DF: '2.50', '∠DEA': '90.00°' },
    },
  },

  /* ============================================================
   * 二、历史事故：模型写了"最自然的写法"，我们却不认
   * ============================================================ */
  {
    name: '定角+定长配方：60° 不能写成等腰直角（∠A 会变 45°）',
    why:
      '2026-10-29 真实事故：模型把 ∠C=90°、∠A=60°、AD=10 写成 C=[0,0]、A=[0,10]、B=[10,0]，' +
      '那是等腰直角三角形，∠A 只有 45°，两条约束连着被驳回。这条用例锁定正确写法：' +
      '形状由 tan(60°) 定、尺寸由定标参数 a 定、D 用 section 派生——同时也是 prompt 里那条配方的可执行版本。',
    gate: '约束关',
    scene: {
      meta: { title: '定角定长配方' },
      view: { xMin: -1, xMax: 17, yMin: -1, yMax: 10.5 },
      params: [
        // a = 5√3 ≈ 8.6603（AC）；由 |AD| = 2a/√3 反解，使 AD 恰好等于 10
        { name: 'a', label: 'AC', min: 5, max: 12, step: 0.01, value: 8.660254 },
      ],
      objects: [
        { type: 'point', id: 'C', at: [0, 0], label: 'C' },
        { type: 'point', id: 'A', at: [0, 'a'], label: 'A' },
        // B 由 60° 定：BC = AC·tan60° = a√3（不是 a！写成 a 就是 45°）
        { type: 'point', id: 'B', at: ['a*tan(60*PI/180)', 0], label: 'B' },
        // D 在 BC 上，角平分线定理 |BD|:|DC| = |AB|:|AC| = 2:1 → 从 B 往 C 取 t=2/3
        {
          type: 'point',
          id: 'D',
          derive: { kind: 'section', a: 'B', b: 'C', t: '2/3' },
          label: 'D',
        },
        { type: 'point', id: 'E', derive: { kind: 'foot', p: 'D', line: ['A', 'B'] }, label: 'E' },
        {
          type: 'point',
          id: 'F',
          derive: { kind: 'intersect', l1: ['A', 'D'], l2: ['C', 'E'] },
          label: 'F',
        },
        { type: 'segment', id: 'AB', from: 'A', to: 'B' },
        { type: 'segment', id: 'BC', from: 'B', to: 'C' },
        { type: 'segment', id: 'CA', from: 'C', to: 'A' },
        { type: 'segment', id: 'AD', from: 'A', to: 'D' },
        { type: 'segment', id: 'DE', from: 'D', to: 'E', dashed: true },
        { type: 'segment', id: 'CE', from: 'C', to: 'E' },
      ],
      constraints: [
        { type: 'angle-value', points: ['A', 'C', 'B'], deg: 90 },
        { type: 'angle-value', points: ['B', 'A', 'C'], deg: 60 },
        { type: 'angle-bisector', vertex: 'A', sides: ['B', 'C'], ray: 'D' },
        { type: 'on-segment', p: 'D', ends: ['B', 'C'] },
        { type: 'perp', points: ['D', 'E', 'A'] },
        { type: 'midpoint', m: 'F', ends: ['C', 'E'] },
        { type: 'value', expr: 'dist(A,D)', equals: 10 },
      ],
      readouts: [
        { label: 'CD', expr: 'dist(C,D)' },
        { label: 'AD', expr: 'dist(A,D)' },
        { label: 'DF', expr: 'dist(D,F)' },
      ],
    },
    expect: {
      kind: 'pass',
      readouts: { CD: '5.00', AD: '10.00', DF: '2.50' },
    },
  },

  {
    name: '坐标数组里写表达式：[0, "a"]',
    why:
      '2026-10-28 一次生成冒出 15 条「坐标数组含非法数字」的假错——模型把变量塞进数组，' +
      '而协议原本只收纯数字数组。它表达的意思完全正确，是求值器太死板。',
    gate: '数值关',
    scene: {
      meta: { title: '数组表达式' },
      view: { xMin: -1, xMax: 6, yMin: -1, yMax: 6 },
      params: [
        { name: 'a', label: 'a', min: 1, max: 5, step: 0.1, value: 3 },
        { name: 'b', label: 'b', min: 1, max: 8, step: 0.1, value: 4 },
      ],
      objects: [
        { type: 'point', id: 'A', at: [0, 'a'], label: 'A' },
        { type: 'point', id: 'B', at: ['b', 0], label: 'B' },
        { type: 'segment', id: 'AB', from: [0, 'a'], to: ['b', 0] },
      ],
      readouts: [{ label: 'AB', expr: 'dist(0, a, b, 0)' }],
    },
    expect: { kind: 'pass', readouts: { AB: '5.00' } },
  },
  {
    name: '全角逗号与数学减号：0，a / b − 0',
    why:
      '从微信、Word、教材电子版复制出来的表达式里常带全角逗号「，」和数学减号「−」' +
      '（U+2212）。它们和 ASCII 长得一模一样，却会让坐标静默算不出数，' +
      '而旧报错只说"不是有限数字"，根本查不出来。',
    gate: '数值关',
    scene: {
      meta: { title: '全角符号' },
      view: { xMin: -1, xMax: 6, yMin: -1, yMax: 6 },
      params: [
        { name: 'a', label: 'a', min: 1, max: 5, step: 0.1, value: 3 },
        { name: 'b', label: 'b', min: 1, max: 8, step: 0.1, value: 4 },
      ],
      objects: [
        // 「，」是全角逗号（U+FF0C），「−」是数学减号（U+2212）
        { type: 'point', id: 'A', at: '0\uff0ca', label: 'A' },
        { type: 'point', id: 'B', at: 'b \u2212 0, 0', label: 'B' },
        // 连成线段：体检会把"既没约束、又没任何东西用到"的点判成孤点并拦下
        // （真实几何题里两个点本来也不会孤立存在）。这条用例测的是全角符号能否求值，
        // 不能因为场景过于极简被孤点规则误伤。
        { type: 'segment', id: 'AB', from: '0\uff0ca', to: 'b \u2212 0, 0' },
      ],
      readouts: [{ label: 'AB', expr: 'dist(0, a, b, 0)' }],
    },
    expect: { kind: 'pass', readouts: { AB: '5.00' } },
  },
  {
    name: '用点 id 引用坐标：from: "A" / to: "B"',
    why:
      '同一个事故里 14 条错有 12 条是这个原因：模型写 {"from":"A"} 指代 A 点坐标，' +
      '这是最自然的写法，协议却不认。现在解析阶段会把它展开成坐标表达式。',
    gate: '格式关',
    scene: {
      meta: { title: '点 id 引用' },
      view: { xMin: -1, xMax: 6, yMin: -1, yMax: 5 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 0], label: 'A' },
        { type: 'point', id: 'B', at: [4, 0], label: 'B' },
        { type: 'point', id: 'C', at: [4, 3], label: 'C' },
        { type: 'segment', id: 'AB', from: 'A', to: 'B' },
        { type: 'segment', id: 'BC', from: 'B', to: 'C' },
        { type: 'segment', id: 'CA', from: 'C', to: 'A' },
      ],
      constraints: [{ type: 'perp', points: ['A', 'B', 'C'] }],
      readouts: [{ label: 'AC', expr: 'dist(A,C)' }],
    },
    expect: { kind: 'pass', readouts: { AC: '5.00' } },
  },

  /* ============================================================
   * 三、派生点：让程序算，别让模型算
   * ============================================================ */
  {
    name: '派生垂足 foot：O 到 AB 的垂足',
    why:
      '模型手算垂足公式必错（实测三次重试给出同一个错的 k）。现在它只声明 "H 是 O 到 AB 的垂足"，' +
      '坐标由程序生成，⊥ 关系天然成立。',
    gate: '综合',
    scene: {
      meta: { title: '垂足' },
      view: { xMin: -1, xMax: 5, yMin: -1, yMax: 4 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 3], label: 'A' },
        { type: 'point', id: 'B', at: [4, 0], label: 'B' },
        { type: 'point', id: 'O', at: [0, 0], label: 'O' },
        { type: 'point', id: 'H', derive: { kind: 'foot', p: 'O', line: ['A', 'B'] }, label: 'H' },
        { type: 'segment', id: 'AB', from: 'A', to: 'B' },
        { type: 'segment', id: 'OH', from: 'O', to: 'H', dashed: true },
      ],
      constraints: [{ type: 'perp', points: ['O', 'H', 'A'] }],
      readouts: [
        { label: 'OH', expr: 'dist(O,H)' }, // 直角三角形斜边上的高 = 3·4/5 = 2.4
        { label: '∠OHA', expr: 'angle(O,H,A)', unit: '°' },
      ],
    },
    expect: { kind: 'pass', readouts: { OH: '2.40', '∠OHA': '90.00°' } },
  },
  {
    name: '派生交点 intersect：两条对角线交于 (2, 2)',
    why:
      '同一类问题的另一种：交点。模型随手填坐标就会错位（实测 F 偏离中点 2.21）。' +
      '现在声明 intersect，并同时用两条 on-segment 约束反过来验收它确实在两条线上。',
    gate: '综合',
    scene: {
      meta: { title: '交点' },
      view: { xMin: -1, xMax: 5, yMin: -1, yMax: 5 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 0], label: 'A' },
        { type: 'point', id: 'B', at: [4, 4], label: 'B' },
        { type: 'point', id: 'C', at: [0, 4], label: 'C' },
        { type: 'point', id: 'D', at: [4, 0], label: 'D' },
        {
          type: 'point',
          id: 'X',
          derive: { kind: 'intersect', l1: ['A', 'B'], l2: ['C', 'D'] },
          label: 'X',
        },
        { type: 'segment', id: 'AB', from: 'A', to: 'B' },
        { type: 'segment', id: 'CD', from: 'C', to: 'D' },
      ],
      constraints: [
        { type: 'on-segment', p: 'X', ends: ['A', 'B'] },
        { type: 'on-segment', p: 'X', ends: ['C', 'D'] },
      ],
      readouts: [{ label: 'AX', expr: 'dist(A,X)' }],
    },
    expect: { kind: 'pass', readouts: { AX: '2.83' } }, // 2√2 = 2.828
  },

  /* ============================================================
   * 四、护栏必须真的会拦（负向用例）
   * 这些是"故意写错"，如果哪天全部通过，说明护栏失效了
   * ============================================================ */
  {
    name: '【应拦】除零：半径 1/(a−a)',
    why:
      '数值关的核心能力。注意：模型通常会聪明地把 a 的范围避开 0（那样不算错），' +
      '所以这里手写一个恒等于除零的表达式，验证护栏本身还在。',
    gate: '数值关',
    scene: {
      meta: { title: '除零' },
      view: { xMin: -3, xMax: 3, yMin: -3, yMax: 3 },
      params: [{ name: 'a', label: 'a', min: 0.5, max: 3, step: 0.1, value: 1 }],
      objects: [{ type: 'circle', id: 'c1', center: [0, 0], radius: '1/(a - a)' }],
    },
    expect: { kind: 'fail', match: '算出来是 Infinity' },
  },
  {
    name: '【应拦】假直角：画出来只有 45°',
    why:
      '约束关存在的理由。题目说 ⊥，模型目测写坐标，画出来 45°——屏幕上"看着还行"，' +
      '整张图其实已经废了。这类错误以前没有任何关卡能发现。',
    gate: '约束关',
    scene: {
      meta: { title: '假直角' },
      view: { xMin: -1, xMax: 4, yMin: -1, yMax: 4 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 3], label: 'A' },
        { type: 'point', id: 'C', at: [0, 0], label: 'C' },
        { type: 'point', id: 'B', at: [3, 3], label: 'B' },
      ],
      constraints: [{ type: 'perp', points: ['A', 'C', 'B'] }],
    },
    expect: { kind: 'fail', match: '∠ACB = 45.0' },
  },
  {
    name: '【应拦】D 不在线段 BC 上',
    why:
      '"点在线上"是最常被写错的关系（模型把 D 画到了 AC 上）。约束验算会给出实测距离和修法，' +
      '模型能照着改——这是它能自我修正的前提。',
    gate: '约束关',
    scene: {
      meta: { title: '点不在线段上' },
      view: { xMin: -1, xMax: 5, yMin: -1, yMax: 5 },
      params: [],
      objects: [
        { type: 'point', id: 'B', at: [4, 0], label: 'B' },
        { type: 'point', id: 'C', at: [0, 4], label: 'C' },
        { type: 'point', id: 'D', at: [3, 3], label: 'D' },
      ],
      constraints: [{ type: 'on-segment', p: 'D', ends: ['B', 'C'] }],
    },
    expect: { kind: 'fail', match: 'D 在线段 BC 上' },
  },
  {
    name: '【应拦】坐标引用了没登记的变量 fx、fy',
    why:
      '报错必须点名。以前只写"坐标求值结果不是有限数字"，模型看了只能瞎猜；' +
      '现在会说"x 分量「fx」求值抛异常：fx is not defined"，一步就能定位。',
    gate: '数值关',
    scene: {
      meta: { title: '未定义名称' },
      view: { xMin: -1, xMax: 5, yMin: -1, yMax: 5 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 0], label: 'A' },
        { type: 'segment', id: 's1', from: 'A', to: 'fx, fy' },
      ],
    },
    expect: { kind: 'fail', match: '「fx」' },
  },
  {
    name: '【应拦】步骤 reveal 了不存在的对象 ghost1',
    why:
      'steps 里的 highlight 和 reveal 分级不同：highlight 写错只是"该亮的地方不亮"（提醒级），' +
      'reveal 写错是"这个对象永远不会出现"，属于硬伤——必须报错拦截，否则讲解讲到"交点出现了"，' +
      '画面上什么都没有。',
    gate: '数值关',
    scene: {
      meta: { title: '幽灵 id' },
      view: { xMin: -6, xMax: 6, yMin: -5, yMax: 5 },
      params: [{ name: 'a', label: 'a', min: -2, max: 2, step: 0.1, value: 1 }],
      objects: [{ type: 'curve', id: 'par', expr: 'a*x^2 - 1' }],
      steps: [{ title: '第一步', text: '交点出现了', reveal: ['ghost1'] }],
    },
    expect: { kind: 'fail', match: 'ghost1' },
  },
  {
    name: 'highlight 指向幽灵 id 只提醒、不拦截',
    why:
      '这条守的是"分级"本身：highlight 错了画面还是对的（只是不亮），退回整份场景反而更糟。' +
      '如果哪天有人把这条改成 error，用户会莫名其妙生成失败。',
    gate: '数值关',
    scene: {
      meta: { title: '幽灵高亮' },
      view: { xMin: -6, xMax: 6, yMin: -5, yMax: 5 },
      params: [{ name: 'a', label: 'a', min: -2, max: 2, step: 0.1, value: 1 }],
      objects: [{ type: 'curve', id: 'par', expr: 'a*x^2 - 1' }],
      steps: [{ title: '第一步', text: '看这条曲线', highlight: ['par', 'ghost2'] }],
    },
    expect: { kind: 'pass', warn: 'ghost2' },
  },
  {
    name: '【应拦】线段缺 to 字段',
    why: '格式关的基本职责：字段缺失要在渲染之前挡掉，不能让渲染器去猜。',
    gate: '格式关',
    scene: {
      meta: { title: '缺字段' },
      view: { xMin: -1, xMax: 5, yMin: -1, yMax: 5 },
      params: [],
      objects: [{ type: 'segment', id: 's1', from: [0, 0] }],
    },
    expect: { kind: 'fail', match: '的 to 必须' },
  },

  /* ============================================================
   * 五、正向基线：这些永远不能坏
   * ============================================================ */
  {
    name: '二次函数：滑杆 + 曲线 + 顶点读数',
    why:
      '最基础的正向场景。曾经因为"自动兜底取景"写错并集，画面被挤成中间一条竖带——' +
      '数据层没问题，渲染层错了。所以这条只守数据层；视野相关的回归由下面的渲染层用例负责。',
    gate: '数值关',
    scene: {
      meta: { title: '二次函数' },
      view: { xMin: -6, xMax: 6, yMin: -5, yMax: 5 },
      params: [{ name: 'a', label: 'a', min: -2, max: 2, step: 0.1, value: 1 }],
      objects: [
        { type: 'curve', id: 'par', label: 'y=f(x)', expr: 'a*x^2 - 2*a*x + 1', domain: [-5, 5] },
        { type: 'point', id: 'vertex', at: '1, 1 - a', label: '顶点' },
      ],
      readouts: [{ label: '顶点坐标', expr: 'pt(1, 1 - a)' }],
    },
    expect: { kind: 'pass', readouts: { 顶点坐标: '(1.00, 0.00)' } },
  },
  {
    name: '参数曲线 parametric：爱心',
    why:
      'y=f(x) 表达不了"同一 x 多个 y"的封闭曲线，所以加了 parametric。' +
      '这条防止以后改动把参数曲线类型弄坏（换名、字段拼错、t 变量被过滤掉）。',
    gate: '数值关',
    scene: {
      meta: { title: '爱心' },
      view: { xMin: -20, xMax: 20, yMin: -20, yMax: 20 },
      params: [],
      objects: [
        {
          type: 'parametric',
          id: 'heart',
          xExpr: '16*sin(t)^3',
          yExpr: '13*cos(t) - 5*cos(2*t) - 2*cos(3*t) - cos(4*t)',
          tRange: [0, 6.283185],
        },
      ],
    },
    expect: { kind: 'pass' },
  },
  {
    name: '超长 label 只提醒、不拦截',
    why:
      '这条测的是"分级"这个设计：label 太长只是不好看，不该让整份场景被退回。' +
      '如果哪天它被当成 error，用户会莫名其妙生成失败。',
    gate: '数值关',
    scene: {
      meta: { title: '长标签' },
      view: { xMin: -3, xMax: 3, yMin: -3, yMax: 3 },
      params: [],
      objects: [{ type: 'point', id: 'P', at: [1, 1], label: '这是一个特别长的标签名字' }],
    },
    expect: { kind: 'pass', warn: '超过 10 个字符' },
  },

  /* ============================================================
   * 五、解三角形：定角 / 定比 / 定值 + area 读数
   * （原题：a²−b²=c²−√3bc，2cosB=sinC；D 在 AB 上 BD=2AD，CD=2，求 S△ACD）
   * ============================================================ */
  {
    name: '金标准2：解三角形，S△ACD = 0.80、CD = 2.00',
    why:
      '三角题的标准答案必须能被程序量出来。这条用了三种新能力：' +
      'angle-value（∠A=30/∠B=60/∠C=90）、section 派生点（BD=2AD）、' +
      'value（CD=2 定住缩放）+ area 读数。它同时钉住"判断形状"和"求面积"两问。',
    gate: '综合',
    scene: {
      meta: { title: '解三角形求面积' },
      view: { xMin: -0.5, xMax: 2.3, yMin: -0.5, yMax: 3.4 },
      // h = AC；取 2*sqrt(27/13) 时 CD 恰好 = 2
      params: [{ name: 'h', label: 'AC', min: 1, max: 5, step: 0.01, value: 2.8823 }],
      objects: [
        { type: 'point', id: 'C', at: [0, 0], label: 'C' },
        { type: 'point', id: 'A', at: [0, 'h'], label: 'A' },
        { type: 'point', id: 'B', at: ['h/sqrt(3)', 0], label: 'B' },
        { type: 'point', id: 'D', label: 'D', derive: { kind: 'section', a: 'A', b: 'B', t: '1/3' } },
        { type: 'segment', id: 'CA', from: 'C', to: 'A' },
        { type: 'segment', id: 'CB', from: 'C', to: 'B' },
        { type: 'segment', id: 'AB', from: 'A', to: 'B' },
        { type: 'segment', id: 'CD', from: 'C', to: 'D' },
      ],
      readouts: [
        { label: '∠A', expr: 'angle(B,A,C)', unit: '°' },
        { label: '∠B', expr: 'angle(A,B,C)', unit: '°' },
        { label: '∠C', expr: 'angle(A,C,B)', unit: '°' },
        { label: 'CD', expr: 'dist(C,D)' },
        { label: 'S', expr: 'area(A,C,D)' },
      ],
      constraints: [
        { type: 'angle-value', points: ['A', 'C', 'B'], deg: 90 },
        { type: 'angle-value', points: ['B', 'A', 'C'], deg: 30 },
        { type: 'angle-value', points: ['A', 'B', 'C'], deg: 60 },
        { type: 'on-segment', p: 'D', ends: ['A', 'B'] },
        { type: 'length-ratio', a: ['B', 'D'], b: ['A', 'D'], ratio: 2 },
        { type: 'value', expr: 'dist(C,D)', equals: 2 },
      ],
    },
    // 6√3/13 ≈ 0.7994 → 0.80
    expect: {
      kind: 'pass',
      readouts: { '∠A': '30.00°', '∠B': '60.00°', '∠C': '90.00°', CD: '2.00', S: '0.80' },
    },
  },
  {
    name: '【应拦】角度画错了：声明 ∠A=30°，实际画成 45°',
    why:
      '判断三角形形状的题，结论全在角度上。以前协议只能表达"垂直"，' +
      '30°/60° 写错了程序无从发现，图看着还挺像。angle-value 就是补这个洞。',
    gate: '约束关',
    scene: {
      meta: { title: '假角' },
      view: { xMin: -1, xMax: 4, yMin: -1, yMax: 4 },
      params: [],
      objects: [
        { type: 'point', id: 'C', at: [0, 0], label: 'C' },
        { type: 'point', id: 'A', at: [0, 3], label: 'A' },
        // 等腰直角 → ∠A 实际 45°，与声明的 30° 不符
        { type: 'point', id: 'B', at: [3, 0], label: 'B' },
      ],
      constraints: [
        { type: 'angle-value', points: ['A', 'C', 'B'], deg: 90 },
        { type: 'angle-value', points: ['B', 'A', 'C'], deg: 30 },
      ],
    },
    expect: { kind: 'fail', match: '∠BAC 应为 30°' },
  },
  {
    name: '【应拦】比例画错了：BD = 2AD 写成 BD = AD',
    why:
      '"BD = 2AD"这类倍数关系以前没人管：D 随手放在中点，图看着合理，答案全错。' +
      'length-ratio 让程序去量两段长度之比。',
    gate: '约束关',
    scene: {
      meta: { title: '错比例' },
      view: { xMin: -1, xMax: 4, yMin: -1, yMax: 4 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 3], label: 'A' },
        { type: 'point', id: 'B', at: [3, 0], label: 'B' },
        // 中点 → BD : AD = 1，不是 2
        { type: 'point', id: 'D', label: 'D', derive: { kind: 'midpoint', a: 'A', b: 'B' } },
      ],
      constraints: [{ type: 'length-ratio', a: ['B', 'D'], b: ['A', 'D'], ratio: 2 }],
    },
    expect: { kind: 'fail', match: '|BD| : |AD| = 2' },
  },
  {
    name: '【应拦】题面给的数值没兑现：CD 应等于 2',
    why:
      '坐标可以随便缩放（画大了画小了都不影响形状），只有题面给定的长度能把比例定死。' +
      'value 约束就是那道锁——它也是"答案算错"最直接的拦网。',
    gate: '约束关',
    scene: {
      meta: { title: '错长度' },
      view: { xMin: -1, xMax: 4, yMin: -1, yMax: 4 },
      params: [],
      objects: [
        { type: 'point', id: 'C', at: [0, 0], label: 'C' },
        { type: 'point', id: 'A', at: [0, 3], label: 'A' },
        { type: 'point', id: 'B', at: [3, 0], label: 'B' },
        { type: 'point', id: 'D', label: 'D', derive: { kind: 'midpoint', a: 'A', b: 'B' } },
      ],
      // dist(C, 中点) = √(1.5²+1.5²) = 2.12 ≠ 2
      constraints: [{ type: 'value', expr: 'dist(C,D)', equals: 2 }],
    },
    expect: { kind: 'fail', match: 'dist(C,D) 应等于 2' },
  },
  {
    name: 'arc 的 from/to 写成数字不该崩（replace is not a function）',
    why:
      '模型经常把角度写成 {"from": 0, "to": 1.5708}（数字而不是字符串），' +
      '以前会一路走到 normalizeExpr 才炸 "out.replace is not a function"，' +
      '报错完全指不到真正的字段。现在直接当常量处理。',
    gate: '数值关',
    scene: {
      meta: { title: '数字角度' },
      view: { xMin: -3, xMax: 3, yMin: -3, yMax: 3 },
      params: [],
      objects: [
        { type: 'arc', id: 'a1', center: [0, 0], radius: '2', from: 0, to: 1.5708 },
      ],
    },
    expect: { kind: 'pass' },
  },

  /* ============================================================
   * 五、图形与题意的一致性："答案对但图不对"是真实报过的问题
   *    约束只管"角多大、边多长"，管不住"图长什么样"。这两条守着新增的两层检查。
   * ============================================================ */
  {
    name: '【应提示】步骤讲 △ACD 和 CD=2，图上却没有 CD 这条线',
    why:
      '用户实际反馈过："答案没问题，左边生成的图不对应"。约束全过、读数全对，' +
      '但图上少了一条线、点摆错了位置——以前的关卡全都看不见。' +
      '这两层检查就是为了让"图和文字对不上"变成可见的提示。',
    gate: '约束关',
    scene: {
      meta: { title: '答案对但图不对' },
      view: { xMin: -1, xMax: 5, yMin: -1, yMax: 5 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 3], label: 'A' },
        { type: 'point', id: 'B', at: [4, 0], label: 'B' },
        { type: 'point', id: 'C', at: [0, 0], label: 'C' },
        { type: 'point', id: 'D', at: [2, 1.5], label: 'D' },
        { type: 'segment', id: 'AB', from: 'A', to: 'B' },
        { type: 'segment', id: 'AC', from: 'A', to: 'C' },
        { type: 'segment', id: 'BC', from: 'B', to: 'C' },
        { type: 'segment', id: 'AD', from: 'A', to: 'D' },
      ],
      // 本用例只测"缺线段提醒"；解题场景零约束现在会被打回，所以补两条真实成立的约束
      constraints: [
        { type: 'angle-value', points: ['A', 'C', 'B'], deg: 90 },
        { type: 'midpoint', m: 'D', ends: ['A', 'B'] },
      ],
      steps: [
        { title: '看三角形', text: '在 Rt△ACD 中，$\\angle ACD = 30^\\circ$' },
        { title: '求长', text: '因为 CD = 2，所以面积是 0.8' },
      ],
    },
    expect: { kind: 'pass', warn: '缺边 CD' },
  },
  {
    name: '好图不许被误报：线画齐了、约束也登记了',
    why:
      '上一版检查如果实现得糙（比如把所有点都当成"未约束"、或把 △ACD 的三条边算错），' +
      '好图也会被刷一堆提醒，人就会习惯性忽略提醒——那这套检查就废了。' +
      '这条用同一张图补齐 CD 并登记三条约束，要求一条提示都不许有。',
    gate: '约束关',
    scene: {
      meta: { title: '图与题一致' },
      view: { xMin: -1, xMax: 5, yMin: -1, yMax: 5 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 3], label: 'A' },
        { type: 'point', id: 'B', at: [4, 0], label: 'B' },
        { type: 'point', id: 'C', at: [0, 0], label: 'C' },
        { type: 'point', id: 'D', at: [2, 1.5], label: 'D' },
        { type: 'segment', id: 'AB', from: 'A', to: 'B' },
        { type: 'segment', id: 'AC', from: 'A', to: 'C' },
        { type: 'segment', id: 'BC', from: 'B', to: 'C' },
        { type: 'segment', id: 'AD', from: 'A', to: 'D' },
        { type: 'segment', id: 'CD', from: 'C', to: 'D' },
      ],
      constraints: [
        { type: 'angle-value', points: ['A', 'C', 'B'], deg: 90 },
        { type: 'on-segment', p: 'D', ends: ['A', 'B'] },
        { type: 'value', expr: 'dist(C,D)', equals: 2.5 },
      ],
      steps: [
        { title: '看三角形', text: '在 Rt△ACD 中，$\\angle ACD = 30^\\circ$' },
        { title: '求长', text: '因为 CD = 2.5，所以面积是 0.8' },
      ],
    },
    expect: { kind: 'pass', noWarn: '没有把' },
  },
  {
    name: '约束关：曲线上的点用 curve-point 派生（椭圆 + 滑杆 m）',
    why:
      '2026-11-05 真实事故：椭圆 x²/(m+9)+y²/(25−m)=1 那道题，曲线上的点全是手写坐标，' +
      '位置没人验证，图与讲解从第一句就对不上。这条用例锁定新写法：' +
      '曲线上的点用 derive 的 curve-point 取，位置天然在曲线上，且滑杆推 m 时点跟着曲线走。' +
      '顺带锁定 pi 小写别名——t 写成 "pi/2" 必须能算。',
    gate: '约束关',
    scene: {
      meta: { title: '椭圆上的点' },
      visual: 'figure',
      view: { xMin: -7, xMax: 7, yMin: -7, yMax: 7 },
      params: [{ name: 'm', label: 'm', min: 0, max: 20, step: 0.5, value: 0 }],
      objects: [
        {
          type: 'parametric',
          id: 'E',
          xExpr: 'sqrt(m+9)*cos(t)',
          yExpr: 'sqrt(25-m)*sin(t)',
        },
        {
          type: 'point',
          id: 'P',
          derive: { kind: 'curve-point', curve: 'E', t: 'pi/2' },
          label: 'P',
        },
      ],
      constraints: [{ type: 'on-curve', p: 'P', curve: 'E' }],
    },
    expect: { kind: 'pass', noWarn: '超出曲线' },
  },
  {
    name: '【应拦】曲线上的点手写坐标，偏出曲线',
    why:
      '手写的坐标几乎不可能正好落在曲线上（真实事故里 P 飘在椭圆外 1 个多单位，' +
      '肉眼却看不出）。on-curve 必须算出实际距离并打回，而不是"看着差不多"就放过。',
    gate: '约束关',
    scene: {
      meta: { title: '点不在椭圆上' },
      view: { xMin: -7, xMax: 7, yMin: -7, yMax: 7 },
      params: [{ name: 'm', label: 'm', min: 0, max: 20, step: 0.5, value: 0 }],
      objects: [
        {
          type: 'parametric',
          id: 'E',
          xExpr: 'sqrt(m+9)*cos(t)',
          yExpr: 'sqrt(25-m)*sin(t)',
        },
        { type: 'point', id: 'P', at: [3, 3], label: 'P' },
      ],
      constraints: [{ type: 'on-curve', p: 'P', curve: 'E' }],
    },
    expect: { kind: 'fail', match: '在曲线 E 上' },
  },
  {
    name: '【应拦】curve-point 引用了不存在的曲线 id',
    why:
      '写错曲线 id 时坐标会变成 NaN，以前只会报一句"未定义名称 NaN"，' +
      '完全指不到真正的问题。现在必须明说"objects 里没有这个 id"。',
    gate: '格式关',
    scene: {
      meta: { title: '曲线 id 写错' },
      view: { xMin: -7, xMax: 7, yMin: -7, yMax: 7 },
      params: [],
      objects: [
        {
          type: 'parametric',
          id: 'E',
          xExpr: '3*cos(t)',
          yExpr: '5*sin(t)',
        },
        {
          type: 'point',
          id: 'P',
          derive: { kind: 'curve-point', curve: 'nope', t: 0 },
          label: 'P',
        },
      ],
    },
    expect: { kind: 'fail', match: '没有这个 id' },
  },
];

/* ================================================================
 * 渲染层用例（需要真的创建 WebGL 画布）
 *
 * 数据层测试看不到「画面」——而历史上最惨的一次事故恰恰是渲染层的：
 * 兜底取景算并集少写一层，把视野从 [-6,6] 覆盖成 [-1,1]，
 * 整个画面挤成中间一条竖带，旁边全空。
 *
 * 这类问题能自动测：渲染完把「最终视野」读出来，断言
 *   ① 该扩的时候扩到了（内容都在视野内）
 *   ② 不该动的时候一点没动（防止视图被压窄）
 *   ③ 扩幅有上限（防止一个离谱坐标把画面撕成空白）
 * ================================================================ */

export interface RenderCase {
  name: string;
  why: string;
  scene: unknown;
  expect: {
    /** 这些世界坐标点必须都落在最终视野内 */
    contains?: Array<[number, number]>;
    /** 最终视野至少要覆盖到这些边界 */
    atLeast?: { xMin?: number; xMax?: number; yMin?: number; yMax?: number };
    /** 最终视野必须与原场景声明的 view 完全一致（该不动时不许动） */
    unchanged?: boolean;
    /** 视野跨度上限（世界单位） */
    maxSpan?: { x?: number; y?: number };
  };
}

export const RENDER_CASES: RenderCase[] = [
  {
    name: '视野装不下内容时自动扩张（将军饮马式）',
    why:
      'LLM 常给出装不下自己坐标的 view（点放在 (8,0)，view 只到 2），画面被裁掉一半。' +
      '渲染器必须在画完后按实际坐标把视野扩到装下——只扩不缩。',
    scene: {
      meta: { title: '兜底取景' },
      view: { xMin: -2, xMax: 2, yMin: -2, yMax: 2 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 6], label: 'A' },
        { type: 'point', id: 'B', at: [8, 0], label: 'B' },
        { type: 'point', id: 'Bp', at: [8, 12], label: "B'" },
        { type: 'point', id: 'P', at: [4, 0], label: 'P' },
        { type: 'segment', id: 'AP', from: 'A', to: 'P' },
        { type: 'segment', id: 'shore', from: [-2, 0], to: [10, 0], dashed: true },
      ],
    },
    expect: {
      contains: [
        [0, 6],
        [8, 0],
        [8, 12],
        [4, 0],
      ],
      atLeast: { xMin: -2, xMax: 8, yMin: -2, yMax: 12 },
    },
  },
  {
    name: '内容装得下时视野一动不动',
    why:
      '这条是那次事故的直接回归测试：bug 版本会把 x 从 [-6,6] 覆盖成内容包围盒 [-1,1]，' +
      '画面变成中间一条竖带。虽然内容全在视野内（所以 contains 检查会通过），' +
      '但视野被压窄了——unchanged 就是抓这个的。',
    scene: {
      meta: { title: '不折腾' },
      view: { xMin: -6, xMax: 6, yMin: -5, yMax: 5 },
      params: [{ name: 'a', label: 'a', min: -2, max: 2, step: 0.1, value: 1 }],
      objects: [
        { type: 'curve', id: 'par', expr: 'a*x^2 - 2*a*x + 1', domain: [-5, 5] },
        { type: 'point', id: 'vertex', at: '1, 1 - a', label: '顶点' },
        { type: 'point', id: 'side', at: '2, -1', label: 'P' },
      ],
    },
    expect: { unchanged: true, contains: [[1, 0]] },
  },
  {
    name: '单侧超界时，另一侧不许被挤窄',
    why:
      '这是那次"画面挤成中间一条竖带"事故的精确复现：y 方向有点超出（y=8 > yMax=5）触发兜底扩张，' +
      '而错误的实现（算并集漏了外层 min）会把 x 一起覆盖成内容包围盒 [0,1]±8%，整张图变成一根竖条，' +
      '左右各留一大片空白。正确行为是"只扩不缩"：x 保持 [-6,6] 不动，只把 y 扩到装下。' +
      '注意：光看"内容都在视野内"是抓不住它的（挤窄后内容也还在），必须断言边界没有被缩小。',
    scene: {
      meta: { title: '单侧超界' },
      view: { xMin: -6, xMax: 6, yMin: -5, yMax: 5 },
      params: [],
      objects: [
        { type: 'point', id: 'A', at: [0, 8], label: 'A' },
        { type: 'point', id: 'B', at: [1, 0], label: 'B' },
        { type: 'segment', id: 'AB', from: 'A', to: 'B' },
      ],
    },
    expect: {
      contains: [[0, 8]],
      // 关键：x 两侧必须都还在原来的位置上
      atLeast: { xMin: -6, xMax: 6, yMax: 8 },
    },
  },
  {
    name: '扩幅有上限：离谱坐标不会把画面撕成空白',
    why:
      '安全阀。如果一个点被写成 (1000, 1000)，无上限的兜底会把视野放大到整屏空白，' +
      '比裁切更糟——用户看到的是"什么都没画"。' +
      '上限的算法是「每个方向最多各扩 6 倍原跨度」，所以总跨度最大约 11 倍' +
      '（原跨度 10 → 110）。没有安全阀时这一格会是 1158，一眼就能看出退化。',
    scene: {
      meta: { title: '离谱坐标' },
      view: { xMin: -5, xMax: 5, yMin: -5, yMax: 5 },
      params: [],
      objects: [
        { type: 'point', id: 'ok', at: [1, 1], label: 'A' },
        { type: 'point', id: 'wild', at: [1000, 1000], label: 'X' },
      ],
    },
    // 原跨度 10 → 每边最多扩 60 → 总跨度上限 5+60 与 -5-60 之间 = 110
    expect: { maxSpan: { x: 110.001, y: 110.001 } },
  },
];

/* ================================================================
 * 二、立体几何（3D）
 *
 * 这套用例走的是**另一条链路**：parseScene3D → verifyScene3D → measureReadouts3D。
 * 2D 的解析器不认 point3/edge3/face3，所以必须分开列——
 * 混进 CASES 会让每条用例都先挂在"未知类型 point3"上。
 *
 * 这里最想守住的三件事：
 *   ① 面必须覆盖全部棱（决定虚实判断走哪条路）；
 *   ② 顶点坐标不能全共面（"假 3D"，模型最常犯的错）；
 *   ③ derive 的重心/中点/垂足真的算对了（不是摆设）。
 * ================================================================ */

export interface TestCase3D {
  name: string;
  why: string;
  gate: '综合' | '格式关' | '数值关' | '约束关' | '结构关';
  scene: unknown;
  expect: Expect;
}

/**
 * 去掉体对角线的正方体：12 条棱全部被两个面共享。
 * 这是"干净"的基准——体检不该有任何提醒。
 */
function cleanCube() {
  const s = buildCube(cubeDefaults);
  return { ...s, objects: s.objects.filter((o) => o.id !== 'diag') };
}

export const CASES_3D: TestCase3D[] = [
  {
    name: '金标准·立体：正方体（8 顶点 / 12 棱 / 6 面，零提醒）',
    why:
      '3D 链路的基础用例。同时守住两件事：面必须把每条棱都盖住（否则那条棱会走射线判断，' +
      '虚实大概率画错），以及 resolve3d 把 readouts 里的 dist3(A,B) 正确展开成三坐标。',
    gate: '综合',
    scene: cleanCube(),
    expect: {
      kind: 'pass',
      readouts: { AB: '2.00', 'AC₁（体对角线）': '3.46' },
      noWarn: '不属于任何面',
    },
  },
  {
    name: '体对角线（自由棱）：只提醒，不拦截',
    why:
      '演示用的正方体故意画了一条体对角线，它两侧没有面，虚实只能靠射线求交判断。' +
      '这种情况**不该打回重做**（图和题都对），但要提醒一句——' +
      '如果模型的意图是辅助线，应该显式写 "dashed": true，而不是依赖射线碰运气。',
    gate: '结构关',
    scene: buildCube(cubeDefaults),
    expect: { kind: 'pass', warn: '不属于任何面' },
  },
  {
    name: '金标准·立体：正四面体（重心 derive + 高 + 面积）',
    why:
      '正四面体的底面重心 G 是用 derive 的 centroid 算出来的，不是手写坐标。' +
      '读数同时校验三件事：侧棱 = 棱长、高 = a·√(2/3)、底面积 = √3/4·a²。',
    gate: '综合',
    scene: buildTetra(tetraDefaults),
    expect: {
      kind: 'pass',
      readouts: { SA: '2.40', '高 SG': '1.96', 'S△ABC': '2.49' },
      noWarn: '不属于任何面',
    },
  },
  {
    name: '正四棱锥：参数表达式 + derive 中点 + 三条约束',
    why:
      '模型生成的立体场景长这样：坐标写成 "a/2, a/2, h" 这样的表达式，' +
      '底面中心用 derive 的中点算，约束声明"侧棱相等""底面四点共面""高垂直底边"。' +
      'PA = √11 只有坐标真的按公式搭出来才对得上。',
    gate: '综合',
    scene: {
      space: '3d',
      meta: { title: '正四棱锥 P-ABCD' },
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
      readouts: [
        { label: 'PA', expr: 'dist3(P,A)' },
        { label: '高 PH', expr: 'dist3(P,H)' },
      ],
      constraints: [
        { type: 'equal-length', a: ['P', 'A'], b: ['P', 'B'] },
        { type: 'coplanar', points: ['A', 'B', 'C', 'D'] },
        { type: 'perp-lines', a: ['P', 'H'], b: ['A', 'B'] },
      ],
    },
    expect: {
      kind: 'pass',
      readouts: { PA: '3.32', '高 PH': '3.00' },
      noWarn: '不属于任何面',
    },
  },
  {
    name: '假 3D：所有顶点都在 z = 0 平面上，必须拦下',
    why:
      '这是立体几何里最高频的事故——模型"画立体图"却只给了 x、y 两个维度，' +
      '结果渲染出一张平面图，用户以为是假的 3D。' +
      '只查坐标格式是拦不住的（"0, 0, 0" 完全合法），必须做共面判定。',
    gate: '结构关',
    scene: {
      space: '3d',
      meta: { title: '假 3D' },
      params: [],
      objects: [
        { type: 'point3', id: 'A', at: '0, 0, 0' },
        { type: 'point3', id: 'B', at: '2, 0, 0' },
        { type: 'point3', id: 'C', at: '2, 2, 0' },
        { type: 'point3', id: 'D', at: '0, 2, 0' },
        { type: 'face3', id: 'f', points: ['A', 'B', 'C', 'D'] },
        { type: 'edge3', id: 'AB', a: 'A', b: 'B' },
        { type: 'edge3', id: 'BC', a: 'B', b: 'C' },
      ],
    },
    expect: { kind: 'fail', match: '都落在同一个平面上' },
  },
  {
    name: '两个顶点坐标完全相同，必须拦下',
    why:
      '手写坐标时复制上一行忘了改，是模型（和人）都会犯的错。' +
      '图上会少一个角，但不报错、不空白，只能靠体检点出来。',
    gate: '结构关',
    scene: {
      space: '3d',
      meta: { title: '顶点重合' },
      params: [],
      objects: [
        { type: 'point3', id: 'A', at: '0, 0, 0' },
        { type: 'point3', id: 'B', at: '2, 0, 0' },
        { type: 'point3', id: 'C', at: '2, 2, 0' },
        { type: 'point3', id: 'P', at: '1, 1, 2' },
        { type: 'point3', id: 'Q', at: '1, 1, 2' },
        { type: 'edge3', id: 'e1', a: 'A', b: 'B' },
        { type: 'edge3', id: 'e2', a: 'B', b: 'Q' },
      ],
    },
    expect: { kind: 'fail', match: '坐标完全相同' },
  },
  {
    name: '约束关：声明的"高垂直于底边"其实不垂直',
    why:
      '这是"图不对但看着像"的典型：顶点偏了 0.3，肉眼几乎看不出，' +
      '但 PH 与 AB 的夹角只有 84°，后面所有推导都会跟着错。' +
      '约束是唯一能自动抓住它的东西——必须报出实测夹角。',
    gate: '约束关',
    scene: {
      space: '3d',
      meta: { title: '假垂直' },
      params: [
        { name: 'h', label: '高', min: 1, max: 5, step: 0.1, value: 3 },
      ],
      objects: [
        { type: 'point3', id: 'A', at: '0, 0, 0' },
        { type: 'point3', id: 'B', at: '2, 0, 0' },
        { type: 'point3', id: 'C', at: '2, 2, 0' },
        { type: 'point3', id: 'D', at: '0, 2, 0' },
        { type: 'point3', id: 'H', derive: { kind: 'midpoint', a: 'A', b: 'C' } },
        // 顶点偏了 0.3：垂足应为 (1,1,0)，这里 P 的 x 是 1.3
        { type: 'point3', id: 'P', at: '1.3, 1, h' },
        { type: 'face3', id: 'f', points: ['A', 'B', 'C', 'D'], opacity: 0.4 },
        { type: 'edge3', id: 'AB', a: 'A', b: 'B' },
        { type: 'edge3', id: 'PH', a: 'P', b: 'H', dashed: true },
      ],
      constraints: [
        { type: 'perp-lines', a: ['P', 'H'], b: ['A', 'B'] },
      ],
    },
    expect: { kind: 'fail', match: '两线方向夹角实测' },
  },
  {
    name: '棱引用了不存在的顶点，必须拦下',
    why:
      '模型给棱起名 "AB" 时，很容易把顶点写成 "A₁"（带下标）而顶点 id 是 "A1"。' +
      '这种错误渲染器只会静默跳过那一整条棱，图和题就对不上了。',
    gate: '结构关',
    scene: {
      space: '3d',
      meta: { title: '悬空棱' },
      params: [],
      objects: [
        { type: 'point3', id: 'A', at: '0, 0, 0' },
        { type: 'point3', id: 'B', at: '2, 0, 0' },
        { type: 'point3', id: 'C', at: '1, 1.7, 2' },
        { type: 'edge3', id: 'e1', a: 'A', b: 'B' },
        { type: 'edge3', id: 'e2', a: 'A', b: 'A₁' },
      ],
    },
    expect: { kind: 'fail', match: '引用的顶点「' },
  },
  {
    name: '格式关：坐标只写了两段（x, y）',
    why:
      '从 2D 思维切到 3D 时最常见的格式错误。' +
      '必须点名"拆出 2 段"，否则模型只会看到"坐标不合法"这种没信息量的话，改不对。',
    gate: '格式关',
    scene: {
      space: '3d',
      meta: { title: '两段坐标' },
      params: [],
      objects: [{ type: 'point3', id: 'A', at: '0, 0' }],
    },
    expect: { kind: 'fail', match: '按逗号拆出 2 段' },
  },

  /* ================================================================
   * 旋转体（圆柱 / 圆锥 / 球）
   *
   * 这组用例来自一个具体的 bug：用户说"画一个半径为 2 高为 4 的圆柱"，
   * 出来的是一个棱柱——因为协议里当时没有曲面对象，prompt 教模型"用 12 棱柱近似"。
   * 现在专用对象有了，下面这些用例守着"圆柱必须是圆柱"这件事。
   * ================================================================ */
  {
    name: '金标准·立体：圆柱 OO₁（半径 2、高 4）',
    why:
      '圆柱是最容易被画成棱柱的图形。这里同时守住四件事：' +
      '曲面体引用的圆心 O、O₁ 不能被判成"孤立顶点"；半径表达式 "r" 能求值；' +
      'readouts 里的体积用 PI*r^2*h 算得出；轴 OO₁ 的长度就是高。',
    gate: '综合',
    scene: buildCylinder(cylinderDefaults),
    expect: {
      kind: 'pass',
      readouts: { '高 OO₁': '4.00', '体积 V': '50.27' },
      noWarn: '没有连任何棱',
    },
  },
  {
    name: '金标准·立体：圆锥 + 球（一个场景两个曲面体）',
    why:
      '验证多曲面体共存，以及"球心直接写坐标"这条分支（圆心不一定是顶点 id）。' +
      '母线 l = √(r²+h²) = 3.40 是勾股定理的现场验算。',
    gate: '综合',
    scene: buildRevolution(revDefaults),
    expect: {
      kind: 'pass',
      readouts: { '母线 l': '3.40', 球体积: '17.16' },
      noWarn: '没有连任何棱',
    },
  },
  {
    name: '有旋转体时不该判"假 3D"',
    why:
      '圆柱的圆心、轴上取的点天然共面（轴就是一条直线），' +
      '如果照多面体那条规则判"所有顶点共面"，一张好图会被打回重做。' +
      '曲面体的存在本身就证明这是三维场景，必须豁免。',
    gate: '结构关',
    scene: {
      space: '3d',
      meta: { title: '轴上的点共面（正常）' },
      params: [{ name: 'r', label: '半径', min: 0.5, max: 3, step: 0.1, value: 1 }],
      objects: [
        { type: 'point3', id: 'O', at: '0, 0, 0' },
        { type: 'point3', id: 'M', at: '0, 0, 2' },
        { type: 'point3', id: 'N', at: '0, 0, 3' },
        { type: 'point3', id: 'O1', at: '0, 0, 4' },
        { type: 'cylinder3', id: 'cyl', a: 'O', b: 'O1', radius: 'r' },
      ],
    },
    expect: { kind: 'pass', noWarn: '落在同一个平面上' },
  },
  {
    name: '圆柱半径是 0，必须拦下',
    why:
      '半径为 0 时渲染器算不出轮廓（半径必须为正），会静默跳过整个圆柱，' +
      '画面上什么都不剩，用户只会看到"生成失败"或一片空白。',
    gate: '数值关',
    scene: {
      space: '3d',
      meta: { title: '半径为 0' },
      params: [{ name: 'r', label: '半径', min: 0, max: 3, step: 0.1, value: 0 }],
      objects: [
        { type: 'point3', id: 'O', at: '0, 0, 0' },
        { type: 'point3', id: 'O1', at: '0, 0, 4' },
        { type: 'cylinder3', id: 'cyl', a: 'O', b: 'O1', radius: 'r' },
      ],
    },
    expect: { kind: 'fail', match: '必须大于 0' },
  },
  {
    name: '圆柱的轴端点写了不存在的顶点，必须拦下',
    why:
      '最常见的是 O₁ 带下标、顶点 id 却是 O1。这种情况渲染器只会跳过整个圆柱，' +
      '不报错也不空白，图和题悄悄对不上——必须点名是哪个字段引用了哪个不存在的点。',
    gate: '结构关',
    scene: {
      space: '3d',
      meta: { title: '轴端点不存在' },
      params: [],
      objects: [
        { type: 'point3', id: 'O', at: '0, 0, 0' },
        { type: 'cylinder3', id: 'cyl', a: 'O', b: 'O₂', radius: 2 },
      ],
    },
    expect: { kind: 'fail', match: '找不到顶点' },
  },
  {
    name: '格式关：圆柱的半径写成了坐标',
    why:
      '模型有时把 radius 当成"圆心坐标"填。这种错必须点名"半径是一段数字，不是坐标"，' +
      '否则模型只会看到"字段不合法"，下一次还这么写。',
    gate: '格式关',
    scene: {
      space: '3d',
      meta: { title: '半径写成坐标' },
      params: [],
      objects: [
        { type: 'point3', id: 'O', at: '0, 0, 0' },
        { type: 'point3', id: 'O1', at: '0, 0, 4' },
        { type: 'cylinder3', id: 'cyl', a: 'O', b: 'O1', radius: '2, 2, 0' },
      ],
    },
    expect: { kind: 'fail', match: '不是坐标' },
  },
  {
    name: '金标准·立体：三棱锥的内切球与外接球（球心和半径都由程序算）',
    why:
      '用户真机跑挂的那道题：VA⊥底面、∠BAC=90°、AB=AC=AV=2，求两球半径之和。' +
      '当时只能画出棱锥——球心要解 3×3 方程组、内心要按对面面积加权，模型算不出来就把球省了。' +
      '现在球心写 derive.circumcenter / incenter，半径写 circumR3 / inR3，全部由程序算。' +
      '这条用例守住四件事：外接球心解得对（R=√3≈1.73）、内心解得对（r=(3−√3)/3≈0.42）、' +
      '半径表达式能求值、球心不会被判成"孤立顶点"。',
    gate: '综合',
    scene: {
      space: '3d',
      meta: { title: '三棱锥 V-ABC 的内切球与外接球' },
      params: [],
      objects: [
        { type: 'point3', id: 'A', at: '0, 0, 0' },
        { type: 'point3', id: 'B', at: '2, 0, 0' },
        { type: 'point3', id: 'C', at: '0, 2, 0' },
        { type: 'point3', id: 'V', at: '0, 0, 2' },
        { type: 'face3', id: 'fABC', points: ['A', 'B', 'C'], opacity: 0.34 },
        { type: 'face3', id: 'fVAB', points: ['V', 'A', 'B'], opacity: 0.3 },
        { type: 'face3', id: 'fVAC', points: ['V', 'A', 'C'], opacity: 0.3 },
        { type: 'face3', id: 'fVBC', points: ['V', 'B', 'C'], opacity: 0.3 },
        { type: 'edge3', id: 'AB', a: 'A', b: 'B' },
        { type: 'edge3', id: 'BC', a: 'B', b: 'C' },
        { type: 'edge3', id: 'CA', a: 'C', b: 'A' },
        { type: 'edge3', id: 'VA', a: 'V', b: 'A' },
        { type: 'edge3', id: 'VB', a: 'V', b: 'B' },
        { type: 'edge3', id: 'VC', a: 'V', b: 'C' },
        {
          type: 'point3',
          id: 'O',
          label: 'O',
          derive: { kind: 'circumcenter', points: ['A', 'B', 'C', 'V'] },
        },
        {
          type: 'point3',
          id: 'I',
          label: 'I',
          derive: { kind: 'incenter', points: ['A', 'B', 'C', 'V'] },
        },
        {
          type: 'sphere3',
          id: 'ballOut',
          center: 'O',
          radius: 'circumR3(A,B,C,V)',
          opacity: 0.07,
        },
        { type: 'sphere3', id: 'ballIn', center: 'I', radius: 'inR3(A,B,C,V)', opacity: 0.2 },
      ],
      readouts: [
        { label: 'R', expr: 'circumR3(A,B,C,V)' },
        { label: 'r', expr: 'inR3(A,B,C,V)' },
        { label: 'R + r', expr: 'circumR3(A,B,C,V) + inR3(A,B,C,V)' },
      ],
      constraints: [
        { type: 'value', expr: 'dist3(A,B)', equals: 2 },
        { type: 'perp-lines', a: ['V', 'A'], b: ['A', 'B'] },
        { type: 'perp-lines', a: ['A', 'B'], b: ['A', 'C'] },
      ],
    },
    expect: { kind: 'pass', readouts: { R: '1.73', r: '0.42', 'R + r': '2.15' } },
  },
  {
    name: '正四面体：外接球心与内切球心重合，不该判成「顶点重合」',
    why:
      '正四面体的外心与内心是同一个点（都等于重心）。原来的重合检查会把这种情况' +
      '报成"图里少一个角，多半是复制顶点忘了改坐标"，把一张完全正确的图打回重做。' +
      '球心是"算出来的结构点"，重合是几何事实，不是笔误——必须豁免这一对。',
    gate: '结构关',
    scene: {
      space: '3d',
      meta: { title: '正四面体 S-ABC 的内切球与外接球' },
      params: [],
      objects: [
        { type: 'point3', id: 'A', at: '0, 0, 0' },
        { type: 'point3', id: 'B', at: '2, 0, 0' },
        { type: 'point3', id: 'C', at: '1, 1.7320508, 0' },
        { type: 'point3', id: 'S', at: '1, 0.5773503, 1.6329932' },
        { type: 'face3', id: 'fABC', points: ['A', 'B', 'C'], opacity: 0.34 },
        { type: 'face3', id: 'fSAB', points: ['S', 'A', 'B'], opacity: 0.3 },
        { type: 'face3', id: 'fSBC', points: ['S', 'B', 'C'], opacity: 0.3 },
        { type: 'face3', id: 'fSCA', points: ['S', 'C', 'A'], opacity: 0.3 },
        { type: 'edge3', id: 'AB', a: 'A', b: 'B' },
        { type: 'edge3', id: 'BC', a: 'B', b: 'C' },
        { type: 'edge3', id: 'CA', a: 'C', b: 'A' },
        { type: 'edge3', id: 'SA', a: 'S', b: 'A' },
        { type: 'edge3', id: 'SB', a: 'S', b: 'B' },
        { type: 'edge3', id: 'SC', a: 'S', b: 'C' },
        {
          type: 'point3',
          id: 'O',
          label: 'O',
          derive: { kind: 'circumcenter', points: ['S', 'A', 'B', 'C'] },
        },
        {
          type: 'point3',
          id: 'I',
          label: 'I',
          derive: { kind: 'incenter', points: ['S', 'A', 'B', 'C'] },
        },
        { type: 'sphere3', id: 'ballOut', center: 'O', radius: 'circumR3(S,A,B,C)', opacity: 0.07 },
        { type: 'sphere3', id: 'ballIn', center: 'I', radius: 'inR3(S,A,B,C)', opacity: 0.2 },
      ],
      readouts: [
        { label: 'R', expr: 'circumR3(S,A,B,C)' },
        { label: 'r', expr: 'inR3(S,A,B,C)' },
        // 正四面体：R = √6/4·a，r = √6/12·a，所以 R = 3r
        { label: 'R / r', expr: 'circumR3(S,A,B,C) / inR3(S,A,B,C)' },
      ],
    },
    expect: { kind: 'pass', readouts: { R: '1.22', r: '0.41', 'R / r': '3.00' } },
  },
  {
    name: '格式关：circumcenter 只给了 3 个点',
    why:
      '四面体的外接球心必须由 4 个点定。只写 3 个点时，三个点只确定一个圆（圆心是一整条轴上的），' +
      '解不出来。这种错要直接点名"要 points[4]"，否则模型会以为是自己坐标写错了，越改越乱。',
    gate: '格式关',
    scene: {
      space: '3d',
      meta: { title: '外接球心给少了点' },
      params: [],
      objects: [
        { type: 'point3', id: 'A', at: '0, 0, 0' },
        { type: 'point3', id: 'B', at: '2, 0, 0' },
        { type: 'point3', id: 'C', at: '0, 2, 0' },
        {
          type: 'point3',
          id: 'O',
          derive: { kind: 'circumcenter', points: ['A', 'B', 'C'] },
        },
      ],
    },
    expect: { kind: 'fail', match: 'points[4]' },
  },
  {
    name: '金标准·截面：平面斜切圆柱出椭圆（半长轴/半短轴/面积）',
    why:
      '斜截面链路的基准用例。守住三件事：section3 的 p+normal 能定平面；' +
      'solveSection 采样出的椭圆量得出正确的长短轴（半长轴 = r/sin60° = 4/√3 ≈ 2.31）；' +
      '读数里的 secA3/secB3/secArea3 占位变量被 resolve 展开并注入数值。',
    gate: '综合',
    scene: buildCylSection(cylSectionDefaults),
    expect: {
      kind: 'pass',
      readouts: {
        '半长轴 a = r/sin60°': '2.31',
        '半短轴 b = r': '2.00',
        '截面面积 πab': '14.51',
      },
    },
  },
  {
    name: '截面：平面与球不相交',
    why:
      '平面离球心太远（距离 3 > 半径 2）。体检必须报"不相交"并给出实测距离，' +
      '否则渲染器静默跳过，画面上截面凭空消失，用户以为是坏了。',
    gate: '数值关',
    scene: {
      space: '3d',
      meta: { title: '切空的截面' },
      params: [],
      objects: [
        { type: 'sphere3', id: 'ball', center: '0, 0, 0', radius: 2 },
        {
          type: 'section3',
          id: 'sec',
          cut: 'ball',
          p: '0, 0, 3',
          normal: [0, 0, 1],
        },
      ],
    },
    expect: { kind: 'fail', match: '不相交' },
  },
  {
    name: '截面：平面平行于圆柱轴（截面是矩形）',
    why:
      '法向量与轴垂直时交线是两条母线，不是"截面"。这是模型的常见思路死角' +
      '（它以为任何平面截圆柱都是椭圆），必须点名 rectangle 退化让它调倾角。',
    gate: '数值关',
    scene: {
      space: '3d',
      meta: { title: '平面平行于轴' },
      params: [],
      objects: [
        { type: 'cylinder3', id: 'cyl', a: '0, 0, 0', b: '0, 0, 5', radius: 2 },
        {
          type: 'section3',
          id: 'sec',
          cut: 'cyl',
          p: '0, 1, 2.5',
          normal: [1, 0, 0],
        },
      ],
    },
    expect: { kind: 'fail', match: '矩形' },
  },
  {
    name: '截面：平面切穿端面',
    why:
      '平面与轴夹角太斜、或位置太靠边时，交线会穿出端面，画面出现悬空的半截椭圆。' +
      '这比"画错"更隐蔽——图看着差不多，但数学是错的，必须拦下。',
    gate: '数值关',
    scene: {
      space: '3d',
      meta: { title: '切穿的截面' },
      params: [],
      objects: [
        { type: 'cylinder3', id: 'cyl', a: '0, 0, 0', b: '0, 0, 3', radius: 2 },
        {
          type: 'section3',
          id: 'sec',
          cut: 'cyl',
          p: '0, 0, 2.8',
          normal: [1, 0, 0.2],
        },
      ],
    },
    expect: { kind: 'fail', match: '穿出' },
  },
  {
    name: '格式关：section3 既没给 plane 也没给 p+normal',
    why:
      '截面必须有平面。两个都不给时要在格式关就点名"二选一"的写法，' +
      '别让模型在数值关猜哪里错了。',
    gate: '格式关',
    scene: {
      space: '3d',
      meta: { title: '截面缺平面' },
      params: [],
      objects: [
        { type: 'cylinder3', id: 'cyl', a: '0, 0, 0', b: '0, 0, 5', radius: 2 },
        { type: 'section3', id: 'sec', cut: 'cyl' },
      ],
    },
    expect: { kind: 'fail', match: '缺平面' },
  },
  {
    name: '格式关：section3 的 cut 指向不存在的对象',
    why:
      'cut 写错（拼错 id 或指向 point3）时截面无从算起。报错要说明' +
      '"cut 必须是 cylinder3/cone3/sphere3 的 id"，模型才知道去补曲面体。',
    gate: '格式关',
    scene: {
      space: '3d',
      meta: { title: 'cut 指错对象' },
      params: [],
      objects: [
        { type: 'cylinder3', id: 'cyl', a: '0, 0, 0', b: '0, 0, 5', radius: 2 },
        {
          type: 'section3',
          id: 'sec',
          cut: 'ghost',
          p: '0, 0, 2.5',
          normal: [1, 0, 1],
        },
      ],
    },
    expect: { kind: 'fail', match: 'cut' },
  },
  {
    name: '【应拦】截面结论写错边数：实测五边形，步骤写"四边形"',
    why:
      '真实事故（2026-11-05）：正方体过 D、M、N 的截面，程序逐面求交算出五边形，' +
      '图形是对的，但 steps 里写死「截面为四边形 DMNP」——图和答案互相打脸。' +
      '旧体检只验坐标/约束/截面切没切穿，唯独不验"最后得出的结论"。' +
      '这条守住：结论边数必须等于实测边数，否则报错让模型重写。',
    gate: '数值关',
    scene: (() => {
      const s = buildCubeSection(cubeSectionDefaults);
      return {
        ...s,
        steps: [...(s.steps ?? []), { title: '结论', text: '综上，截面为四边形 $DMNP$。' }],
      };
    })(),
    expect: { kind: 'fail', match: '五边形' },
  },
  {
    name: '【应拦】步骤里点名、图上没有的点',
    why:
      '真实事故（2026-11-06）：板书逐行写「延长 DM 交 AA₁ 于 R，连接 RN」，' +
      '但 R 从来没在 objects 里声明——图上只有 D、M、N，读者看到"讲解提到、图上找不到"。' +
      '旧体检只看 steps 的 highlight/reveal 里的 id，不看正文。这条守住：' +
      '正文点名的点必须在图里存在，否则报错让模型补（延长线交点用 intersect 派生）。',
    gate: '综合',
    scene: (() => {
      const s = buildCubeSection(cubeSectionDefaults);
      return {
        ...s,
        steps: [
          ...(s.steps ?? []),
          { title: '作图', text: '延长 $DM$ 交 $AA_1$ 于 R，连接 $RN$。' },
        ],
      };
    })(),
    expect: { kind: 'fail', match: 'R' },
  },
  {
    name: '金标准·延长线求交：AC₁ 与 BD₁ 相交于正方体中心',
    why:
      '立体几何作截面的标准手法是"延长两条线求交点"。这条守住 intersect 派生：' +
      '① 按无限长直线求交（可落在延长线上）；② 解出来的坐标是对的（中心 O=(1,1,1)，AO=√3）；' +
      '③ 坐标保持表达式形式，拖参数时点跟着走。',
    gate: '综合',
    scene: {
      space: '3d',
      meta: { title: '对角线交点' },
      params: [{ name: 'a', min: 2, max: 6, value: 2, step: 0.5, label: '棱长' }],
      objects: [
        { type: 'point3', id: 'A', label: 'A', at: [0, 0, 'a'] },
        { type: 'point3', id: 'B', label: 'B', at: ['a', 0, 'a'] },
        { type: 'point3', id: 'C', label: 'C', at: ['a', 'a', 'a'] },
        { type: 'point3', id: 'D', label: 'D', at: [0, 'a', 'a'] },
        { type: 'point3', id: 'A1', label: 'A₁', at: [0, 0, 0] },
        { type: 'point3', id: 'B1', label: 'B₁', at: ['a', 0, 0] },
        { type: 'point3', id: 'C1', label: 'C₁', at: ['a', 'a', 0] },
        { type: 'point3', id: 'D1', label: 'D₁', at: [0, 'a', 0] },
        {
          type: 'point3',
          id: 'O',
          label: 'O',
          derive: { kind: 'intersect', l1: ['A', 'C1'], l2: ['B', 'D1'] },
        },
        { type: 'edge3', id: 'AC1', a: 'A', b: 'C1', dashed: true },
        { type: 'edge3', id: 'BD1', a: 'B', b: 'D1', dashed: true },
        { type: 'edge3', id: 'OA', a: 'O', b: 'A' },
      ],
      readouts: [{ label: 'AO', expr: 'dist3(O,A)' }],
      steps: [{ title: '求交', text: '两条体对角线交于中心 O。', highlight: ['O'] }],
    },
    expect: { kind: 'pass', readouts: { AO: '1.73' } },
  },
  {
    name: '金标准·正方体截面：过 D、M、N 的平面截出五边形',
    why:
      '多面体截面的基准用例（用户真机那道题）。守住四件事：' +
      '① cut 用 {vertices} 能组装出六个面；② 逐面求交后串成闭合五边形；' +
      '③ 面积/周长是程序算的真值（a=4 时 19.24 / 17.25）；' +
      '④ 平面正好穿过顶点 D 时，不能在 D 前后多算出一条边（共线点要合并）。',
    gate: '综合',
    scene: buildCubeSection(cubeSectionDefaults),
    expect: {
      kind: 'pass',
      readouts: {
        截面边数: '5.00',
        截面面积: '19.24',
        截面周长: '17.25',
      },
    },
  },
  {
    name: '多面体截面：平面切三棱锥得到三角形',
    why:
      '最简单的一类多面体截面。它验证"边数随平面变化"这件事：' +
      '平面从 A 附近切过去，只穿过 AB、AC、AD 三条棱 → 三角形（3 边）。',
    gate: '综合',
    scene: {
      space: '3d',
      meta: { title: '三棱锥截面' },
      params: [],
      objects: [
        { type: 'point3', id: 'A', at: [0, 0, 0] },
        { type: 'point3', id: 'B', at: [2, 0, 0] },
        { type: 'point3', id: 'C', at: [0, 2, 0] },
        { type: 'point3', id: 'D', at: [0, 0, 2] },
        { type: 'face3', id: 'fABC', points: ['A', 'B', 'C'] },
        { type: 'face3', id: 'fABD', points: ['A', 'B', 'D'] },
        { type: 'face3', id: 'fACD', points: ['A', 'C', 'D'] },
        { type: 'face3', id: 'fBCD', points: ['B', 'C', 'D'] },
        {
          type: 'section3',
          id: 'sec',
          cut: { vertices: ['A', 'B', 'C', 'D'] },
          p: [0.5, 0.5, 0.5],
          normal: [1, 1, 1],
        },
      ],
      readouts: [{ label: '截面边数', expr: 'secN3(sec)' }],
    },
    expect: { kind: 'pass', readouts: { 截面边数: '3.00' } },
  },
  {
    name: '多面体截面：平面离得太远，根本没切到',
    why:
      '平面在所有顶点同侧时没有截面。必须报"不相交 + 最近距离"，' +
      '否则渲染器静默跳过，画面上什么都没有，用户以为是坏了。',
    gate: '数值关',
    scene: {
      space: '3d',
      meta: { title: '切空的多面体' },
      params: [],
      objects: [
        { type: 'point3', id: 'A', at: [0, 0, 0] },
        { type: 'point3', id: 'B', at: [2, 0, 0] },
        { type: 'point3', id: 'C', at: [0, 2, 0] },
        { type: 'point3', id: 'D', at: [0, 0, 2] },
        { type: 'face3', id: 'fABC', points: ['A', 'B', 'C'] },
        { type: 'face3', id: 'fABD', points: ['A', 'B', 'D'] },
        { type: 'face3', id: 'fACD', points: ['A', 'C', 'D'] },
        { type: 'face3', id: 'fBCD', points: ['B', 'C', 'D'] },
        {
          type: 'section3',
          id: 'sec',
          cut: { vertices: ['A', 'B', 'C', 'D'] },
          p: [0, 0, 9],
          normal: [0, 0, 1],
        },
      ],
    },
    expect: { kind: 'fail', match: '不相交' },
  },
  {
    name: '多面体截面：平面只碰到一个顶点，截面退化',
    why:
      '平面过 D 且与三条棱都只在 D 处相交时，截面是"一个点"，不是多边形。' +
      '这种题在课本里要专门讨论，画出来必须报错而不是画个怪东西。',
    gate: '数值关',
    scene: {
      space: '3d',
      meta: { title: '只碰到顶点' },
      params: [],
      objects: [
        { type: 'point3', id: 'A', at: [0, 0, 0] },
        { type: 'point3', id: 'B', at: [2, 0, 0] },
        { type: 'point3', id: 'C', at: [0, 2, 0] },
        { type: 'point3', id: 'D', at: [0, 0, 2] },
        { type: 'face3', id: 'fABC', points: ['A', 'B', 'C'] },
        { type: 'face3', id: 'fABD', points: ['A', 'B', 'D'] },
        { type: 'face3', id: 'fACD', points: ['A', 'C', 'D'] },
        { type: 'face3', id: 'fBCD', points: ['B', 'C', 'D'] },
        {
          type: 'section3',
          id: 'sec',
          cut: { vertices: ['A', 'B', 'C', 'D'] },
          // 平面 x + y + 2z = 4 只过 D(0,0,2)：其余三个顶点都在同一侧
          p: [0, 0, 2],
          normal: [1, 1, 2],
        },
      ],
    },
    expect: { kind: 'fail', match: '退化' },
  },
  {
    name: '格式关：切多面体时 cut 里没有 vertices',
    why:
      'cut 写成 {} 或漏掉 vertices 时无从知道切哪个多面体。' +
      '要在格式关就说清"列出全部顶点"的写法，别让模型在数值关猜。',
    gate: '格式关',
    scene: {
      space: '3d',
      meta: { title: 'cut 缺 vertices' },
      params: [],
      objects: [
        { type: 'point3', id: 'A', at: [0, 0, 0] },
        { type: 'point3', id: 'B', at: [2, 0, 0] },
        { type: 'point3', id: 'C', at: [0, 2, 0] },
        { type: 'point3', id: 'D', at: [0, 0, 2] },
        { type: 'section3', id: 'sec', cut: {}, p: [0.5, 0.5, 0.5], normal: [1, 1, 1] },
      ],
    },
    expect: { kind: 'fail', match: 'vertices' },
  },
];
