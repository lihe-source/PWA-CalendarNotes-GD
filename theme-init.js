// Applies the saved theme before first paint (kept external so the page CSP can forbid inline scripts).
try{document.documentElement.dataset.theme=localStorage.getItem('calendarNotesTheme')||'dark';document.documentElement.dataset.uiStyle=localStorage.getItem('calendarNotesUiStyleV2')||'mint'}catch{}
