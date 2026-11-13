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
    // 색은 뜻이 분명한 둘에만: 처리 중 파랑 · 완료 초록. 나머지는 회색 (빨강·주황은 심각도 전용)
    open:    { label: '처리 중',     en: 'In progress',     color: '#2563EB' },
    waiting: { label: '대기',        en: 'Waiting',         color: '#6B7280' },
    delayed: { label: '지연',        en: 'Delayed',         color: '#6B7280' },
    deploy:  { label: '배포대기',    en: 'To deploy',       color: '#6B7280' },
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
  // YouTrack Priority → 심각도. 티켓이 여러 개면 가장 급한 값. Priority 가 있는 티켓이 하나도 없으면 null
  const PRIORITY_SEVERITY = { 'hot fix': 'hotfix', hotfix: 'hotfix', critical: 'critical', major: 'major', normal: 'normal', minor: 'normal' };
  const SEVERITY_RANK = ['normal', 'major', 'critical', 'hotfix'];
  function ytSeverity(row, yt) {
    let best = null;
    for (const x of ticketInfos(row, yt)) {
      const key = x.yt && PRIORITY_SEVERITY[String(x.yt.priority || '').trim().toLowerCase()];
      if (!key) continue;
      if (!best || SEVERITY_RANK.indexOf(key) > SEVERITY_RANK.indexOf(best.key)) best = { key, ids: [x.id] };
      else if (key === best.key) best.ids.push(x.id);
    }
    return best;
  }
  // 화면에 보이는 심각도: YouTrack 값이 있으면 그것, 없으면 콘솔에서 고른 값
  function severityOf(row, yt) { const y = yt ? ytSeverity(row, yt) : null; return y ? y.key : severityKey(row); }
  function severityLabel(key, lang = 'ko') { const d = SEVERITY[key] || SEVERITY.normal; return lang === 'en' ? d.en : d.label; }

  // 기기 값(DB)은 그대로 두고 영어 화면에서만 이름을 바꾼다
  const DEVICE_EN = { '웹': 'Web', '기타': 'Other' };
  function deviceLabel(device, lang = 'ko') { return lang === 'en' ? DEVICE_EN[device] || device : device; }

  // 상태(파랑·초록) · 심각도(빨강·분홍·주황)와 겹치지 않는 색
  const ISSUE_COLORS = ['#0F766E', '#4338CA', '#A16207', '#475569', '#9333EA'];

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
  // ── 처리 현황 보기 · 정렬 (UX 1차)
  const OVERDUE_DAYS = 7;   // 이 날 이상 열려 있으면 「지연 N일째」
  // 이월: 이번 달(KST) 전에 접수됐고 아직 완료가 아닌 CS
  function isCarried(row, nowMonth) { return row.status !== 'done' && monthKST(row.received_at) < nowMonth; }
  // view: open(미해결 · 모든 달, 기본) | carry(이월) | done(완료) | all(전체)
  function viewRows(rows, view, nowMonth) {
    if (view === 'all') return rows;
    if (view === 'done') return rows.filter((r) => r.status === 'done');
    if (view === 'carry') return rows.filter((r) => isCarried(r, nowMonth));
    return rows.filter((r) => r.status !== 'done');
  }
  // 접수 월(KST)별 묶음. 이번 달은 비어 있어도 맨 위, 나머지는 최근 달부터. 묶음 안 순서는 그대로
  function groupByMonth(rows, nowMonth) {
    const by = new Map([[nowMonth, []]]);
    rows.forEach((r) => { const ym = monthKST(r.received_at); if (!by.has(ym)) by.set(ym, []); by.get(ym).push(r); });
    const rest = [...by.keys()].filter((ym) => ym !== nowMonth).sort().reverse();
    return [nowMonth, ...rest].map((ym) => ({ ym, rows: by.get(ym) }));
  }
  // 목록을 이번 달(KST) 접수와 그 전 접수로 나눈다. 순서는 그대로
  function splitByMonth(rows, nowMonth) {
    const current = [], before = [];
    rows.forEach((r) => (monthKST(r.received_at) === nowMonth ? current : before).push(r));
    return { current, before };
  }
  // sort: urgent(심각도 → 지연 상태 → 오래된 순) | oldest | recent. 원본 배열은 그대로
  function sortRows(rows, sort, yt) {
    const t = (r) => new Date(r.received_at).getTime();
    const cmp = {
      oldest: (a, b) => t(a) - t(b),
      recent: (a, b) => t(b) - t(a),
      urgent: (a, b) => SEVERITY_RANK.indexOf(severityOf(b, yt)) - SEVERITY_RANK.indexOf(severityOf(a, yt))
        || (b.status === 'delayed') - (a.status === 'delayed')
        || t(a) - t(b),
    }[sort] || ((a, b) => t(b) - t(a));
    return [...rows].sort(cmp);
  }
  // 완료 전 CS 의 경과: { days, overdue }. 완료면 null
  function ageInfo(row, now = Date.now()) {
    const days = ageDays(row, now);
    return days === null ? null : { days, overdue: days >= OVERDUE_DAYS };
  }
  // 버전은 v 없이 저장하고 표시할 때 한 번만 붙인다 (v2.1.6 → 2.1.6)
  function plainVersion(v) { const s = String(v || '').trim(); return /^v\d/i.test(s) ? s.slice(1) : s; }
  // 날짜 없이 쓴 처리 이력은 오늘(KST) 날짜를 앞에 붙인다
  const KST_MD = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit' });
  function datedEntry(entry, now = Date.now()) {
    const s = String(entry || '').trim();
    if (!s || splitTimeline(s).when) return s;
    const p = Object.fromEntries(KST_MD.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
    return `${p.month}/${p.day} ${s}`;
  }

  // ── UX 2차: 필터 겹쳐 걸기 · 행동 카드 · 상태 어긋남
  // filters: { severity: [], status: [], device: [], assignee: [], issue: [], age: ['overdue'] }
  // 종류 안에서는 하나라도 맞으면(OR), 종류끼리는 모두 맞아야(AND). 빈 배열 · 없는 종류는 통과
  function applyFilters(rows, filters, issues, yt, now = Date.now()) {
    const active = Object.entries(filters || {}).filter(([, vs]) => vs && vs.length);
    if (!active.length) return rows;
    return rows.filter((r) => active.every(([type, vs]) => vs.some((v) => (type === 'age'
      ? !!(ageInfo(r, now) || {}).overdue
      : applyFilter([r], { type, value: v }, issues, yt).length > 0))));
  }
  // 위쪽 행동 카드 4장: 늘 전체 미해결 기준
  function actionCounts(rows, yt, now = Date.now()) {
    const open = rows.filter((r) => r.status !== 'done');
    return {
      open: open.length,
      urgent: open.filter((r) => ['hotfix', 'critical'].includes(severityOf(r, yt))).length,
      overdue: open.filter((r) => ageInfo(r, now).overdue).length,
      unassigned: open.filter((r) => !r.assignee).length,
    };
  }
  // CS 상태와 티켓 상태가 어긋난 건: 트래커에서 읽은 티켓이 모두 끝났는데 CS 미완료 → 'ticketDone',
  // CS 는 완료인데 아직 안 끝난 티켓이 있으면 → 'ticketOpen'. 읽은 티켓이 없으면 판단하지 않음(null)
  function mismatch(row, yt) {
    const found = ticketInfos(row, yt).filter((x) => x.yt);
    if (!found.length) return null;
    const allDone = found.every((x) => x.yt.resolved);
    if (allDone && row.status !== 'done') return 'ticketDone';
    if (!allDone && row.status === 'done') return 'ticketOpen';
    return null;
  }
  // 필터 메뉴의 값과 건수. 심각도는 급한 순, 상태는 정해진 순, 나머지는 많은 순(담당 미지정은 맨 끝)
  function filterOptions(rows, type, issues, yt) {
    const count = (v) => applyFilter(rows, { type, value: v }, issues, yt).length;
    if (type === 'severity') return [...SEVERITY_RANK].reverse().map((k) => [k, count(k)]);
    if (type === 'status') return Object.keys(STATUS).map((k) => [k, count(k)]);
    if (type === 'issue') return (issues || []).map((_, i) => [i, count(i)]);
    const key = type === 'assignee' ? (r) => r.assignee || '' : (r) => r[type] || '';
    const m = new Map();
    rows.forEach((r) => m.set(key(r), (m.get(key(r)) || 0) + 1));
    return [...m.entries()].sort((a, b) => (a[0] === '') - (b[0] === '') || b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'ko'));
  }

  // 목록 · 상세의 D+N. 완료된 CS 는 경과일을 보이지 않는다(null)
  function ageDays(row, now = Date.now()) {
    return row.status === 'done' ? null : daysSince(row.received_at, now);
  }

  // 밀린 미해결의 접수 월(KST)별 건수. 완료 건은 빼고 최근 월부터. [['2026-10', 5], ['2026-08', 1]]
  const KST_YM = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' });
  function monthKST(iso) { return KST_YM.format(new Date(iso)).slice(0, 7); }
  function carryMonths(rows) {
    const m = new Map();
    rows.filter((r) => r.status !== 'done').forEach((r) => { const k = monthKST(r.received_at); m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }

  // 월별 접수 · 처리 그래프: endYm 까지 n 달(오래된 달부터, 0건 달도 포함).
  // 완료일은 따로 저장하지 않으므로 「그 달 접수한 CS 중 지금 완료된 건」을 처리로 센다. [{ ym, received, done }]
  function monthlyFlow(rows, endYm, n = 12) {
    const [y, m] = endYm.split('-').map(Number);
    const months = Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.UTC(y, m - n + i, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    });
    const by = new Map(months.map((ym) => [ym, { ym, received: 0, done: 0 }]));
    rows.forEach((r) => {
      const b = by.get(monthKST(r.received_at));
      if (!b) return;
      b.received++;
      if (r.status === 'done') b.done++;
    });
    return months.map((ym) => by.get(ym));
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

  // 상태와 같은 규칙: 해결(Done)=초록, 진행·테스트·리뷰=파랑, 그 외(반려·막힘·대기)=회색
  function ytStateColor(t) {
    const s = t.state || '';
    if (t.resolved) return /reject|반려|불가|won.?t|duplicate|obsolete/i.test(s) ? '#6B7280' : '#15803D';
    if (/block|hold|reject|반려|보류|추적 불가/i.test(s)) return '#6B7280';
    if (/progress|test|review|ready|테스트|검증|개발중|검토중|분석|진행/i.test(s)) return '#2563EB';
    return '#6B7280';
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

  function applyFilter(rows, filter, issues, yt) {
    if (!filter) return rows;
    if (filter.type === 'device') return rows.filter((r) => r.device === filter.value);
    if (filter.type === 'status') return rows.filter((r) => (STATUS[r.status] ? r.status : 'open') === filter.value);
    if (filter.type === 'severity') return rows.filter((r) => severityOf(r, yt) === filter.value);
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
    const sk = severityOf(row, yt);
    const sev = sk === 'normal' ? [] : [SEVERITY[sk].label, SEVERITY[sk].en];
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
  // 칸 · 이력 한 줄의 언어: 한글이 있으면 ko, 영문자만 있으면 en, 둘 다 없으면(번호 · 날짜뿐) null.
  // 이력은 「MM/DD 작성자: 내용」이라 날짜와 작성자를 떼고 내용만 본다 (한국 이름 때문에 영어 이력이 한국어로 잡히지 않게)
  // 규칙을 바꾸면 supabase/functions/ai/lib.ts 의 partLang 도 같이 바꾼다
  function partLang(text, isTimeline = false) {
    let s = String(text || '');
    if (isTimeline) {
      s = splitTimeline(s).text;
      const m = s.match(/^\s*[^:：\n]{1,30}[:：]\s*(\S[\s\S]*)$/);
      if (m) s = m[1];
    }
    if (HANGUL.test(s)) return 'ko';
    return /[A-Za-z]/.test(s) ? 'en' : null;
  }
  // 칸마다 [원문, 이력 줄인지]
  function trParts(row) {
    return [...['title', 'description', 'notes', 'status_note'].map((k) => [row[k] || '', false]), ...(row.timeline || []).map((x) => [x, true])];
  }
  // 원문이 모두 화면 언어인 기록. 한국어 CS 에 영어 이력이 섞이면 어느 화면에서도 아님 (섞인 줄만 번역해서 보인다)
  function isSourceLang(row, lang) { return trParts(row).every(([x, tl]) => { const l = partLang(x, tl); return !l || l === lang; }); }
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
    // 칸 · 이력 줄마다: 이미 화면 언어로 쓴 것은 원문 그대로, 다른 언어로 쓴 것만 번역
    const pick = (o, v, tl) => { const l = partLang(o, tl); return !l || l === lang || typeof v !== 'string' ? o : v; };
    const f = { ...orig };
    ['title', 'description', 'notes', 'status_note'].forEach((k) => { f[k] = pick(orig[k], tr.fields[k], false); });
    const ttl = Array.isArray(tr.fields.timeline) && tr.fields.timeline.length === orig.timeline.length ? tr.fields.timeline : null;
    f.timeline = orig.timeline.map((x, i) => (ttl ? pick(x, ttl[i], true) : x));
    return { ...f, translated: JSON.stringify(TR_FIELDS.map((k) => f[k])) !== JSON.stringify(TR_FIELDS.map((k) => orig[k])) };
  }

  // 기존 기록 번역 한 번 호출 뒤 다음 할 일. 남은 건이 없으면 완료(화면의 자동 번역이 먼저 끝냈어도),
  // 남았는데 한 건도 못 했을 때만 멈춘다 (같은 실패를 무한 반복하지 않게)
  function backfillStep(translated, remaining) {
    if (remaining <= 0) return 'done';
    return translated > 0 ? 'continue' : 'stuck';
  }

  // 목록 끌기: centers 는 원래 순서의 줄 중심(y), idx 는 끄는 줄. 끄는 줄 중심이 y 일 때 놓일 순서
  function dragTarget(centers, idx, y) {
    return centers.filter((c, j) => j !== idx && c < y).length;
  }
  // 다른 줄 j 가 비켜 갈 방향: -1 위로, +1 아래로, 0 그대로
  function dragShift(j, idx, target) {
    if (j === idx) return 0;
    if (idx < target && j > idx && j <= target) return -1;
    if (target < idx && j >= target && j < idx) return 1;
    return 0;
  }

  // 팝업 i 번째의 처음 위치: 계단식으로 32px 씩 비켜 열고(8개마다 처음 자리), 화면 밖으로 나가지 않게 (여백 16)
  function popupPlace(i, vw, vh, w, h) {
    const k = i % 8;
    const clamp = (v, max) => Math.max(16, Math.min(v, max));
    return { x: clamp(120 + k * 32, vw - w - 16), y: clamp(90 + k * 32, vh - h - 16) };
  }

  // 팝업 크게 보기: 화면 가운데, 폭 최대 760 · 높이 화면의 85% (여백 16)
  function popupBig(vw, vh) {
    const w = Math.min(760, vw - 32), h = Math.min(Math.round(vh * 0.85), vh - 32);
    return { x: Math.round((vw - w) / 2), y: Math.round((vh - h) / 2), w, h };
  }

  return {
    popupPlace, popupBig, applyFilters, actionCounts, splitByMonth, groupByMonth, mismatch, filterOptions, OVERDUE_DAYS, isCarried, viewRows, sortRows, ageInfo, plainVersion, datedEntry,
    dragTarget, dragShift, ytSeverity, severityOf,
    backfillStep,
    TR_FIELDS, sourceText, sourceHash, cachedHash, hasHangul, partLang, isSourceLang, needsTranslation, displayFields,
    severityLabel, deviceLabel, statusName, recencyLabel,
    STATUS, SEVERITY, severityKey, severityDef, ISSUE_COLORS, daysSince, ageDays, monthKST, carryMonths, monthlyFlow, recencyKey, groupByRecency, statusLabel, statusColor, splitTimeline, kpi, issueCounts, applyFilter, matchesSearch, assigneeLine,
    ticketId, ticketIds, ticketInfos, ytStateColor, ticketAssignees, ticketState,
  };
});
