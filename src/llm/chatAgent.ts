/**
 * chatAgent.ts —— 答疑智能体：回答 + 受控的画面联动。
 *
 * 三条硬规矩，都是为了"不让聊天把图聊坏"：
 *   1. 几何事实只认 factSheet 里那份**程序核验过**的坐标与条件；
 *   2. 联动只开放两个动作：跳步、高亮。改坐标、重画图、改题目一律不给；
 *   3. 联动指令走回答末尾的一行标记，且必须过白名单（跳步范围、id 是否存在）。
 *      指令写坏了就当没写——回答照常显示，画面不动。
 *
 * 指令格式（模型侧）：
 *   <<act {"jump":2,"focus":["BE","A1O"]}>>
 * 选这个格式而不是让模型输出 JSON 包裹整段回答，是因为要流式显示：
 * 正文必须是裸文本，才能边收边显。
 */

import type { ChatAction, ChatMessage } from './actProtocol';
import { stripActStream } from './actProtocol';
import { streamChat } from './stub';

/** 一次对话需要的全部上下文（每次提问都重带，不靠模型记） */
export interface ChatContext {
  /** 题目原文 */
  problem: string;
  /** 已核验事实（factSheet.text） */
  facts: string;
  /** 分步讲解 */
  steps: Array<{ title: string; text: string }>;
  /** 当前停在第几步（0 起） */
  stepIndex: number;
  /** 场景里真实存在的对象 id（高亮的白名单） */
  ids: string[];
}

/** 历史最多留几轮（一问一答算一轮）：再多就挤掉事实底稿的位置了 */
export const MAX_HISTORY_TURNS = 8;

function systemPrompt(ctx: ChatContext): string {
  const n = ctx.steps.length;
  return `你是 MathMate 的答疑老师，正在陪学生看一道已经画好图的数学题。

【最高优先级：以已验事实为准】
下面「已验事实」里的顶点坐标、长度、角度、垂直/平行关系，都是程序算过并核验的。
- 讲到任何几何关系，必须与它一致；事实里没有的，不要宣称"显然成立"；
- **不要另起一套坐标系自己算**。学生看到的图就是这套坐标，你换一套会让他对不上；
- 需要具体数值时，直接用事实里给出的数。

【怎么回答】
- 学生问"这一步为什么"，要讲**动机**（为什么想到这么做），不要复述步骤原文；
- 口语、短：一般 3~6 句；只有必须写式子时才用公式，公式用 $...$，整行不要超过一行；
- 不重复题目原文，不输出 JSON，不画图（图已经有了）；不确定就说不确定，别编。

【范围】
- 数学问题都答，包括他顺口问的别的数学题；
- 非数学（写作、编程、闲聊、别的科目）就回一句"我只帮你看数学题"，不要展开。

【画面联动（可选，最多一条）】
如果学生明确要求"跳到第几步/回到前面/看某条线"，在**回答的最后一行**追加：
<<act {"jump":2,"focus":["BE","A1O"]}>>
- jump：步骤序号，1 到 ${n || 0}；不是明确要求跳步就不要写；
- focus：要强调的对象 id，只能从下面的「可用 id」里挑，最多 3 个；
- 不需要动图就**完全不要写这一行**，也不要解释这个格式。
${n === 0 ? '\n（本题没有分步讲解，不要写 jump。）' : ''}`;
}

function userPrompt(ctx: ChatContext, question: string): string {
  const stepLines = ctx.steps.length
    ? ctx.steps
        .map((s, i) => `${i + 1}. 【${s.title}】${s.text.replace(/\s+/g, ' ').slice(0, 160)}`)
        .join('\n')
    : '（无分步讲解）';
  const cur =
    ctx.steps.length && ctx.stepIndex >= 0 && ctx.stepIndex < ctx.steps.length
      ? `第 ${ctx.stepIndex + 1} 步（${ctx.steps[ctx.stepIndex].title}）`
      : '未定位';
  return [
    `【题目】${ctx.problem || '（无题面，只有图形）'}`,
    ctx.facts,
    `【解题步骤】\n${stepLines}`,
    `【学生当前看到的位置】${cur}`,
    `【可用 id（focus 只能从这里挑）】${ctx.ids.slice(0, 80).join('、')}`,
    `【学生的问题】${question}`,
  ].join('\n\n');
}

/** 只保留最近 N 轮历史（成对裁剪，避免把 user/assistant 拆散） */
export function trimHistory(history: ChatMessage[], maxTurns = MAX_HISTORY_TURNS): ChatMessage[] {
  const max = maxTurns * 2;
  if (history.length <= max) return history;
  // 从尾部往回数满 max 条，再往前对齐到一条 user 消息开头
  let start = history.length - max;
  while (start > 0 && history[start].role !== 'user') start += 1;
  return history.slice(start);
}

/** 一次问答：流式回调正文，返回清洗后的正文与联动指令 */
export async function askTutor(
  ctx: ChatContext,
  history: ChatMessage[],
  question: string,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ text: string; action: ChatAction | null }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(ctx) },
    ...trimHistory(history),
    { role: 'user', content: userPrompt(ctx, question) },
  ];
  // 流式阶段的正文会临时带上未闭合的 <<act，UI 用 stripActStream 剥掉再显示
  const full = await streamChat(messages, onDelta, { temperature: 0.5, signal });
  return splitReply(full);
}

/**
 * 把模型回复拆成「正文 + 联动指令」。
 * 单独导出是为了能进回归：这是唯一会把模型文字变成画面动作的地方。
 */
export function splitReply(raw: string): { text: string; action: ChatAction | null } {
  const { text, act } = stripActStream(raw, true);
  return { text, action: act };
}
