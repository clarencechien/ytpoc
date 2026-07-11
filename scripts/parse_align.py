#!/usr/bin/env python3
"""A0+A1: 解析 ko.json3 與 en.vtt,對齊為翻譯用 cues。

輸出:
  cues/cues_ko.json       — 依停頓重切的韓文 ASR cues(HANDOFF A0 格式,留作溯源)
  cues/cues_aligned.json  — 以 en.vtt 人工時間軸為骨幹,附上時間重疊的韓文 ASR 文字
                            [{id, start, end, kind: speech|card, en, ko}]
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VID = "tFaHkZO587c"

# A0 重切參數(HANDOFF 建議值)
GAP_S = 0.8          # 停頓超過此秒數即切段
MAX_CHARS = 42       # 段落累積長度上限
TAIL_PAD_S = 0.6     # 段尾延長


def load_ko_words():
    """json3 → [(start_s, word)],過濾 [음악] 等非語音標記。"""
    data = json.loads((ROOT / f"{VID}.ko.json3").read_text(encoding="utf-8"))
    words = []
    for ev in data.get("events", []):
        t0 = ev.get("tStartMs")
        if t0 is None:
            continue
        for seg in ev.get("segs", []) or []:
            w = (seg.get("utf8") or "").strip()
            if not w or w == "\n" or re.fullmatch(r"\[.+?\]", w):
                continue
            words.append(((t0 + seg.get("tOffsetMs", 0)) / 1000.0, w))
    words.sort(key=lambda x: x[0])
    return words


def resegment(words):
    """A0: 依停頓與長度重切 → [{id,start,end,ko}]"""
    cues, cur, cur_len = [], [], 0
    for i, (t, w) in enumerate(words):
        if cur and (t - cur[-1][0] > GAP_S or cur_len + len(w) + 1 > MAX_CHARS):
            cues.append(cur)
            cur, cur_len = [], 0
        cur.append((t, w))
        cur_len += len(w) + 1
    if cur:
        cues.append(cur)
    out = []
    for i, c in enumerate(cues):
        start, end = c[0][0], c[-1][0] + TAIL_PAD_S
        if i + 1 < len(cues):
            end = min(end, cues[i + 1][0][0])
        out.append({
            "id": i,
            "start": round(start, 3),
            "end": round(end, 3),
            "ko": " ".join(w for _, w in c),
        })
    return out


TS = r"(\d\d):(\d\d):(\d\d)\.(\d\d\d)"


def ts_to_s(m, i):
    h, mi, s, ms = (int(m.group(i + j)) for j in range(4))
    return h * 3600 + mi * 60 + s + ms / 1000.0


def load_en_cues():
    raw = (ROOT / f"{VID}.en.vtt").read_text(encoding="utf-8")
    cues = []
    for m in re.finditer(TS + r" --> " + TS + r"[^\n]*\n(.*?)(?=\n\n|\Z)", raw, re.S):
        text = re.sub(r"</?[^>]+>", "", m.group(9)).strip()
        text = text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
        if not text:
            continue
        start, end = ts_to_s(m, 1), ts_to_s(m, 5)
        clean = re.sub(r"\s*\n\s*", " ", text).strip()

        # 上傳者慣例:包在 ( ) 內 = 畫面字卡。可能整句是字卡、
        # 也可能「(字卡) 對話」同框 → 拆成同時間的兩個 cue。
        def add(kind, t):
            cues.append({
                "id": len(cues),
                "start": round(start, 3),
                "end": round(end, 3),
                "kind": kind,
                "en": t,
            })

        rest = clean
        while True:
            m2 = re.match(r"\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*", rest)
            if not m2:
                break
            add("card", m2.group(1).strip())
            rest = rest[m2.end():]
        if rest:
            add("speech", rest)
    return cues


def attach_ko(en_cues, words):
    """把韓文詞依時間塞進重疊的 en cue(僅 speech;card 是畫面文字,ASR 無對應)。

    詞的歸屬:落在 [start-0.3, end+0.3] 窗內且尚未被用掉的詞,依序分配。
    """
    wi = 0
    n = len(words)
    for cue in en_cues:
        if cue["kind"] != "speech":
            cue["ko"] = ""
            continue
        lo, hi = cue["start"] - 0.3, cue["end"] + 0.3
        while wi < n and words[wi][0] < lo:
            wi += 1
        j = wi
        picked = []
        while j < n and words[j][0] <= hi:
            picked.append(words[j][1])
            j += 1
        cue["ko"] = " ".join(picked)
        wi = j
    return en_cues


def main():
    words = load_ko_words()
    ko_cues = resegment(words)
    aligned = attach_ko(load_en_cues(), words)

    (ROOT / "cues").mkdir(exist_ok=True)
    (ROOT / "cues/cues_ko.json").write_text(
        json.dumps(ko_cues, ensure_ascii=False, indent=1), encoding="utf-8")
    (ROOT / "cues/cues_aligned.json").write_text(
        json.dumps(aligned, ensure_ascii=False, indent=1), encoding="utf-8")

    # 自我檢查
    print(f"ko words: {len(words)}, ko cues: {len(ko_cues)}")
    ncard = sum(1 for c in aligned if c["kind"] == "card")
    nsp = len(aligned) - ncard
    print(f"aligned cues: {len(aligned)} (speech {nsp}, card {ncard})")
    bad = [(a, b) for a, b in zip(aligned, aligned[1:]) if b["start"] < a["start"]]
    print(f"non-monotonic starts: {len(bad)}")
    empty_ko = [c for c in aligned if c["kind"] == "speech" and not c["ko"]]
    print(f"speech cues with no ko match: {len(empty_ko)}")
    import random
    random.seed(42)
    print("\n--- 抽樣 10 條 ---")
    for c in sorted(random.sample(aligned, 10), key=lambda x: x["start"]):
        mm, ss = divmod(int(c["start"]), 60)
        print(f"[{mm:02d}:{ss:02d}] {c['kind']:6s} EN: {c['en'][:60]}")
        if c["ko"]:
            print(f"                KO: {c['ko'][:60]}")


if __name__ == "__main__":
    main()
