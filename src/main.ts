/**
 * main.ts —— 入口：把「场景数据 → 渲染器 → UI」串起来
 *
 * 数据流：
 *   用户操作（切场景/拉滑杆/拖拽/解析 JSON）
 *     → 更新 params
 *     → scene.build(params) 得到 Scene 纯数据
 *     → renderer.setScene(scene, params) 重绘
 *     → refreshReadouts() 更新数值面板
 */
import './styles.css';
import 'katex/dist/katex.min.css';
import katex from 'katex';
import { SceneRenderer } from './core/renderer';
import { Scene3DRenderer } from './core/renderer3d';
import { isScene3D } from './protocol/scene3d';
import type { Scene3D } from './protocol/scene3d';
import { sceneRegistry } from './scenes';
import type { SceneEntry } from './scenes';
import { parseScene } from './protocol/parser';
import { parseScene3D } from './protocol/parser3d';
import { verifyScene, type Issue } from './protocol/verifier';
import { verifyScene3D, sectionScope3D } from './protocol/verifier3d';
import { renderIssueReport, clearIssueReport } from './ui/issueReport';
import { mountVideoStudio } from './ui/videoStudio';
import { evalAny } from './protocol/expr';
import type { Scene, StepDef } from './protocol/scene';
import { SAMPLE_SCENE_JSON } from './protocol/samples';
import { requestSceneFromPrompt, requestSceneFromPrompt3D, transcribeImage } from './llm/stub';
import {
  mountNotebook,
  loadEntries,
  saveEntry,
  removeEntry,
  clearEntries,
  type NotebookEntry,
  type NotebookSource,
} from './ui/notebook';

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** 一份场景：平面或立体 */
type AnyScene = Scene | Scene3D;

/**
 * 解析任意场景 JSON。
 * 先看判别字段 space，再交给对应解析器——而不是"拿 2D 解析器去试，失败再试 3D"：
 * 那样 3D 数据会先被 2D 解析器报一堆毫不相关的错（缺 view、未知类型 point3），
 * 用户看到的错误信息全是误导。
 */
function parseAny(json: string): { ok: true; scene: AnyScene } | { ok: false; errors: string[] } {
  let space = '';
  try {
    space = String((JSON.parse(json) as { space?: unknown })?.space ?? '').toLowerCase();
  } catch {
    // 连 JSON 都不合法：交给 2D 解析器报"不是合法的 JSON"，措辞更准确
  }
  return space === '3d' ? parseScene3D(json) : parseScene(json);
}

/** 数值体检也走对应的那一套 */
function verifyAny(scene: AnyScene): Issue[] {
  return isScene3D(scene) ? verifyScene3D(scene) : verifyScene(scene);
}

const canvasContainer = $('canvas-container');
const tabsEl = $<HTMLSelectElement>('scene-tabs'); // 演示场景下拉框
const infoEl = $('scene-info');
const paramsEl = $('params');
const readoutsEl = $('readouts');
/** 「实时数值」这个小标题在立体场景里要换成「操作提示」 */
const readoutsTitleEl = readoutsEl.previousElementSibling as HTMLElement | null;
const jsonInput = $<HTMLTextAreaElement>('json-input');
const jsonError = $('json-error');
const jsonReport = $('json-report');
const llmOutput = $('llm-output');
const llmReport = $('llm-report');
const llmLog = $<HTMLDetailsElement>('llm-log');
const llmLogBody = $('llm-log-body');

/**
 * 生成过程日志（折叠区）。
 * rejectedCount 记"被体检打回了几次"——它衡量的是护栏干了几次活，
 * 不是失败次数。最终成功时要把它讲清楚，否则用户看到 ✗ 会以为出错了。
 */
let logLines: string[] = [];
let rejectedCount = 0;

function resetLog() {
  logLines = [];
  rejectedCount = 0;
  llmLogBody.textContent = '';
  llmLog.hidden = true;
  llmLog.open = false;
}

function pushLog(m: string) {
  logLines.push(m);
  // 以 ✗ 开头的行 = 这一轮没通过（被退回重做）
  if (m.trimStart().startsWith('✗')) rejectedCount++;
  llmLogBody.textContent = logLines.join('\n');
  if (llmLog.hidden) {
    llmLog.hidden = false;
  }
  const summary = llmLog.querySelector('summary');
  if (summary) {
    summary.textContent =
      rejectedCount > 0
        ? `生成过程（${logLines.length} 行 · 其中 ${rejectedCount} 次被自动退回修正）`
        : `生成过程（${logLines.length} 行）`;
  }
}

jsonInput.value = SAMPLE_SCENE_JSON;

const renderer = new SceneRenderer(canvasContainer);
// 主画布关闭步骤运镜：点"上一步/下一步"时视野固定不动（坐标轴不晃、不自动缩放），
// 缩放只由参数滑杆控制；讲解视频板块的渲染器不受影响，仍保留运镜。
renderer.stepFlyEnabled = false;
// 给 2D 画布打标记：切到立体场景时靠它把两块画布互相隐藏
const canvas2d = canvasContainer.querySelector('canvas') as HTMLCanvasElement | null;
canvas2d?.setAttribute('data-space', '2d');

/** 3D 渲染器按需创建——不用立体场景就不占一个 WebGL 上下文 */
let renderer3d: Scene3DRenderer | null = null;

/** 当前生效的场景数据与参数（单一数据源） */
let activeScene: Scene;
let activeScene3D: Scene3D | null = null;
let activeSpace: '2d' | '3d' = '2d';
/** 记住当前场景入口：滑杆改参数时要靠它重新 build */
let currentEntry: SceneEntry | null = null;
let params: Record<string, number> = {};
const sliderInputs = new Map<string, HTMLInputElement>();

// 拖拽画布改参数时，同步滑杆位置与数值面板
renderer.onParamChange = (name, value) => {
  params[name] = value;
  const input = sliderInputs.get(name);
  if (input) input.value = String(value);
  const valEl = document.getElementById(`val-${name}`);
  if (valEl) valEl.textContent = value.toFixed(2);
  refreshReadouts();
};

function defaultsOf(scene: Scene | Scene3D): Record<string, number> {
  const d: Record<string, number> = {};
  for (const p of scene.params) d[p.name] = p.value;
  return d;
}

/** 2D 正交画布 / 3D 透视画布只显示其中一块 */
function setActiveSpace(space: '2d' | '3d') {
  for (const c of Array.from(canvasContainer.querySelectorAll('canvas'))) {
    (c as HTMLCanvasElement).style.display =
      c.getAttribute('data-space') === space ? 'block' : 'none';
  }
  renderer3d?.setActive(space === '3d');
}

function ensureRenderer3d(): Scene3DRenderer {
  if (!renderer3d) {
    renderer3d = new Scene3DRenderer(canvasContainer);
    // 同 2D：主画布切步骤不运镜，视野保持固定
    renderer3d.stepFlyEnabled = false;
  }
  return renderer3d;
}

/**
 * 应用一份场景数据：更新 UI 三件套（信息/滑杆/数值）并渲染。
 * 2D 与 3D 走两条路，但**读数与分步讲解两边都有**——
 * 立体几何同样需要"这一步在讲哪条棱"和"PA 有多长"。
 * resetView=false 用于"拖滑杆改参数"——此时几何变了但视角该保持。
 * fromEntry=true 表示来自顶部场景标签页（只有它才允许滑杆重建场景）。
 */
function applyScene(scene: AnyScene, resetView = true, fromEntry = false) {
  // 非场景标签页来的数据（LLM 生成 / 题本 / 手贴 JSON）不能留着旧 entry：
  // 否则下一次拖滑杆会按旧场景重建，把刚生成的东西覆盖掉
  if (!fromEntry) currentEntry = null;

  infoEl.innerHTML = `
    <h2>${escapeHtml(scene.meta.title)}</h2>
    <p>${escapeHtml(scene.meta.subtitle ?? '')}</p>`;

  if (isScene3D(scene)) {
    activeScene3D = scene;
    activeSpace = '3d';
    params = defaultsOf(scene);
    ensureRenderer3d().setScene(scene, params, resetView);
    setActiveSpace('3d');
    buildSliders(scene);
    // JSON 框也要跟着换，否则右边还挂着上一个场景的数据，看着像"没生效"
    jsonInput.value = JSON.stringify(scene, null, 2);
    clearIssueReport(jsonReport);
    jsonError.textContent = '';
    refreshReadouts3D(scene);
    setupSteps(scene.steps);
    return;
  }

  if (readoutsTitleEl) readoutsTitleEl.textContent = '实时数值';

  activeScene = scene;
  activeScene3D = null;
  activeSpace = '2d';
  params = defaultsOf(scene);
  renderer.setScene(scene, params);
  setActiveSpace('2d');
  buildSliders(scene);
  refreshReadouts();
  setupSteps(scene.steps);
}

/** 诊断页专用：跳过 hash 逻辑直接应用任意场景（不用于正常入口） */
export function applySceneForDebug(scene: Scene) {
  applyScene(scene);
}

// ---------------------------------------------------------------
// 分步讲解（阶段 2）：步骤条 + 图形联动
// ---------------------------------------------------------------
let stepIndex = 0;
/** 当前场景的分步讲解（2D / 3D 共用一套导航逻辑） */
let currentSteps: StepDef[] = [];

/** 把 "文字 $公式$ 文字" 渲染成 HTML：公式段交给 KaTeX，其余转义 */
function renderMathText(text: string): string {
  const parts = text.split(/\$([^$]+)\$/g);
  return parts
    .map((seg, i) => {
      if (i % 2 === 1) {
        try {
          return katex.renderToString(seg, { throwOnError: false });
        } catch {
          return escapeHtml(seg);
        }
      }
      return escapeHtml(seg).replace(/\n/g, '<br>');
    })
    .join('');
}

function setupSteps(steps: StepDef[] | undefined) {
  const panel = $<HTMLElement>('step-panel');
  currentSteps = steps ?? [];
  const prevBtn = $<HTMLButtonElement>('step-prev');
  const nextBtn = $<HTMLButtonElement>('step-next');
  const videoBtn = $<HTMLButtonElement>('step-video');
  if (currentSteps.length === 0) {
    // 布局一致性：面板不再隐藏，而是显示占位提示，保证每个场景右侧结构相同
    panel.hidden = false;
    $('step-pos').textContent = '';
    $('step-title').textContent = '本场景暂无分步讲解';
    $('step-text').innerHTML =
      '<p class="msg" style="margin:0">用「LLM 生成」或「拍照识题」做出的题目会自动带分步讲解。</p>';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    videoBtn.disabled = true;
    renderer.setStep(-1);
    renderer3d?.setStep(-1);
    return;
  }
  panel.hidden = false;
  prevBtn.disabled = false;
  nextBtn.disabled = false;
  videoBtn.disabled = false;
  stepIndex = 0;
  showStep();
}

function showStep() {
  const steps = currentSteps;
  if (steps.length === 0) return;
  stepIndex = Math.max(0, Math.min(stepIndex, steps.length - 1));
  const s = steps[stepIndex];
  $('step-pos').textContent = `第 ${stepIndex + 1} / ${steps.length} 步`;
  $('step-title').textContent = s.title;
  $('step-text').innerHTML = renderMathText(s.text);
  $<HTMLButtonElement>('step-prev').disabled = stepIndex === 0;
  $<HTMLButtonElement>('step-next').disabled = stepIndex === steps.length - 1;
  // 交给当前生效的那个渲染器
  if (activeSpace === '3d') {
    renderer3d?.setStep(stepIndex);
  } else {
    renderer.setStep(stepIndex);
  }
}

$('step-prev').addEventListener('click', () => {
  stepIndex -= 1;
  showStep();
});
$('step-next').addEventListener('click', () => {
  stepIndex += 1;
  showStep();
});

// 讲解视频工作台：把当前场景交给独立区域播放（阶段②）
// 注意传的是场景数据本体 + 当前参数，工作台用自己的渲染器，不碰主画布
const videoStudio = mountVideoStudio();
$('step-video').addEventListener('click', () => {
  const title = currentEntry?.name ?? 'MathMate 讲解视频';
  // 题目原文 = LLM 输入框里的内容（拍照转录后也会回填到这个框）；
  // 内置演示场景没有题面，传空串让题目栏隐藏
  const problem = llmPromptInput.value.trim();
  if (activeSpace === '3d' && activeScene3D) {
    videoStudio.open(activeScene3D, params, title, problem);
  } else {
    videoStudio.open(activeScene, params, title, problem);
  }
});

function loadEntry(entry: SceneEntry) {
  currentEntry = entry;
  // 下拉框同步选中项
  tabsEl.value = entry.key;
  // 场景写进 URL：刷新后停在原场景，不用每次从「二次函数」重新点
  try {
    history.replaceState(null, '', `#${entry.key}`);
  } catch {
    // file:// 等环境下 replaceState 可能受限，不影响主流程
  }
  applyScene(entry.build(entry.defaults), true, true);
}

function buildSliders(scene: Scene | Scene3D) {
  paramsEl.innerHTML = '';
  sliderInputs.clear();

  for (const p of scene.params) {
    if (p.slider === false) continue;
    const row = document.createElement('div');
    row.className = 'slider-row';
    row.innerHTML = `
      <div class="row-head">
        <span>${escapeHtml(p.label)}</span>
        <span class="val" id="val-${p.name}">${p.value.toFixed(2)}</span>
      </div>`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(p.min);
    input.max = String(p.max);
    input.step = String(p.step);
    input.value = String(p.value);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      params[p.name] = v;
      if (activeSpace === '3d') {
        // 立体场景整体重建（对象就几十个，成本可忽略），但保持当前视角
        rebuild3D();
      } else {
        renderer.setParam(p.name, v);
      }
      const valEl = document.getElementById(`val-${p.name}`);
      if (valEl) valEl.textContent = v.toFixed(2);
      if (activeSpace !== '3d') refreshReadouts();
    });
    row.appendChild(input);
    paramsEl.appendChild(row);
    sliderInputs.set(p.name, input);
  }

  if (sliderInputs.size === 0) {
    paramsEl.innerHTML = activeSpace === '3d'
      ? '<p class="msg">该立体场景没有滑杆参数。</p>'
      : '<p class="msg">该场景没有滑杆参数——请直接在画布上拖拽彩色圆点。</p>';
  }
}

/** 立体场景改参数后重建数据，视角保持不变 */
function rebuild3D() {
  // 场景标签页里的演示场景要重新 build（subtitle 里有"棱长 2.00"这类动态数字）；
  // LLM 生成 / 手贴 JSON 的场景没有 builder，直接拿现有数据重算表达式即可
  const next = currentEntry ? currentEntry.build(params) : activeScene3D;
  if (!next || !isScene3D(next)) return;
  activeScene3D = next;
  infoEl.innerHTML = `
    <h2>${escapeHtml(next.meta.title)}</h2>
    <p>${escapeHtml(next.meta.subtitle ?? '')}</p>`;
  ensureRenderer3d().setScene(next, params, false);
  refreshReadouts3D(next);
}

function refreshReadouts() {
  readoutsEl.innerHTML = '';
  const list = activeScene.readouts ?? [];
  if (list.length === 0) {
    readoutsEl.innerHTML = '<p class="msg">该场景没有实时数值。</p>';
    return;
  }
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'readout-row';
    let text = '—';
    try {
      const v = evalAny(r.expr, { ...params });
      if (typeof v === 'number') {
        text = (isFinite(v) ? v.toFixed(2) : '—') + (r.unit ?? '');
      } else if (v !== undefined && v !== null) {
        text = String(v);
      }
    } catch {
      text = '—';
    }
    row.innerHTML = `
      <span class="k">${escapeHtml(r.label)}</span>
      <span class="v">${escapeHtml(text)}</span>`;
    readoutsEl.appendChild(row);
  }
}

/**
 * 立体场景的读数。
 * 表达式的点 id 在 resolve3d 阶段已经展开成数字，这里只按当前参数求值。
 * 没有读数时退化成操作提示——立体图最需要告诉人的就是"可以拖着转"。
 */
function refreshReadouts3D(scene: Scene3D) {
  readoutsEl.innerHTML = '';
  const list = scene.readouts ?? [];
  if (list.length === 0) {
    // 布局一致性：标题统一保持「实时数值」，3D 场景没有读数时在内容区给操作提示
    if (readoutsTitleEl) readoutsTitleEl.textContent = '实时数值';
    readoutsEl.innerHTML =
      '<p class="msg" style="margin:0">拖动图形可旋转 · 滚轮缩放 · 背面的棱自动画成虚线</p>';
    return;
  }
  if (readoutsTitleEl) readoutsTitleEl.textContent = '实时数值';
  // 截面量（secA3/secB3/secArea3）由现场几何算出，注入 scope
  const fullScope = sectionScope3D(scene, { ...params });
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'readout-row';
    let text = '—';
    try {
      const v = evalAny(r.expr, fullScope);
      if (typeof v === 'number') {
        text = (isFinite(v) ? v.toFixed(2) : '—') + (r.unit ?? '');
      } else if (v !== undefined && v !== null) {
        text = String(v);
      }
    } catch {
      text = '—';
    }
    row.innerHTML = `
      <span class="k">${escapeHtml(r.label)}</span>
      <span class="v">${escapeHtml(text)}</span>`;
    readoutsEl.appendChild(row);
  }
}

// ---------------------------------------------------------------
// 场景标签页（下拉框）：每个 option 对应一个内置演示场景
// ---------------------------------------------------------------
{
  // 第一项是占位：LLM/拍照生成自定义题目时选中它（不对应任何内置场景）
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '自定义题目（LLM / 拍照 / JSON）';
  tabsEl.appendChild(placeholder);
}
for (const entry of sceneRegistry) {
  const opt = document.createElement('option');
  opt.value = entry.key;
  opt.textContent = entry.name;
  tabsEl.appendChild(opt);
}
// 用户在下拉框里换场景 = 切换到对应内置演示
tabsEl.addEventListener('change', () => {
  const target = sceneRegistry.find((e) => e.key === tabsEl.value);
  if (target) loadEntry(target);
});
// 初始场景：优先取 URL 里的 #key（刷新后停在原场景），否则用第一个。
// 也认 ?scene=key —— 无头截图/分享链接时 hash 有时会被丢掉，查询参数更可靠。
{
  const fromHash = location.hash.replace('#', '');
  const fromQuery = new URLSearchParams(location.search).get('scene') ?? '';
  const key = fromHash || fromQuery;
  const target = sceneRegistry.find((e) => e.key === key);
  loadEntry(target ?? sceneRegistry[0]);
}

// ---------------------------------------------------------------
// JSON 演示：手改文本框 → 解析 → 渲染
// ---------------------------------------------------------------
$('json-parse-btn').addEventListener('click', () => {
  const result = parseAny(jsonInput.value);
  if (result.ok) {
    jsonError.textContent = '';
    jsonError.className = 'msg';
    // 手贴的 JSON 也做数值体检——error 不拦截（自己写的自己负责），
    // 但问题会以报告面板的形式逐条亮出来，方便对照画面找"为什么少了个点"
    renderIssueReport(jsonReport, verifyAny(result.scene));
    applyScene(result.scene);
    // 自定义 JSON 不属于任何内置演示 → 下拉框回到占位项
    tabsEl.value = '';
  } else {
    jsonError.textContent = '解析失败：\n' + result.errors.join('\n');
    jsonError.className = 'msg error';
    clearIssueReport(jsonReport);
  }
});

// ---------------------------------------------------------------
// 我的题本（阶段 5）：解过的题自动存本地，随时回看
//
// 存的是「场景 JSON 原文」，不是渲染结果——一条几 KB。
// 恢复时必须重新过 parseScene：存档可能来自旧协议版本，直接塞给渲染器会白屏。
// ---------------------------------------------------------------
const notebookEl = $<HTMLElement>('notebook');
const nbBadge = $<HTMLElement>('nb-badge');
const notebookBtn = $<HTMLButtonElement>('notebook-btn');

const notebook = mountNotebook(notebookEl, {
  onOpen: openFromNotebook,
  onDelete: (id) => refreshNotebook(removeEntry(id)),
  onClear: () => refreshNotebook(clearEntries()),
});

/** 重绘列表 + 顶栏徽章 */
function refreshNotebook(entries: NotebookEntry[]) {
  notebook.refresh(entries);
  nbBadge.textContent = String(entries.length);
  nbBadge.hidden = entries.length === 0;
}

function openFromNotebook(entry: NotebookEntry) {
  const result = parseAny(entry.sceneJson);
  if (!result.ok) {
    llmOutput.className = 'msg error';
    llmOutput.textContent =
      `✗ 这条存档打不开（可能是旧版本存下的）：${result.errors.slice(0, 2).join('；')}`;
    return;
  }
  applyScene(result.scene);
  jsonInput.value = JSON.stringify(result.scene, null, 2);
  tabsEl.value = ''; // 题本里的存档不是内置演示 → 下拉框回到占位项
  llmOutput.className = 'msg';
  llmOutput.textContent = `✓ 已从题本打开「${result.scene.meta.title}」`;
  notebook.close();
}

notebookBtn.addEventListener('click', () => notebook.toggle());
refreshNotebook(loadEntries());

// ---------------------------------------------------------------
// LLM 场景生成：一句话 → 模型 → 校验 → 渲染
// ---------------------------------------------------------------
const llmKeyInput = $<HTMLInputElement>('llm-key');
const llmPromptInput = $<HTMLTextAreaElement>('llm-prompt');
/** 「立体几何」开关：勾上后走 3D 的说明书 / 解析器 / 体检器 */
const solidModeInput = $<HTMLInputElement>('solid-mode');

// 模式选择记在本机：习惯用立体的人不用每次重新勾
solidModeInput.checked = localStorage.getItem('mm-solid-mode') === '1';
solidModeInput.addEventListener('change', () => {
  localStorage.setItem('mm-solid-mode', solidModeInput.checked ? '1' : '0');
});

// Key 存 localStorage：只在用户本机浏览器里，不进代码、不进 git
llmKeyInput.value = localStorage.getItem('mm-api-key') ?? '';
llmKeyInput.addEventListener('input', () => {
  // 清洗：删掉全角空格/弯引号/零宽字符等复制时带进的杂质（key 本身是纯 ASCII）
  llmKeyInput.value = llmKeyInput.value.replace(/[^\x20-\x7E]/g, '');
  localStorage.setItem('mm-api-key', llmKeyInput.value.trim());
});

/**
 * 从文字描述生成场景并渲染（阶段 4 抽出复用）：
 * 「LLM 场景生成」按钮和「拍照输入」流程都走这里——
 * 拍照只是多了一步"图 → 文字"，后半段流水线完全相同。
 */
async function generateScene(prompt: string, source: NotebookSource = 'text') {
  const btn = $<HTMLButtonElement>('llm-btn');
  btn.disabled = true;
  llmOutput.className = 'msg';
  llmOutput.textContent = '→ 正在调用模型……';
  clearIssueReport(llmReport);
  // 过程日志收进折叠区。
  // 以前是把每一行都追加到主输出区，于是「✗ 数值体检未通过」这些
  // **中间被打回**的红色行和最终结果混在一起，用户会以为"生成失败了"。
  // 其实那正是护栏在干活：退回重做，下一轮就过了。
  // 现在主输出只留最终结论，过程收起来（想看原因就展开）。
  resetLog();
  // 最后一轮的体检结果：存题本时记下来，回看时才知道当时干不干净
  let lastIssues: Issue[] = [];
  try {
    // 两条链路的**护栏完全相同**，只是协议和说明书不同
    const onIssues = (issues: Issue[]) => {
      lastIssues = issues;
      renderIssueReport(llmReport, issues);
    };
    const scene: AnyScene = solidModeInput.checked
      ? await requestSceneFromPrompt3D(prompt, pushLog, onIssues)
      : await requestSceneFromPrompt(prompt, pushLog, onIssues);
    applyScene(scene);
    // 生成的场景同步填进 JSON 演示框——能看到模型到底输出了什么
    jsonInput.value = JSON.stringify(scene, null, 2);
    tabsEl.value = ''; // 生成的是自定义题目 → 下拉框回到占位项
    // 自动存进题本：同一道题再生成只覆盖那一条，不会越堆越多
    refreshNotebook(
      saveEntry({
        title: scene.meta.title,
        prompt,
        sceneJson: JSON.stringify(scene, null, 2),
        source,
        issueCount: lastIssues.length,
      }),
    );
    llmOutput.textContent =
      rejectedCount === 0
        ? `✓ 已生成「${scene.meta.title}」：一次通过校验与体检`
        : `✓ 已生成「${scene.meta.title}」：共 ${rejectedCount + 1} 次尝试，` +
          `前 ${rejectedCount} 次未通过已被自动退回修正（过程见下方「生成过程」）`;
    // 把场景规模打出来——滑杆/对象数量一眼可核对，避免"看着没有其实在屏幕外"
    llmOutput.textContent +=
      `\n参数 ${scene.params.length} 个 · 对象 ${scene.objects.length} 个` +
      ` · 读数 ${(scene.readouts ?? []).length} 条`;
    // 生成后把右侧面板滚到参数区，防止小屏幕上滑杆在视野之外
    paramsEl.scrollIntoView({ block: 'nearest' });
  } finally {
    btn.disabled = false;
  }
}

$('llm-btn').addEventListener('click', async () => {
  const prompt = llmPromptInput.value.trim();
  if (!prompt) {
    llmOutput.className = 'msg error';
    llmOutput.textContent = '先在输入框里描述你想要的场景。';
    return;
  }
  try {
    await generateScene(prompt);
  } catch (e) {
    llmOutput.className = 'msg error';
    llmOutput.textContent = `✗ ${(e as Error).message}`;
    // 真失败时把过程摊开——用户（和我）需要看它到底卡在哪一轮
    llmLog.hidden = false;
    llmLog.open = true;
  }
});

// ---------------------------------------------------------------
// 拍照输入（阶段 4）：图 → 视觉模型转录 → 复用文字生成流水线
// ---------------------------------------------------------------
const vlKeyInput = $<HTMLInputElement>('vl-key');
const vlModelSelect = $<HTMLSelectElement>('vl-model');
const ocrFileInput = $<HTMLInputElement>('ocr-file');
const ocrFileName = $('ocr-file-name');
const ocrPreview = $<HTMLImageElement>('ocr-preview');
const ocrBtn = $<HTMLButtonElement>('ocr-btn');
const ocrOutput = $('ocr-output');

// 视觉模型 Key 同样只存本机浏览器
vlKeyInput.value = localStorage.getItem('mm-vl-key') ?? '';
vlKeyInput.addEventListener('input', () => {
  vlKeyInput.value = vlKeyInput.value.replace(/[^\x20-\x7E]/g, '');
  localStorage.setItem('mm-vl-key', vlKeyInput.value.trim());
});

// 识别模型选择也记在本机。实测（2026-10-29）：几何图的标记识别 GLM-4.6V 更准，
// deepseek-flash 识图容易丢条件（转录缺信息 → 下游生成零约束），故默认用 GLM，
// DeepSeek 识图只作为"只填了一把 Key"时的兜底
vlModelSelect.value = localStorage.getItem('mm-vl-model') ?? 'glm-4.6v-flash';
vlModelSelect.addEventListener('change', () => {
  localStorage.setItem('mm-vl-model', vlModelSelect.value);
});

/** 选图后把图压缩到最长边 1200px 的 JPEG——手机原图动辄 4000px、好几 MB，
 *  base64 塞进请求体既慢又可能超限；转录题目不需要高分辨率 */
function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1200;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败，换一张试试。'));
    };
    img.src = url;
  });
}

let imageDataUrl = '';

ocrFileInput.addEventListener('change', async () => {
  const file = ocrFileInput.files?.[0];
  if (!file) return;
  ocrFileName.textContent = file.name; // 选完给个反馈，别让人怀疑没选上
  ocrOutput.className = 'msg';
  ocrOutput.textContent = '';
  try {
    imageDataUrl = await readImageFile(file);
    ocrPreview.src = imageDataUrl;
    ocrPreview.hidden = false;
  } catch (e) {
    ocrOutput.className = 'msg error';
    ocrOutput.textContent = (e as Error).message;
  }
});

ocrBtn.addEventListener('click', async () => {
  if (!imageDataUrl) {
    ocrOutput.className = 'msg error';
    ocrOutput.textContent = '先选择一张题目照片。';
    return;
  }
  ocrBtn.disabled = true;
  ocrOutput.className = 'msg';
  ocrOutput.textContent = '→ 正在识别图片中的题目……';
  try {
    // 第①环：视觉模型转录（它只看图写字，不懂数学也没关系）
    const text = await transcribeImage(
      imageDataUrl,
      (m) => {
        ocrOutput.textContent += `\n${m}`;
      },
      vlModelSelect.value,
    );
    // 识别结果填进文字输入框——你可以先人工核对/修改，再点生成
    llmPromptInput.value = text;
    ocrOutput.textContent += `\n✓ 识别完成，已填入「LLM 场景生成」的输入框：\n${text}`;
    ocrOutput.textContent += '\n→ 正在用识别结果生成场景……';
    // 第②环：与手打文字完全相同的生成流水线（含校验、体检、重试）
    await generateScene(text, 'photo');
  } catch (e) {
    ocrOutput.className = 'msg error';
    ocrOutput.textContent += `\n✗ ${(e as Error).message}`;
  } finally {
    ocrBtn.disabled = false;
  }
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
