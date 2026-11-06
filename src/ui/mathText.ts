/**
 * mathText.ts —— 讲解文字里的公式渲染（主页面与视频共用）
 *
 * ===== 为什么单独抽一个模块？=====
 *
 * 这段逻辑原本在 main.ts 和 videoStudio.ts 里各抄了一份，改一处忘另一处是常态。
 * 更要紧的是：**模型输出的 LaTeX 比想象中脏**，清洗规则必须集中、可测。
 *
 * ===== 真实踩过的坑（2026-11-05 视频板书乱码）=====
 *
 * 截图上出现两种坏相：
 *   ① 整行橙红色显示 `$V=\frac{1}{3}\cdot...$`
 *   ② 整行黑色显示 `r = \frac{3-\sqrt{3}}{3}`（源码原样）
 *
 * 根因分别是：
 *   ① 模型把 `$` 也当特殊字符转义了，JSON 里写 `"\\$V=...\\$"`，解析后是 `\$...\$`。
 *      KaTeX 收到的内容末尾带一个孤立反斜杠 → ParseError → KaTeX 默认把**源码标红**
 *      贴回页面，看起来就是"公式乱码"。
 *   ② 模型漏写 `$`，而旧实现只渲染 `$...$` 之间的部分，整行 LaTeX 就原样漏到屏幕上。
 *
 * 再加一个隐患：讲稿解析里 `text.slice(0, 60)` 会从公式中间砍断，
 * 把成对的 `$` 拆散 —— 第 ① 种坏相也会因此凭空产生。
 *
 * 所以这里做三件事：清洗（还原转义、补齐落单的 $）、判断（没有 $ 但明显是公式就整行渲染）、
 * 兜底（真渲染不了就给一段克制的等宽原文，而不是红色报错）。
 */

import katex from 'katex';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 像不像一段 LaTeX：必须出现反斜杠命令（\frac、\sqrt、\cdot…），或上下标 */
function looksLikeLatex(text: string): boolean {
  if (/\\[A-Za-z]{2,}/.test(text)) return true;
  // 只有 ^ / _ 的情况更容易误伤普通文本（如 "a_b 表示下标"），要求带花括号或紧跟数字
  return /[\^_]\{?[0-9A-Za-z]/.test(text) && /[=+\-]/.test(text);
}

/**
 * 清洗一行文字里的公式标记。
 *
 * - `\$` → `$`：模型过度转义的产物。板书里几乎不存在"真的要显示美元符号"的场景，
 *   统一还原的收益远大于风险。
 * - 落单的 `$`（奇数个）→ 末尾补一个：既有截断造成的，也有模型只写了开头忘写结尾。
 *   补上比让整行退化成源码好。
 */
export function normalizeMathInput(raw: string): string {
  let t = String(raw ?? '').replace(/\\\$/g, '$');
  const dollars = (t.match(/\$/g) ?? []).length;
  if (dollars % 2 === 1) t += '$';
  return t;
}

/**
 * 板书行截断：宁可少几个字，也不能把公式从中间砍成两半。
 *
 * 讲稿解析里原来用 `slice(0, 60)` 硬截，一整条 `$...$` 公式写到第 58 个字符时
 * 会被拦腰砍断——收尾的 `$` 没了，整行退化成"公式乱码"。这里改成：
 *   ① 截断点永远不落进 `$...$` 区间内部（半条公式没有可读性）；
 *   ② 优先在 max 内的空格/中文标点/公式边界处断句；
 *   ③ 若 max 内唯一的安全断点太靠前（比如整行几乎是一条长公式），
 *     与其砍掉大半行，不如放宽到 1.6 倍——板书行略微溢出比丢内容好；
 *   ④ 整行就是一条公式时不截（渲染成 KaTeX 后宽度由公式决定）。
 */
export function clipBoardLine(raw: string, max = 60): string {
  const t = String(raw ?? '').trim();
  if (t.length <= max) return t;

  // 成对 $ 区间（奇数个 $ 时最后一个不成对，忽略——normalizeMathInput 会补）
  const dollars: number[] = [];
  for (const m of t.matchAll(/\$/g)) dollars.push(m.index ?? 0);
  const spans: Array<[number, number]> = [];
  for (let i = 0; i + 1 < dollars.length; i += 2) {
    spans.push([dollars[i], dollars[i + 1]]);
  }
  const insideSpan = (p: number) => spans.some(([a, b]) => p > a && p < b);

  /** p 之前最后一个不落在公式内部、且在空格/标点/公式边界上的位置 */
  const lastSafeBefore = (p: number): number => {
    for (let i = Math.min(p, t.length); i > 0; i--) {
      if (insideSpan(i)) continue;
      const ch = t[i - 1];
      if (ch === ' ' || ch === '$' || '，、；：'.includes(ch)) return i;
    }
    return 0;
  };

  let cut = lastSafeBefore(max);
  if (cut > 0 && cut <= max * 0.4) {
    const extended = lastSafeBefore(Math.floor(max * 1.6));
    if (extended > cut) cut = extended;
  }
  if (cut <= 0) return t;
  return t.slice(0, cut).trimEnd() + '…';
}

/**
 * 渲染一段纯公式。
 *
 * 先用严格模式（throwOnError: true）自己接住错误——KaTeX 默认的错误呈现
 * 是把源码染红贴回页面，那正是用户看到的"乱码"。渲染失败时依次尝试：
 *   ① 去掉首尾孤立的反斜杠/空白再试一次（最常见的失败原因）
 *   ② 仍失败就给克制的等宽原文（class 由样式表接管，不再标红刷屏）
 */
function renderFormula(tex: string): string {
  const attempt = (s: string): string | null => {
    try {
      return katex.renderToString(s, { throwOnError: true, displayMode: false });
    } catch {
      return null;
    }
  };

  const direct = attempt(tex);
  if (direct) return direct;

  // 常见脏数据：末尾多一个 `\`（转义残留），或包着多余的花括号
  const cleaned = tex
    .replace(/\\+\s*$/, '')
    .replace(/^\s*\{|\}\s*$/g, '')
    .trim();
  if (cleaned && cleaned !== tex) {
    const second = attempt(cleaned);
    if (second) return second;
  }

  return `<span class="math-fallback">${escapeHtml(cleaned || tex)}</span>`;
}

/**
 * 把 "文字 $公式$ 文字" 渲染成 HTML。公式段交给 KaTeX，其余转义。
 *
 * 没有 `$` 但明显是公式的整行（模型常这么写）也当公式渲染——
 * 板书栏里一整行 `r = \frac{3-\sqrt{3}}{3}` 显示成源码，比渲染失败更难看。
 */
export function renderMathText(raw: string): string {
  const text = normalizeMathInput(raw);
  if (!text.includes('$') && looksLikeLatex(text)) {
    return renderFormula(text.trim());
  }

  const parts = text.split(/\$([^$]+)\$/g);
  return parts
    .map((seg, i) => {
      if (i % 2 === 1) return renderFormula(seg);
      return escapeHtml(seg).replace(/\n/g, '<br>');
    })
    .join('');
}

/**
 * 去掉公式后的纯文字——喂给 TTS 用，公式读出来是一串符号噪音。
 *
 * 反斜杠命令也要清掉：`\frac{3-\sqrt{3}}{3}` 若不处理，
 * 语音会把 "backslash frac" 念出来。
 */
export function plainText(text: string): string {
  return String(text ?? '')
    .replace(/\$[^$]*\$/g, '。')
    .replace(/\\[A-Za-z]+/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
