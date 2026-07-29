# Assistant Teacher Skills

面向助教和教师日常教学工作的 Codex skills：

- `class-summary`：协助教师为火箭 2 班生成标准化课堂小结 Word 文档。
- `homework-feedback`：协助助教或教师依据数学、物理错题记录和作业图片，批量填写 Excel 作业评价。
- `midterm-exam-feedback`：依据数学、物理、化学三科的题型得分和完整试卷，批量生成并写入期中考试反馈。

## 安装

将本仓库中的三个目录复制到 Codex skills 目录：

```text
C:\Users\<用户名>\.codex\skills\
```

其中 `class-summary` 依赖 Python 包 `python-docx`，`homework-feedback` 和 `midterm-exam-feedback` 需要 Node.js。

各 skill 的详细触发条件与工作流程见其目录内的 `SKILL.md`。
