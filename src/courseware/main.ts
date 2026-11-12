/**
 * courseware/main.ts —— 课件板块的入口
 *
 * 为什么单独一个 HTML 入口，而不是塞进 MathMate 主页？
 *   这一阶段的目标是"先把一堂课做到能用"，最怕的是改动现有生成链路。
 *   独立入口 = 独立构建产物，MathMate 主页一行代码都不用动；
 *   等课件验证完了，再把它挂到 scene-picker 里，那时只需换一个挂载容器。
 *
 * 课件注册表：新课件写好后在这里加一行就能上线，
 * 顶部导航与 ?id= 深链都自动认识它。
 */
import { mountCourseware } from './shell';
import type { CoursewareSpec } from './spec';
import { GENERAL_HORSE } from './generalHorse';
import { NUMBER_LINE } from './numberLine';
import { ANT_CYLINDER } from './antCylinder';

const REGISTRY: Record<string, CoursewareSpec> = {
  [GENERAL_HORSE.id]: GENERAL_HORSE,
  [NUMBER_LINE.id]: NUMBER_LINE,
  [ANT_CYLINDER.id]: ANT_CYLINDER,
};

const root = document.getElementById('cw-root');
if (root) {
  // 深链参数：?id=ant-cylinder&t=2.5&step=3（step 从 1 起算，和卡片编号一致）
  // 用途：老师备课时把某个课件某一步的状态直接发给学生/同事，点开就是那一幕。
  // 这也是课件板块和"生成式"最大的差别——课件的每个状态都是确定可回放的。
  const query = new URLSearchParams(location.search);
  const id = query.get('id') ?? GENERAL_HORSE.id;
  const spec = REGISTRY[id] ?? GENERAL_HORSE;

  const primary = spec.primary.name;
  if (query.has(primary)) {
    const v = Number(query.get(primary));
    if (Number.isFinite(v)) {
      spec.params[primary] = v;
      // 深链要落在"参数 + 初始步骤"这个状态上：把 track 之外的一切对齐
    }
  }

  const siblings = Object.values(REGISTRY).map((s) => ({ id: s.id, title: s.title }));
  const mounted = mountCourseware(root, spec, siblings);
  if (query.has('step')) {
    const step = Number(query.get('step'));
    if (Number.isFinite(step) && step >= 1) mounted.setStep(step - 1);
  }
}
