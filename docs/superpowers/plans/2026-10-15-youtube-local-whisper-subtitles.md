# YouTube 地端 Whisper 字幕實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 Chrome 使用者能為目前的公開 YouTube VOD 在 Apple Silicon Mac 上預先產生並同步顯示地端 Whisper 字幕。

**Architecture:** Chrome MV3 擴充套件負責操作播放器與顯示字幕，Python localhost 服務負責配對、工作佇列、音訊處理、MLX Whisper 與 cache。兩端透過版本化 REST JSON 契約通訊；播放器 `currentTime` 是唯一同步時基。

**Tech Stack:** TypeScript、Chrome MV3、esbuild、Vitest、Python 3.10+、FastAPI、uv、yt-dlp、ffmpeg、mlx-whisper、unittest/pytest。

**Spec:** `docs/superpowers/specs/2026-10-15-youtube-local-whisper-subtitles-design.md`

## Global Constraints

- 只支援一般公開 YouTube VOD，不讀取 cookies。
- 模型固定為 `mlx-community/whisper-large-v3-turbo`，輸出原語言。
- 本機服務固定監聽 loopback，API 需通過 extension Origin 與 bearer token 驗證。
- 字幕 schema 版本為 `1`；cache 時長容許誤差為 2000 ms。
- 每次只執行一個實際轉錄工作；所有外部處理必須可取消並清理暫存檔。
- 每個行為先寫失敗測試、確認失敗原因，再寫最小實作並跑回歸測試。

---

### Task 1: 專案骨架與純資料契約

**Files:**
- Create: `pyproject.toml`, `package.json`, `pnpm-workspace.yaml`, `.gitignore`
- Create: `services/local_server/ytwhisper/{youtube,cues,cache,auth}.py`
- Create: `services/local_server/tests/test_{youtube,cues,cache,auth}.py`
- Create: `apps/extension/src/subtitles.ts`, `apps/extension/tests/subtitles.test.ts`

**Interfaces:**
- `normalize_watch_url(url: str, expected_video_id: str) -> str`
- `make_cues(words, max_duration_s=6, max_display_width=84) -> list[SubtitleCue]`
- `CacheStore.load(video_id, duration_ms, model) -> SubtitleDocument | None`
- `PairingManager.pair(code) -> token`, `verify(token) -> bool`
- `extractVideoId(url: string) -> string | null`
- `cueAtTime(cues: SubtitleCue[], timeMs: number) -> SubtitleCue | null`

- [ ] 寫 URL、cue、cache、配對及 cue lookup 的失敗測試。
- [ ] 確認測試因模組或行為缺失而失敗。
- [ ] 實作最小純邏輯模組並跑到全綠。
- [ ] 補 malformed cache、CJK 顯示寬度、時間邊界及錯誤 URL 回歸案例。

### Task 2: 媒體與轉錄 pipeline

**Files:**
- Create: `services/local_server/ytwhisper/{media,transcriber,pipeline}.py`
- Create: `services/local_server/ytwhisper/whisper_worker.py`
- Create: `services/local_server/tests/test_pipeline.py`

**Interfaces:**
- `CommandRunner.run(command, on_progress, cancel_event) -> CompletedCommand`
- `MediaPipeline.process(request, work_dir, on_state, cancel_event) -> SubtitleDocument`
- `Transcriber.transcribe(audio_path, output_path, cancel_event) -> WhisperResult`

- [ ] 以可控 fake command runner 寫下載、轉檔、辨識與清理的失敗測試。
- [ ] 驗證取消會終止目前子行程且不產生完成結果。
- [ ] 用 `python -m yt_dlp` 只取最佳音訊；用 ffmpeg 產生 16 kHz mono WAV。
- [ ] 在獨立 Python 子行程呼叫 mlx-whisper，輸出 language、duration 與 word timestamps JSON。
- [ ] 將 word timestamps 轉 cues，原子寫入 cache，並在 `finally` 清除工作目錄。

### Task 3: 工作佇列與 FastAPI

**Files:**
- Create: `services/local_server/ytwhisper/{jobs,api,models,config,cli}.py`
- Create: `services/local_server/tests/test_{jobs,api}.py`

**Interfaces:**
- `JobManager.create(request) -> (JobSnapshot, cache_hit)`
- `JobManager.get(job_id) -> JobSnapshot`
- `JobManager.cancel(job_id) -> JobSnapshot`
- `create_app(config, pairing, jobs) -> FastAPI`

- [ ] 寫佇列、相同工作去重、cache hit、取消與失敗狀態測試。
- [ ] 寫 health、pair、bearer 驗證、Origin、URL 驗證與統一錯誤格式 API 測試。
- [ ] 實作單 worker queue 與狀態快照，禁止同時載入兩份模型。
- [ ] 實作 `/v1/health`、`/v1/pair`、`/v1/jobs` 與取消路由。
- [ ] 實作 macOS Application Support 路徑、固定埠、`serve` 與 `reset-pairing` CLI。

### Task 4: 擴充套件背景通訊與 popup

**Files:**
- Create: `apps/extension/src/{contracts,api,background,popup}.{ts,html,css}`
- Create: `apps/extension/tests/{api,popup}.test.ts`
- Create: `apps/extension/manifest.json`, `apps/extension/build.mjs`

**Interfaces:**
- Extension messages: `GET_PAGE_STATE`, `START_JOB`, `CANCEL_JOB`, `SET_SUBTITLES`, `SET_PROGRESS`。
- API client methods與後端 `/v1` 契約一一對應；token 存於 `chrome.storage.local`。

- [ ] 先測服務離線、未配對、工作輪詢、cache hit 與錯誤映射。
- [ ] 實作只由 service worker 發出的 localhost 請求與 token header。
- [ ] 實作配對表單、影片狀態、主要操作、字幕開關及重新產生。
- [ ] 建立最小 MV3 permissions：YouTube content script、storage、tabs、固定 localhost host permission。
- [ ] 用 esbuild 產出可由 Chrome「載入未封裝項目」使用的 `dist`。

### Task 5: YouTube player 與字幕 overlay

**Files:**
- Create: `apps/extension/src/{content,player,overlay}.ts`
- Create: `apps/extension/src/content.css`
- Create: `apps/extension/tests/{player,overlay}.test.ts`

**Interfaces:**
- `PlayerController.snapshot()`, `pauseForProcessing()`, `playFromStart()`
- `SubtitleOverlay.setDocument(document)`, `setProgress(snapshot)`, `clear()`

- [ ] 以 jsdom 測播放器偵測、播放狀態保存、cue 邊界、字幕開關與進度卡。
- [ ] 實作掛在 `.html5-video-player` 內的 overlay，避免依賴 YouTube 字幕 DOM。
- [ ] 播放時用 animation frame 讀取 `currentTime`；seek、暫停時立即更新。
- [ ] 監聽 `yt-navigate-finish`，換片時取消舊輪詢並清除 cues。
- [ ] 驗證一般、劇院、全螢幕與倍速播放。

### Task 6: 整合、文件與最終驗證

**Files:**
- Create: `README.md`
- Modify: workspace scripts and dependency lockfiles

- [ ] 寫清楚 `uv sync --extra dev`、`pnpm install`、啟動服務、配對與載入 extension 的步驟。
- [ ] 執行 Python 單元／API 測試、TypeScript 測試、typecheck 與 extension build。
- [ ] 用短英文及中文公開影片完成真實模型 smoke test。
- [ ] 驗證首次處理、從頭播放、seek、倍速、全螢幕、cache hit、取消及服務離線。
- [ ] 檢查無音訊暫存殘留、服務只監聽 loopback、未授權 Origin/token 均被拒絕。

## Current Progress

- 已建立 workspace 與 Python/TypeScript 測試骨架。
- 已完成並以 stdlib unittest 驗證 URL 正規化與 cue 分段。
- 已開始 pairing 與 cache 的 TDD；cache 測試仍需修正臨時目錄建立方式後重跑。
- 目前 sandbox 無法連 PyPI/npm，完整第三方依賴測試需在可使用套件快取或正常網路的環境執行。
- sandbox 禁止寫入 `.git`，尚未能初始化 repository 或 commit。
