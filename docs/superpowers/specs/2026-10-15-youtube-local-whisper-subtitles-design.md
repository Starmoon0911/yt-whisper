# YouTube 地端 Whisper 字幕設計

## 目標

建立一套個人使用的 Chrome MV3 擴充套件與 macOS 本機服務，為沒有字幕的一般公開 YouTube VOD 產生原語言字幕。使用者啟動後，影片先暫停；本機完整取得並辨識音訊；完成後從影片開頭播放，字幕依播放器時間軸同步顯示。

## 第一版範圍

- 支援 `youtube.com/watch` 與可正規化的公開 `youtu.be` VOD URL。
- 使用 `yt-dlp` 取得最佳音訊、`ffmpeg` 轉為 16 kHz mono，再以 Apple Silicon 的 `mlx-whisper` 辨識。
- 預設模型為 `mlx-community/whisper-large-v3-turbo`，自動偵測並保留原始語言。
- 字幕直接疊在 YouTube 播放器內，支援一般、劇院與全螢幕模式。
- 字幕 JSON 保存在本機；成功、失敗或取消後均刪除音訊暫存檔。
- 不支援直播、登入或會員限定影片、私人影片、翻譯、雙語字幕、字幕檔匯出與即時分頁錄音。

## 架構與資料流

1. 使用者從擴充套件 popup 點擊「產生字幕」。內容腳本確認目前是 YouTube watch 頁，記錄影片狀態並暫停 `<video>`。
2. MV3 service worker 向只綁定 `127.0.0.1` 的 Python REST 服務送出 URL、video ID 與頁面顯示的影片長度。
3. 服務先以 video ID、schema、模型與時長檢查 cache。命中時立即回傳；否則建立單一佇列工作。
4. 工作依序執行音訊下載、格式轉換、Whisper 辨識與 cue 重組。外部操作使用可終止的子行程，取消時必須一併終止。
5. Whisper word timestamps 依標點、最多 6 秒及兩行顯示寬度重組為 cues，完成後以原子寫入保存字幕文件。
6. 擴充套件取得結果後將影片跳至 0 秒並自動播放。字幕 renderer 以 `<video>.currentTime` 查找 cue；seek、暫停、倍速均不依賴牆鐘時間。

## 元件責任

### Chrome 擴充套件

- Popup：服務健康、配對、目前影片、工作狀態、產生／載入、字幕開關與重新產生。
- Service worker：持有 localhost API 權限、token 與工作輪詢，不把特權請求交給頁面內容腳本。
- Content script：尋找播放器、暫停與恢復播放、顯示處理卡片及字幕 overlay，並處理 YouTube SPA 導覽。
- Subtitle renderer：以二分搜尋定位 cues；播放期間用 animation frame 更新，seek 與換片時立即重算或清理。

### 本機服務

- API：版本化 REST 介面、嚴格 Origin/CORS、bearer token、資料驗證及一致的錯誤格式。
- Pairing：首次啟動顯示六位配對碼，換取高熵 token；磁碟只保存 token hash，CLI 可重設配對。
- Job manager：一次只執行一份模型工作，相同影片與模型共用既有工作，維護狀態與取消。
- Media pipeline：以 yt-dlp 下載音訊，以 ffmpeg 轉為 Whisper 輸入格式；失敗訊息轉成可操作的 API error。
- Transcriber：在子行程中執行 mlx-whisper，自動偵測語言並輸出 word timestamps。
- Cache：字幕以原子 JSON 寫入 macOS Application Support；schema、模型或時長不符即失效。

## API 契約

- `GET /v1/health`、`POST /v1/health`
  - 回傳服務狀態、是否需要配對、ffmpeg 是否可用、模型名稱。
- `POST /v1/pair`
  - 輸入 `{ "code": "123456" }`，成功回傳 bearer token。
- `POST /v1/jobs`
  - 輸入 `{ "url", "videoId", "durationMs", "force"? }`。
  - 回傳 `{ "jobId", "cacheHit" }`。
- `GET /v1/jobs/{id}`、`POST /v1/jobs/{id}`
  - 回傳狀態、階段、可取得的進度、錯誤或完成字幕。
- `DELETE /v1/jobs/{id}`
  - 將工作標記為取消，終止目前子行程並清理暫存檔。

GET 查詢保留相容性；擴充套件使用無 body 的 POST 查詢別名，確保瀏覽器會產生 Origin，即使 host permission 使請求免除 CORS。兩種查詢方法共用相同讀取邏輯，均須通過嚴格的 extension Origin 驗證，工作查詢另需 bearer token；不接受缺少 Origin 的請求。

工作狀態為 `queued | downloading | converting | transcribing | completed | failed | canceled`。錯誤格式為 `{ "code", "message", "retryable" }`。

字幕文件格式：

```json
{
  "schemaVersion": 1,
  "videoId": "dQw4w9WgXcQ",
  "language": "en",
  "durationMs": 10000,
  "model": "mlx-community/whisper-large-v3-turbo",
  "generatedAt": "2026-10-15T12:00:00Z",
  "cues": [
    { "startMs": 0, "endMs": 900, "text": "Hello" }
  ]
}
```

## 安全、失敗與清理

- 本機服務只監聽 loopback；Chrome 權限只涵蓋 YouTube 與固定 localhost 埠。
- 僅接受 HTTPS YouTube watch URL，且 URL 中的 video ID 必須與頁面回報相符。
- 服務嚴格允許固定 extension Origin，並要求一次性配對所得的 bearer token。
- API 不讀取 Chrome cookies；第一版不支援需登入內容。
- 服務離線、未配對、yt-dlp 解析失敗、ffmpeg 缺失、模型下載及辨識失敗均顯示明確狀態；失敗時不更動原播放位置。
- 不完整結果不得成為有效 cache。音訊與工作目錄在任何終止路徑都必須清除。

## 驗收標準

- 短英文與中文公開影片均能完成原語言字幕。
- 完成後從 0 秒播放，字幕在一般、劇院及全螢幕模式同步。
- seek、暫停及倍速播放後字幕仍以播放器時間正確定位。
- 重整同影片能從 cache 載入；模型、schema 或影片長度不符時重新產生。
- 換片會清除舊字幕且不自動下載新影片。
- 取消會終止工作、清理暫存且不留下成功 cache。
- 服務離線、錯誤 URL 與外部工具失敗都有可理解且可重試的介面。

