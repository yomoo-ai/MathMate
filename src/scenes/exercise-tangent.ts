/**
 * exercise-tangent.ts —— 阶段 0 练习 2：圆的切线
 *
 * 任务：按 EXERCISES.md 的「三步走」把 objects 和 readouts 补全。
 * 参考写法：src/scenes/unitCircle.ts（圆周上锁定的动点）。
 *
 * 核心思路（先想再写）：
 *   半径 OP 的方向是 (cos t, sin t)；切线与半径垂直，方向取 (-sin t, cos t)。
 *   切线段两端 = P ± L * 切线方向，L 取 2.4。
 *   注意：这一切都由公式算出，JSON 里不出现任何硬编码坐标——这就是数据驱动。
 */
import type { Scene } from '../protocol/scene';

export const tangentDefaults: Record<string, number> = {
  t: Math.PI / 4,
};

export function buildTangent(params: Record<string, number>): Scene {
  return {
    meta: {
      title: '练习：圆的切线',
      subtitle: '拖动圆上的点 P，切线始终垂直于半径',
    },
    view: { xMin: -3.5, xMax: 3.5, yMin: -2.5, yMax: 2.5 },
    params: [
      { name: 't', label: 'θ（弧度，拖 P 也可改）', min: 0, max: 6.2832, step: 0.01, value: tangentDefaults.t },
    ],
    objects: [
      // TODO 1：单位圆（center: [0, 0], radius: '1'）
              {
        type: 'circle',
        id: 'unitCircle',
        center: [0, 0],   // ← 注意：这是数组，不是字符串！
        radius: '1',
      },

      // TODO 2：动点 P——锁在圆周上（constraint: circle，dragBind: { angle: 't' }）
              {
        type: 'point',
        id: 'P',
        at: 'cos(t), sin(t)',          // 角度 t 在圆上的坐标（两个三角函数，逗号隔开）
        draggable: true,
        dragBind: { angle: 't' },   // 拖动写回哪个参数？
        constraint: { type: 'circle', center: [0, 0], radius: 1 },
        label: 'P',
        color: '#D85A30',
      },

      // TODO 3：半径线段 OP（from: [0, 0]，to: "cos(t), sin(t)"）
              {
        type: 'segment',
        id: 'OP',
        from: [0, 0],   // 按上面第一行翻译，逗号隔开 x 和 y
        to: 'cos(t), sin(t)',     // 第二行
        color: '#534AB7',
      },

      // TODO 4：切线——从 "cos(t) - 2.4*sin(t), sin(t) + 2.4*cos(t)"
      //              到 "cos(t) + 2.4*sin(t), sin(t) - 2.4*cos(t)"
              {
        type: 'segment',
        id: 'tangent',
        from: 'cos(t) - 2.4*sin(t), sin(t) + 2.4*cos(t)',
        to: 'cos(t) + 2.4*sin(t), sin(t) - 2.4*cos(t)',
        color: '#D85A30',
      },

      // TODO 5（加分）：直角标记——两条 0.25 长的小线段，组成 P 点的直角符号
              {
        type: 'segment',
        id: 'markA',
        from: 'cos(t) - 0.25*cos(t),  sin(t) - 0.25*sin(t)',
        to: 'cos(t) - 0.25*cos(t) - 0.25*sin(t),  sin(t) - 0.25*sin(t) + 0.25*cos(t)',
        color: '#3C3489',
      },
      {
        type: 'segment',
        id: 'markB',
        from: 'cos(t) - 0.25*cos(t) - 0.25*sin(t),  sin(t) - 0.25*sin(t) + 0.25*cos(t)',
        to: 'cos(t) - 0.25*sin(t),  sin(t) + 0.25*cos(t)',
        color: '#3C3489',
      },

    ],
    readouts: [
      // TODO 6：P 的坐标（pt）、切线斜率（-cos(t)/sin(t)，即 -cot θ）、t 的角度（deg）
              { label: 'P 坐标', expr: 'pt(cos(t), sin(t))' },              // 提示：pt() 函数能把两个数包成坐标显示，练习1的中点用过
      { label: '切线斜率', expr: 'cos(t)/-sin(t)' },            // 提示：切线方向是 (-sin t, cos t)，斜率 = y分量 / x分量
      { label: 'θ', expr: 'deg(t)', unit: '°' },     // 这条给你：弧度转角度

    ],
  };
}
