# CalendarNotesPWA V1.0.0

GitHub Pages + Cloudflare Workers/D1 + Google Drive API 的行事曆、備註、提醒 PWA。

## 已完成

- 手機 / iPad / Windows / macOS 瀏覽器可使用，支援安裝成 PWA。
- 月曆、單日事項、週期性行程（每天 / 每週 / 每月 / 每年）。
- 備註 / 待辦、置頂、完成狀態、標籤、提醒。
- 行程可設定 0 / 10 分鐘 / 1 小時 / 1 天 / 1 週前提醒。
- Cloudflare Cron 每分鐘掃描 D1 到期提醒並 Web Push。
- iOS / iPadOS Home Screen PWA、Chrome / Edge Web Push。
- Google Drive 共用資料夾 URL / Folder ID 設定。
- 照片、PDF、Office、TXT、CSV、ZIP 等附件使用 Google Drive resumable upload。
- 自動建立 `CalendarPWA-Data/Attachments/Backups`。
- Google Drive JSON 完整備份與「還原最新備份」。
- IndexedDB 離線資料、待同步 Queue。
- D1 revision 衝突偵測，衝突時保留副本。
- `version.json` 啟動自動檢查更新 + 設定頁手動更新。
- 所有原始檔皆在 ZIP 根目錄，沒有子資料夾。

## 重要設計

附件不經 Cloudflare Worker 中轉，而是瀏覽器直接上傳 Google Drive。Cloudflare 只保存結構化資料與提醒索引，因此大型照片 / PDF 不會占用 D1，也可避免 Worker request body 成為檔案上傳瓶頸。

## 部署前需要修改的檔案

### `wrangler.jsonc`

1. `ALLOWED_ORIGINS`：改成你的 GitHub Pages Origin，例如 `https://lihe-source.github.io`。
2. `VAPID_SUBJECT`：改成你的 email，例如 `mailto:abc@gmail.com`。
3. 建立 D1 後把 `REPLACE_WITH_D1_DATABASE_ID` 換成真正的 Database ID。

### `config.js`

1. `API_BASE_URL`：Worker 部署後的 `https://xxx.workers.dev`。
2. `GOOGLE_CLIENT_ID`：Google Cloud Web OAuth Client ID。
3. `VAPID_PUBLIC_KEY`：`npm run vapid` 產生的 Public Key。

## 安全注意

- 不要把 `VAPID_PRIVATE_KEY` 放 GitHub。
- Google OAuth Client ID 與 VAPID Public Key 可放前端；Private Key 不可。
- Worker 每次 API 呼叫會用 Google access token 讀取 Google UserInfo 驗證使用者。
- Push endpoint 僅接受 Google FCM、Mozilla Push、Apple Push 的 HTTPS host，避免 Worker 被當成任意 URL POST proxy。
- V1 為了讓使用者「貼任意既有 Google Drive 共用資料夾 URL」而使用完整 Drive scope。若應用要公開給大量一般使用者，Google 可能要求 OAuth verification；個人 / 測試用途可將帳號加入 Test users。

## 本機前端測試

Windows 有 Python 時，在此資料夾執行：

```powershell
python -m http.server 8000
```

然後開啟：

```text
http://localhost:8000
```

Google OAuth Authorized JavaScript origins 需加入 `http://localhost:8000`。

## 快速驗證清單

- `https://你的Worker.workers.dev/api/health` 回傳 `ok: true`。
- D1 `schema.sql` 已執行成功。
- Worker 設有 `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY` secrets。
- GitHub Pages 可正常開啟。
- Google OAuth Authorized JavaScript origins 包含 GitHub Pages origin。
- 設定頁 Google 登入成功。
- 貼 Drive Folder URL 後「測試並儲存」成功。
- Drive 中出現 `CalendarPWA-Data`。
- 新增一個 2~3 分鐘後的行程，設定「準時」提醒。
- iPhone/iPad 必須先把網站加入主畫面，再從主畫面 PWA 開啟並按「啟用通知」。
