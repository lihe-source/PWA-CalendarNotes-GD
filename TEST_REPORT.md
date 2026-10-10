# V3_0 驗證紀錄

## 已執行
- 所有 JS 檔（app、api、auth、db、google-drive、push、recurrence、holidays、config、service-worker、theme-init、worker、server-auth、release）語法檢查通過。
- version.json 19 個資產 SHA-256 與實際檔案一致；Service Worker CORE 清單與 version.json 完全相符。
- Chromium（桌機 1280×800、手機 390×780）載入本機副本，21 項檢查全數通過：
  - 月曆 42 格正常；**無 CSP 違規**。
  - Service Worker 安裝成功（安裝時逐檔驗證 SHA-256），快取以 V3_0 命名、含 19 個檔案。
  - 設定頁顯示目前／最新版本 V3_0 與版本說明；模擬由舊版升級時顯示「已更新至 V3_0」提示。
  - A2：草稿還原、捨棄草稿、編輯既有行程後按「新增」開啟空白新增畫面。
  - A5：關閉編輯視窗後焦點回到「新增行程」按鈕。
  - A3：手機版「搜尋行程」可見。
  - B1：淺色／深色 × 11 款配色，文字對比最低 4.62:1，按鈕文字最低 5.19:1。
  - B3：月曆畫面沒有小於 13px 的文字。
- E1：以 SQLite 驗證新的 upsert SQL（資料未變且 1 小時內不寫入；資料變更或逾時才寫入）。
- 目視檢查桌機深色／淺色、手機淺色（天空藍）截圖。

## 未執行（無法在此環境完成）
- 真實 Google 登入、同步、附件上傳、備份還原、Web Push：測試環境無法連線 Google 與 Cloudflare。
- A4（資料沒變不重繪）以程式邏輯檢查，未做自動化實測。
- Worker 實際部署與 D1 執行；iPhone／iPad／Android 實機。
- CSP 與 Google 登入視窗的相容性：依 Google 官方 CSP 需求設定，但未實際登入驗證。請升級後先測一次登入；若登入失敗，把 index.html 的 CSP meta 暫時移除並回報。
