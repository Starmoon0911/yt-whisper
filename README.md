<a id="readme-top"></a>

<div align="center">

# ytWhisper

在 Apple Silicon Mac 上，以本機 Whisper 為公開 YouTube 影片產生原語言字幕。

[![Python](https://img.shields.io/badge/Python-3.10--3.13-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Chrome](https://img.shields.io/badge/Chrome-120%2B-4285F4?logo=googlechrome&logoColor=white)](https://www.google.com/chrome/)
[![Apple Silicon](https://img.shields.io/badge/Apple%20Silicon-MLX-000000?logo=apple&logoColor=white)](https://github.com/ml-explore/mlx)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

<details>
  <summary>目錄</summary>
  <ol>
    <li><a href="#關於專案">關於專案</a></li>
    <li><a href="#開始使用">開始使用</a></li>
    <li><a href="#使用方式">使用方式</a></li>
    <li><a href="#資料快取與權限">資料、快取與權限</a></li>
    <li><a href="#重設配對">重設配對</a></li>
    <li><a href="#限制與故障排除">限制與故障排除</a></li>
    <li><a href="#開發與驗證">開發與驗證</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#貢獻">貢獻</a></li>
    <li><a href="#授權">授權</a></li>
  </ol>
</details>

## 關於專案

ytWhisper 由 Chrome 擴充套件與只監聽 localhost 的 Python 服務組成。擴充套件負責暫停影片、顯示處理階段及渲染字幕；Python 服務下載公開影片音訊、轉檔、以 MLX Whisper 辨識，並保存字幕快取。

- 辨識在 Mac 本機執行，不需要 OpenAI API key。
- 自動偵測影片語言並輸出原語言字幕，不進行翻譯。
- 配對後才允許擴充套件呼叫工作 API，token 不會傳入 YouTube 頁面。
- 服務固定監聽 `127.0.0.1:8765`，不提供公開網路綁定。

### 技術組成

- [Python](https://www.python.org/)、[FastAPI](https://fastapi.tiangolo.com/) 與 [uv](https://docs.astral.sh/uv/)
- [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper)
- TypeScript、Chrome Extensions Manifest V3、[pnpm](https://pnpm.io/)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)（包含 [yt-dlp-ejs](https://pypi.org/project/yt-dlp-ejs/)）與 [FFmpeg](https://ffmpeg.org/)

<p align="right">(<a href="#readme-top">回到頂端</a>)</p>

## 開始使用

### 環境需求

- Apple Silicon Mac（MLX／Metal）。目前未提供 Intel Mac、Windows 或 Linux 後端。
- Python 3.10–3.13、Node.js、[uv](https://docs.astral.sh/uv/) 及 `package.json` 指定的 pnpm 版本。
- Chrome 120 以上，且允許載入未封裝的擴充套件。
- `ffmpeg` 位於啟動服務的終端機 `PATH` 中。使用 Homebrew 時可執行 `brew install ffmpeg`，再以 `ffmpeg -version` 確認。
- JavaScript 執行環境（Node.js 或 [Deno](https://deno.com/)）位於同一個 `PATH` 中。yt-dlp 需要它解出 YouTube 的簽章與 PO token 挑戰；缺少時下載會以「找不到 JavaScript 執行環境」失敗。服務會依序選用 `deno`、`node`、`bun`、`quickjs`、`qjs`。
- 安裝套件、下載影片及首次取得模型需要網路。預設模型 `mlx-community/whisper-large-v3-turbo` 的權重約 1.61 GB。

### 安裝與建置

取得此 repository 後，在根目錄執行：

```sh
uv sync --extra dev
pnpm install
pnpm build
```

`uv` 會建立 `.venv`；後續 Python 指令均透過 `uv run` 執行。`pnpm build` 會將可載入的擴充套件輸出至 `apps/extension/dist`。

### 載入擴充套件並配對

1. 在 Chrome 開啟 `chrome://extensions`，啟用「開發人員模式」。
2. 點選「載入未封裝項目」，選擇本 repository 的 **`apps/extension/dist`**，不要選擇 `src` 或 repository 根目錄。
3. 複製 ytWhisper 卡片上的擴充套件 ID。它應由 32 個小寫 `a`–`p` 字元組成。
4. 在 repository 根目錄啟動服務，將 `YOUR_EXTENSION_ID` 換成剛才複製的 ID：

   ```sh
   uv run ytwhisper serve --extension-id YOUR_EXTENSION_ID
   ```

5. 保持終端機開啟。首次啟動會印出六位數配對碼，服務固定監聽 `http://127.0.0.1:8765`。
6. 從 Chrome 工具列開啟 ytWhisper popup，輸入配對碼並按「配對」。看到「本機服務已連線 · 已配對」後即可使用。
7. 載入或重新載入擴充套件後，重新整理已開啟的 YouTube 影片頁面，讓 content script 生效。

配對成功後，token 會存於擴充套件的本機 storage，服務只保存 token 的 SHA-256 hash。之後以相同擴充套件 ID 與資料目錄啟動時不需再次配對。以 `Ctrl+C` 停止服務。

若要隔離開發資料，可指定絕對路徑：

```sh
uv run ytwhisper serve \
  --extension-id YOUR_EXTENSION_ID \
  --data-dir /absolute/path/to/ytwhisper-data
```

`--data-dir` 只影響配對、字幕與工作目錄，不會改變 Hugging Face 模型快取位置。

<p align="right">(<a href="#readme-top">回到頂端</a>)</p>

## 使用方式

1. 開啟一般公開的 `https://www.youtube.com/watch?v=VIDEO_ID` 影片，等待 metadata 載入。第一次可先用數十秒的英文或中文口語短片測試。
2. 在 popup 點選「產生／載入字幕」。影片會先暫停，popup 與播放器 overlay 會顯示等待、下載、轉換及辨識階段。
3. 辨識完成後，字幕會自動載入，影片從 `0:00` 開始播放。若 Chrome 阻擋自動播放，請手動按播放鍵。
4. 字幕會跟隨目前播放時間，支援 seek、倍速及全螢幕。popup 的「顯示字幕」只切換 overlay，不會重新辨識。
5. 再次按「產生／載入字幕」會優先讀取本機快取；按「重新產生」可略過快取。
6. 處理中可按「取消處理」。失敗或取消時，擴充套件會嘗試還原先前的播放狀態與位置。

服務一次處理一個工作，其餘工作會排隊。同一影片的進行中工作可能由多個分頁共用，因此取消會影響該共用工作。切換影片或關閉分頁只會停止該分頁接收結果，後端工作仍可能繼續。

<p align="right">(<a href="#readme-top">回到頂端</a>)</p>

## 資料、快取與權限

預設資料目錄為 `~/Library/Application Support/ytWhisper/`：

| 路徑 | 用途 |
| --- | --- |
| `pairing.json` | token hash；檔案權限為 `0600` |
| `subtitles/VIDEO_ID.json` | 語言、模型、時間戳與 cue 文字的字幕快取 |
| `work/JOB_ID-…/` | 工作中的下載音訊、16 kHz mono WAV 與辨識暫存檔 |

正常完成、失敗、取消與關閉時會清理該工作的音訊暫存目錄。程序遭強制終止時可能留下檔案；停止服務後可檢查 `work` 並移除不再使用的工作目錄。字幕與模型快取不會自動淘汰。

字幕快取會驗證 schema、影片 ID、模型與影片長度（容許 2 秒差異）。若字幕有誤，可用「重新產生」覆寫快取。Hugging Face 模型通常快取於 `~/.cache/huggingface/`，實際位置也受 `HF_HOME` 等環境設定影響。

擴充套件使用 `storage`、`tabs`、`http://127.0.0.1:8765/*` host permission，以及僅限 YouTube HTTPS 網域的 content scripts。HTTP 請求由 background service worker 發出；服務會驗證啟動時指定的 `chrome-extension://…` Origin，工作 API 也要求 bearer token。一般網頁、缺少 Origin 的請求及其他擴充套件 Origin 都會被拒絕。

辨識在本機進行，但服務仍會連線 YouTube 取得公開影片音訊，並在首次使用時連線 Hugging Face 下載模型。服務不讀取瀏覽器 cookies，也會忽略使用者的 yt-dlp 設定。

<p align="right">(<a href="#readme-top">回到頂端</a>)</p>

## 重設配對

先以 `Ctrl+C` 停止服務，再執行：

```sh
uv run ytwhisper reset-pairing
uv run ytwhisper serve --extension-id YOUR_EXTENSION_ID
```

若啟動時使用了 `--data-dir`，重設與重新啟動都必須帶同一個路徑。重設會撤銷舊 token、保留字幕快取；重新啟動後，以新配對碼在 popup 再次配對。更換 Chrome profile、移除擴充套件或改變載入路徑而導致 ID 變更時，也請依此流程重新配對。

## 限制與故障排除

### 已知限制

- 僅支援一般公開的 YouTube watch 影片；不支援直播、Shorts、embed、私人影片、會員內容及需要登入或受地區／年齡限制的影片。
- 自動偵測語言並輸出原語言，不做翻譯，也不保證中文繁簡轉換。
- Whisper 可能誤辨、人名有誤，或在音樂及靜音處產生文字；重要內容請自行核對。
- 目前只顯示處理階段，沒有精確進度百分比或剩餘時間。

### 常見問題

- **本機服務離線**：確認服務仍在執行，且 port `8765` 未被占用；重新啟動後在 popup 按「重新整理」。
- **無法配對／`ORIGIN_FORBIDDEN`**：確認 `chrome://extensions` 顯示的 ID 與 `--extension-id` 完全一致。遺失 token 時請重設配對。
- **找不到 FFmpeg**：在啟動服務的同一終端機執行 `ffmpeg -version`，修正 `PATH` 後重新啟動。
- **`JS_RUNTIME_MISSING`**：yt-dlp 需要 Node.js 或 Deno 才能解出 YouTube 的簽章與驗證挑戰。安裝後在啟動服務的同一終端機確認 `node --version`（或 `deno --version`），再重新啟動本機服務。此錯誤不會因重試而消失。
- **看不到目前影片**：確認頁面是一般 `/watch?v=…` 影片，metadata 已載入，並重新整理頁面。
- **`DOWNLOAD_FAILED`**：確認影片可公開觀看且網路正常。YouTube 限流、驗證要求或網站變動也可能造成失敗。
- **`TRANSCRIPTION_FAILED`**：確認 Apple Silicon／Metal 可用、模型可下載，且磁碟與記憶體空間充足。
- **已載入但未播放**：手動按播放鍵；必要時重新整理頁面並再次載入快取。
- **字幕重疊**：關閉 YouTube 原生字幕，或用 popup 關閉 ytWhisper 字幕。

可用以下指令確認服務狀態；未帶 Origin 的一般 `curl` 回傳 `403` 是預期行為。

```sh
curl --fail-with-body \
  -H 'Origin: chrome-extension://YOUR_EXTENSION_ID' \
  http://127.0.0.1:8765/v1/health
lsof -nP -iTCP:8765 -sTCP:LISTEN
```

<p align="right">(<a href="#readme-top">回到頂端</a>)</p>

## 開發與驗證

在 repository 根目錄執行：

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

上述 correctness lint 與自動測試不需下載 Whisper 模型。若要執行完整 lint，可使用 `uv run ruff check services/local_server`；目前仍有既有的風格、import 與 exception 類型建議尚未清理。

手動驗收時，建議分別使用短英文與短中文公開影片，確認首次辨識、字幕語言、完成後從頭播放、seek、倍速、全螢幕、字幕開關、快取命中、重新產生及取消流程。最後確認 `work` 無音訊殘留，且服務只監聽 `127.0.0.1:8765`。

<p align="right">(<a href="#readme-top">回到頂端</a>)</p>

## Roadmap

- [x] 本機 MLX Whisper 辨識
- [x] Chrome 播放器字幕 overlay
- [x] localhost Origin 與配對 token 驗證
- [x] 字幕快取、取消與重新產生
- [ ] 支援更多作業系統與推論後端
- [ ] 更細緻的下載及辨識進度
- [ ] 字幕匯出與編輯流程

<p align="right">(<a href="#readme-top">回到頂端</a>)</p>

## 貢獻

歡迎提交 issue 或 pull request。開始修改前，請先確認變更符合目前「Apple Silicon、本機服務、公開 YouTube watch 影片」的專案範圍。

1. Fork repository。
2. 建立功能分支：`git switch -c feature/your-change`。
3. 完成變更並執行「開發與驗證」中的檢查。
4. 提交清楚、聚焦的 commit。
5. Push 分支並開啟 pull request，說明動機、測試方式與使用者可見的影響。

安全性問題請不要公開包含 token、配對資料或本機路徑的紀錄；先建立不含敏感資訊的最小重現方式。

## 授權

本專案以 [MIT License](LICENSE) 授權。

<p align="right">(<a href="#readme-top">回到頂端</a>)</p>
