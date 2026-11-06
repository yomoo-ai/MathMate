/**
 * visualMode.ts —— 「该画图，还是该排板书」
 *
 * ===== 为什么需要这一层 =====
 * 之前所有题都被强制配一张图。几何题没问题，但解方程、不等式、数列、
 * 参数范围这类题没有可指认的图形对象，配上的图只能是装饰。
 * 装饰必然与讲解错位——真实事故：x²/(m+9)+y²/(25−m)=1 被画成一张
 * 与 m 无关的椭圆，讲解却在说 m 的取值范围，图和话从第一句起就不是一回事。
 *
 * 所以这里把"出不出图"变成场景的一个显式字段（visual），并且保留推断与
 * 兜底：模型忘了写、或者嘴上说 figure 却一个对象都没画，都能自动降级。
 *
 * 判定权不交给"模型自我感觉"，而是交给数据：
 *   - 显式 board → 板书
 *   - 显式 figure 且真的有对象 → 出图
 *   - 没写 visual：有步骤但零对象 → 板书（否则渲染器只会画一张空坐标轴）
 */
import type { Scene } from '../protocol/scene';

/** 这份场景该走推导板书吗 */
export function isBoardScene(scene: Scene): boolean {
  if (scene.visual === 'board') return true;
  if (scene.visual === 'figure') return false;
  // 没有 visual 字段的老数据：有步骤却没有一个对象，说明图没画出来
  return (scene.steps?.length ?? 0) > 0 && scene.objects.length === 0;
}

/** 步骤真正点名过的对象 id（highlight / reveal），用于判断"图有没有被用起来" */
export function referencedIds(scene: Scene): Set<string> {
  const out = new Set<string>();
  for (const st of scene.steps ?? []) {
    for (const id of st.highlight ?? []) out.add(id);
    for (const id of st.reveal ?? []) out.add(id);
  }
  return out;
}

/**
 * 生成后的兜底闸门（不花模型调用，纯数据判断）。
 *
 * 只在一种情况下降级：声明了 figure，却一个对象都没画出来。
 * 这时硬渲染会得到一张空坐标轴 + 一套讲得很热闹的步骤，比板书更糟。
 */
export function guardVisual(scene: Scene): { scene: Scene; notice: string | null } {
  if (scene.visual !== 'figure' || scene.objects.length > 0) {
    return { scene, notice: null };
  }
  return {
    scene: { ...scene, visual: 'board', objects: [] },
    notice: '模型没有画出任何图形，已切换为推导模式',
  };
}
