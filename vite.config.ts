import { defineConfig } from 'vite';

export default defineConfig({
  // -----------------------------------------------------------
  // 双入口：index.html 是生成式主应用，courseware.html 是互动课件板块。
  // 分成两个 HTML 而不是放进同一个 SPA，是为了让课件能单独打包、单独投屏，
  // 也为了在课件还没稳定时不牵连主应用。
  // -----------------------------------------------------------
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        courseware: 'courseware.html',
      },
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    // -----------------------------------------------------------
    // LLM 代理：浏览器直接调 api.deepseek.com 会被 CORS 拦下
    // （服务商不允许任意网页带着密钥访问它的接口）。
    // 让 vite 开发服务器替我们转发：页面只请求同源的 /llm-api，
    // vite 把它转发到真正的 API，浏览器以为自己在访问本机。
    // -----------------------------------------------------------
    proxy: {
      '/llm-api': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        // 转发时把 "/llm-api" 前缀去掉：/llm-api/chat/completions
        //   → https://api.deepseek.com/chat/completions
        rewrite: (path) => path.replace(/^\/llm-api/, ''),
      },
      // -----------------------------------------------------------
      // 视觉模型代理（阶段 4）：同样的 CORS 问题，同样的解法。
      // 智谱的接口路径是 /api/paas/v4/...，所以：
      //   /vl-api/api/paas/v4/chat/completions
      //     → https://open.bigmodel.cn/api/paas/v4/chat/completions
      // -----------------------------------------------------------
      '/vl-api': {
        target: 'https://open.bigmodel.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/vl-api/, ''),
      },
    },
  },
});
