/**
 * 投屏模式：讲台上只留「图 + 参数 + 步骤」，字放大、控件收敛。
 *
 * 为什么不做浏览器全屏？
 *   全屏状态下 Esc 会先被浏览器吃掉（退出全屏），我们的 keydown 收不到，
 *   老师按一下以为没反应、再按一下图就没了。所以这里只切 body 的 class，
 *   要全屏让老师自己按 F11 —— 行为可预期，不会被我们抢。
 *
 * 投屏期间的键盘分工：
 *   ← PageUp    上一步
 *   → PageDown  下一步
 *   空格        下一步（PowerPoint 的习惯）
 *   Esc         退出投屏
 * 输入框里打字时一律不拦截；视频工作台打开时也不拦截（它自己有一套）。
 */

export interface PresentationOpts {
  /** 当前步骤（0 起）、总数、标题 */
  getStep: () => { index: number; total: number; title: string };
  onPrev: () => void;
  onNext: () => void;
  /** 进入/退出后通知外部重排（侧栏显隐让画布尺寸变了） */
  onLayoutChange: () => void;
}

export interface PresentationHandle {
  enter: () => void;
  exit: () => void;
  isActive: () => boolean;
  /** 步骤变化后刷新底部条；未进入投屏时什么也不做 */
  sync: () => void;
}

/** 焦点在输入控件里：此时所有单键快捷键都要让路 */
function isTyping(ev: KeyboardEvent): boolean {
  const t = ev.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/** 视频工作台是否占着屏幕（它在自己那套键盘逻辑，别抢） */
function videoStudioOpen(): boolean {
  const vs = document.getElementById('video-studio');
  return !!vs && !vs.hidden;
}

export function mountPresentationMode(opts: PresentationOpts): PresentationHandle {
  const bar = document.getElementById('present-bar') as HTMLElement | null;
  const btn = document.getElementById('present-btn') as HTMLButtonElement | null;
  const pbTitle = document.getElementById('pb-title');
  const pbPos = document.getElementById('pb-pos');
  const pbPrev = document.getElementById('pb-prev') as HTMLButtonElement | null;
  const pbNext = document.getElementById('pb-next') as HTMLButtonElement | null;
  const pbExit = document.getElementById('pb-exit');
  if (!bar || !btn || !pbTitle || !pbPos || !pbPrev || !pbNext || !pbExit) {
    // 结构缺失时退化成空实现，不让页面因为一个可选功能挂掉
    return { enter: () => {}, exit: () => {}, isActive: () => false, sync: () => {} };
  }

  let active = false;

  /**
   * 投屏时把「参数」整块收起来。
   * 这道题没有滑杆时，那块只剩一行「该场景没有滑杆参数」的提示——
   * 在讲台上是纯占地方，投影一放大就特别显眼。
   */
  const syncParamsPanel = (present: boolean) => {
    const panel = document.getElementById('params-panel');
    const box = document.getElementById('params');
    if (!panel || !box) return;
    panel.hidden = present && box.children.length === 0;
  };

  const sync = () => {
    if (!active) return;
    const { index, total, title } = opts.getStep();
    pbPos.textContent = total > 0 ? `${index + 1} / ${total}` : '暂无步骤';
    pbTitle.textContent = title || '';
    pbPrev.disabled = total === 0 || index <= 0;
    pbNext.disabled = total === 0 || index >= total - 1;
    bar.hidden = false;
  };

  const enter = () => {
    if (active) return;
    active = true;
    document.body.classList.add('present');
    btn.textContent = '退出投屏';
    syncParamsPanel(true);
    sync();
    // 侧栏显隐后画布尺寸变了：等一帧让布局落定，再让渲染器重排
    requestAnimationFrame(() => opts.onLayoutChange());
  };

  const exit = () => {
    if (!active) return;
    active = false;
    document.body.classList.remove('present');
    bar.hidden = true;
    btn.textContent = '投屏';
    syncParamsPanel(false);
    requestAnimationFrame(() => opts.onLayoutChange());
  };

  btn.addEventListener('click', () => (active ? exit() : enter()));
  pbExit.addEventListener('click', exit);
  pbPrev.addEventListener('click', () => opts.onPrev());
  pbNext.addEventListener('click', () => opts.onNext());

  document.addEventListener('keydown', (ev) => {
    if (videoStudioOpen()) return;
    if (isTyping(ev)) return;

    if (!active) {
      // 没进投屏时，P 键也可以进（很多讲课软件都是这个习惯）
      if (ev.key === 'p' || ev.key === 'P') {
        ev.preventDefault();
        enter();
      }
      return;
    }

    switch (ev.key) {
      case 'ArrowLeft':
      case 'PageUp':
        ev.preventDefault();
        opts.onPrev();
        break;
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
        ev.preventDefault();
        opts.onNext();
        break;
      case 'Escape':
        ev.preventDefault();
        exit();
        break;
      case 'p':
      case 'P':
        ev.preventDefault();
        exit();
        break;
      default:
        break;
    }
  });

  return { enter, exit, isActive: () => active, sync };
}
