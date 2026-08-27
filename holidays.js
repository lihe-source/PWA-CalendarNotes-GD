// Taiwan public-holiday labels used by the month view.
// 2026 (115) and 2027 (116) are based on the official DGPA work calendars.
// For other years, fixed-date statutory holidays are shown as a fallback;
// compensatory/lunar holidays should be updated after DGPA publishes that year's calendar.
const OFFICIAL = Object.freeze({
  // 2026
  '2026-01-01':'中華民國開國紀念日',
  '2026-02-15':'除夕前一日',
  '2026-02-16':'除夕',
  '2026-02-17':'春節',
  '2026-02-18':'春節',
  '2026-02-19':'春節',
  '2026-02-20':'春節補假',
  '2026-02-27':'和平紀念日補假',
  '2026-02-28':'和平紀念日',
  '2026-04-03':'兒童節補假',
  '2026-04-04':'兒童節',
  '2026-04-05':'清明節',
  '2026-04-06':'清明節補假',
  '2026-05-01':'勞動節',
  '2026-06-19':'端午節',
  '2026-09-25':'中秋節',
  '2026-09-28':'教師節',
  '2026-10-09':'國慶日補假',
  '2026-10-10':'國慶日',
  '2026-10-25':'臺灣光復暨金門古寧頭大捷紀念日',
  '2026-10-26':'光復紀念日補假',
  '2026-12-25':'行憲紀念日',

  // 2027
  '2027-01-01':'中華民國開國紀念日',
  '2027-02-04':'除夕前一日',
  '2027-02-05':'除夕',
  '2027-02-06':'春節',
  '2027-02-07':'春節',
  '2027-02-08':'春節',
  '2027-02-09':'春節補假',
  '2027-02-10':'春節補假',
  '2027-02-28':'和平紀念日',
  '2027-03-01':'和平紀念日補假',
  '2027-04-04':'兒童節',
  '2027-04-05':'清明節',
  '2027-04-06':'兒童節補假',
  '2027-04-30':'勞動節補假',
  '2027-05-01':'勞動節',
  '2027-06-09':'端午節',
  '2027-09-15':'中秋節',
  '2027-09-28':'教師節',
  '2027-10-10':'國慶日',
  '2027-10-11':'國慶日補假',
  '2027-10-25':'臺灣光復暨金門古寧頭大捷紀念日',
  '2027-12-24':'行憲紀念日補假',
  '2027-12-25':'行憲紀念日',
  '2027-12-31':'開國紀念日補假（117年）'
});

const FIXED = Object.freeze({
  '01-01':'中華民國開國紀念日',
  '02-28':'和平紀念日',
  '04-04':'兒童節',
  '05-01':'勞動節',
  '09-28':'教師節',
  '10-10':'國慶日',
  '10-25':'臺灣光復暨金門古寧頭大捷紀念日',
  '12-25':'行憲紀念日'
});

export const TAIWAN_HOLIDAY_OFFICIAL_YEARS = Object.freeze([2026, 2027]);

export function getTaiwanHoliday(dateOrKey){
  const key = typeof dateOrKey === 'string' ? dateOrKey : toKey(dateOrKey);
  if(OFFICIAL[key]) return {name:OFFICIAL[key], official:true};
  const year=Number(key.slice(0,4));
  if(TAIWAN_HOLIDAY_OFFICIAL_YEARS.includes(year)) return null;
  const fixed=FIXED[key.slice(5)];
  return fixed ? {name:fixed, official:false} : null;
}

function toKey(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
