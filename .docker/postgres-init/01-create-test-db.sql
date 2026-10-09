-- 仅在数据卷**首次初始化**时由 Postgres 官方镜像执行：
-- 额外创建一个专用测试库，供集成测试使用（应用库仍是 nexus）。
-- 若数据卷早已存在，该脚本不会重跑；此时改用：corepack pnpm db:test:create
CREATE DATABASE nexus_test;
