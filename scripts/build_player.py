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

tpl = (ROOT / "scripts/player_template.html").read_text()
assert "__CUES_JSON__" in tpl
html = tpl.replace("__CUES_JSON__", payload)
(ROOT / "player.html").write_text(html, encoding="utf-8")

# Cloudflare Pages preview:public/ 整包可直接部署
pub = ROOT / "public"
pub.mkdir(exist_ok=True)
# public 版在 meta 列加 srt/ass 下載連結(與 index.html 同層)
pub_html = html.replace(
    '<span class="meta">頻道十五夜(channel fullmoon)・台灣正體中文字幕 POC</span>',
    '<span class="meta">頻道十五夜(channel fullmoon)・台灣正體中文字幕 POC・'
    '<a href="zh.srt" download style="color:#8b93a5">下載 SRT</a>・'
    '<a href="zh.ass" download style="color:#8b93a5">下載 ASS</a></span>')
(pub / "index.html").write_text(pub_html, encoding="utf-8")
for f in ["zh.srt", "zh.ass", "meta.zh.json"]:
    src = ROOT / "output" / f
    if src.exists():
        (pub / f).write_text(src.read_text(), encoding="utf-8")
print(f"player.html + public/ written, {len(slim)} cues, {len(payload)//1024} KB payload")
