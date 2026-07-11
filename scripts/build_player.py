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
(ROOT / "player.html").write_text(tpl.replace("__CUES_JSON__", payload), encoding="utf-8")
print(f"player.html written, {len(slim)} cues, {len(payload)//1024} KB payload")
