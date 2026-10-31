/**
 * samples.ts —— 一份手写的场景 JSON 示例
 *
 * 侧边栏的「场景 JSON 演示」区默认加载它，点「解析并渲染」可以看到：
 * 纯文本 JSON 经过 parseScene 校验后，直接驱动出画面。
 * 将来这个文本框里躺着的，就是 LLM 的产出。
 */
export const SAMPLE_SCENE_JSON = `{
  "meta": {
    "title": "示例：正弦与余弦（纯 JSON 驱动）",
    "subtitle": "这份 JSON 由人手写，将来由 LLM 生成"
  },
  "view": { "xMin": -6.5, "xMax": 6.5, "yMin": -1.6, "yMax": 1.6 },
  "params": [],
  "objects": [
    {
      "type": "curve",
      "id": "sin",
      "expr": "sin(x)",
      "domain": ["-6.2832", "6.2832"],
      "color": "#185fa5",
      "label": "y = sin x"
    },
    {
      "type": "curve",
      "id": "cos",
      "expr": "cos(x)",
      "domain": ["-6.2832", "6.2832"],
      "color": "#1d9e75",
      "label": "y = cos x"
    },
    {
      "type": "point",
      "id": "origin",
      "at": [0, 0],
      "label": "原点"
    }
  ],
  "readouts": []
}`;
