/**
 * regression.ts —— 回归测试：跑用例 + 画结果表
 *
 * 打开方式：浏览器访问 http://127.0.0.1:5173/regression.html
 *
 * 它做的事很朴素，但顺序很重要：
 *   scene 对象 → JSON.stringify → parseScene（格式关）
 *              → verifyScene（数值关 + 约束关）
 *              → measureReadouts（读数比对）
 * 每一步的产物就是"关卡真正的输出"，所以这里红了，线上一定也红。
 *
 * 判"通过"的规则：
 *   正向用例（expect.kind = 'pass'）——没有任何 error，且所有期望读数都对得上；
 *   负向用例（expect.kind = 'fail'）——必须有一条 error（或在格式关）包含指定的文字。
 *                                   如果它反而全过了，说明护栏失效，这是最危险的退步。
 */

import { SceneRenderer } from '../core/renderer';
import { parseScene } from '../protocol/parser';
import { parseScene3D } from '../protocol/parser3d';
import { parseJsonLoose } from '../protocol/jsonRepair';
import { measureReadouts, verifyScene, type Issue } from '../protocol/verifier';
import { intersectCandidates, measureReadouts3D, verifyScene3D } from '../protocol/verifier3d';
import { buildAnnotations3D, pickAnnotations3D } from '../core/annotations3d';
import { autoFix3D } from '../protocol/autofix3d';
import { foldAngleFrom, foldPositions, planFold } from '../protocol/fold3d';
import { compileTimeline, sampleBeat } from '../ui/timeline';
import type { Narration } from '../llm/narration';
import { resolveScene3D } from '../protocol/resolve3d';
import { sanitizeAction, stripActStream } from '../llm/actProtocol';
import { splitReply } from '../llm/chatAgent';
import { normalizeKnowledge, fallbackKnowledge } from '../llm/knowledge';
import { buildFactSheet } from '../llm/factSheet';
import { evalVec3 } from '../protocol/expr';
import type { Point3Object, Scene3D, Scene3DObject, Vec3 } from '../protocol/scene3d';
import { CASES, CASES_3D, RENDER_CASES, type TestCase, type TestCase3D } from './cases';
import { FEW_SHOT_EXAMPLE, CYLINDER_EXAMPLE } from '../llm/prompt3d';

export interface RowResult {
  name: string;
  why: string;
  gate: string;
  ok: boolean;
  /** 环境不支持导致没执行（如 WebGL 不可用）——不算退步，但要让你看见 */
  skipped?: boolean;
  /** 一句话结论 */
  detail: string;
  /** 失败时展示：期望是什么 */
  expectText?: string;
  /** 失败时展示：实际是什么 */
  actualText?: string;
}

export interface Report {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  rows: RowResult[];
}

const fmtIssue = (i: Issue) =>
  `[${i.level === 'error' ? '错误' : '提醒'}] ${i.where}：${i.message}`;

/**
 * 跑一条用例。
 *
 * 2D 与 3D 的断言逻辑完全一样（有 error 就失败、读数要逐条对得上），
 * 只有中间三层不同：解析器、体检器、读数计算。所以用一个 space 参数切换，
 * 而不是把整个 runOne 复制一遍——复制出来的两份一定会各自漂移。
 */
function runOne(c: TestCase | TestCase3D, space: '2d' | '3d' = '2d'): RowResult {
  const base = { name: c.name, why: c.why, gate: c.gate };
  const json = JSON.stringify(c.scene);

  /* ---------- 第 1 关：格式 ---------- */
  let parseErrors: string[] | null = null;
  let issues: Issue[] = [];
  let measuredList: Array<{ label: string; value: string }> = [];

  if (space === '3d') {
    const parsed = parseScene3D(json);
    if (!parsed.ok) parseErrors = parsed.errors;
    else {
      issues = verifyScene3D(parsed.scene);
      measuredList = measureReadouts3D(parsed.scene);
    }
  } else {
    const parsed = parseScene(json);
    if (!parsed.ok) parseErrors = parsed.errors;
    else {
      issues = verifyScene(parsed.scene);
      measuredList = measureReadouts(parsed.scene);
    }
  }

  if (parseErrors) {
    const text = parseErrors.join('\n');
    if (c.expect.kind === 'fail') {
      return text.includes(c.expect.match)
        ? { ...base, ok: true, detail: `格式关拦下：${parseErrors[0]}` }
        : {
            ...base,
            ok: false,
            detail: '格式关拦下了，但报错内容和预期不符',
            expectText: `含「${c.expect.match}」`,
            actualText: text,
          };
    }
    return {
      ...base,
      ok: false,
      detail: '不该在格式关失败',
      actualText: text,
    };
  }

  /* ---------- 第 2、3 关：数值体检 + 约束验算 ---------- */
  const errs = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warn');

  // 负向用例：期望被拦下
  if (c.expect.kind === 'fail') {
    // 先取成局部变量：TS 的类型窄化进不了闭包，直接写 c.expect.match 会报错
    const match = c.expect.match;
    const hit = errs.find((i) => `${i.where}：${i.message}`.includes(match));
    if (hit) {
      const brief = hit.message.length > 90 ? hit.message.slice(0, 90) + '…' : hit.message;
      return { ...base, ok: true, detail: `体检拦下：${hit.where}：${brief}` };
    }
    return {
      ...base,
      ok: false,
      detail:
        errs.length === 0
          ? '⚠ 期望被拦下，但它全部通过了 —— 护栏失效'
          : '拦下了，但报错内容和预期不符',
      expectText: `含「${match}」`,
      actualText: errs.length ? errs.map(fmtIssue).join('\n') : '（没有任何错误）',
    };
  }

  // 正向用例：不该有任何 error
  if (errs.length > 0) {
    return {
      ...base,
      ok: false,
      detail: `不该报错，却有 ${errs.length} 条错误`,
      actualText: errs.map(fmtIssue).join('\n'),
    };
  }

  /* ---------- 读数比对：这是"数学对不对"的最后一道自检 ---------- */
  const measured = new Map(measuredList.map((m) => [m.label, m.value]));
  const wrong: string[] = [];
  for (const [label, want] of Object.entries(c.expect.readouts ?? {})) {
    const got = measured.get(label);
    if (got === undefined) wrong.push(`${label}：读不出来（表达式求值失败）`);
    else if (got !== want) wrong.push(`${label}：实测 ${got}，期望 ${want}`);
  }
  if (wrong.length > 0) {
    return {
      ...base,
      ok: false,
      detail: '读数对不上',
      actualText: wrong.join('\n'),
    };
  }

  /* ---------- 提醒也能断言（证明 warn 真的出现、且没被当成 error）---------- */
  if (c.expect.warn) {
    const need = c.expect.warn;
    const hit = warns.find((i) => i.message.includes(need));
    if (!hit) {
      return {
        ...base,
        ok: false,
        detail: '通过了，但没有出现预期的提醒',
        expectText: `提醒含「${need}」`,
        actualText: warns.length ? warns.map(fmtIssue).join('\n') : '（没有任何提醒）',
      };
    }
  }

  /* ---------- 反向断言：好图不该被"图形一致性"检查误报 ---------- */
  if (c.expect.noWarn) {
    const bad = c.expect.noWarn;
    const hit = warns.find((i) => i.message.includes(bad));
    if (hit) {
      return {
        ...base,
        ok: false,
        detail: '出现了不该有的提醒（检查在误报）',
        expectText: `不含「${bad}」的提醒`,
        actualText: fmtIssue(hit),
      };
    }
  }

  const rd = Object.entries(c.expect.readouts ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
  return { ...base, ok: true, detail: rd ? `全部通过（${rd}）` : '全部通过' };
}

export function runAll(): Report {
  const rows = [
    ...CASES.map((c) => runOne(c, '2d')),
    ...CASES_3D.map((c) => runOne(c, '3d')),
    ...runPromptCases(),
    ...runAnnotationCases3D(),
    ...runAutoFixCases3D(),
    ...runGuardCases3D(),
    ...runFoldCases3D(),
    ...runFoldDeriveCases3D(),
    ...runJsonRepairCases(),
    ...runLearningCases(),
    ...runRenderCases(),
  ];
  const skipped = rows.filter((r) => r.skipped).length;
  const passed = rows.filter((r) => r.ok && !r.skipped).length;
  const failed = rows.filter((r) => !r.ok).length;
  return { total: rows.length, passed, failed, skipped, rows };
}

/* ===============================================================
 * 提示词关：模型照着 few-shot 抄格式，示例本身必须合法
 *
 * 这条测试防的是一种很难查的退步：示例 JSON 少个逗号 / 字段名写错，
 * 模型就会学着输出坏 JSON，而错误最终表现为"生成失败"，
 * 从报错里完全看不出根因在 prompt 里。
 * =============================================================== */
function runPromptCases(): RowResult[] {
  return [
    checkPromptExample(
      {
        name: '提示词：立体几何 few-shot（棱锥）示例本身必须是合法场景',
        why:
          '模型生成 JSON 的形状完全照着 few-shot 学。示例坏掉时，报错只会说"你的 JSON 不合法"，' +
          '根本追不到源头。这里把示例当真实输出走一遍 3D 的两道关。',
      },
      FEW_SHOT_EXAMPLE,
    ),
    checkPromptExample(
      {
        name: '提示词：圆柱示例本身必须是合法场景',
        why:
          '圆柱示例是"不要画成棱柱"的唯一示范。它自己要是不合法，模型学到的就是错的；' +
          '而且这条用例顺带守住"曲面体过得了体检"——示例里 O、O₁ 只是圆心，不能被判成孤立顶点。',
      },
      CYLINDER_EXAMPLE,
    ),
  ];
}

/** 把一段 few-shot 文本当真实输出跑一遍 3D 的两道关 */
function checkPromptExample(
  meta: { name: string; why: string },
  text: string,
): RowResult {
  const base = { ...meta, gate: '提示词关' };

  // 示例前面可能还有说明文字，取第一个 { 到最后一个 }
  const from = text.indexOf('{');
  const to = text.lastIndexOf('}');
  if (from < 0 || to <= from) {
    return { ...base, ok: false, detail: '示例里找不到 JSON 对象' };
  }
  const json = text.slice(from, to + 1);

  const parsed = parseScene3D(json);
  if (!parsed.ok) {
    return {
      ...base,
      ok: false,
      detail: '示例 JSON 解析失败（模型会照着这个错法输出）',
      actualText: parsed.errors.join('\n'),
    };
  }

  const errs = verifyScene3D(parsed.scene).filter((i) => i.level === 'error');
  if (errs.length > 0) {
    return {
      ...base,
      ok: false,
      detail: '示例能解析，但过不了自己的体检——模型会照着学一个错场景',
      actualText: errs.map(fmtIssue).join('\n'),
    };
  }

  return { ...base, ok: true, detail: `示例合法（${parsed.scene.objects.length} 个对象）` };
}

/* ===============================================================
 * 渲染层：真的建一块画布，把「最终视野」读出来做断言
 *
 * 只做视野相关断言（不比对像素）：像素比对太脆，改一下配色就全红；
 * 而"视野对不对"恰好是历史上唯一一次严重画面事故的根因。
 * =============================================================== */
/* ===============================================================
 * 折起（翻折）关
 *
 * 这一段守的是"折起来"这件事的数学：展开态是不是真的展开、折起角是不是真的那么多、
 * 声明坏掉时会不会安静地不演（而不是把图扭成一团）。
 * 折起是唯一会让"顶点坐标随时间变"的功能，出错的表现往往不是报错，
 * 而是"图看起来在动，但动的不是那一块"——所以必须在数值层卡死。
 * =============================================================== */
function runFoldCases3D(): RowResult[] {
  const mk = (name: string, why: string, ok: boolean, actual?: string): RowResult => ({
    name,
    why,
    gate: '折起关',
    ok,
    detail: ok ? '全部通过' : '断言不成立',
    actualText: actual,
  });

  // 矩形 ABCD 沿 BD 折起：B、D 在折痕上；A 折到 (1,0,1)，C 留在原平面。
  // 摊平时 A 应该回到 (1,-1,0)——正好是绕 x 轴转 +90° 的像。
  const scene: Scene3D = {
    space: '3d' as const,
    meta: { title: '翻折测试' },
    params: [],
    objects: [
      { id: 'B', type: 'point3' as const, at: [0, 0, 0] },
      { id: 'D', type: 'point3' as const, at: [2, 0, 0] },
      { id: 'A', type: 'point3' as const, at: [1, 0, 1] },
      { id: 'C', type: 'point3' as const, at: [1, 2, 0] },
    ],
    fold: { crease: ['B', 'D'], moving: ['A', 'B', 'D'], deg: 90 },
  };
  const pts = new Map<string, Vec3>([
    ['B', [0, 0, 0]],
    ['D', [2, 0, 0]],
    ['A', [1, 0, 1]],
    ['C', [1, 2, 0]],
  ]);

  const rows: RowResult[] = [];
  const { plan, why } = planFold(scene.fold, pts);

  rows.push(
    mk(
      '折起：折痕在 moving 平面上时核成计划',
      '矩形沿对角线折起是最标准的翻折题。核不出来，视频就演不了折起过程',
      !!plan && plan.ids.length === 3,
      plan ? `deg=${plan.deg} ids=${plan.ids.join(',')}` : `失败：${why}`,
    ),
  );

  // ① 展开态：应该把 A 摊到折痕的另一侧 (1,-1,0)，而不是压到 C 身上
  {
    let ok = false;
    let detail = '';
    if (plan) {
      const flat = foldPositions(plan, plan.flatOffset).get('A');
      ok = !!flat && Math.hypot(flat[0] - 1, flat[1] + 1, flat[2]) < 1e-6 && plan.flatOffset === 90;
      detail = flat
        ? `flatOffset=${plan.flatOffset} 展开后 A=(${flat.map((v) => v.toFixed(3)).join(', ')})`
        : '没有 A';
    } else detail = '计划没建出来';
    rows.push(
      mk(
        '折起：展开到"另一半的反方向"（不能叠在另一块上）',
        '绕折痕往两边都能摊平，但只有一边是原来的平铺图。摊错边会看到两块纸叠在一起',
        ok,
        detail,
      ),
    );
  }

  // ② 实测折起角：A 的垂直分量与 C 的垂直分量夹角是 90°
  {
    let ok = false;
    let detail = '';
    if (plan) {
      const got = foldAngleFrom(plan, [1, 0, 1], [1, 2, 0]);
      ok = got !== null && Math.abs(got - 90) < 0.01;
      detail = got === null ? '量不出来' : `实测 ${got.toFixed(2)}°`;
    } else detail = '计划没建出来';
    rows.push(
      mk(
        '折起：实测折起角与声明一致（90°）',
        '声明 90° 实际折 60°，展开再折回去就会多折 30°，看起来像那块平面自己往上翘',
        ok,
        detail,
      ),
    );
  }

  // ③ moving 里混进另一块的点：必须拒绝（否则整张图一起转）
  {
    const bad = planFold({ crease: ['B', 'D'], moving: ['A', 'B', 'D', 'C'], deg: 90 }, pts);
    rows.push(
      mk(
        '折起：moving 混进另一块的点时拒绝执行',
        '这是最危险的一种错：平面照样有法向、折痕照样在平面上，一放行就把整张图转走',
        !bad.plan && !!bad.why && bad.why.includes('C'),
        bad.plan ? '居然通过了' : bad.why,
      ),
    );
  }

  // ④ 折痕端点不存在
  {
    const bad = planFold({ crease: ['B', 'M'], moving: ['A', 'B', 'D'], deg: 90 }, pts);
    rows.push(
      mk(
        '折起：折痕端点不存在时拒绝（并说清是哪个点）',
        '模型会编 id。编出来的折痕如果照样"折"，转轴就成了两个坐标算不出来的点',
        !bad.plan && !!bad.why && bad.why.includes('M'),
        bad.plan ? '居然通过了' : bad.why,
      ),
    );
  }

  // ⑤ 体检：声明 90° 但图只折了 60° → warn 里要有实测值
  {
    // 折起 60°：A 的垂直分量方向 (cos30°, sin30°) 相对摊平方向 (0,-1) 转了 60°
    const a60: Vec3 = [1, -0.5, Math.sqrt(3) / 2];
    const s60 = resolveScene3D({
      ...scene,
      objects: scene.objects.map((o) =>
        o.id === 'A' ? ({ ...o, at: a60 } as Scene3DObject) : o,
      ),
    });
    const issues = verifyScene3D(s60);
    const hit = issues.find((i) => i.where === 'fold' && i.message.includes('实测折起角'));
    rows.push(
      mk(
        '折起：体检报出"声明与实测不一致"',
        '这一条是给模型看的：它会照着数字把坐标折到位，或者把 deg 改成实测值',
        !!hit,
        hit ? hit.message : `没有这条：${JSON.stringify(issues.map((i) => i.message))}`,
      ),
    );
  }

  // ⑥ 折起 + 截面：要提示"动画已停用"，而不是默默画歪
  {
    const withSection = resolveScene3D({
      ...scene,
      objects: [
        ...scene.objects,
        { id: 'sec', type: 'section3' as const, cut: ['A', 'B', 'C'], plane: ['A', 'B', 'D'] },
      ] as Scene3DObject[],
    });
    const issues = verifyScene3D(withSection);
    const hit = issues.find((i) => i.where === 'fold' && i.message.includes('停用'));
    rows.push(
      mk(
        '折起：与截面同时出现时提示动画停用',
        '截面每帧都要按顶点重算，点一动就画歪。停用必须说出来，否则用户以为坏了',
        !!hit,
        hit ? hit.message : `没有这条：${JSON.stringify(issues.map((i) => i.message))}`,
      ),
    );
  }

  // ⑦ 时间轴：折起进度按句累积，第一句摊平、折起那句折完
  {
    const n: Narration = {
      knowns: [],
      fromModel: true,
      steps: [
        {
          title: '折起',
          beats: [
            { say: '先把矩形摊平看。', actions: [] },
            { say: '沿 BD 折起来。', actions: [{ kind: 'fold' }] },
            { say: '折好以后看这个二面角。', actions: [] },
          ],
        },
      ],
    };
    const tl = compileTimeline(n, null, {}, { lineWidth: 0.1, helperWidth: 0.2, foldFrom: 90 });
    const b0 = tl.beats[0];
    const b1 = tl.beats[1];
    const b2 = tl.beats[2];
    const startFlat = sampleBeat(tl, 0, 0).fold === 90;
    const endFolded = sampleBeat(tl, 1, b1.duration).fold === 0;
    const stays = b2.foldStart === 0 && b2.foldEnd === 0;
    rows.push(
      mk(
        '折起：时间轴按句累积（摊平 → 折起 → 保持折好）',
        '折起是个状态而不是一次性的动作：折完之后后面每一句都得是折好的样子',
        startFlat && endFolded && stays && b0.foldEnd === 90,
        `b0=${b0.foldStart}→${b0.foldEnd} b1=${b1.foldStart}→${b1.foldEnd} b2=${b2.foldStart}→${b2.foldEnd}`,
      ),
    );
  }

  // ⑧ 讲稿一次都没提折起：图必须一直是折好的（不能莫名其妙先摊平）
  {
    const n: Narration = {
      knowns: [],
      fromModel: true,
      steps: [{ title: '直接算', beats: [{ say: '直接看折好以后的图。', actions: [] }] }],
    };
    const tl = compileTimeline(n, null, {}, { lineWidth: 0.1, helperWidth: 0.2, foldFrom: 90 });
    rows.push(
      mk(
        '折起：讲稿没提折起时保持折好状态',
        '场景声明的是折好之后的图。没有 fold 动作却先摊平，等于凭空改图',
        tl.beats.every((b) => b.foldStart === 0 && b.foldEnd === 0),
        `首句 fold=${tl.beats[0].foldStart}`,
      ),
    );
  }

  // ⑨ 解析关：fold.deg 越界要报格式错
  {
    const bad = parseScene3D(
      JSON.stringify({
        space: '3d',
        meta: { title: 'x' },
        params: [],
        objects: [
          { id: 'A', type: 'point3', at: [0, 0, 0] },
          { id: 'B', type: 'point3', at: [1, 0, 0] },
          { id: 'C', type: 'point3', at: [1, 1, 0] },
        ],
        fold: { crease: ['A', 'B'], moving: ['A', 'B', 'C'], deg: 0 },
      }),
    );
    rows.push(
      mk(
        '折起：deg 写成 0 时在格式关就被拦下',
        '0° 等于没折，演出来是"图不动"，用户会以为坏了；宁可让它在格式关报错',
        !bad.ok && bad.errors.some((e) => e.includes('fold.deg')),
        bad.ok ? '居然通过了' : bad.errors.join(' / '),
      ),
    );
  }

  return rows;
}

/**
 * 折后点交给程序算（derive.kind = 'fold'）——2026-11-09 那道等腰梯形折叠题的复盘。
 *
 * 当时的现场：
 *   模型手写 A₁ = (-1, 0, 1.73)，而正解是 O + (0,0,√3) = (0.5, 0.866, 1.732)。
 *   它写的两条断言「A₁O ⊥ BE」「OC ⊥ BE」**都是对的**，但坐标错了，
 *   体检实测 75.52° 打回；改了两轮也改不对，最后整题生不出来。
 * 这一组用例就是钉住：坐标必须由程序转，且转出来的东西要能过体检。
 */
function runFoldDeriveCases3D(): RowResult[] {
  const mk = (name: string, why: string, ok: boolean, actual?: string): RowResult => ({
    name,
    why,
    gate: '折后点关',
    ok,
    detail: ok ? '全部通过' : '断言不成立',
    actualText: actual,
  });
  const rows: RowResult[] = [];
  const H = Math.sqrt(3);

  // 等腰梯形：BC=2、AD=4、∠A=60°、E 为 AD 中点。ABE 正好是边长 2 的正三角形。
  const trapezoid = {
    space: '3d',
    meta: { title: '等腰梯形折叠' },
    params: [],
    objects: [
      { id: 'A', type: 'point3', at: [-1, H, 0], hidden: true },
      { id: 'B', type: 'point3', at: [0, 0, 0] },
      { id: 'C', type: 'point3', at: [2, 0, 0] },
      { id: 'D', type: 'point3', at: [3, H, 0] },
      { id: 'E', type: 'point3', at: [1, H, 0] },
      { id: 'O', type: 'point3', derive: { kind: 'midpoint', a: 'B', b: 'E' } },
      { id: 'F', type: 'point3', derive: { kind: 'midpoint', a: 'D', b: 'E' } },
      {
        id: 'A1',
        type: 'point3',
        label: 'A₁',
        derive: { kind: 'fold', of: 'A', crease: ['B', 'E'], deg: 90 },
      },
      { id: 'BC', type: 'edge3', a: 'B', b: 'C' },
      { id: 'CD', type: 'edge3', a: 'C', b: 'D' },
      { id: 'DE', type: 'edge3', a: 'D', b: 'E' },
      { id: 'EB', type: 'edge3', a: 'E', b: 'B' },
      { id: 'A1B', type: 'edge3', a: 'A1', b: 'B' },
      { id: 'A1E', type: 'edge3', a: 'A1', b: 'E' },
      { id: 'fBase', type: 'face3', points: ['B', 'C', 'D', 'E'], opacity: 0.12 },
      { id: 'fFlap', type: 'face3', points: ['A1', 'B', 'E'], opacity: 0.2 },
    ],
    constraints: [
      { type: 'perp-lines', a: ['A1', 'O'], b: ['B', 'E'] },
      { type: 'perp-lines', a: ['O', 'C'], b: ['B', 'E'] },
    ],
    steps: [
      {
        title: '折起',
        text: '将△ABE沿BE折起到△A₁BE的位置，点O、F分别为BE、DE的中点',
      },
      {
        title: '判断',
        text: '是否存在点P在A₁C上，使得BP∥平面A₁OF',
      },
    ],
    fold: { crease: ['B', 'E'], moving: ['A1', 'B', 'E'], deg: 90 },
  };

  const parsed = parseScene3D(JSON.stringify(trapezoid));
  // resolve 后的 at 仍是**表达式字符串**（为了参数化）。要数值就得求值。
  const atOf = (scene: Scene3D, id: string): number[] | null => {
    const o = scene.objects.find((x) => x.id === id) as Point3Object | undefined;
    if (!o || o.at === undefined) return null;
    const v = evalVec3(o.at, {});
    return v ? [v[0], v[1], v[2]] : null;
  };

  // ① 折后点：A₁ 必须正对 O 上方 √3 处（这是"折成直角"的几何后果）
  {
    const s = parsed.ok ? parsed.scene : null;
    const a1 = s ? atOf(s, 'A1') : null;
    const want = [0.5, H / 2, H];
    const d = a1 ? Math.hypot(a1[0] - want[0], a1[1] - want[1], a1[2] - want[2]) : NaN;
    rows.push(
      mk(
        '折后点：A₁ 由程序绕 BE 转 90°，落在 O 正上方 √3',
        '模型手算这一步必错（这次写成 (-1,0,1.73)）。它错了图就全错，而且断言还是对的，看不出来',
        !!a1 && d < 1e-6,
        a1
          ? `A₁=(${a1.map((v) => v.toFixed(3)).join(', ')})，与正解差 ${d.toExponential(2)}`
          : `算不出：${parsed.ok ? JSON.stringify((parsed.scene.objects.find((x) => x.id === 'A1') as Point3Object | undefined)?.at) : parsed.errors.join(' / ')}`,
      ),
    );
  }

  // ② 折好后，题面的两条垂直关系必须真的成立（不给模型留"自己编坐标"的余地）
  {
    const issues = parsed.ok ? verifyScene3D(parsed.scene) : [];
    const errs = issues.filter((i) => i.level === 'error');
    rows.push(
      mk(
        '折后点：折出来的图能过整套体检（含 A₁O⊥BE、OC⊥BE 两条断言）',
        '坐标算对了，垂直关系自然成立；这一条如果红，说明旋转公式或方向选错了',
        parsed.ok && errs.length === 0,
        parsed.ok ? (errs.length ? errs.map((e) => e.message).join(' | ') : '0 条 error') : '解析失败',
      ),
    );
  }

  // ③ 正文提到 A（折前的位置）和 P（假设点）都不该被判"图里没有"
  {
    const issues = parsed.ok ? verifyScene3D(parsed.scene) : [];
    const bad = issues.filter((i) => i.where.startsWith('steps[') && i.level === 'error');
    rows.push(
      mk(
        '点名检查：折前的 A、假设的 P 都放过',
        '这两条把模型逼去"补点"，反而绕开了真正的坐标错误。上一轮就是连卡两次',
        parsed.ok && bad.length === 0,
        bad.length ? bad.map((i) => i.message).join(' | ') : '没有误报',
      ),
    );
  }

  // ④ hidden 的折前点不进画面，也不该被当成"孤立点"
  {
    const o = parsed.ok
      ? (parsed.scene.objects.find((x) => x.id === 'A') as Point3Object | undefined)
      : undefined;
    const issues = parsed.ok ? verifyScene3D(parsed.scene) : [];
    const iso = issues.find((i) => i.where === 'A');
    rows.push(
      mk(
        'hidden：折前的 A 保留坐标但不画，也不报孤立点',
        '它只提供坐标，画面上不该有第二个 A；报孤立点会逼模型删掉它，折后点就算不出来了',
        !!o && o.hidden === true && !iso,
        iso ? iso.message : `hidden=${o ? o.hidden : '无此点'}`,
      ),
    );
  }

  // ⑤ 坐标按 90° 折、动画写 60° → 必须报错（否则演到一半会跳）
  {
    const bad = parseScene3D(
      JSON.stringify({ ...trapezoid, fold: { crease: ['B', 'E'], moving: ['A1', 'B', 'E'], deg: 60 } }),
    );
    const issues = bad.ok ? verifyScene3D(bad.scene) : [];
    const hit = issues.find((i) => i.level === 'error' && i.message.includes('fold.deg'));
    rows.push(
      mk(
        '折后点：坐标 90° 与动画 deg 60° 不一致时报错',
        '两边角度不同，展开再折回时回到的位置和算好的坐标差一截，画面上会跳一下',
        !!hit,
        hit ? hit.message : `没有这条：${JSON.stringify(issues.map((i) => i.message))}`,
      ),
    );
  }

  // ⑥ 要折的点就在折痕上 → 转多少度都不动，必须报错
  {
    // 单独造一个不退化的场景：三点共线会被"整图压扁"的根因检查吞掉，
    // 那就验不到这条 fold 错误了（真实的共线场景本来就该由那条报）
    const bad = parseScene3D(
      JSON.stringify({
        space: '3d',
        meta: { title: '折痕上的点' },
        params: [],
        objects: [
          { id: 'B', type: 'point3', at: [0, 0, 0] },
          { id: 'C', type: 'point3', at: [1, 0, 0] },
          { id: 'A', type: 'point3', at: [0.5, 0, 0] },
          // 两个反向的点撑开"体"，否则四点共面（B、C、A 还共线）会被压扁根因吞掉
          { id: 'Z', type: 'point3', at: [0.5, 1, 0.8] },
          { id: 'W', type: 'point3', at: [0.5, 1, -0.8] },
          {
            id: 'A1',
            type: 'point3',
            derive: { kind: 'fold', of: 'A', crease: ['B', 'C'], deg: 90 },
          },
          { id: 'BC', type: 'edge3', a: 'B', b: 'C' },
          { id: 'ZB', type: 'edge3', a: 'Z', b: 'B' },
          { id: 'ZC', type: 'edge3', a: 'Z', b: 'C' },
          { id: 'WB', type: 'edge3', a: 'W', b: 'B' },
          { id: 'WC', type: 'edge3', a: 'W', b: 'C' },
          { id: 'fZBC', type: 'face3', points: ['Z', 'B', 'C'], opacity: 0.2 },
          { id: 'fWBC', type: 'face3', points: ['W', 'B', 'C'], opacity: 0.2 },
        ],
      }),
    );
    const issues = bad.ok ? verifyScene3D(bad.scene) : [];
    const hit = issues.find((i) => i.level === 'error' && i.message.includes('落在折痕'));
    rows.push(
      mk(
        '折后点：of 落在折痕上时报错',
        '这种场景折出来图不动，模型还以为是"折了 0°"，白折腾一轮',
        !!hit,
        hit ? hit.message : `没有这条：${JSON.stringify(issues.map((i) => i.message))}`,
      ),
    );
  }

  // ⑦ 折回展开态时，A₁ 必须正好落到 A 的位置（derive 与动画是同一条几何）
  {
    let detail = '算不出';
    let ok = false;
    if (parsed.ok) {
      const pts = new Map<string, Vec3>();
      for (const o of parsed.scene.objects) {
        if (o.type !== 'point3') continue;
        const p = (o as Point3Object).at;
        if (p === undefined) continue;
        const v = evalVec3(p, {});
        if (v) pts.set(o.id, [v[0], v[1], v[2]]);
      }
      const { plan } = planFold(parsed.scene.fold, pts);
      const flat = plan ? foldPositions(plan, -plan.deg).get('A1') : undefined;
      const a = atOf(parsed.scene, 'A');
      if (flat && a) {
        const d = Math.hypot(flat[0] - a[0], flat[1] - a[1], flat[2] - a[2]);
        ok = d < 1e-6;
        detail = `展开后 A₁=(${flat.map((v) => v.toFixed(3)).join(', ')})，A=(${a.map((v) => v.toFixed(3)).join(', ')})，差 ${d.toExponential(2)}`;
      } else detail = plan ? '展开后没有 A₁' : '折起计划没建出来';
    }
    rows.push(
      mk(
        '折后点：折回展开态时 A₁ 正好落回 A',
        'derive 算的是折后位置、动画是"把折后那块转回去"。两者必须是同一条几何，否则开头那一帧会跟后面接不上',
        ok,
        detail,
      ),
    );
  }

  // ⑧ 复现 11-09 那一份：手写折后坐标、没有 fold、没有 derive
  {
    const hand = parseScene3D(
      JSON.stringify({
        ...trapezoid,
        objects: trapezoid.objects
          .filter((o) => o.id !== 'A1' && o.id !== 'A')
          // 模型当时写的就是这个位置：x,y 完全跑偏（正解是 0.5, 0.866, 1.732）
          .concat([{ id: 'A1', type: 'point3', label: 'A₁', at: [-1, 0, 1.73] }] as never),
        fold: undefined,
      }),
    );
    const issues = hand.ok ? verifyScene3D(hand.scene) : [];
    const hint = issues.find((i) => i.where === 'fold' && i.message.includes('derive'));
    const perp = issues.find((i) => i.level === 'error' && i.message.includes('夹角实测'));
    rows.push(
      mk(
        '折后点：手写折后坐标时给出"改用 derive fold"的提示',
        '模型不会自己想到这一步。只报"垂直不成立"，它只会去挪坐标，挪两轮也挪不对',
        !!hint,
        hint ? hint.message.slice(0, 60) + '…' : `没有提示：${JSON.stringify(issues.map((i) => i.message))}`,
      ),
    );
    rows.push(
      mk(
        '折后点：手写坐标错了要真的被抓住（这份坐标实测 75.5°）',
        '这一条是"护栏本身没退化"的证明：错的图必须报错，不能因为加了提示就放过',
        !!perp,
        perp ? perp.message.slice(0, 80) : '居然没报错',
      ),
    );
  }

  return rows;
}
/**
 * JSON 语法容错：这四类都实测出现过，其中"缺逗号"就是 2026-11-09 那次
 * 在 position 599 报错的东西。修不好要原样报错，不能悄悄给出半份图。
 */
function runJsonRepairCases(): RowResult[] {
  const mk = (name: string, why: string, ok: boolean, actual?: string): RowResult => ({
    name,
    why,
    gate: 'JSON 关',
    ok,
    detail: ok ? '全部通过' : '断言不成立',
    actualText: actual,
  });
  const rows: RowResult[] = [];
  const base = { space: '3d', meta: { title: 'x' }, params: [], objects: [{ id: 'A', type: 'point3', at: [0, 0, 0] }, { id: 'B', type: 'point3', at: [1, 0, 0] }, { id: 'C', type: 'point3', at: [0, 1, 1] }] };

  const tryParse = (
    text: string,
  ): { ok: true; v: Record<string, unknown> } | { ok: false; why: string } => {
    try {
      return { ok: true, v: parseJsonLoose(text) as Record<string, unknown> };
    } catch (e) {
      return { ok: false, why: (e as Error).message };
    }
  };

  const valid = JSON.stringify(base);
  const variants: Array<{ name: string; text: string; why: string }> = [
    {
      name: 'JSON 关：尾逗号',
      text: valid.replace('"params":[],', '"params":[], ').replace('}]}}', '},]}}'),
      why: '模型写 JS 的习惯：{"a":1,}。语法错但意思完全清楚',
    },
    {
      name: 'JSON 关：漏逗号（两个属性连在一起）',
      text: valid.replace('"params":[],"objects"', '"params":[] "objects"'),
      why: '这就是 position 599 那类错：值后面直接跟下一个键',
    },
    {
      name: 'JSON 关：带 // 注释',
      text: valid.replace('"params":[],', '"params":[], // 本题无参数'),
      why: '模型爱在 JSON 里解释一句，人看着没问题，机器直接失败',
    },
    {
      name: 'JSON 关：输出被截断',
      text: valid.slice(0, Math.floor(valid.length * 0.8)),
      why: '撞上输出长度上限。能救回来一部分总比整题重生成强',
    },
  ];
  for (const v of variants) {
    const r = tryParse(v.text);
    rows.push(mk(v.name, v.why, r.ok, r.ok ? '修好了' : `仍然失败：${r.why}`));
  }

  // 字符串里带逗号/花括号的正经 JSON 不能被"修"坏
  {
    const tricky = JSON.stringify({ ...base, meta: { title: '注意,} 这种字符' } });
    const r = tryParse(tricky);
    const title = r.ok ? (r.v.meta as { title?: string }).title : undefined;
    rows.push(
      mk(
        'JSON 关：字符串里的逗号花括号不被误伤',
        '修复器只能动语法层。把正文里的字符改掉比报错更糟——错得没人发现',
        r.ok && title === '注意,} 这种字符',
        r.ok ? `title=${title}` : `失败：${r.why}`,
      ),
    );
  }

  return rows;
}

/* ===============================================================
 * 学习面板关：聊天联动白名单 + 知识点清洗 + 事实底稿
 *
 * 这一组全是纯函数，不碰 DOM。它们的共同风险是"模型说什么就执行什么"：
 * 联动指令不过白名单，聊天就能把图跳到不存在的步骤、高亮不存在的棱；
 * 知识点不清洗，抽屉里就会出现 9 条、每条 200 字的"公式大全"。
 * =============================================================== */
function runLearningCases(): RowResult[] {
  const mk = (name: string, why: string, ok: boolean, actual?: string): RowResult => ({
    name,
    why,
    gate: '学习面板关',
    ok,
    detail: ok ? '全部通过' : '断言不成立',
    actualText: actual,
  });

  const rows: RowResult[] = [];
  const ids = new Set(['A', 'B', 'C', 'BE', 'A1O']);

  // ① 合法指令原样通过
  {
    const act = sanitizeAction({ jump: 2, focus: ['BE', 'A1O'] }, 4, ids);
    const ok = act?.jump === 2 && act.focus?.length === 2;
    rows.push(
      mk(
        '联动：合法的跳步 + 高亮能通过白名单',
        '这是聊天唯一能动图的两件事，先确保正常指令不被误杀',
        ok,
        JSON.stringify(act),
      ),
    );
  }

  // ② 越界跳步一律丢弃
  {
    const a0 = sanitizeAction({ jump: 0 }, 4, ids);
    const a9 = sanitizeAction({ jump: 9 }, 4, ids);
    const ok = a0 === null && a9 === null;
    rows.push(
      mk(
        '联动：跳步越界（0 / 9）被丢弃',
        '跳到不存在的步骤会让步骤条与图脱节，比不跳更糟',
        ok,
        `${JSON.stringify(a0)} / ${JSON.stringify(a9)}`,
      ),
    );
  }

  // ③ 不存在的 id 被过滤，且最多 3 个
  {
    const act = sanitizeAction(
      { focus: ['BE', '不存在的棱', 'A', 'B', 'C', 'A1O'] },
      4,
      ids,
    );
    const ok = JSON.stringify(act?.focus) === JSON.stringify(['BE', 'A', 'B']);
    rows.push(
      mk(
        '联动：不存在的 id 被过滤，且最多高亮 3 个',
        '模型会照着文字里的点名字写 id，图上没有就该忽略，而不是去猜',
        ok,
        JSON.stringify(act),
      ),
    );
  }

  // ④ 全非法 → null（宁可不动作，不能乱动）
  {
    const act = sanitizeAction({ jump: 99, focus: ['X'] }, 2, ids);
    rows.push(
      mk(
        '联动：全部不合法时返回 null',
        '指令写坏时要"当作没写"，回答照常显示、画面不动',
        act === null,
        JSON.stringify(act),
      ),
    );
  }

  // ⑤ 流式阶段的半截标记要切掉
  {
    const { text } = stripActStream('因为 AO⊥BE，所以折后依然垂直。\n<<act {"jump":2,"fo');
    const ok = text === '因为 AO⊥BE，所以折后依然垂直。';
    rows.push(
      mk(
        '联动：流式期间的半截指令标记不可见',
        '不切掉的话，用户会看着半截 JSON 在回答末尾闪一下',
        ok,
        JSON.stringify(text),
      ),
    );
  }

  // ⑥ 收尾拆出正文与指令
  {
    const r = splitReply('取 BE 中点是因为三线合一。\n<<act {"jump":2,"focus":["BE"]}>>');
    const ok =
      r.text === '取 BE 中点是因为三线合一。' &&
      r.action?.jump === 2 &&
      r.action?.focus?.[0] === 'BE';
    rows.push(
      mk(
        '联动：收尾把正文与指令拆开',
        '正文里不能残留标记，指令也不能丢——两个错一个都会让联动失效',
        ok,
        JSON.stringify(r),
      ),
    );
  }

  // ⑦ 知识点清洗：条数上限、同名去重、超长截断、多余的 step 不进结果
  {
    const raw = JSON.stringify({
      points: [
        { name: '线面垂直的判定', formula: '$a\\perp b$', step: 2 },
        { name: '线面垂直的判定', formula: '重复项', step: 2 },
        ...Array.from({ length: 8 }, (_, i) => ({
          name: `知识点${i}`,
          use: 'x'.repeat(200),
          step: 99,
        })),
      ],
    });
    const pts = normalizeKnowledge(raw);
    const ok =
      pts.length === 6 &&
      pts.filter((p) => p.name.includes('线面垂直')).length === 1 &&
      !('step' in pts[0]) &&
      pts.every((p) => p.use.length <= 80);
    rows.push(
      mk(
        '知识点：条数/同名/超长被清洗，step 字段不进结果',
        '模型一次能给 9 条、每条 200 字，直接渲染会把抽屉撑成一片文字墙',
        ok,
        `${pts.length} 条，首条 ${JSON.stringify(pts[0])}`,
      ),
    );
  }

  // ⑧ 裸 LaTeX 公式自动补 $
  {
    const pts = normalizeKnowledge(
      JSON.stringify([{ name: '二面角', formula: 'AO\\perp BE' }]),
    );
    const ok = pts[0]?.formula === '$AO\\perp BE$';
    rows.push(
      mk(
        '知识点：裸 LaTeX 公式自动包 $',
        '不包 $ 的话 renderMathText 会当普通文字排，学生看到的是一串反斜杠',
        ok,
        JSON.stringify(pts[0]?.formula),
      ),
    );
  }

  // ⑨ 兜底名词：从约束与翻折反推
  {
    const scene: Scene3D = {
      space: '3d' as const,
      meta: { title: '折叠题' },
      params: [],
      objects: [],
      constraints: [
        { type: 'perp-lines' as const, a: ['A1', 'O'], b: ['B', 'E'] },
        { type: 'equal-length' as const, a: ['B', 'C'], b: ['C', 'D'] },
      ],
      fold: { crease: ['B', 'E'] as [string, string], moving: ['A1'], deg: 90 },
    } as Scene3D;
    const names = fallbackKnowledge(scene).map((p) => p.name);
    const ok = names.includes('线线垂直') && names.includes('等长与全等') && names.includes('翻折与二面角');
    rows.push(
      mk(
        '知识点：模型失败时按约束反推名词',
        '抽屉永远不能是空的——没有模型时至少告诉学生"这题在考什么"',
        ok,
        names.join('、'),
      ),
    );
  }

  // ⑩ 事实底稿：坐标可算、隐藏点不出现
  {
    const scene: Scene3D = {
      space: '3d' as const,
      meta: { title: '正方体' },
      params: [],
      objects: [
        { id: 'A', type: 'point3' as const, at: [0, 0, 0] },
        { id: 'B', type: 'point3' as const, at: [2, 0, 0] },
        { id: 'C', type: 'point3' as const, at: [2, 2, 0] },
        { id: 'Ah', type: 'point3' as const, at: [0, 2, 0], hidden: true },
        { id: 'AB', type: 'edge3' as const, a: 'A', b: 'B' },
      ],
      constraints: [{ type: 'perp-lines' as const, a: ['A', 'B'], b: ['A', 'C'] }],
    } as Scene3D;
    const facts = buildFactSheet(scene, {});
    const ok =
      facts.text.includes('A(0, 0, 0)') &&
      !facts.text.includes('Ah') &&
      facts.text.includes('AB ⊥ AC');
    rows.push(
      mk(
        '事实底稿：3D 顶点坐标、约束与隐藏点',
        '答疑全靠这份底稿压住"另算一套坐标"的冲动；隐藏的折前点混进来会更乱',
        ok,
        facts.text.replace(/\n/g, ' | ').slice(0, 160),
      ),
    );
  }

  return rows;
}

function runRenderCases(): RowResult[] {
  const host = document.getElementById('render-sink');
  if (!host) return [];

  const base: RowResult[] = [];
  let engine: SceneRenderer;
  try {
    engine = new SceneRenderer(host);
  } catch (err) {
    // WebGL 不可用（少见，但无头环境偶尔如此）：诚实标"跳过"，不要假装通过
    const msg = (err as Error).message;
    return RENDER_CASES.map((c) => ({
      name: c.name,
      why: c.why,
      gate: '渲染关',
      ok: true,
      skipped: true,
      detail: `WebGL 不可用，未执行（${msg}）——环境问题，不是代码退步`,
    }));
  }

  for (const c of RENDER_CASES) {
    const meta = { name: c.name, why: c.why, gate: '渲染关' };
    const parsed = parseScene(JSON.stringify(c.scene));
    if (!parsed.ok) {
      base.push({
        ...meta,
        ok: false,
        detail: '这个测试场景本身写错了（解析失败）',
        actualText: parsed.errors.join('\n'),
      });
      continue;
    }

    const scene = parsed.scene;
    // ⚠ 必须在 setScene 之前抄一份：autoFitView 是原地改 scene.view 的
    const declared = { ...scene.view };
    const params: Record<string, number> = {};
    for (const p of scene.params) params[p.name] = p.value;

    try {
      engine.setScene(scene, params);
    } catch (err) {
      base.push({
        ...meta,
        ok: false,
        detail: '渲染过程抛异常',
        actualText: (err as Error).message,
      });
      continue;
    }

    const v = engine.getView();
    const problems: string[] = [];
    const eps = 1e-6;

    for (const [x, y] of c.expect.contains ?? []) {
      const inside =
        x >= v.xMin - eps && x <= v.xMax + eps && y >= v.yMin - eps && y <= v.yMax + eps;
      if (!inside) problems.push(`点 (${x}, ${y}) 不在视野内`);
    }

    const al = c.expect.atLeast ?? {};
    if (al.xMin !== undefined && v.xMin > al.xMin + eps)
      problems.push(`xMin 应 ≤ ${al.xMin}，实际 ${v.xMin.toFixed(2)}`);
    if (al.xMax !== undefined && v.xMax < al.xMax - eps)
      problems.push(`xMax 应 ≥ ${al.xMax}，实际 ${v.xMax.toFixed(2)}`);
    if (al.yMin !== undefined && v.yMin > al.yMin + eps)
      problems.push(`yMin 应 ≤ ${al.yMin}，实际 ${v.yMin.toFixed(2)}`);
    if (al.yMax !== undefined && v.yMax < al.yMax - eps)
      problems.push(`yMax 应 ≥ ${al.yMax}，实际 ${v.yMax.toFixed(2)}`);

    if (c.expect.unchanged) {
      const same = (a: number, b: number) => Math.abs(a - b) < eps;
      if (
        !same(v.xMin, declared.xMin) ||
        !same(v.xMax, declared.xMax) ||
        !same(v.yMin, declared.yMin) ||
        !same(v.yMax, declared.yMax)
      ) {
        problems.push(
          `视野被动过：声明的是 [${declared.xMin}, ${declared.xMax}] × [${declared.yMin}, ${declared.yMax}]，` +
            `实际变成 [${v.xMin.toFixed(2)}, ${v.xMax.toFixed(2)}] × [${v.yMin.toFixed(2)}, ${v.yMax.toFixed(2)}]`,
        );
      }
    }

    const ms = c.expect.maxSpan ?? {};
    const spanX = v.xMax - v.xMin;
    const spanY = v.yMax - v.yMin;
    if (ms.x !== undefined && spanX > ms.x + eps)
      problems.push(`x 跨度 ${spanX.toFixed(1)} 超过上限 ${ms.x}`);
    if (ms.y !== undefined && spanY > ms.y + eps)
      problems.push(`y 跨度 ${spanY.toFixed(1)} 超过上限 ${ms.y}`);

    if (problems.length > 0) {
      base.push({ ...meta, ok: false, detail: '最终视野不符合预期', actualText: problems.join('\n') });
    } else {
      base.push({
        ...meta,
        ok: true,
        detail: `视野 [${v.xMin.toFixed(1)}, ${v.xMax.toFixed(1)}] × [${v.yMin.toFixed(1)}, ${v.yMax.toFixed(1)}]`,
      });
    }
  }

  return base;
}

/* ===============================================================
 * 3D 标注关：constraints → 空间记号的推算 + 按句挑选
 *
 * 为什么单独一块：标注是纯函数（不进渲染器也能全量验证），
 * 而它出错的表现是"角弧画在别的顶点上 / 异面直线画了直角方块"——
 * 这类几何错误体检器不管，只有在这里按数学断言才守得住。
 * =============================================================== */
function runAnnotationCases3D(): RowResult[] {
  const mk = (name: string, why: string, ok: boolean, actual?: string): RowResult => ({
    name,
    why,
    gate: '3D 标注关',
    ok,
    detail: ok ? '全部通过' : '断言不成立',
    actualText: actual,
  });

  // 底面正方形 A B C D + 竖棱 AA1，外加 E F 用于异面垂直
  const scene: Scene3D = {
    space: '3d' as const,
    meta: { title: '标注推算测试' },
    params: [],
    objects: [
      { id: 'A', type: 'point3' as const, label: 'A', at: [0, 0, 0] },
      { id: 'B', type: 'point3' as const, label: 'B', at: [2, 0, 0] },
      { id: 'C', type: 'point3' as const, label: 'C', at: [2, 2, 0] },
      { id: 'D', type: 'point3' as const, label: 'D', at: [0, 2, 0] },
      { id: 'A1', type: 'point3' as const, label: "A'", at: [0, 0, 2] },
      { id: 'E', type: 'point3' as const, at: [0, 3, 1] },
      { id: 'F', type: 'point3' as const, at: [0, 5, 1] },
    ],
    constraints: [
      { type: 'angle-value' as const, points: ['B', 'A', 'D'], deg: 90 },
      { type: 'value' as const, expr: 'dist3(A,B)', equals: 2 },
      { type: 'perp-lines' as const, a: ['A1', 'A'], b: ['A', 'B'] }, // 共顶点 A
      { type: 'perp-lines' as const, a: ['A', 'C'], b: ['B', 'D'] }, // 对角线半路相交
      { type: 'perp-lines' as const, a: ['A', 'B'], b: ['E', 'F'] }, // 异面垂直
      { type: 'equal-length' as const, a: ['A', 'B'], b: ['B', 'C'] },
      { type: 'length-ratio' as const, a: ['A', 'B'], b: ['A', 'D'], ratio: 1 },
    ],
  };
  const marks = buildAnnotations3D(scene, {});

  const rows: RowResult[] = [];

  // ① 角度弧：∠BAD 顶点 A，度数文字 90°，弧是 17 个点的折线（16 段）
  const angle = marks.find((m) => m.text === '90°');
  rows.push(
    mk(
      '3D 标注：angle-value 画出顶点弧与度数',
      '∠BAD=90° 应推算出以 A 为 primary 的弧 + 文字',
      !!angle &&
        angle.primary.length === 1 &&
        angle.primary[0] === 'A' &&
        angle.polylines.length === 1 &&
        angle.polylines[0].length === 17,
      `marks=${JSON.stringify(marks.map((m) => m.text ?? m.primary))}`,
    ),
  );

  // ② 弧的几何：起点应在 AB 臂上（A + r·单位(AB)），全程距 A 恒等于 r
  {
    const arc = angle?.polylines[0];
    let geoOk = false;
    let detail = '';
    if (!arc) detail = '没有弧';
    else {
      const r = Math.hypot(arc[0][0], arc[0][1], arc[0][2]);
      geoOk = r > 0.1;
      for (const p of arc) {
        const d = Math.hypot(p[0], p[1], p[2]);
        if (Math.abs(d - r) > 1e-6) {
          geoOk = false;
          detail = `弧上点距顶点 ${d.toFixed(4)} ≠ 半径 ${r.toFixed(4)}`;
          break;
        }
      }
      // 起点方向应沿 AB（x 轴正方向）：起点 y=z=0
      if (geoOk && (Math.abs(arc[0][1]) > 1e-9 || Math.abs(arc[0][2]) > 1e-9)) {
        geoOk = false;
        detail = '弧起点不在 AB 臂上';
      }
      // 90° 弧的终点应在 AD 臂上（y 轴正方向）
      if (geoOk && (Math.abs(arc[16][0]) > 1e-9 || Math.abs(arc[16][2]) > 1e-9)) {
        geoOk = false;
        detail = '弧终点不在 AD 臂上';
      }
      if (geoOk) detail = `半径 ${r.toFixed(3)}，起终点方向正确`;
    }
    rows.push(mk('3D 标注：弧的形状贴合两臂且半径恒定', '空间圆弧应真的在该角平面内', geoOk, detail));
  }

  // ③ dist3 数值：文字 "2"，锚在 AB 外侧（y 分量应为负——背离形心）
  const val = marks.find((m) => m.text === '2');
  rows.push(
    mk(
      '3D 标注：dist3 长度值贴在线段外侧',
      'AB=2 的文字应挂在中点外侧（背离场景形心）',
      !!val &&
        val.primary.join(',') === 'A,B' &&
        !!val.at &&
        val.at[1] < 0,
      val ? `at=${JSON.stringify(val.at)}` : '没有 dist3 标注',
    ),
  );

  // ④ 直角方块：共顶点的 VA⊥AB 只认 A；对角线相交的带上全部四个端点
  const perpMarks = marks.filter((m) => m.text === undefined && m.polylines.length === 1 && m.weight === 3);
  const shared = perpMarks.find((m) => m.primary.length === 1 && m.primary[0] === 'A');
  const crossing = perpMarks.find((m) => m.primary.length === 4);
  rows.push(
    mk(
      '3D 标注：perp-lines 相交时画直角方块',
      '共顶点 → primary 只含 A；对角线半路相交 → 带四个端点',
      !!shared && !!crossing && shared.polylines[0].length === 3,
      `perp 标注数=${perpMarks.length}`,
    ),
  );

  // ⑤ 异面垂直不画：AB 与 EF 方向垂直但距离为 1，没有公共点
  rows.push(
    mk(
      '3D 标注：异面垂直跳过不画',
      '两条异面直线没有交点，直角方块画在哪都会误导',
      perpMarks.every((m) => !(m.primary.includes('E') || m.primary.includes('F'))),
      `perp 标注 primary=${JSON.stringify(perpMarks.map((m) => m.primary))}`,
    ),
  );

  // ⑥ 等长刻度：两条线段各一道杠，primary 是四个端点
  const ticks = marks.find((m) => m.polylines.length === 2);
  rows.push(
    mk(
      '3D 标注：equal-length 画两道刻度',
      'AB=BC 应各有一道垂直短杠',
      !!ticks &&
        ticks.primary.join(',') === 'A,B,B,C' &&
        ticks.polylines.every((p) => p.length === 2),
      ticks ? 'ok' : '没有刻度标注',
    ),
  );

  // ⑦ length-ratio：ratio=1 时式子不带系数
  const ratio = marks.find((m) => m.text === 'AB=AD');
  rows.push(
    mk(
      '3D 标注：length-ratio 写成式子',
      'ratio=1 时应是「AB=AD」而不是「AB=1AD」',
      !!ratio && ratio.weight === 2,
      ratio ? `text=${ratio.text}` : '没有 ratio 标注',
    ),
  );

  // ⑦b 下标：id 里的数字必须转成下标，与图上顶点标签（C₁）一致。
  // 2026-11-06 用户实测：式子里硬生生写成「CN=2NC1」，那个 1 是普通数字。
  {
    const subScene: Scene3D = {
      space: '3d' as const,
      meta: { title: '下标测试' },
      params: [],
      objects: [
        { id: 'C', type: 'point3' as const, at: [2, 2, 0] },
        { id: 'N', type: 'point3' as const, at: [2, 2, 1] },
        { id: 'C1', type: 'point3' as const, at: [2, 2, 2] },
      ],
      constraints: [
        { type: 'length-ratio' as const, a: ['C', 'N'], b: ['N', 'C1'], ratio: 2 },
      ],
    };
    const subMarks = buildAnnotations3D(subScene, {});
    const subText = subMarks.find((m) => m.weight === 2)?.text ?? '';
    rows.push(
      mk(
        '3D 标注：id 里的数字转下标（NC1 → NC₁）',
        '式子必须和图上顶点标签一致，不能出现普通数字 1',
        subText === 'CN=2NC₁',
        `text=${subText || '（没有 ratio 标注）'}`,
      ),
    );
  }

  // ⑧ 挑选规则：全命中最多 2 条、部分命中只留 1 条、没命中不标
  {
    const byFocusA = pickAnnotations3D(marks, ['A']);
    const okA = byFocusA.length === 2 && byFocusA.every((m) => m.weight === 3);
    rows.push(
      mk(
        '3D 标注：focus=顶点 A 挑出全命中且最多 2 条',
        '∠BAD 弧与 VA⊥AB 方块都全命中 A，按权重留前两条',
        okA,
        `挑中=${JSON.stringify(byFocusA.map((m) => m.primary))}`,
      ),
    );

    // 「棱 AB 的长度等于 2」这类句子：focus 恰好是 {A,B}，长度标注的主目标
    // 也是 {A,B}——必须优先于"只沾一个端点、但权重更高"的直角方块。
    const byFocusAB = pickAnnotations3D(marks, ['A', 'B']);
    const textsAB = byFocusAB.map((m) => m.text ?? m.primary.join(''));
    const okAB =
      byFocusAB.length <= 2 &&
      textsAB.includes('2') &&
      !byFocusAB.some((m) => m.primary.length === 1);
    rows.push(
      mk(
        '3D 标注：主目标集合与 focus 完全一致时优先挑它',
        'focus={A,B} 时应挑长度值「2」（可连带 AB=AD），不能挑只沾 A 的直角方块',
        okAB,
        `挑中=${JSON.stringify(textsAB)}`,
      ),
    );

    const byFocusBC = pickAnnotations3D(marks, ['B', 'C']);
    const okBC = byFocusBC.length === 1 && byFocusBC[0].weight === 3 && byFocusBC[0].primary.length === 4;
    rows.push(
      mk(
        '3D 标注：部分命中只留信息量最高的一条',
        'focus=B,C 时直角方块（对角线，命中一半、权重 3）胜过等长刻度（权重 1），只留一条',
        okBC,
        `挑中=${JSON.stringify(byFocusBC.map((m) => m.primary))}`,
      ),
    );

    const none = pickAnnotations3D(marks, []);
    rows.push(
      mk('3D 标注：focus 为空时什么都不标', '“先看图形”的句子不该满屏度数', none.length === 0),
    );
  }

  return rows;
}

/* ===============================================================
 * 程序代改关（autofix3d）：体检错误先由程序修，修不动才退回模型
 *
 * 为什么单独一块：这是"模型抄答案都抄不对"之后的兜底——
 * 截面边数、延长线交点、写反的比值，程序自己全都算得出来，
 * 退回模型既烧调用又烧出 429。这里验证三件事：
 * 修得全（用户实测事故一次修干净）、修得对（体检复检通过）、
 * 修不动的不硬修（推断不出的点名留给模型）。
 * =============================================================== */
function runAutoFixCases3D(): RowResult[] {
  const mk = (name: string, why: string, ok: boolean, actual?: string): RowResult => ({
    name,
    why,
    gate: '程序代改关',
    ok,
    detail: ok ? '全部通过' : '断言不成立',
    actualText: actual,
  });

  const CUBE_IDS = ['A', 'B', 'C', 'D', 'A1', 'B1', 'C1', 'D1'];
  const CUBE_AT: Record<string, [number, number, number]> = {
    A: [0, 0, 0], B: [2, 0, 0], C: [2, 2, 0], D: [0, 2, 0],
    A1: [0, 0, 2], B1: [2, 0, 2], C1: [2, 2, 2], D1: [0, 2, 2],
  };
  /** 正方体骨架：8 顶点 + 6 个面（截面求解要靠面找交线） */
  const cubeObjects = (): Scene3DObject[] => [
    ...CUBE_IDS.map((id) => ({ id, type: 'point3' as const, at: CUBE_AT[id] })),
    { id: 'fBottom', type: 'face3' as const, points: ['A', 'B', 'C', 'D'] },
    { id: 'fTop', type: 'face3' as const, points: ['A1', 'B1', 'C1', 'D1'] },
    { id: 'fFront', type: 'face3' as const, points: ['A', 'B', 'B1', 'A1'] },
    { id: 'fRight', type: 'face3' as const, points: ['B', 'C', 'C1', 'B1'] },
    { id: 'fBack', type: 'face3' as const, points: ['C', 'D', 'D1', 'C1'] },
    { id: 'fLeft', type: 'face3' as const, points: ['D', 'A', 'A1', 'D1'] },
  ];

  const rows: RowResult[] = [];

  // ① 用户实测事故复刻（2026-11-06）：正方体过 D、M、N 的截面是五边形，
  //    模型连写 3 轮"四边形"，比值还把 0.5 写成 5。
  const bad: Scene3D = {
    space: '3d' as const,
    meta: { title: '代改测试：截面五边形' },
    params: [],
    objects: [
      ...cubeObjects(),
      { id: 'M', type: 'point3' as const, at: [0.6, 0, 2] },
      { id: 'N', type: 'point3' as const, derive: { kind: 'section' as const, a: 'C', b: 'C1', t: '1/3' } },
      { id: 'sec', type: 'section3' as const, cut: { vertices: CUBE_IDS }, plane: ['D', 'M', 'N'] },
    ],
    constraints: [{ type: 'length-ratio' as const, a: ['C', 'N'], b: ['N', 'C1'], ratio: 5 }],
    steps: [{ title: '作截面', text: '过 D、M、N 作正方体的截面，截面为四边形 DMN。' }],
  };
  const fixed1 = autoFix3D(bad);
  const errors1 = verifyScene3D(fixed1.scene).filter((i) => i.level === 'error');
  rows.push(
    mk(
      '代改：用户实测事故一次修干净（体检复检通过）',
      '五边形误写四边形 + 比值 5 错，程序应全修好且不再报错',
      errors1.length === 0,
      errors1.map((e) => `${e.where}：${e.message}`).join('；') || '无错误',
    ),
  );

  const stepText = String(fixed1.scene.steps?.[0]?.text ?? '');
  rows.push(
    mk(
      '代改：截面结论改成五边形并写全顶点',
      '边数 = 平面穿过的面数，由逐面求交得出',
      stepText.includes('五边形') && !stepText.includes('四边形'),
      stepText,
    ),
  );

  const ratioC = fixed1.scene.constraints?.find((c) => c.type === 'length-ratio');
  const ratioVal = ratioC && ratioC.type === 'length-ratio' ? ratioC.ratio : NaN;
  rows.push(
    mk(
      '代改：错误比值换成实测值 0.5',
      'N 是派生点（位置由程序算），改值安全；手写坐标的点不碰',
      ratioVal === 0.5,
      `ratio = ${ratioVal}`,
    ),
  );

  const newPts = fixed1.scene.objects.filter(
    (o) => o.type === 'point3' && (o.id === 'P' || o.id === 'Q'),
  );
  rows.push(
    mk(
      '代改：截面无主顶点自动补声明（棱上落点）',
      '正文要写全顶点，匿名顶点得先有名字',
      newPts.length === 2,
      fixed1.fixes.join('；') || '（没有代改）',
    ),
  );

  // ② 句式推断：「M 是 A1D1 的中点，延长 DM 交 AA1 于 P」——
  //    M、P 都没声明；P 的定义依赖 M，链式推断要能接上。
  const scene2: Scene3D = {
    space: '3d' as const,
    meta: { title: '代改测试：句式推断' },
    params: [],
    objects: cubeObjects(),
    steps: [{ title: '构造', text: 'M 是 A1D1 的中点，延长 DM 交 AA1 于 P。' }],
  };
  const fixed2 = autoFix3D(scene2);
  const errors2 = verifyScene3D(fixed2.scene).filter((i) => i.level === 'error');
  rows.push(
    mk(
      '代改：正文点名的点按句式自动补（复检通过）',
      '中点/延长线交点都能从句式读出来，交点由程序算',
      errors2.length === 0,
      errors2.map((e) => `${e.where}：${e.message}`).join('；') || '无错误',
    ),
  );
  const m2 = fixed2.scene.objects.find((o) => o.id === 'M' && o.type === 'point3') as
    | { derive?: { kind?: string } }
    | undefined;
  const p2 = fixed2.scene.objects.find((o) => o.id === 'P' && o.type === 'point3') as
    | { derive?: { kind?: string } }
    | undefined;
  rows.push(
    mk(
      '代改：M 补成中点派生、P 补成交点派生（链式）',
      'P 依赖 M，先补 M 再补 P，两步都得成',
      m2?.derive?.kind === 'midpoint' && p2?.derive?.kind === 'intersect',
      `M=${m2?.derive?.kind ?? '没补'}、P=${p2?.derive?.kind ?? '没补'}`,
    ),
  );

  // ③ 比值写反：|CN|:|NC1| 实测 0.5，模型写 2 —— 对调 a/b 保留原比值
  const scene3: Scene3D = {
    space: '3d' as const,
    meta: { title: '代改测试：比值写反' },
    params: [],
    objects: [
      ...cubeObjects(),
      { id: 'N', type: 'point3' as const, derive: { kind: 'section' as const, a: 'C', b: 'C1', t: '1/3' } },
    ],
    constraints: [{ type: 'length-ratio' as const, a: ['C', 'N'], b: ['N', 'C1'], ratio: 2 }],
  };
  const fixed3 = autoFix3D(scene3);
  const c3 = fixed3.scene.constraints?.find((c) => c.type === 'length-ratio') as
    | { a: string[]; b: string[]; ratio: number }
    | undefined;
  const swapped =
    !!c3 && c3.a[0] === 'N' && c3.a[1] === 'C1' && c3.b[0] === 'C' && c3.b[1] === 'N' && c3.ratio === 2;
  rows.push(
    mk(
      '代改：比值写反时对调两条线段（保留原比值）',
      'actual ≈ 1/ratio 说明方向写反了，不该改值',
      swapped,
      JSON.stringify(c3),
    ),
  );

  // ④ 推断不出的点名：不硬补，原样留给模型（体检仍报 error）
  const scene4: Scene3D = {
    space: '3d' as const,
    meta: { title: '代改测试：推断不出' },
    params: [],
    objects: cubeObjects(),
    steps: [{ title: '辅助', text: '设 K 为辅助点。' }],
  };
  const fixed4 = autoFix3D(scene4);
  rows.push(
    mk(
      '代改：推断不出的点名不硬补',
      'K 从任何句式都推不出来，只能留给模型',
      fixed4.fixes.length === 0,
      fixed4.fixes.join('；') || '（没有代改，正确）',
    ),
  );

  // ⑤ 异面交点的候选线对提示（2026-11-06 实测：报错里的硬编码示例把模型
  //    带偏，声明出第二条异面线对——程序算得出的候选不该让模型猜）
  const pts5 = new Map<string, Vec3>(
    Object.entries({ ...CUBE_AT, M: [2, 2, 1] as [number, number, number] }).map(([k, v]) => [k, v as Vec3]),
  );
  // 保留直线 DM（D(0,2,0)→M(2,2,1)，整条线躺在平面 y=2 里）：
  //   · CD1、C1D1 都在该平面内且不平行 → 两个真候选（延长线真交，交点非顶点）
  //   · CD/DD1 与 DM 共端点 → 排除；CC1 与 DM 交在 M（已声明点）→ 排除
  //   · 其余线段都不在平面 y=2 → 异面排除
  const cand5 = intersectCandidates(['D', 'M'], pts5);
  rows.push(
    mk(
      '异面候选：只列真共面相交、排除共端点与交在已声明点的线段',
      '保留 DM 时 CD1、C1D1 是仅有的有价值候选',
      JSON.stringify(cand5) === JSON.stringify(['CD1', 'C1D1']),
      JSON.stringify(cand5),
    ),
  );

  // 保留 AB（底面前棱）：所有能相交的线段要么共端点（AD/AA1/BC/BB1），
  // 要么交点就是已声明的 B（BD1 的延长线恰好穿过 B）→ 候选应为空
  const candAB = intersectCandidates(['A', 'B'], pts5);
  rows.push(
    mk(
      '异面候选：没有有价值候选时返回空列表',
      'AB 的延长线相交点全是已有顶点或共端点，不该瞎列',
      candAB.length === 0,
      JSON.stringify(candAB),
    ),
  );

  return rows;
}

/* ===============================================================
 * 护栏关：① 图形被压扁时只报根因 ② 面∩面=交线 的断言核对
 * =============================================================== */
function runGuardCases3D(): RowResult[] {
  const mk = (name: string, why: string, ok: boolean, actual?: string): RowResult => ({
    name,
    why,
    gate: '护栏关',
    ok,
    detail: ok ? '全部通过' : '断言不成立',
    actualText: actual,
  });

  const rows: RowResult[] = [];

  /** 正方体；flat=true 时上层顶点 z 也是 0（"忘了给高度"的事故现场） */
  const cubeScene = (
    flat: boolean,
    steps: Array<{ title: string; text: string }> = [],
  ): Scene3D => {
    const h = flat ? 0 : 2;
    return {
      space: '3d' as const,
      meta: { title: flat ? '压扁的立方体' : '正方体' },
      params: [],
      objects: [
        { id: 'A', type: 'point3' as const, at: [0, 0, 0] },
        { id: 'B', type: 'point3' as const, at: [2, 0, 0] },
        { id: 'C', type: 'point3' as const, at: [2, 2, 0] },
        { id: 'D', type: 'point3' as const, at: [0, 2, 0] },
        { id: 'A1', type: 'point3' as const, at: [0, 0, h] },
        { id: 'B1', type: 'point3' as const, at: [2, 0, h] },
        { id: 'C1', type: 'point3' as const, at: [2, 2, h] },
        { id: 'D1', type: 'point3' as const, at: [0, 2, h] },
        { id: 'fBottom', type: 'face3' as const, points: ['A', 'B', 'C', 'D'] },
        { id: 'fTop', type: 'face3' as const, points: ['A1', 'B1', 'C1', 'D1'] },
        { id: 'fFront', type: 'face3' as const, points: ['A', 'B', 'B1', 'A1'] },
        { id: 'eAB', type: 'edge3' as const, a: 'A', b: 'B' },
        { id: 'eBC', type: 'edge3' as const, b: 'C', a: 'B' },
        { id: 'eAA1', type: 'edge3' as const, a: 'A', b: 'A1' },
      ],
      constraints: flat
        ? [{ type: 'perp-lines' as const, a: ['A', 'B'] as [string, string], b: ['A', 'A1'] as [string, string] }]
        : [],
      steps,
    };
  };

  const runVerify = (scene: Scene3D): Issue[] => {
    const parsed = parseScene3D(JSON.stringify(scene));
    if (!parsed.ok) {
      return [{ level: 'error', where: 'parse', message: parsed.errors.join('；') }];
    }
    return verifyScene3D(parsed.scene);
  };

  // ① 压扁的立方体：8 个顶点 z 全 0 → 只回传「所有顶点共面」一条
  const flatErrs = runVerify(cubeScene(true)).filter((i) => i.level === 'error');
  rows.push(
    mk(
      '护栏：图形被压扁时只报根因一条',
      '8 个顶点 z 全 0，顶点重合 / AB⊥AA₁ 都是连带现象，一次全报会让模型去改症状',
      flatErrs.length === 1 &&
        /同一个平面/.test(flatErrs[0].message) &&
        /另有 \d+ 条/.test(flatErrs[0].message),
      flatErrs.map((e) => e.message).join(' | '),
    ),
  );

  // ② 文案 bug：全零偏差时不能出现「最偏离的  只差」（名字是空的）
  rows.push(
    mk(
      '护栏：共面报错不出现空名字',
      '所有点严格共面时取不到"最偏离的点"，文案要说"零偏差"而不是留空',
      flatErrs.length === 1 && !/最偏离的\s*只差/.test(flatErrs[0].message),
      flatErrs[0]?.message ?? '（没有报错）',
    ),
  );

  // ③ 全部点共线：也应该立刻点出根因，而不是留一堆下游错误
  const collinear: Scene3D = {
    space: '3d' as const,
    meta: { title: '所有点共线' },
    params: [],
    objects: [
      { id: 'A', type: 'point3' as const, at: [0, 0, 0] },
      { id: 'B', type: 'point3' as const, at: [1, 0, 0] },
      { id: 'C', type: 'point3' as const, at: [2, 0, 0] },
      { id: 'D', type: 'point3' as const, at: [3, 0, 0] },
      { id: 'eAB', type: 'edge3' as const, a: 'A', b: 'B' },
    ],
  };
  const colErrs = runVerify(collinear).filter((i) => i.level === 'error');
  rows.push(
    mk(
      '护栏：所有顶点共线时报"不是立体图形"',
      '连一个不共线的三点都找不出来时，必须直接说清根因',
      colErrs.length === 1 && /同一条直线/.test(colErrs[0].message),
      colErrs.map((e) => e.message).join(' | '),
    ),
  );

  // ④ 正确断言：平面 A₁BD ∩ 平面 ABCD = BD（B、D 同时在这两个面上）
  const okErrs = runVerify(
    cubeScene(false, [{ title: '求交线', text: '平面 A1BD ∩ 平面 ABCD = BD。' }]),
  ).filter((i) => i.level === 'error');
  rows.push(
    mk(
      '护栏：正确的面∩面=交线 不误报',
      'B、D 同时属于两个平面，断言成立就该放行',
      okErrs.length === 0,
      okErrs.map((e) => e.message).join(' | ') || '（没有报错，正确）',
    ),
  );

  // ⑤ 错误断言：写成 AC（A、C 都不在平面 A₁BD 上）
  const badErrs = runVerify(
    cubeScene(false, [{ title: '求交线', text: '平面 A1BD ∩ 平面 ABCD = AC。' }]),
  ).filter((i) => i.level === 'error');
  rows.push(
    mk(
      '护栏：面∩面=交线 端点不在两面上时报错',
      'AC 不在平面 A₁BD 上，这种断言会把学生教错',
      badErrs.some((e) => /不在两个平面上/.test(e.message) && /AC|平面 A1BD/.test(e.message)),
      badErrs.map((e) => e.message).join(' | '),
    ),
  );

  // ⑥ 平行平面却声称交于一条线
  const parErrs = runVerify(
    cubeScene(false, [{ title: '求交线', text: '平面 A1B1C1D1 ∩ 平面 ABCD = AB。' }]),
  ).filter((i) => i.level === 'error');
  rows.push(
    mk(
      '护栏：平行平面声称有交线时报错',
      '上下底面平行，交不出直线，AB 更不在交线上',
      parErrs.some((e) => /平行/.test(e.message) && /没有交线/.test(e.message)),
      parErrs.map((e) => e.message).join(' | '),
    ),
  );

  // ⑦ 名字里有点没声明（XYZ）→ 拆不干净，静默跳过，绝不瞎猜
  const junkErrs = runVerify(
    cubeScene(false, [{ title: '求交线', text: '平面 XYZ ∩ 平面 ABC = MN。' }]),
  ).filter((i) => i.level === 'error');
  rows.push(
    mk(
      '护栏：拆不开的平面名字不误报',
      'XYZ / MN 不是本题顶点，交线检查必须放弃而不是编一个结论',
      !junkErrs.some((e) => /交线|平行/.test(e.message)),
      junkErrs.map((e) => e.message).join(' | ') || '（没有交线类报错，正确）',
    ),
  );

  return rows;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render(report: Report) {
  const summary = document.getElementById('summary')!;
  summary.innerHTML = '';

  const big = el('div', report.failed === 0 ? 'verdict ok' : 'verdict bad');
  const skipNote = report.skipped > 0 ? `（${report.skipped} 条跳过）` : '';
  big.textContent =
    report.failed === 0
      ? `✓ 全部通过　${report.passed} / ${report.total}${skipNote}`
      : `✗ ${report.failed} 条退步　${report.passed} / ${report.total} 通过${skipNote}`;
  summary.appendChild(big);

  const time = el(
    'div',
    'time',
    `运行于 ${new Date().toLocaleString('zh-CN')}　·　覆盖：格式关 / 数值关 / 约束关 / 读数 / 渲染视野` +
      `　·　画面美观与标签排布仍需肉眼确认`,
  );
  summary.appendChild(time);

  const tbody = document.getElementById('rows')!;
  tbody.innerHTML = '';

  for (const r of report.rows) {
    const tr = el('tr', r.skipped ? 'skip' : r.ok ? 'ok' : 'bad');

    const tdState = el('td', 'state');
    const badgeCls = r.skipped ? 'badge skip' : r.ok ? 'badge pass' : 'badge fail';
    const badgeText = r.skipped ? '跳过' : r.ok ? '通过' : '失败';
    tdState.appendChild(el('span', badgeCls, badgeText));
    tr.appendChild(tdState);

    const tdName = el('td', 'name');
    tdName.appendChild(el('div', 'case-name', r.name));
    tdName.appendChild(el('div', 'case-why', r.why));
    tr.appendChild(tdName);

    tr.appendChild(el('td', 'gate', r.gate));

    const tdRes = el('td', 'res');
    tdRes.appendChild(el('div', 'detail', r.detail));
    if (!r.ok) {
      if (r.expectText) tdRes.appendChild(el('div', 'kv', `期望：${r.expectText}`));
      if (r.actualText) tdRes.appendChild(el('pre', 'actual', r.actualText));
    }
    tr.appendChild(tdRes);

    tbody.appendChild(tr);
  }
}

render(runAll());
