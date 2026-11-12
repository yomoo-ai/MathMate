/**
 * 核验清单浮层：画布左上角一枚小胶囊 + 点开的明细。
 *
 * 放在画布上而不是右侧面板，是因为它回答的是「这张图可不可信」，
 * 必须和图形挨着看；右侧面板已经很长，塞进去会被当成又一段说明文字。
 *
 * 投屏模式下整体隐藏——那是给学生看的画面，可信度标签反而占地方。
 */

import type { CoverageResult } from '../protocol/coverage';

export interface VerifyPanelHandle {
  /** 换场景 / 重新体检后刷新；传 null 表示没有场景 */
  update: (result: CoverageResult | null) => void;
}

type ChipState = 'pass' | 'fail' | 'empty' | 'tainted';

function chipOf(result: CoverageResult | null): { state: ChipState; text: string } {
  if (!result) return { state: 'empty', text: '未核验' };
  if (result.failed > 0) return { state: 'fail', text: `${result.total} 项中 ${result.failed} 项未通过` };
  // 一条约束都没有：没什么可核的，「不可信」这种话反而像在指责
  if (result.empty) return { state: 'empty', text: '未核验 · 只有坐标' };
  if (result.tainted) return { state: 'tainted', text: '核验不可信' };
  return { state: 'pass', text: `已核验 ${result.total} 项` };
}

const MARK: Record<ChipState, string> = {
  pass: '✓',
  fail: '×',
  empty: '!',
  tainted: '!',
};

export function mountVerifyPanel(host: HTMLElement): VerifyPanelHandle {
  // 幂等：开发服务器热更新时模块可能被再执行一次，
  // 不清掉旧的就会在画布上叠出两枚胶囊（且只有新的那枚会更新）
  host.querySelectorAll('.vf-chip, .vf-pop').forEach((n) => n.remove());

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'vf-chip';
  chip.dataset.state = 'empty';
  chip.hidden = true;

  const mark = document.createElement('span');
  mark.className = 'vf-mark';
  const label = document.createElement('span');
  label.className = 'vf-label';
  chip.append(mark, label);

  const pop = document.createElement('div');
  pop.className = 'vf-pop';
  pop.hidden = true;

  host.append(chip, pop);

  let current: CoverageResult | null = null;

  const renderPop = () => {
    pop.textContent = '';
    if (!current) return;

    const head = document.createElement('div');
    head.className = 'vf-pop-head';
    head.textContent = '本次核验（程序按坐标实算）';
    pop.appendChild(head);

    if (current.items.length === 0) {
      const none = document.createElement('div');
      none.className = 'vf-none';
      none.textContent =
        '这个场景没有声明任何几何约束，图上的位置只有坐标、没有任何关系被验证。看的时候请自己核一遍。';
      pop.appendChild(none);
      return;
    }

    const list = document.createElement('div');
    list.className = 'vf-list';
    for (const item of current.items) {
      const row = document.createElement('div');
      row.className = 'vf-item';
      row.dataset.ok = String(item.ok);

      const m = document.createElement('span');
      m.className = 'vf-item-mark';
      m.textContent = item.ok ? '✓' : '×';

      const desc = document.createElement('span');
      desc.className = 'vf-desc';
      desc.textContent = item.text;

      row.append(m, desc);

      if (!item.ok && item.reason) {
        const why = document.createElement('div');
        why.className = 'vf-why';
        why.textContent = item.reason;
        // 完整的报错（含「修法：…」）放 title 里，需要时悬停可看
        if (item.reasonFull) row.title = item.reasonFull;
        row.appendChild(why);
      }
      list.appendChild(row);
    }
    pop.appendChild(list);

    const foot = document.createElement('div');
    foot.className = 'vf-foot';
    if (current.tainted) {
      foot.textContent =
        '这张图存在更底层的错误（整体退化、坐标算不出等），逐条结论暂时不可信，先看下方报错。';
    } else if (current.failed === 0) {
      foot.textContent =
        '以上关系都由程序按实际坐标算出，不是模型自述。派生点（垂足、交点、中点、折后点）也是程序算的，天然满足。';
    } else {
      foot.textContent = '未通过的项已在图上表现为错误，修正后这里会变绿。';
    }
    pop.appendChild(foot);
  };

  chip.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const willOpen = pop.hidden;
    pop.hidden = !willOpen;
    chip.dataset.open = String(willOpen);
    // 清单内容是懒渲染的：打开时才画，省得每次换场景都白建一堆节点
    if (willOpen) renderPop();
  });

  // 点画布或别处收起
  document.addEventListener('click', (ev) => {
    if (pop.hidden) return;
    const t = ev.target as Node | null;
    if (t && (pop.contains(t) || chip.contains(t))) return;
    pop.hidden = true;
    chip.dataset.open = 'false';
  });

  return {
    update: (result) => {
      current = result;
      const { state, text } = chipOf(result);
      chip.dataset.state = state;
      mark.textContent = MARK[state];
      label.textContent = text;
      chip.title =
        state === 'pass'
          ? '点开看本次验了哪些关系'
          : state === 'fail'
            ? '有约束没通过，点开看具体哪条'
            : '这张图没有被完整核验，点开看说明';
      chip.hidden = false;
      // 数据变了但浮层开着：同步刷新内容，避免看到旧清单
      if (!pop.hidden) renderPop();
    },
  };
}
