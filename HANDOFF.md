# HANDOFF：韓文 YouTube 影片 → 台灣正體中文字幕播放頁（POC）

> 交接對象:Claude Code(web session)
> 目標影片:https://www.youtube.com/watch?v=tFaHkZO587c(video id: `tFaHkZO587c`)
> 交付物:單檔 `player.html`,iframe 嵌入 YouTube + 自製韓/中雙語字幕同步

---

## 0. 環境限制(重要,先讀)

- **本 sandbox 無法連線 YouTube**(受管 proxy allowlist + datacenter IP bot check)。不要嘗試 yt-dlp / curl youtube.com,會浪費時間。
- 所有媒體與字幕原料**已由使用者在外部下載並放入 repo 的 `media/`**,以 repo 內檔案為唯一事實來源。
- PyPI 可用(`pip install`),ffmpeg 可安裝。但 Phase A 不需要它們,只有 fallback 的 Phase B 需要。
- 最終 `player.html` 是在使用者本機瀏覽器執行,iframe 嵌 YouTube 沒有問題。sandbox 無法視覺驗收,驗收止於資料正確性與程式邏輯。

## 1. 輸入檔案清單

| 檔案 | 說明 |
|---|---|
| `media/tFaHkZO587c.ko.json3` | 韓文 auto-sub(YouTube 原聲 ASR),詞級時間戳,**主要原料** |
| `media/tFaHkZO587c.en.vtt` | 上傳者手動英文字幕,**翻譯參考**(專有名詞、語意校準用,不是翻譯來源) |
| `media/tFaHkZO587c.ko.vtt` | 韓文 auto-sub 的 vtt 版,備援(有滾動重複 cue,髒,優先用 json3) |
| `media/tFaHkZO587c.info.json` | yt-dlp metadata(title/description/chapters/uploader),glossary 與語域判斷用。**若不存在,跳過並在報告中註記** |
| `media/audio.m4a` | 音檔,僅 Phase B fallback 用。**若不存在,Phase B 不可執行** |

## 2. Pipeline(Phase A:主路線)

### Phase A0 — json3 解析與重新斷句
- 解析 json3 的 `events[].segs[]`,展開為 `(絕對時間秒, 詞)` 序列(`tStartMs + tOffsetMs`)。
- 依停頓重新斷句:gap > `0.8s` 或累積長度 > `42` 字元即切段;段尾 end = 最後詞時間 + `0.6s`,但不得超過下一段 start。
- 參數寫成常數,方便調整。輸出 `cues/cues_ko.json`:`[{id, start, end, ko}]`。
- **自我檢查**:cue 數量、片長、隨機抽 10 條印出人工可讀格式;檢查時間軸單調遞增、無重疊。

### Phase A1 — Glossary 抽取(譯名先行)
- 讀取 info.json(若有)+ en.vtt + 全部韓文 cue,抽出:人名、地名、機構、產品/專有名詞、反覆出現的關鍵詞。
- 產出 `glossary.json`:`[{ko, zh, note, source}]`,zh 為台灣慣用譯名。
- **停下來把 glossary 呈現給使用者確認後才進 A2**。譯名一經鎖定,全片不得漂移。

### Phase A2 — 品質閘門(前 5 分鐘)
- 只翻譯 start < 300s 的 cue,依「翻譯規格」(§4)執行。
- 輸出對照表(時間 | 韓文 | 中文)給使用者人工抽查。
- **通過標準**:使用者確認語感與準確度 OK。未通過就調整 prompt/斷句參數重跑,不得先跑全片。

### Phase A3 — 全片翻譯
- Sliding window:每批 ~30 cues,附前一批的**譯文**作為 context,維持譯名與語氣一致。
- 兩遍制:第一遍忠實直譯;第二遍以台灣口語潤飾 + 檢查每行 ≤ ~20 全形字(超長就在語意邊界斷行,最多兩行)。
- 輸出 `cues/cues.json`:`[{id, start, end, ko, zh}]`,並順手輸出 `output/zh.srt`(標準 SRT,給其他播放器用)。

### Phase A4 — player.html(單檔交付)
- **YouTube IFrame Player API**:`new YT.Player('player', {videoId:'tFaHkZO587c', playerVars:{...}})`。
- 同步機制:`setInterval` 每 200ms 讀 `player.getCurrentTime()`,對排序後的 cues 做 binary search 找當前 cue。
- 版面:
  - 播放器上方或下方一條字幕帶:中文為主(大字),韓文小字在上,可切換顯示模式(中/韓+中/隱藏)。
  - 右側(桌面)/下方(窄螢幕)逐句 transcript 清單,當前句 highlight 並自動捲動;點擊任一句 `player.seekTo(start, true)`。
- 字幕資料以 inline JSON 直接嵌入 HTML,零外部依賴(除了 YouTube IFrame API script)。
- 不用任何框架,vanilla JS + CSS。深色背景、字幕帶半透明。
- 註明:本機開啟需 `python -m http.server`(file:// 下 IFrame API origin 會出問題),或部署 Cloudflare Pages。

## 3. Phase B(fallback,僅當 A0 抽查發現 ko ASR 品質差)

- 條件:`media/audio.m4a` 存在,且使用者同意。
- `pip install faster-whisper`,模型 `large-v3-turbo`、`compute_type="int8"`、`language="ko"`、`vad_filter=True`。
- 產出同 A0 格式的 cues,回到 A1 續行。
- CPU-only,轉錄時間約為片長的 0.5–2 倍,先告知使用者再跑。

## 4. 翻譯規格(prompt 要求)

1. **目標語**:台灣正體中文,台灣用詞與語感(影片/品質/網路/資訊/軟體;禁止視頻/質量/網絡/信息/軟件等中國大陸用語)。
2. **翻譯來源是韓文 cue**;en.vtt 只作參考,韓英歧異時以韓文為準。
3. **語域**:先從 info.json 與內容判斷(訪談/教學/綜藝/Vlog),在 A2 報告中明示判斷結果與依據,再據此選擇書面或口語語感。
4. 譯名一律查 `glossary.json`,不在表內的新專有名詞:音譯 + 在報告中列出待使用者確認。
5. 字幕文體:短句、去冗餘(韓文語尾敬語不逐字翻)、保留語氣但不加油添醋。
6. ASR 明顯錯字:依上下文合理修正,並在 `output/asr_fixes.log` 記錄(原文 → 修正,附時間戳)——所有修正可溯源,不留黑箱。
7. 不確定的句子在 zh 尾端加 `⚠`,並集中列表回報,禁止裝懂硬翻。

## 5. Repo 結構(目標狀態)

```
poc-krsub/
├── media/            # 使用者提供,唯讀對待
├── scripts/
│   ├── parse_json3.py
│   └── (transcribe.py — 僅 Phase B)
├── cues/
│   ├── cues_ko.json
│   └── cues.json
├── glossary.json
├── output/
│   ├── zh.srt
│   └── asr_fixes.log
├── player.html       # 最終交付物
└── HANDOFF.md        # 本文件
```

## 6. 驗收標準

- [ ] cues 時間軸單調、無重疊,cue 數與片長合理
- [ ] glossary 經使用者確認
- [ ] 前 5 分鐘品質閘門通過後才有全片翻譯
- [ ] `player.html` 單檔、無框架、字幕同步 + 點句跳轉可用
- [ ] `zh.srt` 可被一般播放器載入
- [ ] 所有 ASR 修正與未確認譯名皆有紀錄,可溯源

## 7. 執行紀律

- 每個 Phase 結束先報告再往下走;A1→A2、A2→A3 之間**必須等使用者確認**。
- 不臆測影片內容;一切以 repo 內檔案為準。
- 遇到缺檔(info.json / audio.m4a)照 §1 的指示處理,不要卡住。
