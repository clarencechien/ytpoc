#!/usr/bin/env python3
"""A4: 合併翻譯批次 → cues/cues.json、output/zh.srt、output/zh.ass、output/asr_fixes.log

驗證:全部 id 覆蓋、zh 非空、無中國大陸用語/簡體常見字。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

BANNED = ["视", "视频", "質量", "網絡", "信息化", "軟件", "屏幕", "立馬", "小夥伴"]
# 簡體常見字抽查(粗略)
SIMP = "简体见问题说对话时东车银钱头买卖门间闻"


def merge():
    aligned = {c["id"]: c for c in json.loads((ROOT / "cues/cues_aligned.json").read_text())}
    zh = {}
    fixes, flagged = [], []
    for f in sorted((ROOT / "cues/zh").glob("batch_*.json")):
        for row in json.loads(f.read_text()):
            i = row["id"]
            if i in zh:
                print(f"WARN duplicate id {i} in {f.name}")
            zh[i] = row
            for fx in row.get("fixes") or []:
                fixes.append(fx)
            if "uncertain" in (row.get("flags") or []):
                flagged.append(i)
            for fl in row.get("flags") or []:
                if fl.startswith("new-term:"):
                    fixes.append(f"[新譯名] cue {i}: {fl[9:]}")

    missing = sorted(set(aligned) - set(zh))
    if missing:
        print(f"FAIL: {len(missing)} cues missing translation: {missing[:20]} ...")
        sys.exit(1)

    out = []
    problems = []
    for i in sorted(aligned):
        c = aligned[i]
        z = (zh[i].get("zh") or "").strip()
        if not z:
            problems.append(f"empty zh at {i}")
        for b in BANNED:
            if b in z:
                problems.append(f"banned '{b}' at {i}: {z}")
        for ch in z:
            if ch in SIMP:
                problems.append(f"simplified '{ch}' at {i}: {z}")
        out.append({
            "id": i, "start": c["start"], "end": c["end"],
            "kind": c["kind"], "ko": c.get("ko", ""), "en": c["en"], "zh": z,
        })
    if problems:
        print("QUALITY PROBLEMS:")
        for p in problems[:40]:
            print(" ", p)
        sys.exit(1)

    (ROOT / "cues/cues.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    (ROOT / "output").mkdir(exist_ok=True)
    (ROOT / "output/asr_fixes.log").write_text(
        "\n".join(fixes) + "\n", encoding="utf-8")
    print(f"cues: {len(out)}, fixes: {len(fixes)}, uncertain: {len(flagged)}")
    return out


def fmt_srt(t):
    ms = round(t * 1000)
    h, r = divmod(ms, 3600000)
    m, r = divmod(r, 60000)
    s, ms = divmod(r, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def emit_srt(cues):
    """zh.srt:對話 + 字卡(字卡加【】區隔,SRT 無樣式能力)。"""
    lines = []
    for n, c in enumerate(cues, 1):
        z = c["zh"].replace("\\n", "\n")
        if c["kind"] == "card":
            z = "【" + z.replace("\n", " ") + "】"
        lines += [str(n), f"{fmt_srt(c['start'])} --> {fmt_srt(c['end'])}", z, ""]
    (ROOT / "output/zh.srt").write_text("\n".join(lines), encoding="utf-8")
    print("wrote output/zh.srt")


def fmt_ass(t):
    cs = round(t * 100)
    h, r = divmod(cs, 360000)
    m, r = divmod(r, 6000)
    s, cs = divmod(r, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


ASS_HEADER = """[Script Info]
Title: 나영석 VS 막내PD ep1 behind — 台灣正體中文
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Dialog,Noto Sans TC,64,&H00FFFFFF,&H000000FF,&H00101010,&H96000000,0,0,0,0,100,100,0,0,1,3,1,2,80,80,60,1
Style: Card,Noto Sans TC,52,&H001A1A1A,&H000000FF,&H00FFFFFF,&HC8FFFFFF,1,0,0,0,100,100,0,0,3,4,0,8,80,80,50,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Text
"""


def emit_ass(cues):
    """zh.ass:對話置底白字,字卡置頂白底色塊(韓綜風)。"""
    ev = []
    for c in cues:
        z = c["zh"].replace("\\n", "\n").replace("\n", "\\N")
        style = "Card" if c["kind"] == "card" else "Dialog"
        ev.append(f"Dialogue: 0,{fmt_ass(c['start'])},{fmt_ass(c['end'])},{style},,0,0,0,{z}")
    (ROOT / "output/zh.ass").write_text(ASS_HEADER + "\n".join(ev) + "\n", encoding="utf-8")
    print("wrote output/zh.ass")


if __name__ == "__main__":
    cues = merge()
    emit_srt(cues)
    emit_ass(cues)
