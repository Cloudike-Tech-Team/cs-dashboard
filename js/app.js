(() => {
  'use strict';

  const DEVICES = ['웹', 'CLDAstream Win', 'CLDAstream MAC', 'PC client Win', 'PC client MAC', 'Android', 'IOS', '기타'];
  const TZ = 'Asia/Seoul';       // 월 경계·표시·입력 모두 KST 기준으로 통일
  const TZ_OFFSET = '+09:00';    // KST 는 서머타임이 없어 고정 오프셋으로 충분
  const LS_REPORTER = 'cs.lastReporter';

  const cfg = window.CS_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  if (!window.supabase || !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('YOUR-PROJECT')) {
    document.body.innerHTML =
      '<p style="padding:24px">js/config.js 에 Supabase URL 과 anon key 를 입력하세요.</p>';
    return;
  }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  const state = {
    month: currentMonthKST(),  // 'YYYY-MM'
    rows: [],
    rowsMonth: null,           // state.rows 가 실제로 속한 월 (export 파일명용)
    loading: false,
    editing: null,             // 수정 중인 원본 row (신규면 null)
    busy: false,               // 저장/삭제 요청 진행 중 → 모달 닫기 차단
    loadSeq: 0,                // 빠른 월 이동 시 늦게 도착한 응답 무시용
    summary: null,             // 현재 월의 저장된 요약 행 (없으면 null)
    summaryBusy: false,        // 요약 생성 요청 진행 중
  };
  const PAGE = 1000;           // PostgREST 기본 max-rows

  // ───────────── 날짜 유틸 (KST) ─────────────
  function kstParts(date) {
    const p = {};
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
    }).formatToParts(date).forEach(({ type, value }) => { p[type] = value; });
    return p;
  }
  function currentMonthKST() {
    const p = kstParts(new Date());
    return `${p.year}-${p.month}`;
  }
  function shiftMonth(ym, delta) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  function monthRange(ym) {
    return {
      from: new Date(`${ym}-01T00:00:00${TZ_OFFSET}`).toISOString(),
      to: new Date(`${shiftMonth(ym, 1)}-01T00:00:00${TZ_OFFSET}`).toISOString(),
    };
  }
  const WEEKDAY_KO = { Sun: '일', Mon: '월', Tue: '화', Wed: '수', Thu: '목', Fri: '금', Sat: '토' };
  function fmtDateTime(iso) {
    const p = kstParts(new Date(iso));
    return `${p.year}-${p.month}-${p.day} (${WEEKDAY_KO[p.weekday] || p.weekday}) ${p.hour}:${p.minute}`;
  }
  function toLocalInput(iso) {      // ISO → datetime-local 값 (KST)
    const p = kstParts(new Date(iso));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }
  function fromLocalInput(v) {      // datetime-local 값(KST로 해석) → ISO
    const d = new Date(`${v}:00${TZ_OFFSET}`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // ───────────── 공통 UI ─────────────
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    });
    children.flat().forEach((c) => c != null && node.append(c));
    return node;
  }
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
  }
  function showError(node, msg) {
    node.textContent = msg || '';
    node.hidden = !msg;
  }
  function isSafeUrl(s) {
    try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:'; }
    catch { return false; }
  }

  // ───────────── 인증 ─────────────
  async function initAuth() {
    const { data: { session } } = await sb.auth.getSession();
    renderAuth(session);
    sb.auth.onAuthStateChange((_event, s) => renderAuth(s));
  }
  let signedInAs = null;
  function renderAuth(session) {
    const email = session?.user?.email || null;
    $('login-view').hidden = !!session;
    $('app-view').hidden = !session;
    if (email === signedInAs) return;
    signedInAs = email;
    if (session) {
      $('user-email').textContent = email || '';
      loadMonth();
    } else {
      state.rows = [];
      $('cs-tbody').replaceChildren();
    }
  }
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('login-error'), '');
    const btn = e.submitter || e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({
      email: $('login-email').value.trim(),
      password: $('login-password').value,
    });
    btn.disabled = false;
    if (error) showError($('login-error'), '로그인 실패: ' + error.message);
  });
  $('logout-btn').addEventListener('click', () => sb.auth.signOut());

  // ───────────── 조회 ─────────────
  async function loadMonth() {
    const seq = ++state.loadSeq;
    const month = state.month;
    $('month-input').value = month;
    showError($('list-error'), '');
    $('summary').textContent = '불러오는 중…';
    setLoading(true);

    const { data, error } = await fetchMonth(month);

    if (seq !== state.loadSeq) return;
    setLoading(false);
    if (error) {
      state.rows = [];
      showError($('list-error'), '불러오기 실패: ' + error.message);
    } else {
      state.rows = data;
    }
    state.rowsMonth = month;
    renderTable();
    renderStats();
    loadMonthChips();
    loadSummary(seq);
  }

  // 한 달에 1000건이 넘어도 잘리지 않도록 페이지 단위로 모두 가져옴
  async function fetchMonth(month) {
    const { from, to } = monthRange(month);
    const rows = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await sb
        .from('cs_tickets')
        .select('*')
        .gte('received_at', from)
        .lt('received_at', to)
        .order('received_at', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })   // 페이지 경계에서 순서가 흔들리지 않게
        .range(offset, offset + PAGE - 1);
      if (error) return { data: null, error };
      rows.push(...data);
      if (data.length < PAGE) return { data: rows, error: null };
    }
  }

  function setLoading(on) {
    state.loading = on;
    $('export-btn').disabled = on;
  }

  async function loadMonthChips() {
    const { data, error } = await sb
      .from('cs_monthly_counts')
      .select('month,count')
      .order('month', { ascending: false })
      .limit(12);
    const box = $('month-chips');
    if (error) { box.replaceChildren(); return; }
    box.replaceChildren(...data.map((r) => {
      const b = el('button', { type: 'button', class: 'chip' + (r.month === state.month ? ' active' : '') },
        `${r.month} `, el('b', { text: String(r.count) }));
      b.addEventListener('click', () => { state.month = r.month; loadMonth(); });
      return b;
    }));
  }

  function filteredRows() {
    const q = $('search-input').value.trim().toLowerCase();
    const dev = $('device-filter').value;
    return state.rows.filter((r) => {
      if (dev && r.device !== dev) return false;
      if (!q) return true;
      return [r.reporter, r.customer, r.version, r.description, r.notes, ...r.timeline, ...r.tickets]
        .some((v) => (v || '').toLowerCase().includes(q));
    });
  }

  function ticketNode(t) {
    return isSafeUrl(t)
      ? el('a', { href: t, target: '_blank', rel: 'noopener noreferrer', text: shortTicket(t) })
      : el('span', { text: t });
  }
  function shortTicket(t) {
    try { const u = new URL(t); return u.pathname.split('/').filter(Boolean).pop() || u.host; }
    catch { return t; }
  }

  function renderTable() {
    const rows = filteredRows();
    const tbody = $('cs-tbody');
    tbody.replaceChildren(...rows.map((r) => {
      const tr = el('tr', { tabindex: '0' },
        el('td', { class: 'nowrap', text: fmtDateTime(r.received_at) }),
        el('td', { text: r.customer }),
        el('td', { class: 'nowrap' }, el('span', { class: 'tag', text: r.device })),
        el('td', { text: r.version }),
        el('td', { class: 'desc-cell' }, el('div', { class: 'desc', text: r.description })),
        el('td', { class: 'nowrap', text: r.reporter }),
        el('td', {}, el('div', { class: 'tickets' }, r.tickets.map(ticketNode))),
      );
      tr.addEventListener('click', (e) => { if (!e.target.closest('a')) openDialog(r); });
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === tr) openDialog(r); });
      return tr;
    }));
    const total = state.rows.length;
    $('summary').textContent = rows.length === total
      ? `${state.month} · 총 ${total}건`
      : `${state.month} · ${rows.length}건 표시 (전체 ${total}건)`;
    $('empty').hidden = rows.length > 0 || !!$('list-error').textContent;
    if (total > 0 && rows.length === 0) $('empty').textContent = '검색 조건에 맞는 CS가 없습니다.';
    else $('empty').textContent = '이 달에 접수된 CS가 없습니다.';
  }

  // ───────────── 툴바 ─────────────
  $('prev-month').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); loadMonth(); });
  $('next-month').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); loadMonth(); });
  $('this-month').addEventListener('click', () => { state.month = currentMonthKST(); loadMonth(); });
  $('month-input').addEventListener('change', (e) => {
    if (/^\d{4}-\d{2}$/.test(e.target.value)) { state.month = e.target.value; loadMonth(); }
  });
  $('search-input').addEventListener('input', renderTable);
  $('device-filter').addEventListener('change', renderTable);
  $('export-btn').addEventListener('click', exportCsv);
  $('new-btn').addEventListener('click', () => openDialog(null));

  // ───────────── 등록/수정 폼 ─────────────
  const dialog = $('cs-dialog');
  const form = $('cs-form');

  function addListItem(name, value = '') {
    const list = form.querySelector(`[data-list="${name}"]`);
    const input = el('input', {
      type: 'text', maxlength: '2000',
      placeholder: name === 'timeline' ? '예) 10/12 14:00 로그 요청' : '티켓 번호 또는 URL',
    });
    input.value = value;
    const remove = el('button', { type: 'button', class: 'btn ghost small', 'aria-label': '항목 삭제', text: '−' });
    remove.addEventListener('click', () => row.remove());
    const row = el('div', { class: 'list-row' }, input, remove);
    list.append(row);
    return input;
  }
  form.querySelectorAll('[data-add]').forEach((b) =>
    b.addEventListener('click', () => addListItem(b.dataset.add).focus()));
  function listValues(name) {
    return [...form.querySelectorAll(`[data-list="${name}"] input`)]
      .map((i) => i.value.trim()).filter(Boolean);
  }

  function openDialog(row) {
    state.editing = row;
    form.reset();
    showError($('form-error'), '');
    setBusy(false);
    setDeleteConfirm(false);
    form.querySelectorAll('.list-items').forEach((l) => l.replaceChildren());

    $('dialog-title').textContent = row ? 'CS 수정' : '새 CS';
    $('delete-btn').hidden = !row;
    resetPasteBox(!row);
    const f = form.elements;
    if (row) {
      f.reporter.value = row.reporter;
      f.customer.value = row.customer;
      f.received_at.value = toLocalInput(row.received_at);
      f.device.value = row.device;
      f.version.value = row.version;
      f.description.value = row.description;
      f.notes.value = row.notes;
      row.timeline.forEach((v) => addListItem('timeline', v));
      row.tickets.forEach((v) => addListItem('tickets', v));
      $('form-meta').textContent =
        `등록 ${fmtDateTime(row.created_at)} · 최종 수정 ${fmtDateTime(row.updated_at)}`;
    } else {
      try { f.reporter.value = localStorage.getItem(LS_REPORTER) || ''; } catch { /* 저장소 차단 시 무시 */ }
      f.received_at.value = toLocalInput(new Date().toISOString());
      $('form-meta').textContent = '';
    }
    if (!listValues('timeline').length) addListItem('timeline');
    if (!listValues('tickets').length) addListItem('tickets');
    dialog.showModal();
  }
  dialog.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => { if (!state.busy) dialog.close(); }));
  // 저장/삭제 요청 중에는 Esc 로 닫히지 않게 (응답이 다른 CS 의 모달에 섞이는 것 방지)
  dialog.addEventListener('cancel', (e) => { if (state.busy) e.preventDefault(); });

  function setBusy(on) {
    state.busy = on;
    ['save-btn', 'delete-btn', 'delete-yes', 'delete-no'].forEach((id) => { $(id).disabled = on; });
    dialog.querySelectorAll('[data-close]').forEach((b) => { b.disabled = on; });
  }

  // 한 줄 입력칸에서 Enter 를 눌러도 저장되지 않게. 리스트 항목에서는 새 항목 추가.
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    const list = e.target.closest('[data-list]');
    if (list) addListItem(list.dataset.list).focus();
  });

  function readForm() {
    const f = form.elements;
    const payload = {
      reporter: f.reporter.value.trim(),
      customer: f.customer.value.trim(),
      received_at: fromLocalInput(f.received_at.value),
      device: f.device.value,
      version: f.version.value.trim(),
      description: f.description.value.trim(),
      notes: f.notes.value.trim(),
      timeline: listValues('timeline'),
      tickets: listValues('tickets'),
    };
    const missing = [];
    if (!payload.reporter) missing.push('접수자');
    if (!payload.customer) missing.push('고객사, 유저');
    if (!payload.received_at) missing.push('날짜');
    if (!DEVICES.includes(payload.device)) missing.push('기기');
    return { payload, missing };
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { payload, missing } = readForm();
    if (missing.length) { showError($('form-error'), `필수 항목: ${missing.join(', ')}`); return; }

    const target = state.editing;
    setBusy(true);
    showError($('form-error'), '');

    let res;
    if (target) {
      // 낙관적 잠금: 그 사이 다른 사람이 수정했다면 updated_at 이 달라 0건 갱신됨
      res = await sb.from('cs_tickets').update(payload)
        .eq('id', target.id)
        .eq('updated_at', target.updated_at)
        .select();
    } else {
      res = await sb.from('cs_tickets').insert(payload).select();
    }
    setBusy(false);
    if (res.error) { showError($('form-error'), '저장 실패: ' + res.error.message); return; }
    if (res.data.length === 0) { showError($('form-error'), CONFLICT_MSG); return; }

    try { localStorage.setItem(LS_REPORTER, payload.reporter); } catch { /* 무시 */ }
    dialog.close();
    toast(target ? '수정했습니다.' : '등록했습니다.');
    // 저장한 CS 가 있는 달로 이동
    state.month = toLocalInput(res.data[0].received_at).slice(0, 7);
    loadMonth();
  });
  const CONFLICT_MSG = '다른 사용자가 먼저 수정했거나 삭제된 CS입니다. 창을 닫고 목록을 다시 연 뒤 수정하세요.';

  function setDeleteConfirm(on) {
    $('delete-btn').hidden = on || !state.editing;
    $('delete-confirm').hidden = !on;
  }
  $('delete-btn').addEventListener('click', () => setDeleteConfirm(true));
  $('delete-no').addEventListener('click', () => setDeleteConfirm(false));
  $('delete-yes').addEventListener('click', async () => {
    const target = state.editing;
    setBusy(true);
    // 수정과 같은 낙관적 잠금: 다른 사람이 방금 고친 CS 를 모르고 지우지 않게
    const { data, error } = await sb.from('cs_tickets').delete()
      .eq('id', target.id)
      .eq('updated_at', target.updated_at)
      .select('id');
    setBusy(false);
    if (error) { showError($('form-error'), '삭제 실패: ' + error.message); return; }
    if (data.length === 0) { setDeleteConfirm(false); showError($('form-error'), CONFLICT_MSG); return; }
    dialog.close();
    toast('삭제했습니다.');
    loadMonth();
  });

  // ───────────── AI (Edge Function `ai`) ─────────────
  // 로그인 JWT 는 supabase-js 가 자동으로 붙임. 실패 시 함수가 돌려준 { error } 메시지를 그대로 사용.
  async function callAi(body) {
    const { data, error } = await sb.functions.invoke('ai', { body });
    if (!error) return data;
    let msg = error.message || '요청 실패';
    if (error.context && typeof error.context.json === 'function') {
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch { /* 본문 없음 */ }
    } else if (/Failed to send|fetch/i.test(msg)) {
      msg = 'AI 함수에 연결할 수 없습니다. Edge Function 이 배포되어 있는지 확인하세요.';
    }
    throw new Error(msg);
  }

  // ── 슬랙 메시지 붙여넣기 → 폼 채우기
  function resetPasteBox(show) {
    const box = $('paste-box');
    box.hidden = !show;
    box.open = false;
    $('paste-text').value = '';
    $('paste-status').textContent = '';
    showError($('paste-notes'), '');
    $('paste-btn').disabled = false;
  }
  // 모델이 준 received_at ('YYYY-MM-DDTHH:MM' | 'HH:MM' | null) → datetime-local 값. 날짜가 없으면 오늘(KST).
  function parsedDateToInput(v) {
    if (!v) return null;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return v;
    if (/^\d{2}:\d{2}$/.test(v)) return `${toLocalInput(new Date().toISOString()).slice(0, 10)}T${v}`;
    return null;
  }
  function applyParsed(p) {
    const f = form.elements;
    if (p.reporter) f.reporter.value = p.reporter;
    if (p.customer) f.customer.value = p.customer;
    const dt = parsedDateToInput(p.received_at);
    if (dt) f.received_at.value = dt;
    f.device.value = p.device && DEVICES.includes(p.device) ? p.device : '';
    f.version.value = p.version || '';
    f.description.value = p.description || '';
    f.notes.value = p.notes || '';
    const hints = [];
    if (!p.received_at) hints.push('날짜: 메시지에 없어 현재 시각 유지');
    else if (/^\d{2}:\d{2}$/.test(p.received_at)) hints.push('날짜: 메시지에 날짜가 없어 오늘로 설정');
    if (!p.device) hints.push('기기: 판단 불가, 직접 선택 필요');
    if (p.confidence_notes) hints.push(p.confidence_notes);
    showError($('paste-notes'), hints.length ? '검토 필요 · ' + hints.join(' / ') : '');
  }
  $('paste-btn').addEventListener('click', async () => {
    const text = $('paste-text').value.trim();
    if (!text) { $('paste-status').textContent = '붙여넣은 내용이 없습니다.'; return; }
    const btn = $('paste-btn');
    btn.disabled = true;
    $('paste-status').textContent = '분석 중… (몇 초 걸립니다)';
    showError($('paste-notes'), '');
    try {
      const { parsed } = await callAi({ mode: 'parse', text });
      applyParsed(parsed);
      $('paste-status').textContent = '채웠습니다. 내용을 확인한 뒤 저장하세요.';
      $('paste-box').open = false;
      form.elements.description.focus();
    } catch (e) {
      $('paste-status').textContent = '';
      showError($('paste-notes'), '분석 실패: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ── 월 통계 (state.rows 전체 기준, 검색 필터와 무관)
  function countBy(rows, key) {
    const m = new Map();
    rows.forEach((r) => { const k = r[key] || '(없음)'; m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'ko'));
  }
  function statGroup(title, pairs, limit) {
    const rows = pairs.slice(0, limit).map(([k, n]) =>
      el('div', { class: 'stat-row' }, el('span', { class: 'label', text: k }), el('b', { text: String(n) })));
    if (pairs.length > limit) rows.push(el('div', { class: 'stat-row muted' }, el('span', { text: `외 ${pairs.length - limit}개` })));
    return el('div', {}, el('h3', { text: title }), rows);
  }
  function renderStats() {
    const rows = state.rows;
    const body = $('stats-body');
    if (!rows.length) { body.replaceChildren(el('p', { class: 'muted', text: '이 달에 접수된 CS가 없습니다.' })); return; }
    body.replaceChildren(
      el('div', { class: 'total', text: `총 ${rows.length}건` }),
      statGroup('기기별', countBy(rows, 'device'), 8),
      statGroup('고객사 상위', countBy(rows, 'customer'), 5),
      statGroup('접수자별', countBy(rows, 'reporter'), 5),
    );
  }

  // ── 월간 요약
  async function loadSummary(seq) {
    renderSummary(null, '불러오는 중…');
    const { data, error } = await sb
      .from('cs_monthly_summaries').select('*').eq('month', state.month).maybeSingle();
    if (seq !== state.loadSeq) return;
    if (error) { renderSummary(null, ''); showError($('summary-error'), '요약 불러오기 실패: ' + error.message); return; }
    renderSummary(data, '');
  }
  function renderSummary(row, status) {
    state.summary = row;
    showError($('summary-error'), '');
    $('summary-content').replaceChildren(...(row ? markdownNodes(row.content) : []));
    $('summary-empty').hidden = !!row || !!status;
    $('summary-copy-btn').hidden = !row;
    $('summary-gen-btn').textContent = row ? '재생성' : '요약 생성';
    $('summary-gen-btn').disabled = state.summaryBusy;
    $('summary-meta').textContent = status || (row
      ? `${row.ticket_count}건 기준 · 생성 ${fmtDateTime(row.generated_at)}`
      : '');
  }
  $('summary-gen-btn').addEventListener('click', async () => {
    if (state.summaryBusy) return;
    if (state.loading || !state.rows.length) { toast('요약할 CS가 없습니다.'); return; }
    const month = state.month;
    const seq = state.loadSeq;
    state.summaryBusy = true;
    $('summary-gen-btn').disabled = true;
    $('summary-meta').textContent = `${month} CS ${state.rows.length}건을 읽고 요약을 작성하는 중… (최대 1분)`;
    showError($('summary-error'), '');
    try {
      const { summary } = await callAi({ mode: 'summarize', month });
      state.summaryBusy = false;
      if (seq !== state.loadSeq) return;     // 그 사이 월을 옮겼으면 화면에 반영하지 않음
      renderSummary(summary, '');
      toast('요약을 저장했습니다.');
    } catch (e) {
      state.summaryBusy = false;
      if (seq !== state.loadSeq) return;
      renderSummary(state.summary, '');
      showError($('summary-error'), '요약 생성 실패: ' + e.message);
    }
  });
  $('summary-copy-btn').addEventListener('click', async () => {
    if (!state.summary) return;
    try { await navigator.clipboard.writeText(state.summary.content); toast('마크다운을 복사했습니다.'); }
    catch { toast('복사에 실패했습니다. 브라우저 권한을 확인하세요.'); }
  });

  // 요약 마크다운의 제한된 부분집합(##, ###, -, 1., **굵게**)만 DOM 으로 변환. innerHTML 미사용.
  function inlineNodes(text) {
    return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part) =>
      part.startsWith('**') && part.endsWith('**') ? el('b', { text: part.slice(2, -2) }) : document.createTextNode(part));
  }
  function markdownNodes(md) {
    const out = [];
    let list = null;
    const flush = () => { list = null; };
    md.split('\n').forEach((raw) => {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { flush(); return; }
      if ((m = line.match(/^###\s+(.*)/))) { flush(); out.push(el('h4', {}, inlineNodes(m[1]))); return; }
      if ((m = line.match(/^##\s+(.*)/))) { flush(); out.push(el('h3', {}, inlineNodes(m[1]))); return; }
      if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
        if (!list || list.tagName !== 'UL') { list = el('ul'); out.push(list); }
        list.append(el('li', {}, inlineNodes(m[1]))); return;
      }
      if ((m = line.match(/^\s*\d+\.\s+(.*)/))) {
        if (!list || list.tagName !== 'OL') { list = el('ol'); out.push(list); }
        list.append(el('li', {}, inlineNodes(m[1]))); return;
      }
      flush();
      out.push(el('p', {}, inlineNodes(line)));
    });
    return out;
  }

  // ───────────── CSV 내보내기 (해당 월 전체) ─────────────
  function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // 엑셀 수식 인젝션 방지
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function exportCsv() {
    if (state.loading) return;
    if ($('list-error').textContent) { toast('목록을 불러오지 못해 내보낼 수 없습니다.'); return; }
    if (!state.rows.length) { toast('내보낼 CS가 없습니다.'); return; }
    const header = ['접수 일시', '접수자', '고객사/유저', '기기', '버전', '현상설명', '특이사항', '처리 타임라인', '티켓', '등록 일시', '최종 수정'];
    const lines = [header, ...state.rows.map((r) => [
      fmtDateTime(r.received_at), r.reporter, r.customer, r.device, r.version,
      r.description, r.notes, r.timeline.join('\n'), r.tickets.join('\n'),
      fmtDateTime(r.created_at), fmtDateTime(r.updated_at),
    ])].map((cols) => cols.map(csvCell).join(','));
    // BOM 을 붙여야 엑셀에서 한글이 깨지지 않음
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `CS_${state.rowsMonth}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ───────────── 초기화 ─────────────
  const devSelect = form.elements.device;
  devSelect.append(el('option', { value: '', text: '선택하세요' }));
  DEVICES.forEach((d) => {
    devSelect.append(el('option', { value: d, text: d }));
    $('device-filter').append(el('option', { value: d, text: d }));
  });
  initAuth();
})();
