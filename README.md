# Assistant Teacher Skills

面向教师日常工作的 Codex skills：

- `课堂小结`：为火箭 2 班生成标准化课堂小结 Word 文档。
- `作业反馈`：依据数学或物理错题记录和作业图片，批量填写 Excel 作业评价。

## 安装

将本仓库中的两个目录复制到 Codex skills 目录：

```text
C:\Users\<用户名>\.codex\skills\
```

其中 `课堂小结` 依赖 Python 包 `python-docx`，`作业反馈` 需要 Node.js。

各 skill 的详细触发条件与工作流程见其目录内的 `SKILL.md`。
