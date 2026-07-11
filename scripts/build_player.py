#!/usr/bin/env python3
"""A5: 把 cues/cues.json 注入 player 模板 → player.html(單檔交付)。"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

cues = json.loads((ROOT / "cues/cues.json").read_text())
# player 只需要這些欄位;\n 還原成真換行由 CSS pre-line 處理
slim = [{"id": c["id"], "start": c["start"], "end": c["end"],
         "kind": c["kind"], "ko": c["ko"], "zh": c["zh"].replace("\\n", "\n")}
        for c in cues]
payload = json.dumps(slim, ensure_ascii=False, separators=(",", ":"))
# </script> 防呆
payload = payload.replace("</", "<\\/")

import subprocess
build = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT,
                       capture_output=True, text=True).stdout.strip() or "dev"

tpl = (ROOT / "scripts/player_template.html").read_text()
assert "__CUES_JSON__" in tpl
html = tpl.replace("__CUES_JSON__", payload).replace("__BUILD__", build)
(ROOT / "player.html").write_text(html, encoding="utf-8")

# Cloudflare Pages preview:public/ 整包可直接部署
pub = ROOT / "public"
pub.mkdir(exist_ok=True)
# public 版:動態模式(不內嵌 cues,執行時抓 /list、/cues/<id>)
dyn = tpl.replace("__CUES_JSON__", "null").replace("__BUILD__", build)
pub_html = dyn.replace(
    '<span class="meta">頻道十五夜(channel fullmoon)・台灣正體中文字幕 POC</span>',
    '<span class="meta">頻道十五夜(channel fullmoon)・台灣正體中文字幕 POC・'
    '<a href="zh.srt" download style="color:#8b93a5">下載 SRT</a>・'
    '<a href="zh.ass" download style="color:#8b93a5">下載 ASS</a></span>')
(pub / "index.html").write_text(pub_html, encoding="utf-8")

# v1 那集的 cues 放成靜態備援(動態頁 /cues/<id> 404 時 fallback /cues-<id>.json)
(pub / "cues-tFaHkZO587c.json").write_text(payload.replace("<\\/", "</"), encoding="utf-8")

# 合併 glossary(genre 層 + 頻道層)給 worker 翻譯 prompt 用
import itertools
gg = json.loads((ROOT / "glossary_genre.json").read_text())
gc = json.loads((ROOT / "glossary.json").read_text())
merged = [{"ko": g["ko"], "zh": g["zh"]} for g in itertools.chain(gg, gc)]
(pub / "glossary.json").write_text(json.dumps(merged, ensure_ascii=False), encoding="utf-8")
for f in ["zh.srt", "zh.ass", "meta.zh.json"]:
    src = ROOT / "output" / f
    if src.exists():
        (pub / f).write_text(src.read_text(), encoding="utf-8")
print(f"player.html + public/ written, {len(slim)} cues, {len(payload)//1024} KB payload")
