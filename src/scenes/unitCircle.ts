/**
 * unitCircle.ts —— 场景二：单位圆与正弦函数
 *
 * 教学点：圆上动点 P(cosθ, sinθ) 与正弦曲线 y = sin x 的「对应关系」。
 * 技巧：把 θ（弧度）直接当作正弦曲线的横坐标 x，两个对象就能落在
 * 同一个坐标系里——这是三角函数教学最经典的一张图。
 *
 * 交互：拖圆上的点 P（锁在圆周上，只能改角度 θ），或拉 θ 滑杆。
 */
import type { Scene } from '../protocol/scene';

export const unitCircleDefaults: Record<string, number> = {
  t: Math.PI / 4,
};

export function buildUnitCircle(params: Record<string, number>): Scene {
  return {
    meta: {
      title: '单位圆与正弦函数',
      subtitle: '圆上动点 P 与曲线 y = sin x 的对应关系（θ 弧度 = 曲线横坐标）',
    },
    // 左边放单位圆，右边展开正弦曲线
    view: { xMin: -1.8, xMax: 7.6, yMin: -2, yMax: 2 },
    params: [
      {
        name: 't',
        label: 'θ（弧度，可拖拽圆上的点）',
        min: 0,
        max: 6.2832,
        step: 0.01,
        value: unitCircleDefaults.t,
      },
    ],
    objects: [
      {
        type: 'circle',
        id: 'unit',
        center: [0, 0],
        radius: '1',
        color: '#b4b2a9',
        label: '单位圆',
      },
      // 半径 OP
      {
        type: 'segment',
        id: 'op',
        from: [0, 0],
        to: 'cos(t), sin(t)',
        color: '#5f5e5a',
      },
      // 动点 P：锁在单位圆上，拖拽时写回角度参数 t
      {
        type: 'point',
        id: 'p',
        at: 'cos(t), sin(t)',
        draggable: true,
        dragBind: { angle: 't' },
        constraint: { type: 'circle', center: [0, 0], radius: 1 },
        label: 'P',
      },
      // P 到 x 轴的垂线 = sin θ
      {
        type: 'segment',
        id: 'sine',
        from: 'cos(t), sin(t)',
        to: 'cos(t), 0',
        color: '#d85a30',
        label: 'sin θ',
      },
      // 角 θ 的圆弧
      {
        type: 'arc',
        id: 'angleArc',
        center: [0, 0],
        radius: '0.35',
        from: '0',
        to: 't',
        color: '#d85a30',
      },
      // 正弦曲线：横坐标就是 θ
      {
        type: 'curve',
        id: 'sinCurve',
        expr: 'sin(x)',
        domain: ['0', '6.2832'],
        color: '#1d9e75',
        label: 'y = sin x',
      },
      // 曲线上的对应点 (θ, sinθ)
      {
        type: 'point',
        id: 'q',
        at: 't, sin(t)',
        color: '#1d9e75',
        label: '对应点 (θ, sinθ)',
      },
      // 对应关系虚线：P 与 Q 同高
      {
        type: 'segment',
        id: 'link',
        from: 'cos(t), sin(t)',
        to: 't, sin(t)',
        dashed: true,
        color: '#b4b2a9',
      },
      {
        type: 'segment',
        id: 'xproj',
        from: 't, sin(t)',
        to: 't, 0',
        dashed: true,
        color: '#b4b2a9',
      },
    ],
    readouts: [
      { label: 'θ', expr: 'deg(t)', unit: '°' },
      { label: 'cos θ', expr: 'cos(t)' },
      { label: 'sin θ', expr: 'sin(t)' },
    ],
  };
}
