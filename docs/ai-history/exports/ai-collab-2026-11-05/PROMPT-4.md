你上一版只输出了 4 行 import，没有实现任何逻辑，却在假引用上返回 0——这是假通过。

这次按下面的步骤写，一条都不许省：
1. readFileSync 读 root/README.md。
2. 正则 /\\`([^\\`\\n]+)\\`/g 取出所有行内代码片段。
3. 过滤：以 http:// 或 https:// 开头 → 丢；不含 / 且不以 .md .mjs .yml .json 结尾 → 丢；含空格 → 丢。
4. 对剩下的每条：existsSync(path.join(root, 候选)) 为 false 就 push 到 missing。
5. 输出：missing 非空 → 逐行 console.log('缺失: ' + 路径) 后 process.exitCode = 1；否则 console.log('README 引用检查通过：' + 总数 + ' 条')。
6. 验收：我在 README 里加一条 `docs/nonexistent-guide.md` 时，脚本必须打印它并以 1 退出。
7. 只输出文件内容。
