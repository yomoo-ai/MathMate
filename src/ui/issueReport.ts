/**
 * issueReport.ts —— 体检报告的可视化渲染（阶段 3 收尾）
 *
 * 职责单一：把 Issue[] 画成一段 HTML——
 *   - 全部通过：一枚绿色「✓ 通过」徽章；
 *   - 有问题：顶部一行汇总（几个错误 / 几条提醒），下面逐条列出，
 *     错误红底、提醒黄底，出处（对象 id）和原因分开显示。
 *
 * 为什么单独一个文件？main.ts 已经不小了，而"报告长什么样"是纯 UI 逻辑，
 * 以后想改配色、加折叠、加"一键复制报告"，都只动这里。
 */

import type { Issue } from '../protocol/verifier';

/** 防 XSS：问题文本里可能混有用户输入（如表达式内容），插入 innerHTML 前必须转义 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把问题清单渲染进指定容器（innerHTML 全量覆盖） */
export function renderIssueReport(el: HTMLElement, issues: Issue[]): void {
  if (issues.length === 0) {
    el.innerHTML = `
      <div class="issue-item">
        <span class="badge ok">✓ 通过</span>
        <span class="issue-msg">格式校验与数值体检全部通过</span>
      </div>`;
    return;
  }

  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warn');

  // 汇总行 + 逐条明细。错误在前，提醒在后——先看要命的，再看顺带的
  const rows = [...errors, ...warns]
    .map(
      (i) => `
      <div class="issue-item ${i.level}">
        <span class="badge ${i.level}">${i.level === 'error' ? '错误' : '提醒'}</span>
        <span class="issue-body"><b>${esc(i.where)}</b>${esc(i.message)}</span>
      </div>`,
    )
    .join('');

  el.innerHTML = `
    <div class="issue-head">
      ${errors.length > 0 ? `<span class="badge error">错误 ${errors.length}</span>` : ''}
      ${warns.length > 0 ? `<span class="badge warn">提醒 ${warns.length}</span>` : ''}
      <span class="issue-head-text">${
        errors.length > 0 ? '需要修正后才能正常显示' : '不影响渲染，但建议留意'
      }</span>
    </div>
    ${rows}`;
}

/** 清空报告（开始新一轮生成/解析时调用） */
export function clearIssueReport(el: HTMLElement): void {
  el.innerHTML = '';
}
