/**
 * parabola.ts —— 场景一：二次函数 y = a(x - h)² + k
 *
 * 教学点：三个参数分别控制什么，一眼能看到。
 * 交互：拉滑杆，或直接拖画面里的「顶点」。
 *
 * 注意每个场景都是一个「纯函数」：params 进，Scene 数据出。
 * 交互（拖拽/滑杆）完全由 main.ts 和 renderer 处理，场景里不写交互代码。
 */
import type { Scene } from '../protocol/scene';

export const parabolaDefaults: Record<string, number> = {
  a: 1,
  h: 0,
  k: 0,
};

export function buildParabola(params: Record<string, number>): Scene {
  return {
    meta: {
      title: '二次函数',
      subtitle: 'y = a(x - h)² + k —— 拖顶点或拉滑杆，曲线实时重绘',
    },
    view: { xMin: -6, xMax: 6, yMin: -5, yMax: 5 },
    params: [
      {
        name: 'a',
        label: 'a（开口方向与大小）',
        min: -2,
        max: 2,
        step: 0.1,
        value: parabolaDefaults.a,
      },
      {
        name: 'h',
        label: 'h（左右平移）',
        min: -4,
        max: 4,
        step: 0.1,
        value: parabolaDefaults.h,
      },
      {
        name: 'k',
        label: 'k（上下平移）',
        min: -3,
        max: 3,
        step: 0.1,
        value: parabolaDefaults.k,
      },
    ],
    objects: [
      // 函数曲线：表达式引用参数，渲染时自动采样
      {
        type: 'curve',
        id: 'parabola',
        expr: 'a*(x-h)^2+k',
        color: '#185fa5',
        label: 'y = a(x-h)² + k',
      },
      // 对称轴（虚线）
      {
        type: 'segment',
        id: 'axis',
        from: 'h, -5',
        to: 'h, 5',
        dashed: true,
        color: '#888780',
        label: '对称轴 x = h',
      },
      // 顶点：位置由参数决定，拖它 = 同时改 h 和 k
      {
        type: 'point',
        id: 'vertex',
        at: 'h, k',
        draggable: true,
        dragBind: { x: 'h', y: 'k' },
        label: '顶点 (h, k)',
        // 焦点就在正上方 0.25 处，标签默认朝上会压住焦点，改放左侧
        labelOffset: [-1.4, -0.1],
      },
      // 焦点：y = k + 1/(4a)。a = 0 时表达式结果为 Infinity，
      // 渲染器会自动跳过该对象（容错演示），属正常现象
      {
        type: 'point',
        id: 'focus',
        at: 'h, k + 1/(4*a)',
        color: '#1d9e75',
        label: '焦点',
        // 焦点离顶点很近（a=1 时只差 0.25），标签会和「顶点」标签叠在一起，
        // 默认往右下挪开一点；labelOffset 单位是世界坐标
        labelOffset: [1.1, -0.15],
      },
    ],
    readouts: [
      { label: '顶点坐标', expr: 'pt(h, k)' },
      { label: '开口方向', expr: 'a > 0 ? "向上" : "向下"' },
      {
        label: '与 x 轴交点个数',
        expr: '-k/a > 0 ? 2 : (-k/a == 0 ? 1 : 0)',
      },
    ],
  };
}
