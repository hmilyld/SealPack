#!/usr/bin/env python3
"""下载设计所需的拉丁字体并生成本地 @font-face。

应用的 CSP 是 `default-src 'self'`，运行期不能访问 Google Fonts，
所以必须把 woff2 打包进应用。中文由系统字体兜底（这些字体都没有 CJK 字形）。

用法：python scripts/fetch_fonts.py
产物：src/assets/fonts/*.woff2 + src/styles/fonts.css
"""

from __future__ import annotations

import pathlib
import re
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "src" / "assets" / "fonts"
CSS_OUT = ROOT / "src" / "styles" / "fonts.css"

# 只要 latin 子集，控制体积；CJK 走系统字体
FAMILIES = [
    ("Instrument+Sans", "Instrument Sans", [400, 500, 600, 700], "normal"),
    ("Chakra+Petch", "Chakra Petch", [500, 600, 700], "normal"),
    ("JetBrains+Mono", "JetBrains Mono", [400, 500], "normal"),
    ("IBM+Plex+Mono", "IBM Plex Mono", [400, 500, 600], "normal"),
]

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
)


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    CSS_OUT.parent.mkdir(parents=True, exist_ok=True)

    query = "&".join(
        f"family={q}:wght@{';'.join(str(w) for w in weights)}" for q, _, weights, _ in FAMILIES
    )
    url = f"https://fonts.googleapis.com/css2?{query}&display=swap"
    css = get(url).decode("utf-8")
    print(f"拉取 CSS：{len(css)} 字节")

    # Google 的 CSS 用 /* latin */ 之类的注释标注子集，块紧随其后
    blocks = re.findall(
        r"/\*\s*([\w-]+)\s*\*/\s*(@font-face\s*\{.*?\})", css, re.S
    )
    faces: list[str] = []

    for subset, block in blocks:
        if subset != "latin":
            continue

        family = re.search(r"font-family:\s*'([^']+)'", block).group(1)
        weight = re.search(r"font-weight:\s*(\d+)", block).group(1)
        style = re.search(r"font-style:\s*(\w+)", block).group(1)
        src = re.search(r"url\((https://[^)]+\.woff2)\)", block).group(1)
        urange = re.search(r"unicode-range:\s*([^;]+);", block).group(1).strip()

        slug = family.lower().replace(" ", "-")
        name = f"{slug}-{weight}.woff2"
        target = OUT_DIR / name
        if not target.exists():
            target.write_bytes(get(src))
            print(f"  ↓ {name}  ({target.stat().st_size // 1024} KB)")

        faces.append(
            "@font-face {\n"
            f"  font-family: '{family}';\n"
            f"  font-style: {style};\n"
            f"  font-weight: {weight};\n"
            "  font-display: swap;\n"
            f"  src: url('../assets/fonts/{name}') format('woff2');\n"
            f"  unicode-range: {urange};\n"
            "}"
        )

    header = (
        "/* 由 scripts/fetch_fonts.py 生成，请勿手改。\n"
        "   仅包含 latin 子集；中文由系统字体兜底（见 tokens.css 的字体栈）。 */\n\n"
    )
    CSS_OUT.write_text(header + "\n\n".join(faces) + "\n", encoding="utf-8")
    print(f"写出 {CSS_OUT.relative_to(ROOT)}：{len(faces)} 条 @font-face")


if __name__ == "__main__":
    main()
