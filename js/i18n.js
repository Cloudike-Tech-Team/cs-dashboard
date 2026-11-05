// 화면 언어(한국어·영어) 사전과 판정. DOM·supabase 에 의존하지 않아 `node --test js/i18n.test.js` 로 검증한다.
// 브라우저에서는 window.CSI18n 으로 노출된다. 키를 추가할 때는 ko·en 둘 다에 넣는다 (테스트가 검사).
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  root.CSI18n = lib;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const LANGS = ['ko', 'en'];

  // 저장된 선택(상단 버튼) 우선, 없으면 브라우저 첫 언어가 한국어면 ko, 그 외는 en
  function detectLang(stored, navLangs) {
    if (LANGS.includes(stored)) return stored;
    const first = String((navLangs || [])[0] || '').toLowerCase();
    return first.startsWith('ko') ? 'ko' : 'en';
  }

  const DICT = {
    ko: {
      nCount: '{n}건',
    },
    en: {
      nCount: '{n}',
    },
  };

  function t(lang, key, params) {
    const s = (DICT[lang] && DICT[lang][key]) ?? DICT.ko[key] ?? key;
    return params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s;
  }

  const WEEKDAY_KO = { Sun: '일', Mon: '월', Tue: '화', Wed: '수', Thu: '목', Fri: '금', Sat: '토' };
  function weekday(lang, enShort) { return lang === 'ko' ? WEEKDAY_KO[enShort] || enShort : enShort; }

  const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // 'YYYY-MM' 한 달의 건수 조각. sameYear 면 연도 생략
  function monthCount(lang, ym, sameYear, n) {
    const y = ym.slice(0, 4), m = Number(ym.slice(5, 7));
    if (lang === 'ko') return `${sameYear ? '' : `${y.slice(2)}년 `}${m}월 ${n}`;
    return `${MONTH_EN[m - 1]}${sameYear ? '' : ` ${y}`} ${n}`;
  }

  return { LANGS, DICT, detectLang, t, weekday, monthCount, MONTH_EN };
});
