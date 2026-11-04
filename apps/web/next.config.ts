import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@nexus/shared"],
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  /**
   * 关掉 gzip。
   *
   * 原因只有一个：事件流。
   *
   * Next 的压缩中间件会把 `text/event-stream` 也 gzip 掉，而 gzip 必须先攒够
   * 一块才往下发。执行事件是一条几十字节的小消息，攒不满，浏览器就什么都
   * 收不到——`EventSource` 连上了、状态 200、content-type 也对，但一条事件都
   * 不来。实测：带 `Accept-Encoding: gzip` 时 8 秒收到 0 字节；改成
   * `identity` 后 1 毫秒收到 51 KB。
   *
   * 后果不是"慢"，是"没有反馈"：点完「要求补充分析」，页面切到进行中面板，
   * 进度却永远不动，用户只能干等整轮跑完再手动刷新才知道结果——看起来就像
   * 卡死了。
   *
   * 这个站点的响应体本来就小（共享 JS 约 100 KB），省下的那点带宽不值这个
   * 代价。将来要恢复压缩，得先给事件流那条路径单独开一条不经过压缩中间件
   * 的通路，而不是全局打开。
   */
  compress: false,
  async rewrites() {
    const target =
      process.env.API_PROXY_TARGET?.replace(/\/$/, "") ??
      "http://127.0.0.1:4100";
    return [{ source: "/api/:path*", destination: `${target}/api/:path*` }];
  }
};

export default config;
