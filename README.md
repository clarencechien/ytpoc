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

### Cloudflare Pages 快速佈版(preview)

`public/` 資料夾就是完整可部署的靜態站(`index.html` = player,字幕 JSON 已內嵌,
另附 `zh.srt` / `zh.ass` 下載)。三種方式擇一:

**方式 1:Dashboard 直接拖上傳(最快)**
1. [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → Create → Pages → **Upload assets**
2. 取個專案名(如 `ytpoc-krsub`),把 repo 裡的 `public/` 資料夾整個拖進去 → Deploy
3. 完成後開 `https://<專案名>.pages.dev` 即可播放驗收

**方式 2:wrangler CLI**
```bash
npx wrangler pages deploy public --project-name=ytpoc-krsub
```

**方式 3:連 GitHub 自動佈版**
1. Dashboard → Workers & Pages → Create → Pages → **Connect to Git**,選本 repo 與分支
2. Build settings:Framework preset 選 **None**,Build command 留空,
   **Build output directory 填 `public`**
3. 之後每次 push 該分支就自動重佈

注意:player 用 YouTube IFrame API 嵌原影片(不動影片檔),部署到 Pages 的 https 網域即可正常播放。

### ffmpeg 燒錄(需自備影片檔,sandbox 內無法下載)

```bash
yt-dlp -f "bv*+ba" -o video.mp4 "https://www.youtube.com/watch?v=tFaHkZO587c"
ffmpeg -i video.mp4 -vf "subtitles=output/zh.ass" -c:a copy burned.mp4
```

`zh.ass` 已含字卡置頂/對話置底的樣式定義,燒錄後即為成品畫面。

## 驗收狀態

- [x] cues 時間軸單調、無重疊(1545 cues:對話 1059、字卡 486)
- [x] 前 5 分鐘品質閘門(批次 00)抽查通過後才展開全片
- [x] 全片翻譯完成,譯名零漂移(羅英錫/羅PD/Karina/忙內PD/石磨 Gala 一致性檢查通過)
- [x] `player.html` 單檔、無框架、JS 語法檢查與 HTTP 服務煙霧測試通過
- [x] `zh.srt` 標準格式;`zh.ass` 經 ffmpeg 實際渲染驗證(字卡置頂色塊、對話置底)
- [x] 198 處 ASR 修正 + 48 個新譯名留痕於 `output/asr_fixes.log`;18 句標 `⚠` 待人工確認
- [ ] 使用者本機瀏覽器視覺驗收(sandbox 無法連 YouTube,iframe 需本機開啟)

## Repo 結構

```
├── scripts/          # A0–A4 pipeline(python,可重跑)
├── cues/             # 中間產物(對齊後 cues、翻譯後 cues)
├── glossary.json     # 譯名表(ko → zh-TW)
├── output/           # zh.srt / zh.ass / meta.zh.json / asr_fixes.log
├── public/           # Cloudflare Pages 可直接部署的 preview(index.html + srt/ass)
├── player.html       # 最終交付物(單檔版)
└── HANDOFF.md        # 原始交接文件
```
