/**
 * actProtocol.ts —— 聊天回复里的「画面联动指令」协议。
 *
 * 模型在回答末尾追加一行：
 *   <<act {"jump":2,"focus":["BE","A1O"]}>>
 *
 * 选这种行尾标记而不是让整段回答走 JSON，原因只有一个：**要流式**。
 * 正文得是裸文本才能边收边显；控制信息放在最后一行，收尾时一次剥掉。
 *
 * 这里全是纯函数，且是"模型文字 → 画面动作"的唯一通道，所以必须进回归：
 * 白名单漏一条，聊天就能把图搞乱。
 */

export interface ChatAction {
  /** 跳到第几步（1 起） */
  jump?: number;
  /** 要强调的对象 id */
  focus?: string[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const ACT_RE = /<<\s*act\s*([\s\S]*?)>>/g;

function toAction(raw: string): ChatAction | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw.trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const act: ChatAction = {};
  const j = Number(o.jump);
  if (Number.isFinite(j) && j !== 0) act.jump = j;
  if (Array.isArray(o.focus)) {
    const f = o.focus.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    if (f.length) act.focus = f;
  }
  return act.jump !== undefined || act.focus ? act : null;
}

/**
 * 剥掉指令标记，返回可显示的正文。
 *
 * withAct=false 用于**流式过程中**：此时标记可能只到一半（"<<"、"<<act {"ju"），
 * 末尾未闭合的部分一律切掉，否则用户会看着半截 JSON 一闪而过。
 * withAct=true 用于收尾：把已闭合的标记解析成动作。
 */
export function stripActStream(
  raw: string,
  withAct = false,
): { text: string; act: ChatAction | null } {
  let act: ChatAction | null = null;
  if (withAct) {
    const re = new RegExp(ACT_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      act = toAction(m[1]) ?? act; // 有多条时以最后一条为准
    }
  }
  let text = raw.replace(new RegExp(ACT_RE.source, 'g'), '');
  // 末尾未闭合的标记（流式截断 / 模型写坏）整段切掉
  text = text.replace(/<<\s*act[\s\S]*$/, '');
  // 顺手清掉模型偶尔留在末尾的空代码围栏
  text = text.replace(/```[a-zA-Z]*\s*$/, '');
  return { text: text.trim(), act: withAct ? act : null };
}

/**
 * 白名单：跳步必须在 1..stepCount，高亮必须是场景里真有的 id，最多 3 个。
 * 全部不合法就返回 null —— 宁可不动图，也不要动错。
 */
export function sanitizeAction(
  act: ChatAction | null,
  stepCount: number,
  ids: Iterable<string>,
): ChatAction | null {
  if (!act) return null;
  const idSet = ids instanceof Set ? (ids as Set<string>) : new Set(ids);
  const out: ChatAction = {};
  if (typeof act.jump === 'number' && isFinite(act.jump)) {
    const j = Math.round(act.jump);
    if (j >= 1 && j <= stepCount) out.jump = j;
  }
  if (Array.isArray(act.focus)) {
    const f: string[] = [];
    for (const id of act.focus) {
      if (typeof id === 'string' && idSet.has(id) && !f.includes(id)) f.push(id);
      if (f.length >= 3) break;
    }
    if (f.length) out.focus = f;
  }
  return out.jump !== undefined || out.focus ? out : null;
}

/** 联动结果的小标签文案（挂在回答下方） */
export function describeAction(act: ChatAction, stepTitle?: string): string[] {
  const out: string[] = [];
  if (act.jump !== undefined) {
    out.push(`已跳到第 ${act.jump} 步${stepTitle ? ` · ${stepTitle}` : ''}`);
  }
  if (act.focus?.length) out.push(`高亮 ${act.focus.join('、')}`);
  return out;
}
