/**
 * exercise-line.ts —— 阶段 0 练习 1：两点确定一条直线
 *
 * 任务：按 EXERCISES.md 的「三步走」把 objects 和 readouts 补全。
 * 参考写法：src/scenes/triangle.ts（可拖拽顶点）、src/scenes/parabola.ts（readouts）。
 *
 * 协议速查（忘了就翻 src/protocol/scene.ts）：
 *   point:    { type: 'point', at: 'ax, ay', draggable: true, dragBind: { x: 'ax', y: 'ay' } }
 *   segment:  { type: 'segment', from: 'ax, ay', to: 'bx, ay', dashed: true }
 *   readout:  { label: '长度', expr: 'dist(ax,ay,bx,by)' }
 */
import type { Scene } from '../protocol/scene';

export const lineDefaults: Record<string, number> = {
  ax: -2,
  ay: 1,
  bx: 3,
  by: -1,
};

export function buildLine(params: Record<string, number>): Scene {
  return {
    meta: {
      title: '练习：两点确定一条直线',
      subtitle: '拖动 A、B，观察线段、斜率三角形与读数变化',
    },
    view: { xMin: -5, xMax: 5, yMin: -4, yMax: 4 },
    params: [
      { name: 'ax', label: 'A 的 x', min: -6, max: 6, step: 0.01, value: lineDefaults.ax, slider: false },
      { name: 'ay', label: 'A 的 y', min: -6, max: 6, step: 0.01, value: lineDefaults.ay, slider: false },
      { name: 'bx', label: 'B 的 x', min: -6, max: 6, step: 0.01, value: lineDefaults.bx, slider: false },
      { name: 'by', label: 'B 的 y', min: -6, max: 6, step: 0.01, value: lineDefaults.by, slider: false },
    ],
    objects: [
      // ===== 示范：TODO 1 已完成，下面这 8 行就是「一个可拖拽的点」的全部内容 =====
      {
        type: 'point',        // 对象类型：点
        id: 'A',             // 全场景唯一的名字（拖拽时靠它认人）
        at: 'ax, ay',        // 画在哪个位置——"参数 cx, 参数 cy" 的字符串写法
        draggable: true,     // 允许鼠标拖动
        dragBind: { x: 'ax', y: 'ay' },  // 拖动后把坐标写回这两个参数
        label: 'A',          // 画在点旁边的文字
        color: '#185fa5',    // 蓝色——方便和 B 区分
      },
      {
        type: 'point',
        id: 'B',
        at: 'bx, by',
        draggable: true,
        dragBind: { x: 'bx', y: 'by' },
        label: 'B',
      },
            {
        type: 'segment',
        id: 'AB',
        from: 'ax, ay',    // ← 起点：A 在哪？照着点 A 的 at 抄
        to: 'bx, by',      // ← 终点：B 在哪？照着点 B 的 at 抄
      },

            {
        type: 'segment',
        id: 'dx',          // 水平虚线
        from: 'ax, ay',    // 从 A 出发
        to: 'bx, ay',         // 走到哪？→ 那个混搭点
        dashed: true,      // true = 画虚线
        color: '#888780',  // 灰色，可选
      },
      {
        type: 'segment',
        id: 'dy',          // 竖直虚线
        from: 'bx, ay',       // 从混搭点出发
        to: 'bx, by',      // 走到 B
        dashed: true,
        color: '#888780',
      },

      // TODO 5：中点 M（at: "(ax+bx)/2, (ay+by)/2"）
              {
        type: 'point',
        id: 'M',
        at: '(ax+bx)/2, (ay+by)/2',        // ← 中点的坐标表达式（x, y 两半）
        label: 'M',
        color: '#534AB7', // 紫色，可选，方便和 A/B 区分
      },

    ],
    readouts: [
      // 诊断用读数：能直接在右侧看到参数的真实数值
      { label: 'A 坐标', expr: 'pt(ax, ay)' },
      { label: 'B 坐标', expr: 'pt(bx, by)' },
      { label: 'AB 长度', expr: 'dist(ax,ay,bx,by)' },
      // TODO 6：斜率 k（(by-ay)/(bx-ax)）、倾角（deg + ang）
                    { label: '斜率 k', expr: '(by-ay)/(bx-ax)' },
      { label: '倾角', expr: 'deg(ang(ax,ay,bx,by))', unit: '°' },



    ],
  };
}
