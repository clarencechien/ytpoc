# 韓綜 YouTube 播放器 POC — 台灣正體中文字幕

目標:對韓國綜藝影片做出**差異化、高品質的台灣正體中文翻譯**,以單檔 HTML player 呈現,
並把韓綜特有的「畫面字卡」(자막/字卡) 做成獨立圖層同步顯示。

- 目標影片:[나영석 VS 막내PD 第1話幕後](https://www.youtube.com/watch?v=tFaHkZO587c)(channel fullmoon,52 分鐘)
- 交付物:`player.html`(YouTube iframe + 自製字幕/字卡同步)、`output/zh.srt`、`output/zh.ass`

## 檔案盤點(輸入原料)

| 檔案 | 說明 |
|---|---|
| `tFaHkZO587c.ko.json3` | 韓文 auto-sub(ASR),詞級時間戳。2547 events。品質髒,當**語意來源** |
| `tFaHkZO587c.en.vtt` | **上傳者手動英文字幕**,1384 cues。人工斷句/時間軸,其中 486 句括號句 = **畫面字卡英譯** |
| `tFaHkZO587c.ko.vtt` | 韓文 auto-sub 的 vtt 版(滾動重複 cue,僅備援) |
| `tFaHkZO587c.info.json` | yt-dlp metadata(title/description/tags),glossary 與語域判斷用 |
| ~~`audio.m4a`~~ | **不存在** → HANDOFF Phase B(whisper 重轉錄)不可執行 |

## Pipeline(與 HANDOFF 的差異)

原 HANDOFF 以韓文 ASR 重新斷句為骨幹(Phase A0)。盤點後改採**混合骨幹**策略,理由:

1. `en.vtt` 是人工字幕:斷句、時間軸、對話/字卡的區分都是人工品質,遠優於對 ASR 做 gap>0.8s 的機械切分。
2. 486 句括號字卡是韓綜的靈魂(吐槽、狀態說明),ASR 完全收不到(那是畫面文字不是聲音),只有 en.vtt 有。
3. 韓文 ASR 仍逐句對齊回每個 cue,翻譯時**以韓文為語意主源、英文為斷句與校準參考**,符合 HANDOFF §4.2 精神。

流程:

```
A0  parse:  ko.json3 → 詞級時間序列;en.vtt → cues(speech/card 分類)
A1  align:  以時間重疊把韓文詞對齊到每個 en cue → cues/cues_aligned.json
A2  glossary: metadata + 全文抽專有名詞 → glossary.json(台灣慣用譯名)
A3  translate: 批次翻譯(韓文主源/英文參考/glossary 鎖定),兩遍制(直譯→台式口語潤飾)
A4  emit:   cues/cues.json、output/zh.srt、output/zh.ass(字卡置頂樣式)、output/asr_fixes.log
A5  player: player.html(iframe API、對話字幕帶 + 字卡圖層 + 可點擊 transcript)
```

## 差異化重點

- **字卡獨立圖層**:對話字幕在下方字幕帶;字卡以韓綜風格(置頂、色塊)另行顯示,不混在一起。
- **台灣語感**:綜藝語域(哏、吐槽、敬語去冗餘),禁中國大陸用語(視頻/質量/網絡…)。
- **譯名鎖定**:glossary 先行,全片不漂移;新譯名與 ASR 修正全部留痕(`output/asr_fixes.log`、`⚠` 標記)。

## 使用方式

```bash
python -m http.server 8000
# 開 http://localhost:8000/player.html
```

(`file://` 直開會因 IFrame API origin 限制失效。)

### ffmpeg 燒錄(需自備影片檔,sandbox 內無法下載)

```bash
yt-dlp -f "bv*+ba" -o video.mp4 "https://www.youtube.com/watch?v=tFaHkZO587c"
ffmpeg -i video.mp4 -vf "subtitles=output/zh.ass" -c:a copy burned.mp4
```

`zh.ass` 已含字卡置頂/對話置底的樣式定義,燒錄後即為成品畫面。

## Repo 結構

```
├── scripts/          # A0–A4 pipeline(python,可重跑)
├── cues/             # 中間產物(對齊後 cues、翻譯後 cues)
├── glossary.json     # 譯名表(ko → zh-TW)
├── output/           # zh.srt / zh.ass / asr_fixes.log
├── player.html       # 最終交付物
└── HANDOFF.md        # 原始交接文件
```
