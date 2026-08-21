#!/usr/bin/env python3
import os, subprocess
from pathlib import Path

def find_free_llm():
    for c in [Path.home() / "free_llm.py", Path.home() / "tools" / "free_llm.py"]:
        if c.exists(): return str(c)
    return None

def ask(nest, question, llm_script=None):
    hits = nest.search(question, limit=5)
    if not hits: return "知识库里没找到相关内容。"
    ctx = "\n".join(f"### {h['title']} ({h['path']})\n{h['snippet']}" for h in hits)[:2000]
    llm = llm_script or find_free_llm()
    if not llm:
        return "\n".join(f"- {h['title']}: {h['snippet']}" for h in hits)
    prompt = ("以下是我的 Markdown 知识库中的相关内容片段。"
              "请基于这些片段回答我的问题。\n\n"
              f"问题: {question}\n\n知识库片段:\n{ctx}")
    try:
        r = subprocess.run(["python3", llm, prompt], capture_output=True, text=True, timeout=120)
        return r.stdout.strip().split("---")[0].strip() or "(无输出)"
    except Exception as e:
        return f"(LLM 失败: {e})"

def main(root, nest):
    import sys
    rest = sys.argv[1:]
    question = " ".join(rest)
    if not question:
        print("用法: md-nest <目录> ask <问题>"); return
    print(f"🤔 问题: {question}\n")
    print(ask(nest, question))
