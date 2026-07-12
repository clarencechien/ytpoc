# kvsplayer — 韓綜 YouTube 台灣正體中文字幕站(個人版)

貼一條 YouTube 連結,自動產生「台灣正體中文字幕 + 韓綜畫面字卡」的播放頁。
單一 Cloudflare Worker + R2,寫入面用 Google SSO 鎖定,任何人可看。

## 現況架構(live)

| 路徑 | 內容 | 權限 |
|---|---|---|
| `/` | 影片清單(標題/cue 數/YouTube 連結);`/?v=<id>` 播放頁 | 公開 |
| `/list`、`/cues/<id>` | 清單 / 成品字幕 JSON(R2) | 公開 |
| `/admin` | 提交頁:貼連結→ack→進度條;任務總覽(階段/進度/最後錯誤,5 秒更新;停擺任務可一鍵重排) | Access(Google SSO)+ email |
| `/admin/videos*`、`/admin/models` | pipeline API / 模型清單 | 同上 |

## 字幕產生流程(全自動)

```
貼連結 → ① 抓 YouTube 字幕軌(innertube 多 client;CF IP 常被擋,碰運氣)
          有人工英文字幕 → 雙源翻譯(品質最佳,字卡來自括號慣例)
       → ② 失敗自動切 Gemini 看片:3 分鐘一段,開放式掃描到影片結尾
          (聽寫韓語 + 讀畫面字卡 + 翻譯一次完成;不需填片長)
       → ③ 都不行:手貼 json3/vtt(admin 頁欄位)
翻譯一律鎖定 glossary(genre 40 詞 + 頻道譯名表,見 public/glossary.json)
```

- 標題自動補抓(YouTube oEmbed,不被 bot 檢查);重送會補 meta
- **Queues 自驅動**(Workers Paid):送出即排入 `kvs-jobs` 佇列,關頁面照跑完,
  失敗自動退避重試(最多 8 次);**可同時排多支影片**各自獨立跑,
  同一支 90 秒內重複送出自動去重
- 任務可斷點續跑:同連結再按一次即繼續;截斷的舊任務填「片長」可延長掃描
- 模型:`wrangler.jsonc` 的 `GEMINI_MODEL`(現為 gemini-3.5-flash);
  `/admin/models` 可查 key 可用清單

## ingest 現實(為什麼是 Gemini)

YouTube 對 Cloudflare IP 段的 bot 檢查已封死字幕軌與影音下載
(WEB/TV/Android/iOS client 實測全滅)。可行替代:
自架住宅 IP 抓取節點(要養機器)、Data API 抓字幕(需影片擁有者 OAuth)。
**Gemini 直接看 YouTube URL 是目前唯一全自動路徑**,代價:
token 消耗大(約百-數百 token/秒)、單段處理慢(30-90 秒/3 分鐘)、
時間戳與字卡辨識品質仍在驗證。

## Gemini 看片原理(路線B 技術細節,燒過 NTD 200 學費的部分)

**它真的在「看」影片,不是抓字幕。** 呼叫 `generateContent` 時把 YouTube URL 放進
`fileData.fileUri`,**由 Google 自家基礎設施去抓影片**(所以不受 YouTube 對
Cloudflare IP 的封鎖;僅限公開影片),`videoMetadata` 的 start/end offset 指定
只處理某個時間段——**只有被裁的段落會轉成 token 計費**。

**影片如何變成 token(= 錢):**

| 成分 | 取樣 | token 率 |
|---|---|---|
| 畫面 | 每秒抽 1 幀 | LOW 解析度 ≈ 66 tok/幀;MEDIUM ≈ 258 tok/幀 |
| 聲音 | 連續 | ≈ 32 tok/秒 |
| 合計 | | LOW ≈ 100 tok/秒;MEDIUM ≈ 300 tok/秒 |

一個 3 分鐘段:LOW ≈ 1.8 萬 tok、MEDIUM ≈ 5.4 萬 tok。30 分鐘全片掃一遍
(LOW)≈ 18 萬 tok,flash 級模型 **一遍不到 USD 0.1**。

**「OCR 字卡」不是獨立的 OCR 引擎**:多模態模型的視覺編碼器把每一幀變成
token,模型在同一次推理裡「讀」幀內文字(字卡)、「聽」音訊 token(對白)、
並直接輸出台灣正體中文——一次呼叫 = 聽寫 + 讀字卡 + 翻譯。

**成本與品質的關鍵事實:**

1. **每次呼叫都重新 ingest 該段**——重試一次就重新付一次該段的影片 token。
   NTD 200 帳單的元兇就是毒段 × 8 次重試 × 手動重送復活死鏈(現已改
   3 次重試 + 細掃階梯 + No frames 立即收尾)
2. `countTokens` 免費(片長探測不花錢);輸出 token 另計但佔比小
3. **1 fps 取樣**:閃現不到 1 秒的字卡可能漏抓;LOW 解析度小字可能糊
   (`GEMINI_MEDIA_RES` 可調回 MEDIUM,成本 ×3)
4. **時間戳是模型估的**(從 token 位置推算),非逐幀精確——播放驗收時
   要特別注意對嘴誤差
5. 任務總覽的「x.xM tok」= 該影片累計 ingest 的實際用量,乘上模型單價
   就是這支片的成本

## Debug

- **任務卡住**:總覽面板會顯示「最後錯誤」與停擺警告(>5 分鐘無進度),按「重排」重新入列
- **即時 log**:Dashboard → Workers → kvsplayer → **Logs**(observability 已開),
  queue consumer 的每次錯誤與重試都看得到
- 佇列狀態:Dashboard → Queues → kvs-jobs(積壓量/DLQ)

## 踩坑全紀錄與反思(2026-07-11~12)

| 問題 | 根因 | 更好的做法 |
|---|---|---|
| 字幕抖動/裁切,修了三輪 | 字幕參與版面計算;固定高度框治標 | day-1 就用影片內 overlay(業界標準),先研究 YouTube 原生字幕的實作再動手 |
| CF 部署連環卡(name 不符/production 版本釘死/影子 wrangler.jsonc) | 沒先讀平台設定解析規則(jsonc>toml、git 連動要求同名) | 首次部署先 `wrangler deploy --dry-run` 本地驗 + 查 active version;懷疑「沒部上」時先確認「跑的是哪一版」 |
| YouTube 封鎖 CF IP(四 client 全滅) | 預測到但低估徹底性,繞了四個 client 才認 | 一開始就把 Gemini 看片設計成主路線,抓軌當 bonus |
| 片長估計錯 → 字幕截斷 | 用無根據常數(300 tok/s)做關鍵決策 | 開放式掃描本該是 day-1 設計:不依賴任何片長資訊 |
| 524 超時/JSON 截斷/500/No frames 逐個爆 | 錯誤處理事後逐個補;通用重試蓋過了明確訊號 | 失敗階梯先設計好;**權威錯誤訊號(如 No frames=片尾)直接分支處理**,不進重試 |
| 「跳 3 分鐘」的錯誤決策 | 工程便利優先於產品價值 | 內容缺失=失敗;降階細掃(60s)把內容撿回來才是解 |
| Access 漏鎖 /videos | 頁面與 API 不同前綴,保護面破碎 | 寫入面統一掛 /admin 底下,單一保護面 |

**總反思**:三個系統性教訓——(1) **可觀測性先行**:last_error 面板是第 N 輪才加的,
若 day-1 就有,每個坑的 debug 都快一個量級;(2) **外部依賴的假設先驗證再蓋樓**
(token 率、innertube 可用性、平台設定規則);(3) **錯誤訊息是規格**:
Gemini 的每種錯誤都在告訴你系統邊界在哪,聽訊號比通用重試聰明。

## 部署 / 開發

- 唯一設定檔:根目錄 `wrangler.jsonc`(**勿再建 wrangler.toml**,會互搶)
- push `main` 即自動部署(Workers Builds,git 連動 worker 名 `kvsplayer`)
- Secret:Dashboard → Settings → Variables and Secrets → `GEMINI_API_KEY`
- Access:Zero Trust 只鎖 `<網域>/admin` 一條 path
- 本地:`npx wrangler dev --local`(`.dev.vars` 放 key);
  播放頁模板在 `scripts/player_template.html`,改完跑 `python3 scripts/build_player.py`

## 下一步候選(依價值排序)

1. **品質驗證迴圈**:Gemini 看片版的時間戳準度/字卡辨識率實測與 prompt 調校
2. **校對 UI**:播放頁 transcript 直接改譯文寫回 R2(人在迴路)
3. **頻道 glossary 自動累積**:新譯名回寫,跨集一致
5. **住宅 IP 抓取節點**:救回便宜的字幕軌路線(品質最佳來源)

## 歷史

v1 手工 POC(52 分鐘《羅英錫 VS 忙內PD》全片、1545 cues、zh.srt/zh.ass/ffmpeg 燒錄驗證)
與早期 v2/v3 規劃、部署踩坑紀錄:見 [docs/ARCHIVE.md](docs/ARCHIVE.md)。
v1 產物仍在 repo(`cues/`、`output/`、`player.html` 單檔版)。
