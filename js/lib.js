// 프론트 순수 함수. DOM·supabase 에 의존하지 않아 `node --test js/lib.test.js` 로 검증한다.
// 브라우저에서는 window.CSLib 로 노출된다.
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  root.CSLib = lib;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // 순서가 곧 select 의 표시 순서. 키는 DB check 제약(schema.sql)과 Edge Function(lib.ts)의 Status 와 같아야 한다.
  const STATUS = {
    open:    { label: '처리 중',     color: '#B45309' },
    waiting: { label: '대기',        color: '#1D4ED8' },
    delayed: { label: '지연',        color: '#B91C1C' },
    deploy:  { label: '배포대기',    color: '#7C3AED' },
    done:    { label: '완료',        color: '#15803D' },
    unknown: { label: '원인 미확인', color: '#6B7280' },
  };
  const ISSUE_COLORS = ['#B45309', '#1D4ED8', '#0F766E', '#6B7280', '#7C3AED'];

  function statusDef(row) { return STATUS[row.status] || STATUS.open; }
  function statusLabel(row) { return row.status_note || statusDef(row).label; }
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
  function assigneeLine(row, yt) {
    const a = row.assignee || '', t = yt ? ticketAssignees(row, yt).names.join(', ') : row.ticket_assignee || '';
    const head = a ? `담당 ${a}` : '담당 미지정';
    return t && t !== a ? `${head} · 티켓 ${t}` : head;
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
  function ticketState(row, yt) {
    const found = ticketInfos(row, yt).filter((x) => x.yt && x.yt.state);
    if (!found.length) return null;
    const rep = found.find((x) => !x.yt.resolved) || found[0];
    return {
      label: found.length > 1 ? `${rep.yt.state} 외 ${found.length - 1}` : rep.yt.state,
      color: ytStateColor(rep.yt),
      title: found.map((x) => `${x.id} ${x.yt.state}`).join(' · '),
      allResolved: found.every((x) => x.yt.resolved),
    };
  }

  function applyFilter(rows, filter, issues) {
    if (!filter) return rows;
    if (filter.type === 'device') return rows.filter((r) => r.device === filter.value);
    if (filter.type === 'status') return rows.filter((r) => (STATUS[r.status] ? r.status : 'open') === filter.value);
    if (filter.type === 'assignee') return rows.filter((r) => (r.assignee || '') === filter.value);
    const issue = issues[filter.value];
    if (!issue) return rows;
    const ids = new Set(issue.ticket_ids || []);
    return rows.filter((r) => ids.has(r.id));
  }

  function matchesSearch(row, q, yt) {
    const needle = (q || '').trim().toLowerCase();
    if (!needle) return true;
    const ytText = ticketInfos(row, yt).flatMap((x) => (x.yt ? [x.yt.state, ...x.yt.assignees] : []));
    return [...ytText, row.title, row.reporter, row.customer, row.version, row.description, row.notes,
      statusLabel(row), row.assignee, row.ticket_assignee, ...(row.timeline || []), ...(row.tickets || [])]
      .some((v) => (v || '').toLowerCase().includes(needle));
  }

  return {
    STATUS, ISSUE_COLORS, statusLabel, statusColor, splitTimeline, kpi, issueCounts, applyFilter, matchesSearch, assigneeLine,
    ticketId, ticketIds, ticketInfos, ytStateColor, ticketAssignees, ticketState,
  };
});
