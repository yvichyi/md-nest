<div align="center">

# 📚 md-nest · Markdown 知识库 AI 助手

**给你的笔记文件夹一个可搜索、可问答的大脑**

零依赖 · 离线 · SQLite FTS5 秒级检索 · 可选 AI 问答

[![python](https://img.shields.io/badge/Python-3.8+-3776AB?logo=python&logoColor=white)](https://python.org)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

---

## 一句话

`md-nest` 把你的 Markdown 笔记目录变成**可搜索的知识库**,还能用 AI 问答(可选,调本地免费 LLM)。

## 快速开始

```bash
pip install md-nest

# 索引你的 Obsidian/笔记目录
md-nest ~/Notes rebuild

# 搜索
md-nest ~/Notes "Python 异步"

# AI 问答(需要 free_llm.py,可选)
md-nest ~/Notes ask "我关于 Python 的笔记写了什么？"
```

## 特性

- **零依赖** — 纯 Python, `sqlite3` + `re`, 即装即用
- **FTS5 全文搜索** — 秒级检索,中文英文都支持(FTS5+LIKE 回退)
- **AI 问答**（可选）— 搜索命中 → 本地 LLM 回答
- **Obsidian 友好** — 直接索引 `.md` 文件,索引目录自动隐藏
- **隐私** — 所有数据本地,不联网

## 命令

| 命令 | 说明 |
|------|------|
| `md-nest <dir> rebuild` | 重建索引 |
| `md-nest <dir> "关键词"` | 搜索(默认) |
| `md-nest <dir> ask "问题"` | AI 问答 |
| `md-nest <dir> stats` | 知识库统计 |
| `md-nest <dir> list` | 列出所有文档 |

## 工作原理

```text
md-nest scan → SQLite FTS5 索引 → search / ask
                        ↑
                  free_llm.py(可选,本地免费 LLM)
```

## License

MIT