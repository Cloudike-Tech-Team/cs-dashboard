(() => {
  'use strict';

  const DEVICES = ['웹', 'CLDAstream Win', 'CLDAstream MAC', 'PC client Win', 'PC client MAC', 'Android', 'IOS', '기타'];
  const TZ = 'Asia/Seoul';       // 월 경계·표시·입력 모두 KST 기준으로 통일
  const TZ_OFFSET = '+09:00';    // KST 는 서머타임이 없어 고정 오프셋으로 충분
  const LS_REPORTER = 'cs.lastReporter';
  const L = window.CSLib;

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
    busy: false,               // 저장/삭제/빠른 조작 요청 진행 중
    loadSeq: 0,                // 빠른 월 이동 시 늦게 도착한 응답 무시용
    summary: null,             // 현재 월의 저장된 요약 행 (없으면 null)
    summaryBusy: false,        // 요약 생성 요청 진행 중
    summaryBusyMonth: null,    // 생성 중인 월 ('YYYY-MM'). 다른 달을 보고 있으면 "생성 중" 을 표시하지 않음
    filter: null,              // null | { type: 'issue'|'device'|'assignee'|'status', value }
    selected: null,            // 상세 패널에 열린 row id
    quick: null,               // 상세 패널의 인라인 폼: null | 'status' | 'history'
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
      state.selected = null;
      state.filter = null;
      $('cs-list').replaceChildren();
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
  async function loadMonth(opts = {}) {
    const seq = ++state.loadSeq;
    const month = state.month;
    $('month-label').textContent = month;
    showError($('list-error'), '');
    $('list-title').textContent = '불러오는 중…';
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
    state.filter = null;
    state.quick = null;
    state.selected = opts.selected && state.rows.some((r) => r.id === opts.selected) ? opts.selected : null;
    renderAll();
    loadSummary(seq);
  }

  function renderAll() {
    renderKpi();
    renderSidebar();
    renderList();
    renderDetail();
    renderNameList();
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

  function filteredRows() {
    const q = $('search-input').value;
    const issues = state.summary ? state.summary.issues || [] : [];
    return L.applyFilter(state.rows, state.filter, issues).filter((r) => L.matchesSearch(r, q));
  }

  function deviceLine(r) { return r.version ? `${r.device} · v${r.version}` : r.device; }

  function shortTicket(t) {
    try { const u = new URL(t); return u.pathname.split('/').filter(Boolean).pop() || u.host; }
    catch { return t; }
  }
  // 목록용(버튼 안이라 링크 불가) / 상세용(링크)
  function ticketChip(t) { return el('span', { class: 'chip', text: shortTicket(t) }); }
  function ticketNode(t) {
    return isSafeUrl(t)
      ? el('a', { class: 'chip', href: t, target: '_blank', rel: 'noopener noreferrer', text: shortTicket(t) })
      : el('span', { class: 'chip', text: t });
  }

  function filterName() {
    const f = state.filter;
    if (!f) return '';
    if (f.type === 'device') return f.value;
    if (f.type === 'status') return L.STATUS[f.value] ? L.STATUS[f.value].label : f.value;
    if (f.type === 'assignee') return f.value ? `담당 ${f.value}` : '담당 미지정';
    const issue = (state.summary && state.summary.issues || [])[f.value];
    return issue ? issue.label : '';
  }

  function initial(name) { return (name || '').trim().slice(0, 1) || '–'; }

  // 한 줄 행: 날짜 | 고객사 | 제목(유일한 강조) | 기기 | 담당 이니셜 | 상태. 시각·유저 ID·티켓은 상세에서.
  function rowNode(r) {
    const p = kstParts(new Date(r.received_at));
    const b = el('button', { type: 'button', class: 'cs-row' + (state.selected === r.id ? ' active' : '') },
      el('span', { class: 'col-when mono', text: `${p.month}-${p.day}`, title: `${p.hour}:${p.minute} (${WEEKDAY_KO[p.weekday] || p.weekday})` }),
      el('span', { class: 'col-who mono', text: r.customer, title: r.customer }),
      el('span', { class: 'col-what' },
        el('span', { class: 'row-title', text: r.title || '(제목 없음)' }),
        r.tickets.length ? el('span', { class: 'row-ticket mono muted', text: `T${r.tickets.length}`, title: `티켓 ${r.tickets.length}개` }) : null),
      el('span', { class: 'col-device muted', text: deviceLine(r), title: deviceLine(r) }),
      el('span', { class: 'col-asg' + (r.assignee ? '' : ' none'), text: initial(r.assignee), title: L.assigneeLine(r) }),
      // 목록에는 기본 상태만. 상태 메모(긴 설명)는 상세에서 보여 준다
      el('span', { class: 'col-status', title: r.status_note || '' }, el('span', { class: 'dot' }), el('span', { text: L.STATUS[r.status] ? L.STATUS[r.status].label : L.statusLabel(r) })),
    );
    b.style.setProperty('--c', L.statusColor(r));
    b.addEventListener('click', () => selectRow(r.id));
    return b;
  }

  function renderList() {
    const rows = filteredRows();
    $('cs-list').replaceChildren(...rows.map(rowNode));
    const total = state.rows.length;
    const name = filterName();
    $('list-title').textContent = state.filter
      ? `${name} · ${rows.length}건 / 전체 ${total}건`
      : (rows.length === total ? `${state.month} 접수 · ${total}건` : `${state.month} 검색 · ${rows.length}건 / 전체 ${total}건`);
    const err = !!$('list-error').textContent;
    $('empty').hidden = rows.length > 0 || err;
    $('empty').textContent = total > 0 ? '해당 조건의 접수 건이 없습니다.' : '이 달에 접수된 CS가 없습니다.';
  }

  function selectRow(id) {
    state.selected = state.selected === id ? null : id;
    state.quick = null;
    renderList();
    renderDetail();
    // 세로로 쌓이는 폭에서는 상세가 목록 아래에 있어 눈에 띄지 않으므로 스크롤해 준다
    if (state.selected && window.matchMedia('(max-width: 1000px)').matches) $('detail').scrollIntoView({ block: 'start' });
  }

  // ───────────── 상세 패널 ─────────────
  function selectedRow() { return state.rows.find((x) => x.id === state.selected) || null; }

  function renderDetail() {
    const r = selectedRow();
    $('detail').hidden = !r;
    if (!r) return;
    $('detail-when').textContent = fmtDateTime(r.received_at);
    $('detail-status').textContent = L.statusLabel(r);
    $('detail-status').style.setProperty('--c', L.statusColor(r));
    $('detail-title').textContent = r.title || '(제목 없음)';
    $('detail-customer').textContent = r.customer;
    $('detail-device').textContent = deviceLine(r);
    $('detail-received').textContent = fmtDateTime(r.received_at);
    $('detail-reporter').textContent = r.reporter;
    $('detail-assignee').textContent = r.assignee || '미지정';
    $('detail-assignee').className = r.assignee ? '' : 'muted';
    $('detail-ticket-assignee').textContent = r.ticket_assignee || (r.tickets.length ? '미지정' : '—');
    $('detail-ticket-assignee').className = r.ticket_assignee ? '' : 'muted';
    $('detail-tickets').replaceChildren(...(r.tickets.length ? r.tickets.map(ticketNode) : [el('span', { class: 'muted small', text: '없음' })]));
    $('detail-desc').textContent = r.description || '—';
    $('detail-history').replaceChildren(...(r.timeline.length
      ? r.timeline.map((t) => {
          const { when, text } = L.splitTimeline(t);
          return el('li', {}, el('span', { class: 'mono muted', text: when }), el('span', { class: 'hist-dot' }), el('span', { text }));
        })
      : [el('li', { class: 'muted', text: '이력 없음' })]));
    showError($('detail-error'), '');
    renderQuick(r);
  }

  function renderQuick(r) {
    const box = $('quick-box');
    box.replaceChildren();
    ['status-btn', 'history-btn', 'assignee-btn', 'edit-btn'].forEach((id) => { $(id).disabled = !!state.quick || state.busy; });
    if (state.quick === 'status') {
      const sel = el('select', { 'aria-label': '상태' },
        Object.entries(L.STATUS).map(([k, v]) => el('option', { value: k, text: v.label })));
      sel.value = r.status;
      const note = el('input', { type: 'text', maxlength: '50', placeholder: '상태 메모 (예: 로그 대기)' });
      note.value = r.status_note;
      // 상태를 바꾸면 이전 상태의 메모("로그 대기")가 새 상태의 라벨로 남지 않게 비운다
      sel.addEventListener('change', () => { note.value = sel.value === r.status ? r.status_note : ''; });
      const submit = () => saveQuick(r, { status: sel.value, status_note: note.value.trim() });
      note.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
      box.append(el('div', { class: 'quick-form' }, sel, note, quickButtons(submit)));
      sel.focus();
    } else if (state.quick === 'history') {
      const input = el('input', { type: 'text', maxlength: '2000', placeholder: '처리 내용' });
      const p = kstParts(new Date());
      input.value = `${p.month}/${p.day} `;
      const submit = () => {
        const t = input.value.trim();
        if (!t || /^\d{1,2}\/\d{1,2}$/.test(t)) { showError($('detail-error'), '처리 내용을 입력하세요.'); input.focus(); return; }
        saveQuick(r, { timeline: [...r.timeline, t] });
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
      box.append(el('div', { class: 'quick-form' }, input, quickButtons(submit)));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (state.quick === 'assignee') {
      const a = el('input', { type: 'text', maxlength: '100', list: 'assignee-names', placeholder: '담당자 (개발팀)' });
      a.value = r.assignee || '';
      const t = el('input', { type: 'text', maxlength: '100', list: 'assignee-names', placeholder: '티켓 담당 (비우면 담당자와 같음)' });
      t.value = r.ticket_assignee || '';
      const submit = () => saveQuick(r, { assignee: a.value.trim(), ticket_assignee: t.value.trim() });
      [a, t].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } }));
      box.append(el('div', { class: 'quick-form' }, a, t, quickButtons(submit)));
      a.focus();
    }
  }

  function quickButtons(onSave) {
    const save = el('button', { type: 'button', class: 'btn primary small', text: '저장' });
    save.addEventListener('click', onSave);
    const cancel = el('button', { type: 'button', class: 'btn small', text: '취소' });
    cancel.addEventListener('click', () => { state.quick = null; renderDetail(); });
    return el('div', { class: 'quick-actions' }, save, cancel);
  }

  // 상세 패널에서 한 필드만 고치는 저장. 수정 모달과 같은 낙관적 잠금.
  async function saveQuick(r, patch) {
    if (state.busy) return;
    state.busy = true;
    showError($('detail-error'), '');
    const controls = [...$('quick-box').querySelectorAll('button, input, select')];
    controls.forEach((n) => { n.disabled = true; });
    const { data, error } = await sb.from('cs_tickets').update(patch)
      .eq('id', r.id)
      .eq('updated_at', r.updated_at)
      .select();
    state.busy = false;
    if (error || data.length === 0) {
      controls.forEach((n) => { n.disabled = false; });
      showError($('detail-error'), error ? '저장 실패: ' + error.message : CONFLICT_MSG);
      return;
    }
    const idx = state.rows.findIndex((x) => x.id === r.id);
    if (idx >= 0) state.rows[idx] = data[0];
    state.quick = null;
    toast('저장했습니다.');
    rememberNames([data[0].assignee, data[0].ticket_assignee]);
    renderAll();
  }

  $('status-btn').addEventListener('click', () => { state.quick = 'status'; renderDetail(); });
  $('history-btn').addEventListener('click', () => { state.quick = 'history'; renderDetail(); });
  $('assignee-btn').addEventListener('click', () => { state.quick = 'assignee'; renderDetail(); });
  $('edit-btn').addEventListener('click', () => { const r = selectedRow(); if (r) openDialog(r); });
  $('detail-close').addEventListener('click', () => { state.selected = null; state.quick = null; renderList(); renderDetail(); });

  // ───────────── KPI · 사이드바 ─────────────
  function renderKpi() {
    const k = L.kpi(state.rows);
    $('kpi-total').textContent = String(k.total);
    $('kpi-open').textContent = String(k.open);
    $('kpi-open-sub').textContent = k.total ? `전체의 ${Math.round((k.open / k.total) * 100)}%` : '';
    $('kpi-ticketed').textContent = String(k.ticketed);
    $('kpi-ticketed-of').textContent = `/ ${k.total}`;
    $('kpi-ticketed-sub').textContent = k.total ? `${k.total - k.ticketed}건은 티켓 없음` : '';
    $('kpi-ticketed-bar').style.width = k.total ? `${Math.round((k.ticketed / k.total) * 100)}%` : '0%';

    // 상태별 도넛 + 범례(누르면 상태 필터). 0건인 상태는 그리지 않는다
    const C = 2 * Math.PI * 15.5;
    const counts = Object.keys(L.STATUS).map((key) => [key, state.rows.filter((r) => (L.STATUS[r.status] ? r.status : 'open') === key).length]).filter(([, n]) => n > 0);
    const statusFilter = state.filter && state.filter.type === 'status' ? state.filter.value : null;
    const svgNS = 'http://www.w3.org/2000/svg';
    let offset = 0;
    const segs = counts.map(([key, n]) => {
      const len = (n / k.total) * C;
      const c = document.createElementNS(svgNS, 'circle');
      c.setAttribute('class', 'ring-seg' + (statusFilter && statusFilter !== key ? ' dim' : ''));
      c.setAttribute('cx', '18'); c.setAttribute('cy', '18'); c.setAttribute('r', '15.5');
      c.setAttribute('stroke', L.STATUS[key].color);
      c.setAttribute('stroke-dasharray', `${Math.max(len - 0.6, 0)} ${C - Math.max(len - 0.6, 0)}`);   // 조각 사이 틈
      c.setAttribute('stroke-dashoffset', String(-offset));
      offset += len;
      return c;
    });
    $('kpi-ring-segs').replaceChildren(...segs);
    $('kpi-legend').replaceChildren(...counts.map(([key, n]) => {
      const b = el('button', { type: 'button', class: 'legend-btn' + (isActive('status', key) ? ' active' : '') },
        el('span', { class: 'dot' }), el('span', { text: L.STATUS[key].label }), el('b', { text: String(n) }));
      b.style.setProperty('--c', L.STATUS[key].color);
      b.addEventListener('click', () => toggleFilter('status', key));
      return b;
    }));
  }

  function isActive(type, value) { return !!state.filter && state.filter.type === type && state.filter.value === value; }
  function toggleFilter(type, value) {
    state.filter = isActive(type, value) ? null : { type, value };
    renderKpi();
    renderSidebar();
    renderList();
  }

  function countBy(rows, key) {
    const m = new Map();
    rows.forEach((r) => { const k = r[key] || '(없음)'; m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'ko'));
  }

  function fmtShort(iso) {
    const p = kstParts(new Date(iso));
    return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }

  function renderSidebar() {
    const s = state.summary;
    // 헤더
    const busyHere = state.summaryBusy && state.summaryBusyMonth === state.month;
    $('summary-meta').textContent = busyHere ? '생성 중… (최대 1분)' : s ? `생성 ${fmtShort(s.generated_at)} · ${s.ticket_count}건 기준` : '아직 생성된 요약이 없습니다';
    $('summary-copy-btn').hidden = !s;
    $('summary-gen-btn').textContent = s ? '재생성' : '생성';
    $('summary-gen-btn').disabled = state.summaryBusy || state.loading;
    $('filter-clear').hidden = !state.filter;

    // 주요 이슈
    const issueBox = $('issue-list');
    const issues = L.issueCounts(s ? s.issues || [] : [], state.rows);
    if (!s) issueBox.replaceChildren(el('p', { class: 'side-empty', text: '요약을 생성하면 주요 이슈가 표시됩니다.' }));
    else if (!issues.length) issueBox.replaceChildren(el('p', { class: 'side-empty', text: '이전 형식의 요약입니다. 재생성하면 주요 이슈가 표시됩니다.' }));
    else issueBox.replaceChildren(...issues.map((is, i) => {
      // 라벨 + 건수만. 설명은 툴팁으로 내려 사이드바를 짧게 유지한다
      const b = el('button', { type: 'button', class: 'issue-btn' + (isActive('issue', i) ? ' active' : ''), title: is.detail || '' },
        el('span', { class: 'issue-head' }, el('span', { class: 'swatch' }), el('span', { class: 'issue-label', text: is.label })),
        el('b', { text: String(is.count) }));
      b.style.setProperty('--c', L.ISSUE_COLORS[i % L.ISSUE_COLORS.length]);
      b.disabled = is.count === 0;
      b.addEventListener('click', () => toggleFilter('issue', i));
      return b;
    }));

    // 기기별
    const devBox = $('device-list');
    const counts = countBy(state.rows, 'device');
    const max = counts.length ? counts[0][1] : 0;
    if (!counts.length) devBox.replaceChildren(el('p', { class: 'side-empty', text: '이 달에 접수된 CS가 없습니다.' }));
    else devBox.replaceChildren(...counts.map(([d, n]) => {
      const fill = el('span');
      fill.style.width = `${Math.round((n / max) * 100)}%`;
      const b = el('button', { type: 'button', class: 'device-btn' + (isActive('device', d) ? ' active' : '') },
        el('span', { class: 'lbl', text: d }),
        el('span', { class: 'bar', 'aria-hidden': 'true' }, fill),
        el('b', { text: String(n) }));
      b.addEventListener('click', () => toggleFilter('device', d));
      return b;
    }));

    // 담당자별 (빈 값은 "미지정"으로 묶어 맨 끝에)
    const asgBox = $('assignee-list');
    const asg = countBy(state.rows.map((r) => ({ a: r.assignee || '' })), 'a')
      .map(([k, n]) => [k === '(없음)' ? '' : k, n]);
    const unassigned = asg.find(([k]) => k === '');
    const named = asg.filter(([k]) => k !== '');
    const asgRows = unassigned ? [...named, unassigned] : named;
    const asgMax = asgRows.length ? Math.max(...asgRows.map(([, n]) => n)) : 0;
    if (!asgRows.length) asgBox.replaceChildren(el('p', { class: 'side-empty', text: '이 달에 접수된 CS가 없습니다.' }));
    else asgBox.replaceChildren(...asgRows.map(([a, n]) => {
      const fill = el('span');
      fill.style.width = `${Math.round((n / asgMax) * 100)}%`;
      const b = el('button', { type: 'button', class: 'device-btn' + (isActive('assignee', a) ? ' active' : '') },
        el('span', { class: 'lbl' + (a ? '' : ' muted'), text: a || '미지정' }),
        el('span', { class: 'bar', 'aria-hidden': 'true' }, fill),
        el('b', { text: String(n) }));
      b.addEventListener('click', () => toggleFilter('assignee', a));
      return b;
    }));

    // 특이사항
    const notesBox = $('notes-list');
    const notes = s ? s.notes || [] : [];
    $('notes-count').textContent = notes.length ? String(notes.length) : '';
    notesBox.replaceChildren(...(notes.length
      ? notes.map((n) => el('p', {}, n.customer ? el('span', { class: 'cust', text: n.customer }) : null, n.text))
      : [el('p', { class: 'muted', text: s ? '없음' : '—' })]));
  }
  $('filter-clear').addEventListener('click', () => { state.filter = null; renderKpi(); renderSidebar(); renderList(); });

  // ───────────── 툴바 ─────────────
  $('prev-month').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); loadMonth(); });
  $('next-month').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); loadMonth(); });
  $('this-month').addEventListener('click', () => { state.month = currentMonthKST(); loadMonth(); });
  $('search-input').addEventListener('input', renderList);
  $('export-btn').addEventListener('click', exportCsv);
  $('new-btn').addEventListener('click', () => openDialog(null));

  // ───────────── 등록/수정 폼 ─────────────
  const CONFLICT_MSG = '다른 사용자가 먼저 수정했거나 삭제된 CS입니다. 창을 닫고 목록을 다시 연 뒤 수정하세요.';
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
      f.title.value = row.title;
      f.status.value = row.status;
      f.status_note.value = row.status_note;
      f.assignee.value = row.assignee || '';
      f.ticket_assignee.value = row.ticket_assignee || '';
      f.description.value = row.description;
      f.notes.value = row.notes;
      row.timeline.forEach((v) => addListItem('timeline', v));
      row.tickets.forEach((v) => addListItem('tickets', v));
      $('form-meta').textContent =
        `등록 ${fmtDateTime(row.created_at)} · 최종 수정 ${fmtDateTime(row.updated_at)}`;
    } else {
      try { f.reporter.value = localStorage.getItem(LS_REPORTER) || ''; } catch { /* 저장소 차단 시 무시 */ }
      f.received_at.value = toLocalInput(new Date().toISOString());
      f.status.value = 'open';
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
      title: f.title.value.trim(),
      status: f.status.value,
      status_note: f.status_note.value.trim(),
      assignee: f.assignee.value.trim(),
      ticket_assignee: f.ticket_assignee.value.trim(),
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
    if (!payload.title) missing.push('제목');
    if (!L.STATUS[payload.status]) missing.push('상태');
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
    rememberNames([payload.assignee, payload.ticket_assignee]);
    dialog.close();
    toast(target ? '수정했습니다.' : '등록했습니다.');
    // 저장한 CS 가 있는 달로 이동하고, 그 CS 를 상세에 연다
    state.month = toLocalInput(res.data[0].received_at).slice(0, 7);
    loadMonth({ selected: res.data[0].id });
  });

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
    f.title.value = p.title || '';
    f.assignee.value = p.assignee || '';
    const dt = parsedDateToInput(p.received_at);
    if (dt) f.received_at.value = dt;
    f.device.value = p.device && DEVICES.includes(p.device) ? p.device : '';
    f.version.value = p.version || '';
    f.description.value = p.description || '';
    f.notes.value = p.notes || '';
    // 댓글 → 처리 이력. 기존 입력칸은 비우고 순서대로 채운다 (붙여넣기는 새 CS 흐름에서만 쓰임)
    const tl = Array.isArray(p.timeline) ? p.timeline : [];
    form.querySelector('[data-list="timeline"]').replaceChildren();
    tl.forEach((t) => addListItem('timeline', t));
    if (!tl.length) addListItem('timeline');
    const hints = [];
    if (tl.length) hints.push(`처리 이력: 댓글 ${tl.length}개를 옮겼음, 순서·날짜 확인`);
    if (p.assignee) hints.push(`담당자: ${p.assignee}로 읽음, 확인 필요`);
    if (!p.received_at) hints.push('날짜: 메시지에 없어 현재 시각 유지');
    else if (/^\d{2}:\d{2}$/.test(p.received_at)) hints.push('날짜: 메시지에 날짜가 없어 오늘로 설정');
    if (!p.device) hints.push('기기: 판단 불가, 직접 선택 필요');
    if (!p.title) hints.push('제목: 메시지에서 뽑지 못함, 직접 입력 필요');
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

  // ── 월간 요약
  async function loadSummary(seq) {
    state.summary = null;
    renderSidebar();
    const { data, error } = await sb
      .from('cs_monthly_summaries').select('*').eq('month', state.month).maybeSingle();
    if (seq !== state.loadSeq) return;
    if (error) { showError($('summary-error'), '요약 불러오기 실패: ' + error.message); return; }
    showError($('summary-error'), '');
    state.summary = data;
    renderSidebar();
  }
  $('summary-gen-btn').addEventListener('click', async () => {
    if (state.summaryBusy) return;
    if (state.loading || !state.rows.length) { toast('요약할 CS가 없습니다.'); return; }
    const month = state.month;
    state.summaryBusy = true;
    state.summaryBusyMonth = month;
    showError($('summary-error'), '');
    renderSidebar();
    try {
      const { summary } = await callAi({ mode: 'summarize', month });
      state.summaryBusy = false;
      if (state.month !== month) { renderSidebar(); return; }   // 그 사이 다른 달로 옮겼으면 그 달 화면만 풀어 준다
      state.summary = summary;
      if (state.filter && state.filter.type === 'issue') state.filter = null;   // 이슈 번호가 바뀌므로
      renderSidebar();
      renderList();
      toast('요약을 저장했습니다.');
    } catch (e) {
      state.summaryBusy = false;
      renderSidebar();
      if (state.month !== month) return;
      showError($('summary-error'), '요약 생성 실패: ' + e.message);
    }
  });
  $('summary-copy-btn').addEventListener('click', async () => {
    if (!state.summary) return;
    try { await navigator.clipboard.writeText(state.summary.content); toast('마크다운을 복사했습니다.'); }
    catch { toast('복사에 실패했습니다. 브라우저 권한을 확인하세요.'); }
  });

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
    const header = ['접수 일시', '접수자', '고객사/유저', '기기', '버전', '제목', '상태', '담당자', '티켓 담당', '현상설명', '특이사항', '처리 타임라인', '티켓', '등록 일시', '최종 수정'];
    const lines = [header, ...state.rows.map((r) => [
      fmtDateTime(r.received_at), r.reporter, r.customer, r.device, r.version,
      r.title, L.statusLabel(r), r.assignee, r.ticket_assignee,
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

  // ───────────── 담당자 이름 제안 (datalist) ─────────────
  // 이번 달 행에 나온 이름 + 이 브라우저에서 입력한 이름. 고정 명단 없이 오타만 줄인다.
  const LS_NAMES = 'cs.assigneeNames';
  function rememberNames(names) {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(LS_NAMES) || '[]'); } catch { /* 무시 */ }
    const next = [...new Set([...names.filter(Boolean), ...saved])].slice(0, 50);
    try { localStorage.setItem(LS_NAMES, JSON.stringify(next)); } catch { /* 무시 */ }
    renderNameList();
  }
  function renderNameList() {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(LS_NAMES) || '[]'); } catch { /* 무시 */ }
    const fromRows = state.rows.flatMap((r) => [r.assignee, r.ticket_assignee]);
    const names = [...new Set([...fromRows, ...saved].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
    $('assignee-names').replaceChildren(...names.map((n) => el('option', { value: n })));
  }

  // ───────────── 초기화 ─────────────
  const devSelect = form.elements.device;
  devSelect.append(el('option', { value: '', text: '선택하세요' }));
  DEVICES.forEach((d) => devSelect.append(el('option', { value: d, text: d })));
  const statusSelect = form.elements.status;
  Object.entries(L.STATUS).forEach(([k, v]) => statusSelect.append(el('option', { value: k, text: v.label })));
  statusSelect.addEventListener('change', () => {
    const orig = state.editing;
    form.elements.status_note.value = orig && statusSelect.value === orig.status ? orig.status_note : '';
  });
  initAuth();
})();
