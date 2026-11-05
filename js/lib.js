// 프론트 순수 함수. DOM·supabase 에 의존하지 않아 `node --test js/lib.test.js` 로 검증한다.
// 브라우저에서는 window.CSLib 로 노출된다.
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  root.CSLib = lib;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // 순서가 곧 select 의 표시 순서. 키는 DB check 제약(schema.sql)과 Edge Function(lib.ts)의 Status 와 같아야 한다.
  // label 은 한국어, en 은 영어 화면 라벨
  const STATUS = {
    open:    { label: '처리 중',     en: 'In progress',     color: '#B45309' },
    waiting: { label: '대기',        en: 'Waiting',         color: '#1D4ED8' },
    delayed: { label: '지연',        en: 'Delayed',         color: '#B91C1C' },
    deploy:  { label: '배포대기',    en: 'To deploy',       color: '#7C3AED' },
    done:    { label: '완료',        en: 'Done',            color: '#15803D' },
    unknown: { label: '원인 미확인', en: 'Unknown',         color: '#6B7280' },
  };
  // 심각도. 순서가 곧 select 표시 순서(가벼운 → 급한). 키는 DB check 제약(schema.sql)과 같아야 한다.
  // 보통은 기본값이라 목록에 배지를 달지 않는다.
  const SEVERITY = {
    normal:   { label: '보통',     en: 'Normal',   color: '#6B7280' },
    major:    { label: '중요',     en: 'Major',    color: '#EA580C' },   // 주황
    critical: { label: '크리티컬', en: 'Critical', color: '#DB2777' },   // 분홍
    hotfix:   { label: '핫픽스',   en: 'Hotfix',   color: '#DC2626' },   // 빨강
  };
  function severityKey(row) { return SEVERITY[row.severity] ? row.severity : 'normal'; }
  function severityDef(row) { return SEVERITY[severityKey(row)]; }
  function severityLabel(key, lang = 'ko') { const d = SEVERITY[key] || SEVERITY.normal; return lang === 'en' ? d.en : d.label; }

  // 기기 값(DB)은 그대로 두고 영어 화면에서만 이름을 바꾼다
  const DEVICE_EN = { '웹': 'Web', '기타': 'Other' };
  function deviceLabel(device, lang = 'ko') { return lang === 'en' ? DEVICE_EN[device] || device : device; }

  const ISSUE_COLORS = ['#B45309', '#1D4ED8', '#0F766E', '#6B7280', '#7C3AED'];

  function statusDef(row) { return STATUS[row.status] || STATUS.open; }
  // fields: 번역 표시용 칸(displayFields 결과). 있으면 그 상태 메모를 쓴다
  function statusLabel(row, lang = 'ko', fields) {
    const note = fields ? fields.status_note : row.status_note;
    return note || (lang === 'en' ? statusDef(row).en : statusDef(row).label);
  }
  function statusName(key, lang = 'ko') { const d = STATUS[key] || STATUS.open; return lang === 'en' ? d.en : d.label; }
  function statusColor(row) { return statusDef(row).color; }

  // 타임라인 문자열 앞의 "10/12", "10-12 14:00", "2026-10-12" 를 떼어 MM-DD 로. 버전 번호(3.19.61)는 '.' 이라 매칭 안 됨.
  const TL_RE = /^(?:\d{4}-)?(\d{1,2})[/-](\d{1,2})(?:\s+\d{1,2}:\d{2})?(?:\s+|$)/;
  function splitTimeline(entry) {
    const s = String(entry || '');
    const m = s.match(TL_RE);
    if (m) {
      const mo = Number(m[1]), d = Number(m[2]);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        return { when: `${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, text: s.slice(m[0].length) };
      }
    }
    return { when: '', text: s };
  }

  // 접수 후 경과일 (KST 날짜 기준이 아닌 24시간 단위, 0 이상)
  function daysSince(iso, now = Date.now()) {
    return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86400000));
  }

  // 밀린 미해결의 접수 월(KST)별 건수. 완료 건은 빼고 최근 월부터. [['2026-10', 5], ['2026-08', 1]]
  const KST_YM = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' });
  function monthKST(iso) { return KST_YM.format(new Date(iso)).slice(0, 7); }
  function carryMonths(rows) {
    const m = new Map();
    rows.filter((r) => r.status !== 'done').forEach((r) => { const k = monthKST(r.received_at); m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }

  // 전체 기간 검색 결과의 기간 묶음. 오늘 기준, 겹치지 않게: 이번 달(KST 달력) → 최근 30일 → 최근 1년 → 그 이전.
  const RECENCY = [
    { key: 'month', label: '이번 달', en: 'This month' },
    { key: 'd30', label: '최근 30일', en: 'Last 30 days' },
    { key: 'y1', label: '최근 1년', en: 'Last year' },
    { key: 'older', label: '1년 이상 전', en: 'Older' },
  ];
  function recencyLabel(key, lang = 'ko') { const g = RECENCY.find((x) => x.key === key); return g ? (lang === 'en' ? g.en : g.label) : key; }
  function recencyKey(iso, now = Date.now()) {
    if (monthKST(iso) === monthKST(new Date(now).toISOString())) return 'month';
    const days = daysSince(iso, now);
    if (days <= 30) return 'd30';
    if (days <= 365) return 'y1';
    return 'older';
  }
  // rows 순서를 유지한 채 묶음별로. 빈 묶음은 뺀다. [{ key, label, rows }]
  function groupByRecency(rows, now = Date.now()) {
    const by = new Map(RECENCY.map((g) => [g.key, []]));
    rows.forEach((r) => by.get(recencyKey(r.received_at, now)).push(r));
    return RECENCY.map((g) => ({ ...g, rows: by.get(g.key) })).filter((g) => g.rows.length);
  }

  function kpi(rows) {
    return {
      total: rows.length,
      open: rows.filter((r) => r.status !== 'done').length,
      done: rows.filter((r) => r.status === 'done').length,
      ticketed: rows.filter((r) => (r.tickets || []).length > 0).length,
    };
  }

  function issueCounts(issues, rows) {
    const ids = new Set(rows.map((r) => r.id));
    return issues.map((is) => ({ ...is, count: (is.ticket_ids || []).filter((id) => ids.has(id)).length }));
  }

  // "담당 오민식 · 티켓 김개발". 같은 사람이면 한 번만, 둘 다 비면 "담당 미지정".
  // yt 를 주면 티켓 담당은 YouTrack·Jira 값(없으면 수동 입력값).
  function assigneeLine(row, yt, lang = 'ko') {
    const a = row.assignee || '', t = yt ? ticketAssignees(row, yt).names.join(', ') : row.ticket_assignee || '';
    const en = lang === 'en';
    const head = a ? `${en ? 'Owner' : '담당'} ${a}` : (en ? 'Unassigned' : '담당 미지정');
    return t && t !== a ? `${head} · ${en ? 'Ticket' : '티켓'} ${t}` : head;
  }

  // ── 트래커 티켓 (Edge Function `tickets` 가 YouTrack·Jira 에서 읽어 돌려준 { 'NRF-1': { state, resolved, assignees, url } })
  // 티켓 칸의 URL·텍스트에서 첫 이슈 ID 를 뽑는다. https://yt.cloudike.io/issue/NRF-4817/slug → NRF-4817,
  // https://cloudike.atlassian.net/browse/CLDA-82 → CLDA-82
  const TICKET_ID_RE = /\b([A-Z][A-Z0-9_]*-\d+)\b/;
  function ticketId(t) {
    const m = String(t || '').match(TICKET_ID_RE);
    return m ? m[1] : '';
  }
  function ticketIds(rows) {
    return [...new Set(rows.flatMap((r) => (r.tickets || []).map(ticketId)).filter(Boolean))];
  }
  // [{ raw, id, yt }] — yt 는 트래커에 없거나 아직 못 읽었으면 null
  function ticketInfos(row, yt) {
    return (row.tickets || []).map((raw) => {
      const id = ticketId(raw);
      return { raw, id, yt: (id && yt && yt[id]) || null };
    });
  }

  // 해결(Done)=초록, 해결이지만 Rejected 류=회색, 막힘·반려=빨강, 테스트·리뷰=보라, 진행=주황, 그 외(To Do·Backlog·검토 예정)=파랑
  function ytStateColor(t) {
    const s = t.state || '';
    if (t.resolved) return /reject|반려|불가|won.?t|duplicate|obsolete/i.test(s) ? '#6B7280' : '#15803D';
    if (/block|hold|reject|반려|보류|추적 불가/i.test(s)) return '#B91C1C';
    if (/test|review|ready|테스트|검증/i.test(s)) return '#7C3AED';
    if (/progress|개발중|검토중|분석|진행/i.test(s)) return '#B45309';
    return '#1D4ED8';
  }

  // 티켓 담당: 트래커 담당자(중복 제거). 하나도 못 읽었으면 수동 입력값을 쓴다.
  function ticketAssignees(row, yt) {
    const found = ticketInfos(row, yt).filter((x) => x.yt);
    if (!found.length) return { names: row.ticket_assignee ? [row.ticket_assignee] : [], manual: !!row.ticket_assignee };
    return { names: [...new Set(found.flatMap((x) => x.yt.assignees))], manual: false };
  }

  // 목록용 티켓 상태 한 칸: 아직 안 끝난 첫 티켓의 상태. 모두 끝났으면 첫 티켓. 여러 개면 "외 n".
  function ticketState(row, yt, lang = 'ko') {
    const found = ticketInfos(row, yt).filter((x) => x.yt && x.yt.state);
    if (!found.length) return null;
    const rep = found.find((x) => !x.yt.resolved) || found[0];
    return {
      label: found.length > 1 ? `${rep.yt.state} ${lang === 'en' ? '+' : '외 '}${found.length - 1}` : rep.yt.state,
      color: ytStateColor(rep.yt),
      title: found.map((x) => `${x.id} ${x.yt.state}`).join(' · '),
      allResolved: found.every((x) => x.yt.resolved),
    };
  }

  function applyFilter(rows, filter, issues) {
    if (!filter) return rows;
    if (filter.type === 'device') return rows.filter((r) => r.device === filter.value);
    if (filter.type === 'status') return rows.filter((r) => (STATUS[r.status] ? r.status : 'open') === filter.value);
    if (filter.type === 'severity') return rows.filter((r) => severityKey(r) === filter.value);
    if (filter.type === 'assignee') return rows.filter((r) => (r.assignee || '') === filter.value);
    const issue = issues[filter.value];
    if (!issue) return rows;
    const ids = new Set(issue.ticket_ids || []);
    return rows.filter((r) => ids.has(r.id));
  }

  // extra: 현재 화면 언어의 번역 칸들 (원문과 함께 검색)
  function matchesSearch(row, q, yt, extra = []) {
    const needle = (q || '').trim().toLowerCase();
    if (!needle) return true;
    const ytText = ticketInfos(row, yt).flatMap((x) => (x.yt ? [x.yt.state, ...x.yt.assignees] : []));
    const sev = severityKey(row) === 'normal' ? [] : [severityDef(row).label, severityDef(row).en];
    return [...ytText, ...extra, row.title, row.reporter, row.customer, row.version, row.description, row.notes,
      statusLabel(row), statusDef(row).en, ...sev, row.assignee, row.ticket_assignee, ...(row.timeline || []), ...(row.tickets || [])]
      .some((v) => (v || '').toLowerCase().includes(needle));
  }

  // ── 번역 (원문 cs_tickets 는 그대로, 번역본은 cs_ticket_translations 에 { fields, source_hash })
  // 규칙을 바꾸면 supabase/functions/ai/lib.ts 의 sourceText 도 같이 바꾼다 (양쪽 테스트가 같은 해시를 검사)
  const TR_FIELDS = ['title', 'description', 'notes', 'status_note', 'timeline'];
  function sourceText(row) {
    return JSON.stringify([row.title || '', row.description || '', row.notes || '', row.status_note || '', row.timeline || []]);
  }
  // 캐시 { text, hash } 가 지금 원문과 같을 때만 해시를 돌려준다 (원문을 고친 뒤 오래된 번역이 최신처럼 보이지 않게)
  function cachedHash(entry, row) { return entry && entry.text === sourceText(row) ? entry.hash : null; }
  async function sourceHash(row) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceText(row)));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const HANGUL = /[\uAC00-\uD7A3\u3131-\u318E]/;
  function hasHangul(row) { return HANGUL.test(sourceText(row)); }
  function isBlank(row) { return !row.title && !row.description && !row.notes && !row.status_note && !(row.timeline || []).length; }
  // 원문이 이미 화면 언어인 기록 (한글이 있으면 한국어로, 없으면 영어로 쓴 것으로 본다)
  function isSourceLang(row, lang) { return lang === 'ko' ? hasHangul(row) : !hasHangul(row); }
  function needsTranslation(row, hash, trByLang, lang) {
    if (isBlank(row)) return false;
    if (isSourceLang(row, lang)) return false;   // 원문 언어 화면에서는 번역 불필요
    const tr = trByLang && trByLang[lang];
    return !tr || tr.source_hash !== hash;
  }
  // 화면에 보일 칸. 최신 번역(원문 해시 일치)만 쓰고, 없거나 오래됐으면 원문
  function displayFields(row, hash, trByLang, lang) {
    const orig = { title: row.title || '', description: row.description || '', notes: row.notes || '', status_note: row.status_note || '', timeline: row.timeline || [] };
    const tr = trByLang && trByLang[lang];
    // 원문 언어 화면에서는 모델이 다시 쓴 문장 대신 항상 원문
    if (!tr || tr.source_hash !== hash || !tr.fields || isSourceLang(row, lang)) return { ...orig, translated: false };
    const f = { ...orig, ...tr.fields, timeline: Array.isArray(tr.fields.timeline) ? tr.fields.timeline : orig.timeline };
    return { ...f, translated: JSON.stringify(TR_FIELDS.map((k) => f[k])) !== JSON.stringify(TR_FIELDS.map((k) => orig[k])) };
  }

  return {
    TR_FIELDS, sourceText, sourceHash, cachedHash, hasHangul, needsTranslation, displayFields,
    severityLabel, deviceLabel, statusName, recencyLabel,
    STATUS, SEVERITY, severityKey, severityDef, ISSUE_COLORS, daysSince, monthKST, carryMonths, recencyKey, groupByRecency, statusLabel, statusColor, splitTimeline, kpi, issueCounts, applyFilter, matchesSearch, assigneeLine,
    ticketId, ticketIds, ticketInfos, ytStateColor, ticketAssignees, ticketState,
  };
});
