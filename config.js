// ====== 部署後只需要修改這個檔案 ======
window.APP_CONFIG = {
  APP_NAME: '行事曆・備註提醒',
  VERSION: 'V1.0.0',

  // Cloudflare Worker 部署後取得，例如：
  // https://calendar-notes-pwa-api.your-subdomain.workers.dev
  API_BASE_URL: 'https://calendar-notes-pwa-api.rexchre.workers.dev',

  // Google Cloud Console -> OAuth 2.0 Client ID -> Web application
  GOOGLE_CLIENT_ID: 'REPLACE_WITH_GOOGLE_CLIENT_ID.apps.googleusercontent.com',

  // npm run vapid 產生；Public Key 可放前端，Private Key 只能放 Cloudflare Secret
  VAPID_PUBLIC_KEY: 'BMFfNWY8ljGYAI7f3TU0bQqJfuuzWSW1wRhmf-jJQETX8bM8q5ySxYcCfbI-WVvmDFhFeHvvhCtZGwMOe4JxvIA',

  GOOGLE_SCOPES: [
    'openid',
    'email',
    'profile',
    // 使用者要「貼任意既有共用資料夾 URL」時，需要 Drive 權限。
    // 若日後改用 Google Picker，可再縮限權限。
    'https://www.googleapis.com/auth/drive'
  ].join(' '),

  DEFAULT_TIMEZONE: 'Asia/Taipei',
  AUTO_SYNC_INTERVAL_MS: 5 * 60 * 1000,
  MAX_INLINE_PREVIEW_BYTES: 8 * 1024 * 1024
};
