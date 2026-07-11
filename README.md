# kvsplayer — 韓綜 YouTube 台灣正體中文字幕站(個人版)

貼一條 YouTube 連結,自動產生「台灣正體中文字幕 + 韓綜畫面字卡」的播放頁。
單一 Cloudflare Worker + R2,寫入面用 Google SSO 鎖定,任何人可看。

## 現況架構(live)

| 路徑 | 內容 | 權限 |
|---|---|---|
| `/` | 影片清單(標題/cue 數/YouTube 連結);`/?v=<id>` 播放頁 | 公開 |
| `/list`、`/cues/<id>` | 清單 / 成品字幕 JSON(R2) | 公開 |
| `/admin` | 提交頁:貼連結→ack→進度條;任務總覽(佇列中每支影片的階段/進度,5 秒自動更新) | Access(Google SSO)+ email |
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
