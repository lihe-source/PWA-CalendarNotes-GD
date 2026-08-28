# V1.6.1 更新注意

V1.6.1 只修改前端 24 小時制時間選擇器與顯示格式。若 V1.5.0 共享 Worker 已部署成功，本版不需要重新部署 Worker，也不需要執行 D1 migration。

# V1.6.0 更新注意

V1.6.0 只修改前端響應式版面、卡通主題與 Service Worker 版本。若 V1.5.0 的共享 Worker 已經成功部署，這次不需要重新部署 Worker，也不需要再次執行 migration。

若你上一版仍停在 `Could not resolve "@mmmike/web-push/send"`，請先在本資料夾執行 `npm install`，再執行 `npx wrangler deploy` 一次，完成 V1.5.0 共享 Worker 的部署。

---

# V1.5.0 既有系統升級（先做這一段）

如果你目前已經是 V1.4.x，**不要重新建立 D1**。在本 V1.5.0 資料夾依序執行：

```cmd
npx wrangler d1 execute calendar-notes-pwa-db --remote --file=./migrate_v1_5_0.sql
npx wrangler deploy
```

`migrate_v1_5_0.sql` 只執行一次。它會加入 `workspaces` / `workspace_members`，並把現有 events / notes / reminders 指向 `shared-main`。

若是全新空白 D1，直接執行 `schema.sql`，不要再執行 migration。

多人加入時，每個 Google 帳號都必須先取得同一個 Google Drive Folder 的分享權限；OAuth 專案若仍在 Testing，也必須把每個帳號加入 Test users。

---

# Cloudflare 部署教學（Windows / Wrangler）

以下流程以 Cloudflare 官方目前推薦的 Wrangler 設定方式為準。

## A. 先準備

1. 建立 Cloudflare 帳號。
2. Windows 安裝 Node.js LTS。
3. 解壓縮本 ZIP。
4. PowerShell / CMD 進入解壓後資料夾。

檢查：

```powershell
node -v
npm -v
```

## B. 安裝 Wrangler 與 Web Push 套件

```powershell
npm install
```

登入 Cloudflare：

```powershell
npx wrangler login
```

瀏覽器會開啟 Cloudflare 授權頁，按 Allow。

## C. 建立 D1

在專案資料夾執行：

```powershell
npx wrangler d1 create calendar-notes-pwa-db --location apac
```

成功後會顯示類似：

```text
database_name = "calendar-notes-pwa-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

複製 `database_id`。

打開 `wrangler.jsonc`，將：

```text
REPLACE_WITH_D1_DATABASE_ID
```

換成剛才的 ID。

## D. 設定允許的 GitHub Pages Origin

在 `wrangler.jsonc`：

```jsonc
"ALLOWED_ORIGINS": "https://YOUR_GITHUB_USERNAME.github.io,http://localhost:8000,http://127.0.0.1:8000"
```

例如 GitHub Pages 是：

```text
https://lihe-source.github.io/Calendar-PWA/
```

Origin 要填：

```text
https://lihe-source.github.io
```

**不要加 `/Calendar-PWA/` 路徑。**

同一檔案把：

```jsonc
"VAPID_SUBJECT": "mailto:YOUR_EMAIL@example.com"
```

改成你的 email。

## E. 建立 D1 資料表

```powershell
npx wrangler d1 execute calendar-notes-pwa-db --remote --file=schema.sql
```

看到 SQL statements 執行成功即可。

## F. 產生 VAPID Web Push 金鑰

```powershell
npm run vapid
```

會得到：

```text
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
```

Public Key 可公開；Private Key 不可上傳 GitHub。

### Public Key 寫入 Worker Secret

```powershell
npx wrangler secret put VAPID_PUBLIC_KEY
```

系統要求輸入值時貼上 Public Key。

### Private Key 寫入 Worker Secret

```powershell
npx wrangler secret put VAPID_PRIVATE_KEY
```

貼上 Private Key。

### Public Key 同時放到 PWA

打開 `config.js`：

```js
VAPID_PUBLIC_KEY: 'REPLACE_WITH_VAPID_PUBLIC_KEY',
```

換成同一組 Public Key。

## G. 部署 Worker

```powershell
npx wrangler deploy
```

成功後會顯示類似：

```text
https://calendar-notes-pwa-api.YOUR-SUBDOMAIN.workers.dev
```

複製這個網址。

打開 `config.js`：

```js
API_BASE_URL: 'https://REPLACE_ME.workers.dev',
```

換成真正 Worker URL。

## H. 驗證 Worker

瀏覽器開：

```text
https://你的Worker.workers.dev/api/health
```

應看到類似：

```json
{"ok":true,"service":"calendar-notes-pwa-api",...}
```

## I. 確認 Cron Trigger

`wrangler.jsonc` 已包含：

```jsonc
"triggers": {
  "crons": ["* * * * *"]
}
```

代表每分鐘執行一次提醒掃描。Cloudflare Cron 使用 UTC，但本程式把實際提醒時間先轉成 ISO UTC 存入 D1，所以台灣 `Asia/Taipei` 不需要手動把 cron 換算 +8。

也可在 Cloudflare Dashboard 檢查：

```text
Workers & Pages
→ calendar-notes-pwa-api
→ Settings / Triggers
→ Cron Triggers
```

應看到 `* * * * *`。

## J. 測試 Cron（可選）

本機 Worker：

```powershell
npx wrangler dev
```

另一個終端執行：

```powershell
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

## K. 查看 Worker Log

部署後需要排查提醒時：

```powershell
npx wrangler tail
```

然後新增一個 2~3 分鐘後的提醒，觀察 Worker 是否有錯誤。

---

# Google Cloud 必要設定

Cloudflare 完成後，PWA 要能登入與存 Google Drive，還要做以下設定。

## 1. 建立 Google Cloud Project

Google Cloud Console 建立 Project。

## 2. 啟用 Google Drive API

```text
APIs & Services
→ Library
→ Google Drive API
→ Enable
```

## 3. 設定 OAuth Consent Screen

設定 App name、Support email、Developer email。

若只是自己 / 少量測試帳號使用，可保持 Testing，並將要使用的 Google 帳號加入 Test users。

## 4. Data Access / Scopes

本程式需要：

```text
openid
email
profile
https://www.googleapis.com/auth/drive
```

完整 Drive scope 是因為 V1 支援「使用者直接貼任意既有共用資料夾 URL」。

## 5. 建立 OAuth Client

```text
APIs & Services
→ Credentials / Clients
→ Create Client
→ Web application
```

Authorized JavaScript origins 加入：

```text
https://YOUR_GITHUB_USERNAME.github.io
http://localhost:8000
```

例如：

```text
https://lihe-source.github.io
```

把 Client ID 複製到 `config.js`：

```js
GOOGLE_CLIENT_ID: 'xxxx.apps.googleusercontent.com',
```

本程式使用 Google Identity Services token model，不需要在 GitHub Pages 保存 Google Client Secret。

---

# GitHub Pages 部署

1. 建立 GitHub repository，例如 `Calendar-Notes-PWA`。
2. 將 ZIP 內所有檔案直接上傳到 repository 根目錄。
3. 不要上傳 `node_modules`；本 ZIP 本來就沒有包含。
4. GitHub repository → `Settings` → `Pages`。
5. Source 選 `Deploy from a branch`。
6. Branch 選 `main`。
7. Folder 選 `/(root)`。
8. Save。
9. 網址會是：

```text
https://YOUR_GITHUB_USERNAME.github.io/Calendar-Notes-PWA/
```

如果 repository 本身叫 `YOUR_GITHUB_USERNAME.github.io`，則是根網址。

---

# iPhone / iPad Push 測試

1. 用 Safari 開 GitHub Pages 網址。
2. 分享 → 加入主畫面。
3. 從主畫面的 PWA 圖示開啟。
4. 設定 → Google 登入。
5. 設定 Drive 共用資料夾。
6. 按「啟用通知」。
7. 按「測試通知」。
8. 新增 2~3 分鐘後的行程，提醒選「準時」。
9. 關閉 PWA，等待 Cloudflare Cron 推播。

若「測試通知」成功、排程通知失敗，優先檢查：

- D1 `reminders` 是否有 trigger_at。
- Cron Trigger 是否存在。
- `npx wrangler tail` 是否出現 Push 401/403/404/410。
- VAPID Public/Private 是否同一組。
- PWA `config.js` Public Key 是否與 Worker Secret 相同。
