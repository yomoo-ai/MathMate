/**
 * jsonRepair.ts —— 模型输出的 JSON 出语法错时，先试着修再报错。
 *
 * 为什么值得单独写一个模块？
 * 因为这类错误**不是几何错误**，却和几何错误一样烧一次调用额度：
 * 一次生成通常要几十秒，模型只是在第 600 个字符处漏了一个逗号，
 * 整份图就白生成了，回传重试还要再等一轮。
 *
 * 修的四类，都是实测里反复出现的：
 *   ① 尾逗号        { "a": 1, }        ← 模型写 JS 的习惯
 *   ② 缺逗号        { "a": 1 "b": 2 }  ← 就是这次 599 位置那个错
 *   ③ 注释          // 这里算高         ← 模型爱解释
 *   ④ 被截断        { "a": 1, "b":    ← 输出撞上长度上限
 *
 * **不做**的事：不猜语义、不改数字、不补内容。修完还解析不了就原样报错，
 * 让模型自己看着改——乱猜比报错更糟，因为错得很安静。
 */

/** 扫描时需要在字符串外做的三件事：去注释、补缺逗号、去尾逗号 */
function normalize(src: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  /** 上一个"有意义的"字符（用于判断是不是漏了逗号） */
  let prevSig = '';
  /** 当前 out 里最后一个逗号的下标（尾逗号要回头删掉） */
  let lastComma = -1;
  /** 上一个非空白字符是不是逗号 */
  let prevWasComma = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        esc = true;
        continue;
      }
      // 字符串里裸换行/制表符：JSON 不认，转义掉
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') continue;
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      if (ch === '"') {
        inStr = false;
        prevSig = '"';
      }
      out += ch;
      continue;
    }

    // ---- 字符串外 ----
    if (ch === '"') {
      // 漏逗号：值后面直接跟下一个键（"a": 1 "b": 2）
      if (prevSig === '"' || prevSig === '}' || prevSig === ']' || /[0-9]/.test(prevSig)) {
        out += ',';
        prevWasComma = true;
      }
      inStr = true;
      out += ch;
      prevSig = '"';
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (ch === ',') {
      lastComma = out.length;
      out += ch;
      prevWasComma = true;
      prevSig = ',';
      continue;
    }
    if (ch === '}' || ch === ']') {
      // 尾逗号：删除刚才那个
      if (prevWasComma && lastComma >= 0) {
        out = out.slice(0, lastComma) + out.slice(lastComma + 1);
        lastComma = -1;
      }
      out += ch;
      prevWasComma = false;
      prevSig = ch;
      continue;
    }
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
      out += ch;
      continue;
    }
    out += ch;
    prevWasComma = false;
    prevSig = ch;
  }

  // 截断在字符串中间：把引号收掉，后面才谈得上补括号
  if (inStr) out += '"';
  return out;
}

/** 按出现顺序补上没闭合的 } 和 ] */
function closeOpen(src: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = src;
  while (stack.length > 0) out += stack.pop() === '{' ? '}' : ']';
  return out;
}

/** 截断时最后一个成员的逗号位置（字符串外、且在最外层之后） */
function lastMemberComma(src: string): number {
  let inStr = false;
  let esc = false;
  let depth = 0;
  let hit = -1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth > 0) hit = i;
  }
  return hit;
}

/**
 * 解析 JSON；失败就先修，修完再解析。
 *
 * 返回值一定是对象——修不好就直接抛原始错误（报错文案要能反映**模型的原文**，
 * 否则模型看到的是修过的版本，反而对不上自己写的字）。
 */
export function parseJsonLoose(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (rawErr) {
    let s = normalize(input);
    for (let round = 0; round < 6; round++) {
      try {
        return JSON.parse(closeOpen(s));
      } catch {
        // 被截断：砍掉最后一个不完整的成员再试
        const cut = lastMemberComma(s);
        if (cut < 0) break;
        s = s.slice(0, cut);
      }
    }
    throw rawErr;
  }
}
