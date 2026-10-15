# ytWhisper

在 Apple Silicon Mac 上，用本機 Whisper 為公開 YouTube 影片產生原語言字幕。Chrome 擴充套件負責暫停影片、顯示處理階段與字幕；Python 服務下載音訊、轉檔、辨識並保存字幕快取。不需要 OpenAI API key。

## 環境需求

- Apple Silicon Mac（MLX／Metal）；目前以 macOS 為目標，未提供 Intel Mac、Windows 或 Linux 後端。
- Python 3.10–3.13、[uv](https://docs.astral.sh/uv/)、Node.js，以及 `package.json` 指定的 pnpm 12.11.2。
- Chrome 120 以上，且允許載入未封裝的擴充套件。
- `ffmpeg` 在啟動服務的終端機 `PATH` 中。使用 Homebrew 時可執行 `brew install ffmpeg`，再以 `ffmpeg -version` 確認。
- 首次安裝需要套件網路連線；首次辨識會從 Hugging Face 下載 `mlx-community/whisper-large-v3-turbo`。模型權重約 1.61 GB，另需套件、模型執行記憶體與影片音訊的暫存空間。下載影片仍需要網路。

## 安裝與建置

在 repository 根目錄執行：

```sh
uv sync --extra dev
pnpm install
pnpm build
```

`uv` 會建立 `.venv`；後續 Python 指令都透過 `uv run` 執行。`pnpm build` 將可載入的擴充套件輸出至 `apps/extension/dist`。workspace 只允許 esbuild 的 dependency build script。

## 載入擴充套件、啟動服務與配對

1. 在 Chrome 開啟 `chrome://extensions`，啟用「開發人員模式」。
2. 點選「載入未封裝項目」，選擇本 repository 的 **`apps/extension/dist`** 目錄。請勿選擇 `src` 或 repository 根目錄。
3. 複製 ytWhisper 卡片上的擴充套件 ID。它必須是 32 個小寫 `a`–`p` 字元。保持此載入路徑，並使用這次載入得到的 ID。
4. 在 repository 根目錄執行下列指令，將 `YOUR_EXTENSION_ID` 換成剛才複製的 ID：

   ```sh
   uv run ytwhisper serve --extension-id YOUR_EXTENSION_ID
   ```

5. 保持終端機開啟。首次啟動會印出 `Pairing code: 123456` 形式的六位數配對碼，服務固定監聽 `http://127.0.0.1:8765`。
6. 從 Chrome 工具列開啟 ytWhisper popup，輸入該六位數代碼並按「配對」。看到「本機服務已連線 · 已配對」後即可使用。
7. 載入或重新載入擴充套件後，重新整理已開啟的 YouTube 影片頁面，讓 content script 生效。

配對碼只供當次服務首次配對使用；配對成功後，token 存於擴充套件的本機 storage，服務只保存 token 的 SHA-256 hash。之後重新啟動服務時，請使用同一個擴充套件 ID 與資料目錄，不需再次配對。以 `Ctrl+C` 停止服務；正常關閉會取消未完成工作並清理工作目錄。

若要隔離開發資料，可以啟動：

```sh
uv run ytwhisper serve --extension-id YOUR_EXTENSION_ID --data-dir /absolute/path/to/ytwhisper-data
```

`--data-dir` 只改變配對、字幕與音訊工作目錄，不改變 Hugging Face 的模型快取位置。服務沒有公開網路綁定、遠端位址或自訂 port 選項。

## 使用

1. 開啟一般公開的 `https://www.youtube.com/watch?v=VIDEO_ID` 影片，等待影片 metadata 載入。建議先用幾十秒的英文與中文口語短片驗證。
2. 在 popup 點選「產生／載入字幕」。目前影片會先暫停；popup 與播放器 overlay 顯示等待、下載、轉換、Whisper 辨識等階段。目前提供階段狀態，沒有精確百分比或剩餘時間。
3. 辨識完成後，字幕自動載入，影片從 `0:00` 開始播放。若 Chrome 阻擋自動播放，手動按影片的播放鍵即可。
4. 字幕以影片目前時間為準；可拖曳時間軸、切換倍速及使用播放器全螢幕。以 popup「顯示字幕」切換 overlay，不會重新辨識。
5. 再次按「產生／載入字幕」會嘗試讀取本機快取；命中時顯示「已從本機快取載入字幕」，並從頭播放。想略過快取時按「重新產生」。
6. 處理中按「取消處理」可停止該工作。失敗或取消時會嘗試還原處理前的播放／暫停狀態，並保留播放位置。

服務一次處理一個工作；其他工作排隊。同一影片的進行中工作可能由多個分頁共用，取消會影響該共用工作。切換影片或關閉分頁只停止該分頁接收結果，後端工作仍可能繼續；需要取消時，請在切換前操作。

## 資料、快取與權限

預設資料目錄是 `~/Library/Application Support/ytWhisper/`：

| 路徑 | 用途 |
| --- | --- |
| `pairing.json` | token hash；檔案權限 `0600` |
| `subtitles/VIDEO_ID.json` | 原語言、模型、時間戳與 cue 文字的字幕快取 |
| `work/JOB_ID-…/` | 單一工作的下載音訊、16 kHz mono WAV 與辨識暫存檔 |

正常完成、失敗、取消與正常關閉會清理該工作的音訊暫存目錄。強制殺掉程序或系統中斷可能留下檔案；停止服務後可檢查 `work`，將不再使用的工作目錄移至垃圾桶。字幕快取與模型快取會保留，不會自動淘汰。

字幕快取會檢查 schema、影片 ID、模型與影片長度（容許 2 秒差異），不合時會重新處理。若字幕有誤，可用「重新產生」覆寫該影片的快取。Hugging Face 模型快取由其套件管理，通常位於 `~/.cache/huggingface/`，也受 `HF_HOME` 等環境設定影響。

擴充套件使用 `storage`、`tabs`、固定 `http://127.0.0.1:8765/*` host permission，以及僅限 YouTube HTTPS 網域的 content scripts。HTTP 請求由 background service worker 發出，token 不傳到影片頁面。服務要求啟動時指定的 `chrome-extension://…` Origin；工作 API 另外要求配對 token。一般網頁、缺少 Origin 的請求與其他擴充套件 Origin 都會被拒絕。

辨識在此 Mac 進行；服務仍會向 YouTube 取得公開影片音訊，首次載入模型則會連線 Hugging Face。服務不讀取瀏覽器 cookies，也會忽略使用者的 yt-dlp 設定。

## 重設配對

先以 `Ctrl+C` 停止服務，再執行：

```sh
uv run ytwhisper reset-pairing
uv run ytwhisper serve --extension-id YOUR_EXTENSION_ID
```

若啟動時有使用 `--data-dir`，重設與重新啟動都必須帶同一個 `--data-dir`。重設會撤銷舊 token，保留字幕快取；重新啟動後，以新配對碼在 popup 再次配對。更換 Chrome profile、移除擴充套件或載入路徑導致 ID 改變時，也請依這個流程重新配對。

## 限制與故障排除

- 目前支援一般公開的 YouTube watch 影片，不支援直播、Shorts／embed 頁面、私人影片、會員內容、需登入或地區／年齡限制的影片。影片本身及下載服務的可用性仍取決於 YouTube。
- 自動偵測語言並輸出原語言；不做翻譯，不保證中文繁簡轉換。Whisper 可能誤辨、人名有誤或在音樂／靜音處產生文字，字幕需自行核對。
- 「本機服務離線」：確認終端機中的服務仍在執行、port `8765` 沒有被其他程序占用。重新啟動服務後，在 popup 按「重新整理」；進行中工作因服務重啟失效時，重新發起工作。
- 無法配對或出現 `ORIGIN_FORBIDDEN`：核對 `chrome://extensions` 的 ID 與 `--extension-id` 完全一致。配對完成的服務不會再接受舊代碼；遺失 token 時使用重設配對流程。
- 找不到 ffmpeg：在同一個啟動終端機執行 `ffmpeg -version`，修正 `PATH` 後重新啟動服務。目前 popup 在 ffmpeg 缺少時也會停用「產生／載入字幕」，即使已有快取。
- 看不到目前影片：重新整理影片頁面，確認是一般 `/watch?v=…` 頁面且影片長度已載入。播放器頁面結構變更、廣告與 Chrome extension 政策也可能影響偵測。
- `DOWNLOAD_FAILED`：先確認是可公開觀看的影片與網路可用；YouTube 限流、驗證要求或 yt-dlp 與網站變動不相容都可能造成失敗。本程式沒有登入或 cookie 匯入流程。
- `TRANSCRIPTION_FAILED`：確認 Apple Silicon／Metal 可用、模型下載可連線、磁碟與記憶體足夠。首次下載可能較久；服務的階段狀態不代表精確下載進度。
- 已載入卻未播放：按影片播放鍵；必要時重新整理頁面並再次載入快取。
- 已辨識字幕與 YouTube 原生字幕重疊：關閉播放器原生字幕，或以 popup 關閉 ytWhisper 字幕。

可用下列指令確認服務狀態；將 `YOUR_EXTENSION_ID` 換成啟動服務時使用的 ID。未帶 Origin 的一般 `curl` 會回 `403`，這是預期行為。

```sh
curl --fail-with-body \
  -H 'Origin: chrome-extension://YOUR_EXTENSION_ID' \
  http://127.0.0.1:8765/v1/health
lsof -nP -iTCP:8765 -sTCP:LISTEN
```

## 開發驗證

在根目錄執行：

```sh
uv sync --extra dev
pnpm install
uv run python -m pytest
uv run ruff check --select E4,E7,E9,F services/local_server
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

不限定規則的完整 lint 可用 `uv run ruff check services/local_server`；目前仍有既有的風格、import 與 exception 類型建議未清理。上述 correctness 規則檢查與測試可獨立執行，不需下載模型。測試使用替身覆蓋失敗與競態；測試通過不等於已在 Chrome 中完成真實模型及播放驗證。

手動驗收時，請用一支短英文與一支短中文公開影片，各自確認首次辨識、原語言 cue、完成後從頭播放、seek、倍速、全螢幕與字幕開關。再確認第二次載入命中快取、「重新產生」可取消，以及停止服務後 popup 顯示離線。最後檢查 `work` 無音訊殘留、`lsof` 僅列出 `127.0.0.1:8765`，並確認錯誤 Origin 與缺少／錯誤 token 的工作請求會被拒絕。
