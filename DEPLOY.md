# V2.0.0 部署／升級步驟

## A. 從本次附件 V1.6.6 升級

### 1. 保存目前資料

在舊 App 的設定頁建立一次 Google Drive 備份；也建議先保存 GitHub 現有檔案。保留 Google Drive 附件資料夾。升級 SQL 只新增表格、索引與觸發器，不刪除行程、備註或訂閱。

### 2. 安裝部署依賴

Windows 解壓 ZIP，進入 `PWA-CalendarNotes-GD_V2_0_0` 資料夾，在 PowerShell 或終端機執行：

```powershell
npm ci
npx wrangler login
```

使用支援目前 Wrangler 的 Node.js LTS。專案提供鎖定檔；不需要把 node_modules 上傳 GitHub。

### 3. 升級既有 D1

```powershell
npm run db:upgrade
```

等同：

```powershell
npx wrangler d1 execute calendar-notes-pwa-db --remote --file=migrate_v2_0_0.sql
```

請確認目標是原本的 `calendar-notes-pwa-db`。本 ZIP 保留原 database_id。**既有資料庫不要重新建立，也不要執行 DROP TABLE。** 升級腳本可重複執行；其提醒重建工作由新版排程分批完成。

若是比 V1.5 更早的資料庫，先依舊版流程執行 `migrate_v1_5_0.sql`，再執行本次升級。本次附件 V1.6.6 不需要重跑 V1.5 升級。

### 4. 部署 Worker

```powershell
npm run deploy
```

沿用既有 Worker 名稱及 VAPID secrets，不要重新生成 VAPID 金鑰；更換金鑰會影響既有通知訂閱。

在瀏覽器開啟：

https://calendar-notes-pwa-api.rexchre.workers.dev/api/health

應看到 `ok: true`、`version: "V2.0.0"`。若資料庫升級失敗，先處理錯誤，暫時不要更新前端。

### 5. 更新 GitHub Pages

把解壓資料夾內的檔案覆蓋到原儲存庫根目錄：

https://github.com/lihe-source/PWA-CalendarNotes-GD

可以上傳根目錄全部交付檔案；只要保留 README 列出的前端必需檔也能執行前端，但 Worker 部署原始碼與 package-lock.json 建議一起保存。不要上傳 node_modules、秘密金鑰、OAuth Client Secret 或本機部署快取。

等待 GitHub Pages 完成部署，再重新開啟 PWA。新版本會核對檔案完整性後切換；正在編輯時會先等編輯結束。設定頁應顯示 V2.0.0。

若前端檔案尚未發布一致，App 會保留可用版本。等部署完成後，按「檢查更新」。不要為了更新而刪除 IndexedDB 或重設 App，以免移除未同步資料。

## B. 啟用較穩定的持續登入

新版已包含 Worker 端授權更新功能。**若未完成此段設定，App 會相容原有登入方式，但 Google access token 到期後仍可能需要重新登入。** 一進 App 顯示本機主畫面的行為不受影響。

### 1. Google Cloud 設定

使用原有 Web application OAuth Client，已授權 JavaScript 來源應包含：

```text
https://lihe-source.github.io
```

本版使用 Google Identity Services 的 Popup code model；交換授權碼時使用上面相同的 origin，不能填 GitHub 專案子路徑或 Worker API URL。沿用既有 Drive API 與 OAuth 同意畫面設定。

從該 OAuth Client 取得 Client Secret。不要貼在 config.js、聊天、GitHub 或公開文件。

### 2. 設定 Worker secrets

```powershell
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

依終端機提示輸入 Client Secret。GOOGLE_CLIENT_ID 已由 wrangler.jsonc 保留並設定。

接著建立一次加密金鑰：

```powershell
npm run auth:key
```

複製輸出的 Base64 金鑰，執行：

```powershell
npx wrangler secret put AUTH_ENCRYPTION_KEY
```

依提示貼上該金鑰。這把金鑰用來加密保存在 D1 的 Google 權杖；**保存並持續沿用，不要每次部署重新生成**。

再執行：

```powershell
npm run deploy
```

開啟 `/api/auth/config`，應看到 `persistent: true`。在 App 登出並登入一次，建立新版會話；之後可由 Worker 更新 Google 授權，減少重複操作。伺服器會話目前有效期為 30 天；授權被取消、Google 要求驗證或會話到期時，仍需重新登入。

D1 只存會話雜湊，Google access／refresh token 使用 AES-GCM 加密。AUTH_ENCRYPTION_KEY、GOOGLE_CLIENT_SECRET 都僅存在 Cloudflare secrets。

## C. 通知確認

1. 每部 iPhone／iPad 從主畫面 PWA 開啟；桌機從 Chrome／Edge 開啟。
2. 登入同帳號／共享工作區後，在設定頁按「啟用通知」。已訂閱的裝置會在連線時重新對應目前帳號。
3. 按「測試通知」，本版只測試目前裝置，不會一次傳到其他裝置。
4. 「推播服務已接受」表示推播供應商接受請求，不能保證作業系統已顯示。請檢查通知權限、勿擾與通知摘要。
5. 建立 3 分鐘後的行程，選「準時」，確認待同步為 0，再切到背景等候。排程仍為每分鐘一次，實際通知也會受系統投遞影響。
6. 設定頁「通知狀態」可查看伺服器設定、裝置數與接受／重試統計。

## D. 全新部署

1. 建立 D1 後，將 wrangler.jsonc 的 database_id 指向新資料庫。
2. 執行 `npm run db:init`（schema.sql 已含 V2 全部表格）。
3. 設定 VAPID_PUBLIC_KEY、VAPID_PRIVATE_KEY、VAPID_SUBJECT；私鑰只放 Worker secrets，公鑰同步填入 config.js。
4. 更新 config.js 的 API_BASE_URL、GOOGLE_CLIENT_ID，以及 wrangler.jsonc 的 ALLOWED_ORIGINS、GOOGLE_CLIENT_ID。
5. 按 B 段設定 Google Client Secret 與加密金鑰。
6. 執行 `npm run release`、`npm run deploy`，再上傳前端到 GitHub Pages。
7. 首位擁有 Drive 共用資料夾編輯權限的使用者建立共享工作區。其他成員須事先取得相同 Drive 資料夾權限。

## E. 復原與錯誤排除

- **同步失敗**：先看待同步筆數與項目錯誤；資料保留在原帳號，不要清除瀏覽器資料。
- **授權需要更新**：設定頁重新登入。若要減少反覆登入，確認 B 段的 secrets 與 persistent 狀態。
- **SERVER_ERROR／升級後 API 無法使用**：確認已對同一 D1 執行 V2 migration，且 Worker 部署包含 server-auth.js、recurrence.js。
- **附件失敗**：文字及已成功附件仍保留；重新選取未成功的附件。上傳工作階段逾時後需重新開始。
- **還原失敗**：D1 批次 SQL 失敗會回滾。如果只是回應途中斷線，先同步確認伺服器狀態；不要直接重複舊預覽。
- **復原上一次還原**：設定頁按「復原上次還原」，預覽後確認。雲端模式使用伺服器快照，本機模式使用本機快照；也可匯入自動下載的 before-restore JSON。
- **找不到舊資料**：確認 Google 帳號與原共用資料夾一致。第一次升級會移轉符合條件的舊 IndexedDB；原資料庫仍保留。未登入建立的內容可用「匯入本機模式內容」。

