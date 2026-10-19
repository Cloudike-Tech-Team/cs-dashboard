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
  function assigneeLine(row) {
    const a = row.assignee || '', t = row.ticket_assignee || '';
    const head = a ? `담당 ${a}` : '담당 미지정';
    return t && t !== a ? `${head} · 티켓 ${t}` : head;
  }

  function applyFilter(rows, filter, issues) {
    if (!filter) return rows;
    if (filter.type === 'device') return rows.filter((r) => r.device === filter.value);
    if (filter.type === 'assignee') return rows.filter((r) => (r.assignee || '') === filter.value);
    const issue = issues[filter.value];
    if (!issue) return rows;
    const ids = new Set(issue.ticket_ids || []);
    return rows.filter((r) => ids.has(r.id));
  }

  function matchesSearch(row, q) {
    const needle = (q || '').trim().toLowerCase();
    if (!needle) return true;
    return [row.title, row.reporter, row.customer, row.version, row.description, row.notes,
      statusLabel(row), row.assignee, row.ticket_assignee, ...(row.timeline || []), ...(row.tickets || [])]
      .some((v) => (v || '').toLowerCase().includes(needle));
  }

  return { STATUS, ISSUE_COLORS, statusLabel, statusColor, splitTimeline, kpi, issueCounts, applyFilter, matchesSearch, assigneeLine };
});
