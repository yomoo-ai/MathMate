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
import { measureReadouts3D, verifyScene3D } from '../protocol/verifier3d';
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
 * 下面是把结果画到页面上（没有框架，直接拼 DOM）
 * =============================================================== */

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
