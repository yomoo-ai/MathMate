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
import { measureReadouts, verifyScene, type Issue } from '../protocol/verifier';
import { intersectCandidates, measureReadouts3D, verifyScene3D } from '../protocol/verifier3d';
import { buildAnnotations3D, pickAnnotations3D } from '../core/annotations3d';
import { autoFix3D } from '../protocol/autofix3d';
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
