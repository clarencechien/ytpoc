# 歸檔:v1 POC 與歷史規劃(2026-07)

> 本文件保存 v1 手工 POC 的完整紀錄與早期規劃,部分內容已不符現況
> (如:innertube 抓軌已被 YouTube 封鎖、Pages 部署方式已改為 Worker 一體)。
> 現況請看根目錄 README.md。

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

## POC 反思(v1 學到什麼)

1. **字卡/對話的區分不是 LLM 判斷**,是 regex 規則:本頻道人工英文字幕把畫面字卡包在
   `(...)` 裡。這是撿了上傳者的便宜——換頻道慣例就失效;沒有人工字幕的影片,
   字卡資訊根本不存在(ASR 聽不到畫面文字),得靠 OCR/視覺模型。
2. **品質的最大槓桿不是模型強度,是輸入結構**:人工字幕的斷句時間軸 + 原文 ASR 對齊,
   比對髒 ASR 硬翻好一個檔次。glossary 先行 + 確定性檢查器(禁用詞/覆蓋率/譯名一致性掃描)
   用零 LLM 成本擋掉整類錯誤(本次的譯名漂移就是機器掃出來的)。
3. **取得原料是最脆弱的一環**:datacenter IP 抓 YouTube 會被 bot check 擋,
   正式版 ingest 必須設計(cookie/代理/使用者授權),不是純技術問題。
4. **播放器 UI 教訓**:字幕/字卡一律做成影片容器內的 absolute 疊層,不參與版面計算,
   抖動與裁切兩類 bug 從架構上消失。

## 下一版企劃(v2:貼連結全自動,Cloudflare 架構)

目標:一個頁面,貼 YouTube 連結 → 自動產生雙語播放頁。

```
[Pages 前端] 貼連結/進度頁/播放頁(本 POC 的 player 元件化)
     │
[Worker API] 建任務 → [Queues] pipeline 逐階段執行,狀態寫 [D1]
     │
 ingest:抓字幕軌+metadata(自架抓取節點帶 cookie/代理;失敗回報而非硬撐)
 route :有人工字幕 → 走 v1 雙源路線(品質高、成本低)
         只有 ASR   → Workers AI Whisper 重轉錄(品質降級,標示給使用者)
         字卡       → 括號慣例優先;無人工字幕時 VLM 抽樣影格 OCR(可選、費用高)
 glossary:D1 依「頻道」累積譯名庫,跨集共用,新譯名進待確認佇列
 translate:分層模型——便宜模型全片初翻 → 確定性檢查器掃描 →
           強模型只重翻被標記句(⚠/笑點/檢查未過),控制成本又保品質
 emit  :cues JSON 存 R2/D1,播放頁動態載入;srt/ass 供下載
     │
[校對 UI] 播放頁 transcript 面板可直接改譯文,改動寫回 D1(人在迴路)
```

里程碑:
- **M1 最小自動化**:貼連結 → ingest + 雙源翻譯 + 播放頁(僅支援有人工字幕的影片)
- **M2 降級路線**:Whisper ASR fallback、頻道 glossary 庫、校對 UI
- **M3 字卡泛化**:VLM 影格 OCR 字卡層、多語言目標、成本儀表板

成本假設(52 分鐘/集):字幕翻譯 LLM 成本個位數美元;VLM OCR 另計(約每集再一個量級),
所以 M3 才做且做成可選。

## v2-personal:個人版下一步(Gemini API + R2-only,已評估可行)

在通用 v2 之前先做個人版:自己一個帳號能貼連結產字幕,其他人唯讀。

### 架構(全 Cloudflare 免費層 + Workers Paid $5/月可選)

```
[Pages] 公開播放頁(唯讀,任何人可看)
        /admin 提交頁(貼 YouTube link、看 pipeline 進度、手動上傳 vtt 備援)
   │
[Cloudflare Access] 只有 /admin 與寫入 API 要過 Google SSO,
        policy 限定 allowlist email(你的 Gmail);Worker 驗 Cf-Access-Jwt-Assertion
   │
[Worker API] 無 D1,狀態與資料全存 R2:
        videos/<id>/meta.json      — 影片資訊
        videos/<id>/status.json    — pipeline 階段狀態(admin 頁輪詢)
        videos/<id>/cues.json      — 成品字幕(播放頁動態載入)
        index.json                 — 影片清單(播放頁首頁)
   │
[Gemini API](AI Studio key,存 wrangler secret,絕不進前端)
        路線A(優先):影片有字幕軌 → 抓下來走 v1 雙源翻譯(便宜、快)
        路線B(備援):Gemini 原生支援直接餵 YouTube URL 看片 →
                      切 5-10 分鐘段(videoMetadata offset)逐段
                      轉錄+讀畫面字卡+翻譯,一次解決 ingest 與 OCR 兩大難題
```

### 為什麼 R2-only 成立

單一寫入者(只有你)→ 不需要 D1 的並發控制與關聯查詢;每支影片一個 JSON
資料夾、一個全站 index.json 就是完整資料模型。要升級社群版時 blob → D1 好遷。

### 已知取捨

- 免費層 Worker 沒有 Queues/長任務:pipeline 由 admin 頁輪詢驅動逐段執行
  (每段一個 request,LLM 等待是網路時間不吃 CPU 限額);升 $5 Workers Paid
  可換 Queues + Cron,免顧頁面
- Gemini 看片的 token 消耗:約 300 tokens/秒,52 分鐘全片 ≈ 1M tokens,
  Flash 模型個位數美元/集;所以字幕軌路線永遠優先,看片是備援
- 時間戳精度:路線B 的段內時間戳需抽驗,必要時用段落 offset 校正
- AI Studio 免費 key 有每日配額,正式跑建議掛計費(仍然便宜)

### 進度:worker/ 骨架已完成並通過本地 e2e

`worker/` 內含完整寫入面(建立→翻譯批次→合併驗證→index),v1 解析/對齊已移植成 JS
(本地實測同一原料解析出 1545 cues,與 Python pipeline 一致);內建 admin 頁
(貼連結+貼字幕原料+一鍵全自動);Access email 雙重驗證已測(非本人 403)。

**Cloudflare 重建指南(從零開始,約 5 分鐘)**

設定檔是 repo 根目錄的 **`wrangler.jsonc`**(唯一設定檔;之前卡關就是因為
Cloudflare 匯入時自動 commit 了一個 assets-only 的 wrangler.jsonc,優先序又比
wrangler.toml 高,把完整設定整個遮蔽)。現在 jsonc 就是完整設定,匯入即用。

1. **刪舊 worker**(若存在):Workers & Pages → kvsplayer → Settings → Delete
2. **建 R2 bucket**:R2 → Create bucket → 名稱 `kvs-krsub`(一字不差)
3. **匯入 repo**:Workers & Pages → Create → Worker → **Import a repository** →
   選 `clarencechien/ytpoc`、branch `main`。**什麼都不用改**:名稱會自動預填
   `kvsplayer`(讀自 wrangler.jsonc),不用設 Path、不用改指令 → Deploy
4. **設 Secret**:worker → Settings → Variables and Secrets → 加 **Secret**
   `GEMINI_API_KEY`(先填 `dummy`,拿到 [AI Studio](https://aistudio.google.com/apikey)
   真 key 後同處替換)
5. **掛 Access(只鎖寫入面)**:Zero Trust → Access → Applications →
   Add(Self-hosted)→ 兩條 domain+path:`<worker網域>/admin` 與 `<worker網域>/videos`,
   policy Allow → Emails = 你的 Gmail(Google 登入)

單一 worker 服務三種路徑(全部已本地實測):

| 路徑 | 內容 | 權限 |
|---|---|---|
| `/` | 播放頁(`public/` 靜態資產) | 公開 |
| `/list`、`/cues/<id>` | 影片清單 / 成品字幕 JSON(R2) | 公開 |
| `/admin`、`/videos*` | 提交與 pipeline API | Access(Google SSO)+ email allowlist |

**部署成功的判準**:`/list` 回 `[]`(JSON)。`/` 只是靜態頁,不能證明 worker 活著。

之後每次 push `main`,自動重建部署。注意事項:
- **不要再新增 `wrangler.toml`**——jsonc 優先序更高,兩個並存必出影子設定事故
- `name` 改名時,Dashboard 的 worker 名稱要跟著一致,否則會佈成另一個 worker
- 換模型改 `wrangler.jsonc` 的 `GEMINI_MODEL`(需為有效 model id)

本地開發:repo 根目錄 `npx wrangler dev --local`(`.dev.vars` 放本地 key,已 gitignore)。

### 剩餘工作

1. 播放頁改吃 `/cues/<id>` + 影片清單頁(目前 `/` 仍是 v1 內嵌那集)
2. ~~自動抓字幕軌~~ 已做:貼連結即自動抓(innertube;ko 人工優先退 ASR、
   en 僅取人工);YouTube 若擋 Cloudflare IP 會回 422 並指引手貼 fallback
3. 路線B(Gemini 看片)10 分鐘段 POC,驗時間戳與字卡辨識品質

## 社群化評估(v3 方向:限縮「YouTube 韓綜」)

### 為什麼限縮到 YouTube 韓綜

1. **版權結構最乾淨**:韓綜正片片段/幕後在 YouTube 上多由**版權方官方頻道**自己上傳
   (tvN、頻道十五夜、各台官方帳號)。我們 iframe 嵌原影片、不搬運不重傳,
   播放量與廣告收益完整歸權利人——這是與版權方利益「同向」的設計,合作談判有立足點。
2. **字卡文化是韓綜獨有的差異化**,通用字幕工具做不好這塊;限縮讓 glossary 與
   翻譯 prompt 可以深耕單一類型。
3. YouTube 2020 年關閉社群字幕功能後,這個需求缺口一直存在。

### 版權/法律(誠實評估,非法律意見)

| 行為 | 風險 | 說明 |
|---|---|---|
| iframe 嵌入官方影片 | 低 | 不重製、不繞廣告,YouTube ToS 允許嵌入 |
| 翻譯字幕(對白/字卡) | **中高** | 翻譯是衍生著作,未經授權即涉改作權;粉絲字幕長期靠權利人容忍存活 |
| 儲存韓文原文 cue | 中 | 原文逐字稿本身是重製;僅存「譯文+時間軸」可降險但不消除 |
| 下載影音/OCR 影格 | 高 | v2 M3 的 VLM 字卡路線需下載影格,重製行為明確,商用前必須授權 |

減險設計(產品層):非商業起步、明確標示非官方、**通知即下架**流程、
逐頻道 opt-out 名單、不做會員收費牆。終局路徑:拿著 POC 品質去談
**版權方授權合作**(定位「官方多語字幕的外包工具/通路」)——Viki 證明
「授權內容 + 社群翻譯」是成立的商業模式,差別是我們不碰影片檔。

### 社群修正字幕的可能性

可行,且 POC 的 transcript 面板就是現成編輯介面。模式(參考 Viki/維基):

- **提交層**:播放頁逐句「建議修改」,附理由;登入即可提交
- **審核層**:信譽制——新手提交進佇列,資深貢獻者/頻道版主合併;譯名變更需通過
  glossary 投票(鎖定表不能被單句修改繞過,v1 的一致性教訓)
- **授權層**:貢獻者條款要求修正以 CC-BY 授權回饋,避免社群內容再生版權糾紛
- **防護層**:版本歷史可回滾、確定性檢查器(禁用詞/行長/時間軸)在提交時即時把關
- **激勵層**:貢獻榜、頻道別「字幕組」認領制(fansub 文化的合法化出口)

### 韓綜詞庫(已建立)

`glossary_genre.json`:40 條頻道無關的韓綜通用詞(稱謂/製作/節目/梗/字卡慣用語),
與頻道級 `glossary.json` 分層——翻譯時 genre 層先載入、頻道層覆蓋、單集新詞回寫頻道層。
社群化後此檔開放 PR 共編,是社群貢獻門檻最低、爭議最小的切入點。

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
