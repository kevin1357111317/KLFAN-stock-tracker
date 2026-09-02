#!/usr/bin/env python3
"""把 app.css + app.js 組成單一 HTML（klfan_app.html）。

輸出的檔案是給 Claude Artifact 工具用的「片段」格式：不含 doctype/html/head/body，
發布時會自動被包進外層骨架。想在本機開起來看，用 klfan_app_full.html。
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))

FONTS = ("https://fonts.googleapis.com/css2?"
         "family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700"
         "&family=IBM+Plex+Sans:wght@400;500;600"
         "&family=IBM+Plex+Mono:wght@400;500;600&display=swap")


def build():
    with open(os.path.join(HERE, "app.css"), encoding="utf-8") as f:
        css = f.read()
    with open(os.path.join(HERE, "app.js"), encoding="utf-8") as f:
        js = f.read()

    # 這段 JS 會被塞進 <script type="text/plain"> 當文字，裡面不能出現結束標籤
    assert "</script" not in js.lower(), "app.js 不能包含 </script"
    assert "</script" not in css.lower(), "app.css 不能包含 </script"

    html = (
        "<title>KLFAN 投資追蹤台帳</title>\n"
        f'<link rel="stylesheet" href="{FONTS}">\n'
        f'<style id="app-style">\n{css}\n</style>\n\n'
        '<div id="app"></div>\n\n'
        f'<script id="app-src" type="text/plain">\n{js}\n</script>\n'
        "<script>(function(){var s=document.getElementById('app-src')"
        ".textContent;(new Function(s))();})();</script>\n"
    )

    out = os.path.join(HERE, "klfan_app.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)

    # 本機預覽用（自己補上完整文件外層）
    full = os.path.join(HERE, "klfan_app_full.html")
    with open(full, "w", encoding="utf-8") as f:
        f.write('<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width, initial-scale=1">'
                "</head><body>" + html + "</body></html>")

    print(f"built {out} ({os.path.getsize(out):,} bytes)")
    print(f"built {full} (本機預覽用)")


if __name__ == "__main__":
    build()
