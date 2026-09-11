# V2.2.2 驗證紀錄

- app.js、config.js、service-worker.js 語法檢查通過。
- version.json 全部 16 個靜態資源 SHA-256 與實際檔案一致。
- 確認啟動不再讀取 selectedDate，改用既有工作區時區 today()；切回行事曆與跨日回前景重新選取今天。
- 核對行程及備註列表具 overflow-y:auto、min-height:0，父層固定可用高度；橫向覆寫原整頁捲動規則。
- 原 auth.js、api.js、db.js、worker.js、server-auth.js、wrangler.jsonc 與 V2.2.1 完全一致。
- 保留啟動自動檢查更新及設定頁檢查更新功能。
- ZIP CRC 檢查通過，無 EXE、DLL 或 Electron 執行環境。

限制：本次 Chromium 測試環境下載回應 502，未完成實際瀏覽器排版測試，也未在 iPhone／iPad／Windows 實機驗證。
