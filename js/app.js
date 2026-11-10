(() => {
  'use strict';

  // 배포 버전. index.html 의 <meta name="app-version"> 과 asset ?v= 를 함께 올린다.
  // GitHub Pages 는 파일마다 따로 10분 캐시하므로 배포 직후 "예전 HTML + 새 JS" 가 섞일 수 있다.
  // 그러면 새 JS 가 HTML 에 없는 요소를 찾다 멈추므로, HTML 을 캐시 무시로 다시 받아 한 번만 새로고침한다.
  const APP_VERSION = '20261110-5';
  const htmlVersion = (document.querySelector('meta[name="app-version"]') || {}).content;
  if (htmlVersion !== APP_VERSION) {
    let retried = false;
    try { retried = sessionStorage.getItem('cs.versionReload') === APP_VERSION; sessionStorage.setItem('cs.versionReload', APP_VERSION); } catch { /* 무시 */ }
    if (!retried) {
      fetch(location.href, { cache: 'reload' }).catch(() => {}).finally(() => location.reload());
      return;
    }
  }

  const DEVICES = ['웹', 'CLDAstream Win', 'CLDAstream MAC', 'PC client Win', 'PC client MAC', 'Android', 'IOS', '기타'];
  const TZ = 'Asia/Seoul';       // 월 경계·표시·입력 모두 KST 기준으로 통일
  const TZ_OFFSET = '+09:00';    // KST 는 서머타임이 없어 고정 오프셋으로 충분
  const LS_REPORTER = 'cs.lastReporter';
  const L = window.CSLib;
  const I = window.CSI18n;
  const LS_LANG = 'cs.lang';   // 상단 「한국어 / English」 로 고른 언어. 없으면 브라우저 언어
  function storedLang() { try { return localStorage.getItem(LS_LANG); } catch { return null; } }

  const cfg = window.CS_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  if (!window.supabase || !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('YOUR-PROJECT')) {
    document.body.innerHTML =
      `<p style="padding:24px">${I.t(I.detectLang(storedLang(), navigator.languages || [navigator.language]), 'app.noConfig')}</p>`;
    return;
  }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  const state = {
    lang: I.detectLang(storedLang(), navigator.languages || [navigator.language]),   // 'ko' | 'en'
    month: currentMonthKST(),  // 'YYYY-MM' — 왼쪽 월간 요약 · 막대를 볼 달
    all: [],                   // 모든 달의 CS (한 달 십여 건 규모라 한 번에 읽고 화면에서 거른다)
    rows: [],                  // state.all 중 state.month 에 접수된 CS (월간 요약 · 막대용)
    view: 'open',              // 목록 보기: open(미해결 · 모든 달) | carry(이월) | all | done
    sort: 'urgent',            // 정렬: urgent | oldest | recent
    listMonth: null,           // 목록 기간: null(전체 기간) | 'YYYY-MM'(그 달 접수만. 검색도 그 달 안에서)
    assignees: [],             // CS 담당 명단 (cs_assignees, 이름순)
    assigneesError: '',
    loading: false,
    editing: null,             // 수정 중인 원본 row (신규면 null)
    busy: false,               // 저장/삭제/빠른 조작 요청 진행 중
    loadSeq: 0,                // 늦게 도착한 전체 목록 응답 무시용
    summarySeq: 0,             // 빠른 월 이동 시 늦게 도착한 월간 요약 응답 무시용 (목록 순번과 따로)
    summary: null,             // 현재 월의 저장된 요약 행 (없으면 null)
    summaryBusy: false,        // 요약 생성 요청 진행 중
    summaryBusyMonth: null,    // 생성 중인 월 ('YYYY-MM'). 다른 달을 보고 있으면 "생성 중" 을 표시하지 않음
    filters: {},               // { severity: [], status: [], device: [], assignee: [], issue: [], age: ['overdue'] } — 종류 안 OR, 종류끼리 AND
    selected: null,            // 상세 패널에 열린 row id
    yt: {},                    // 트래커(YouTrack·Jira) 티켓 캐시 { 'NRF-1': { source, summary, state, resolved, assignees, url } | null(없음) }
    ytBusy: 0,                 // 진행 중인 티켓 조회 요청 수
    ytError: '',
    tr: {},                    // 번역 { [id]: { ko?: { fields, source_hash }, en?: … } } (cs_ticket_translations)
    hash: {},                  // 원문 해시 캐시 { [id]: { text, hash } } — 원문(text)이 바뀌면 쓰지 않는다 (L.cachedHash)
    trError: '',
    showOriginal: false,       // 상세에서 「원문 보기」를 누른 상태
    backfill: { remaining: 0, running: false, msg: '' },
  };
  function t(key, params) { return I.t(state.lang, key, params); }
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
  function fmtDateTime(iso) {
    const p = kstParts(new Date(iso));
    return `${p.year}-${p.month}-${p.day} (${I.weekday(state.lang, p.weekday)}) ${p.hour}:${p.minute}`;
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
      loadAssignees();
      loadAll();
      checkBackfill();
    } else {
      [...popups.keys()].forEach(closePopup);
      state.all = [];
      state.rows = [];
      state.selected = null;
      state.filters = {};
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
    if (error) showError($('login-error'), t('login.failed', { e: error.message }));
  });
  $('logout-btn').addEventListener('click', () => sb.auth.signOut());

  // ───────────── 조회 ─────────────
  // 모든 달의 CS 를 한 번에 읽는다. 목록(보기 · 정렬 · 검색)과 월간 막대는 이 배열에서 화면이 거른다.
  async function loadAll(opts = {}) {
    const seq = ++state.loadSeq;
    $('month-label').textContent = state.month;
    showError($('list-error'), '');
    $('list-title').textContent = t('list.loading');
    setLoading(true);
    const { data, error } = await fetchAll();
    if (seq !== state.loadSeq) return;
    setLoading(false);
    if (error) showError($('list-error'), t('list.loadFailed', { e: error.message }));
    state.all = error ? [] : data;
    deriveMonth();
    state.selected = opts.selected && state.all.some((r) => r.id === opts.selected) ? opts.selected : null;
    renderAll();
    loadSummary();
    loadTickets({ refresh: true });
    // 화면 언어 번역은 안 끝난 CS · 보고 있는 달 것만 요청한다 (나머지는 있는 번역만 읽음)
    loadTranslations(state.all, { request: false }).then(() => requestTranslations(workingRows()));
  }
  function deriveMonth() { state.rows = state.all.filter((r) => L.monthKST(r.received_at) === state.month); }
  // 티켓 · 번역을 미리 챙길 CS: 안 끝난 CS 전부 + 보고 있는 달
  function workingRows() { return state.all.filter((r) => r.status !== 'done' || L.monthKST(r.received_at) === state.month); }
  // 왼쪽 월간 요약 · 막대의 달만 바꾼다 (목록은 그대로)
  function changeMonth(month) {
    state.month = month;
    $('month-label').textContent = month;
    deriveMonth();
    delete state.filters.issue;   // 이슈 번호는 달마다 다르다
    renderAll();
    loadSummary();
    loadTickets({ rows: state.rows });
  }

  // 티켓의 담당자·상태를 YouTrack·Jira 에서 읽어 온다 (Edge Function `tickets`. 표시 전용, DB 에 쓰지 않음).
  // refresh: 캐시에 있어도 다시 읽음 (새로고침 버튼). 아니면 처음 보는 ID 만.
  // rows: 티켓을 읽을 CS (기본: 안 끝난 CS + 보고 있는 달)
  async function loadTickets({ refresh = false, rows = workingRows() } = {}) {
    const ids = L.ticketIds(rows).filter((id) => refresh || !(id in state.yt));
    if (!ids.length) { renderYtStatus(); return; }
    state.ytBusy++;            // 요청이 겹칠 수 있음. 결과는 ID 별로 합치므로 순서는 상관없다
    renderYtStatus();
    try {
      const warnings = new Set();
      for (let i = 0; i < ids.length; i += 300) {
        const { tickets, missing, warnings: w = [] } = await callFn('tickets', { ids: ids.slice(i, i + 300) });
        Object.assign(state.yt, tickets);
        missing.forEach((id) => { state.yt[id] = null; });   // 트래커에 없는 ID 는 다시 묻지 않음
        w.forEach((m) => warnings.add(m));                    // 한쪽 트래커만 실패한 경우 (토큰 미설정 등)
      }
      state.ytError = warnings.size ? t('tickets.partial', { e: [...warnings].join(' / ') }) : '';
    } catch (e) {
      state.ytError = t('tickets.failed', { e: e.message });
    }
    state.ytBusy--;
    renderYtStatus();
    renderCards();
    renderSidebar();
    renderList();
    renderDetail();
  }

  function renderYtStatus() {
    showError($('tickets-error'), state.ytError);
    $('tickets-refresh').disabled = state.ytBusy > 0;
    $('tickets-refresh').textContent = state.ytBusy ? t('tickets.loading') : t('tickets.refresh');
  }
  $('tickets-refresh').addEventListener('click', () => loadTickets({ refresh: true, rows: [...new Set([...workingRows(), ...visibleRows().slice(0, 300)])] }));

  function renderAll() {
    renderCards();
    renderSidebar();
    renderList();
    renderDetail();
    renderNameList();
  }

  // 한 번에 1000건(PostgREST 기본 max-rows)이 넘어도 잘리지 않도록 페이지 단위로 모두 가져옴
  async function fetchAll() {
    const rows = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await sb
        .from('cs_tickets')
        .select('*')
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

  function allRows() { return state.all; }
  // 저장 · 변경된 한 건을 목록에 반영
  function replaceRow(row) {
    const idx = state.all.findIndex((x) => x.id === row.id);
    if (idx >= 0) state.all[idx] = row;
    deriveMonth();
  }

  // ───────────── 보기 · 정렬 · 검색 ─────────────
  const VIEWS = ['open', 'carry', 'all', 'done'];
  const SORTS = ['urgent', 'oldest', 'recent'];
  const LS_LIST = 'cs.listPrefs';   // 마지막으로 고른 보기 · 정렬 · 검색 범위 (이 브라우저만)
  try {
    const p = JSON.parse(localStorage.getItem(LS_LIST) || '{}');
    if (VIEWS.includes(p.view)) state.view = p.view;
    if (SORTS.includes(p.sort)) state.sort = p.sort;
  } catch { /* 무시 */ }
  function saveListPrefs() { try { localStorage.setItem(LS_LIST, JSON.stringify({ view: state.view, sort: state.sort })); } catch { /* 무시 */ } }
  function searchQuery() { return $('search-input').value.trim(); }

  // 지금 목록에 보이는 CS: 보기 → (검색 범위) → 필터 · 검색 → 정렬.
  // 검색어가 있으면 보기와 상관없이 모든 CS(완료 포함)에서 찾는다
  function listView() { return searchQuery() ? 'all' : state.view; }
  // 필터 · 검색어를 걸기 전 목록 (보기 + 검색 범위). 상태 칩 · 필터 메뉴 건수도 이 기준
  function baseRows() {
    const rows = L.viewRows(state.all, listView(), currentMonthKST());
    return state.listMonth ? rows.filter((r) => L.monthKST(r.received_at) === state.listMonth) : rows;
  }
  // 검색어까지 건 목록 (필터 전). 상태 칩 · 필터 메뉴 건수의 기준
  function searchedRows() {
    const q = searchQuery();
    return q ? baseRows().filter((r) => L.matchesSearch(r, q, state.yt, trTexts(r))) : baseRows();
  }
  function visibleRows() {
    return L.sortRows(filteredRows(baseRows()), state.sort, state.yt);
  }

  function renderViewBar() {
    const counts = Object.fromEntries(VIEWS.map((v) => [v, L.viewRows(state.all, v, currentMonthKST()).length]));
    $('view-tabs').replaceChildren(...VIEWS.map((v) => {
      const b = el('button', { type: 'button', class: state.view === v ? 'on' : '', 'aria-pressed': String(state.view === v) },
        el('span', { text: t(`view.${v}`) }), el('b', { text: String(counts[v]) }));
      b.addEventListener('click', () => setView(v));
      return b;
    }));
  }
  function setView(v) {
    if (state.view === v) return;
    state.view = v;
    saveListPrefs();
    renderCards();
    renderList();
    loadTickets({ rows: visibleRows().slice(0, 300) });   // 완료 · 전체 보기에서 처음 보이는 티켓
  }
  function renderSortSelect() {
    $('sort-select').replaceChildren(...SORTS.map((k) => el('option', { value: k, text: t(`sort.${k}`) })));
    $('sort-select').value = state.sort;
  }
  $('sort-select').addEventListener('change', () => { state.sort = $('sort-select').value; saveListPrefs(); renderList(); });
  // 목록 기간: 「전체 기간」 또는 ‹ YYYY-MM › 로 한 달씩. 처음 ‹ 를 누르면 지난달(전달)
  function renderPeriod() {
    const cm = currentMonthKST();
    const all = el('button', { type: 'button', class: 'period-all' + (state.listMonth ? '' : ' on'), 'aria-pressed': String(!state.listMonth), text: t('period.all') });
    all.addEventListener('click', () => setListMonth(null));
    const prev = el('button', { type: 'button', class: 'period-step', 'aria-label': t('aria.prevMonth'), title: t('aria.prevMonth'), text: '‹' });
    prev.addEventListener('click', () => setListMonth(shiftMonth(state.listMonth || cm, -1)));
    const label = el('button', { type: 'button', class: 'period-month mono' + (state.listMonth ? ' on' : ''), 'aria-pressed': String(!!state.listMonth), title: t('period.pickTitle'), text: state.listMonth || t('period.pick') });
    label.addEventListener('click', () => setListMonth(state.listMonth ? null : cm));
    const next = el('button', { type: 'button', class: 'period-step', 'aria-label': t('aria.nextMonth'), title: t('aria.nextMonth'), text: '›' });
    next.addEventListener('click', () => setListMonth(shiftMonth(state.listMonth || shiftMonth(cm, -1), 1)));
    $('period').replaceChildren(all, prev, label, next);
  }
  // 목록 기간을 바꾸면 위 월간 리포트도 그 달로 맞춘다 (전체 기간으로 돌아가면 리포트는 그대로)
  function setListMonth(m) {
    state.listMonth = m;
    if (m && m !== state.month) changeMonth(m);
    else { renderCards(); renderList(); }
    loadTickets({ rows: visibleRows().slice(0, 300) });
  }


  // 검색 결과에 보이는 티켓만 트래커에서 읽는다 (입력이 멈춘 뒤)
  let searchTicketTimer;
  function loadSearchTickets() {
    clearTimeout(searchTicketTimer);
    if (!searchQuery()) return;
    searchTicketTimer = setTimeout(() => loadTickets({ rows: visibleRows().slice(0, 300) }), 400);
  }

  // 월 목록·밀린 미해결 모두 같은 필터·검색을 적용한다
  function filteredRows(rows = state.rows) {
    const q = $('search-input').value;
    const issues = summaryView().issues;
    return L.applyFilters(rows, state.filters, issues, state.yt).filter((r) => L.matchesSearch(r, q, state.yt, trTexts(r)));
  }

  // 버전은 v 없이 저장하고 여기서 한 번만 붙인다 (예전에 v 를 넣어 저장한 값도 vv 가 되지 않게)
  function deviceLine(r) { const d = L.deviceLabel(r.device, state.lang); const v = L.plainVersion(r.version); return v ? `${d} · v${v}` : d; }

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

  // 필터 값 하나의 화면 이름
  function filterValueName(type, v) {
    if (type === 'device') return L.deviceLabel(v, state.lang);
    if (type === 'status') return L.statusName(v, state.lang);
    if (type === 'severity') return L.severityLabel(v, state.lang);
    if (type === 'assignee') return v || t('common.unassigned');
    if (type === 'age') return t('fchip.age');
    const issue = summaryView().issues[v];
    return issue ? issue.label : '';
  }

  // 완료 전 CS 의 경과: 「N일째」, 7일 이상은 「지연 N일째」(빨강). 완료면 null
  function ageNode(r) {
    const a = L.ageInfo(r);
    if (!a) return null;
    const text = a.days === 0 ? t('age.today') : t(a.overdue ? 'age.overdue' : 'age.days', { n: a.days });
    return el('span', { class: 'row-age' + (a.overdue ? ' overdue' : ''), text, title: t('age.title', { n: a.days, d: L.OVERDUE_DAYS }) });
  }
  function receivedNode(r) {
    const age = ageNode(r);
    return [el('span', { class: 'mono', text: fmtDateTime(r.received_at) }), ...(age ? [' ', age] : [])];
  }
  // 심각도 배지 (목록 · 팝업). 보통은 흐린 글자. YouTrack Priority 로 정해진 값은 점선 + 툴팁
  function sevBadge(r) {
    const ys = L.ytSeverity(r, state.yt);
    const key = ys ? ys.key : L.severityKey(r);
    const b = el('span', { class: 'sev-badge' + (key === 'normal' ? ' normal' : '') + (ys ? ' from-yt' : ''), text: L.severityLabel(key, state.lang), title: ys ? t('sev.fromYt', { ids: ys.ids.join(', ') }) : '' });
    b.style.setProperty('--s', L.SEVERITY[key].color);
    return b;
  }

  // 행: 현상(굵게) + 아래 줄 고객사 · 기기 · 꼬리표 | CS 상태 | CS 담당 | 티켓(번호 · 트래커 상태 · 개발 담당) | 접수일 · 경과.
  // 왼쪽 띠 색 = 심각도 (보통은 없음). 올해가 아닌 건은 접수일에 연도(YY-MM-DD).
  // grouped: 이번 달 / 지난달 이전 묶음 안이면 「이월」 꼬리표는 머리글과 겹치므로 생략
  function rowNode(r, grouped = false) {
    const p = kstParts(new Date(r.received_at));
    const thisYear = currentMonthKST().slice(0, 4);
    const when = p.year !== thisYear ? `${p.year.slice(2)}-${p.month}-${p.day}` : `${p.month}-${p.day}`;
    const f = disp(r);
    const sk = L.severityOf(r, state.yt);
    const carried = !grouped && L.isCarried(r, currentMonthKST());
    const mm = L.mismatch(r, state.yt);
    const age = ageNode(r);
    const b = el('div', { role: 'button', tabindex: '0', class: 'cs-row' + (state.selected === r.id ? ' active' : '') + (sk !== 'normal' ? ' sev' : '') },
      el('span', { class: 'col-main' },
        el('span', { class: 'line1' }, sk !== 'normal' ? sevBadge(r) : null, el('span', { class: 'row-title', text: f.title || t('list.noTitle'), title: f.title || '' })),
        el('span', { class: 'line2' },
          el('span', { class: 'who', text: r.customer, title: r.customer }),
          el('span', { class: 'dev', text: deviceLine(r) }),
          age ? el('span', { class: 'age-inline' }, ageNode(r)) : null,
          carried ? el('span', { class: 'row-tag', text: t('tag.carry'), title: t('tag.carryTitle') }) : null,
          f.status_note ? el('span', { class: 'row-tag note', text: f.status_note }) : null,
          mm ? el('span', { class: 'row-tag warn', text: t(`mm.${mm}`), title: t(`mm.${mm}Title`) }) : null)),
      el('span', { class: 'col-status' }, statusPill(r)),
      // 담당이 없는 미해결은 눈에 띄게
      el('span', { class: 'col-asg' + (r.assignee ? '' : r.status === 'done' ? ' none' : ' none warn'), title: L.assigneeLine(r, state.yt, state.lang) },
        el('span', { class: 'avatar', 'aria-hidden': 'true', text: r.assignee ? r.assignee.trim().charAt(0).toUpperCase() : '?' }),
        el('span', { class: 'asg-name', text: r.assignee || t('common.unassigned') })),
      ticketCell(r),
      el('span', { class: 'col-when', title: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} (${I.weekday(state.lang, p.weekday)})` },
        el('span', { class: 'mono', text: when }), age),
    );
    b.style.setProperty('--s', L.SEVERITY[sk].color);
    b.addEventListener('click', () => selectRow(r.id));
    b.addEventListener('keydown', (e) => {
      if (e.target === b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectRow(r.id); }
    });
    return b;
  }
  function statusPill(r) {
    const n = el('span', { class: 'st-pill', text: L.statusName(r.status, state.lang) });
    n.style.setProperty('--c', L.statusColor(r));
    return n;
  }
  // 목록의 티켓 칸: 「NRF-4771 외 1」 + 트래커 상태 · 개발 담당
  function ticketCell(r) {
    if (!r.tickets.length) return el('span', { class: 'col-ticket none', text: '—' });
    const infos = L.ticketInfos(r, state.yt);
    const first = infos[0].id || shortTicket(infos[0].raw);
    const more = infos.length > 1 ? (state.lang === 'en' ? ` +${infos.length - 1}` : ` 외 ${infos.length - 1}`) : '';
    const s = L.ticketState(r, state.yt, state.lang);
    const ta = L.ticketAssignees(r, state.yt);
    const st = s ? el('span', { class: 'tk-state', text: s.label.replace(/ (외 |\+)\d+$/, ''), title: s.title }) : el('span', { class: 'tk-state none', text: state.ytBusy ? '…' : t('list.unknownState') });
    if (s) st.style.setProperty('--c', s.color);
    return el('span', { class: 'col-ticket' },
      el('span', { class: 'mono tk-id', text: first + more }),
      el('span', { class: 'line2' }, st, ta.names.length ? el('span', { class: 'muted', text: ta.names.join(', '), title: ta.manual ? t('list.manual', { text: ta.names.join(', ') }) : '' }) : null));
  }

  function ticketAsgNode(r, cls) {
    const { names, manual } = L.ticketAssignees(r, state.yt);
    const text = names.length ? names.join(', ') : (r.tickets.length ? t('common.unassigned') : '—');
    return el('span', { class: cls + (names.length ? '' : ' none'), text, title: manual ? t('list.manual', { text }) : text });
  }
  function ticketStateNode(r) {
    const s = L.ticketState(r, state.yt, state.lang);
    if (!s) return el('span', { class: 'col-tstate none', text: r.tickets.length ? (state.ytBusy ? '…' : t('list.unknownState')) : '—' });
    const n = el('span', { class: 'col-tstate', title: s.title }, el('span', { class: 'dot' }), el('span', { text: s.label }));
    n.style.setProperty('--c', s.color);
    return n;
  }

  // 미해결 · 전체 보기: 접수 월별로 묶는다. 이번 달은 비어 있어도 맨 위(「이번 달에 접수된 CS가 없습니다」), 그 아래 지난달부터
  function monthGroups(rows) {
    const cm = currentMonthKST();
    const year = cm.slice(0, 4);
    const name = (ym) => I.monthCount(state.lang, ym, ym.slice(0, 4) === year, '').trim();
    return L.groupByMonth(rows, cm).flatMap((g) => [
      el('div', { class: 'hist-group month-group' + (g.ym === cm ? ' this' : '') },
        el('strong', { text: g.ym === cm ? t('grp.thisMonth', { month: name(g.ym) }) : t('grp.month', { month: name(g.ym) }) }),
        el('span', { class: 'mono', text: t('nCount', { n: g.rows.length }) })),
      ...(g.rows.length ? g.rows.map((r) => rowNode(r, g.ym !== cm)) : [el('p', { class: 'group-empty', text: t('grp.empty') })]),
    ]);
  }

  // 목록: 보기(미해결 · 이월 · 전체 · 완료) → 필터 · 검색 → 정렬. 검색 중이면 접수 시기별로 묶는다
  function renderList() {
    renderViewBar();
    renderPeriod();
    const base = baseRows();
    const rows = visibleRows();
    const q = searchQuery();
    $('view-tabs').classList.toggle('searching', !!q);
    $('cs-list').replaceChildren(...(q
      ? L.groupByRecency(rows).flatMap((g) => [
        el('div', { class: 'hist-group', title: t('list.searchHint') }, el('strong', { text: L.recencyLabel(g.key, state.lang) }), el('span', { class: 'mono', text: t('nCount', { n: g.rows.length }) })),
        ...g.rows.map((r) => rowNode(r)),
      ])
      : ['open', 'all'].includes(state.view) && !state.listMonth ? monthGroups(rows) : rows.map((r) => rowNode(r))));
    const view = (q ? t('view.search') : t(`view.${state.view}`)) + (state.listMonth ? ` · ${state.listMonth}` : '');
    $('list-title').textContent = rows.length === base.length ? t('list.count', { view, n: rows.length }) : t('list.countOf', { view, n: rows.length, total: base.length });
    renderFilterChips();
    const err = !!$('list-error').textContent;
    $('empty').hidden = rows.length > 0 || err || state.loading;
    $('empty').textContent = base.length > 0 ? t('list.emptyFiltered') : t('list.emptyView');
  }

  function selectRow(id) {
    state.selected = state.selected === id ? null : id;
    state.showOriginal = false;
    renderList();
    renderDetail();
    // 세로로 쌓이는 폭에서는 상세가 목록 아래에 있어 눈에 띄지 않으므로 스크롤해 준다
    if (state.selected && window.matchMedia('(max-width: 1100px)').matches) $('detail').scrollIntoView({ block: 'start' });
  }

  // ───────────── 상세 패널 ─────────────
  function selectedRow() { return allRows().find((x) => x.id === state.selected) || null; }

  function renderDetail() {
    renderPopups();   // 떠 있는 팝업도 같은 데이터로 다시 그린다
    const r = selectedRow();
    $('detail').hidden = !r;
    if (!r) return;
    $('detail-when').textContent = `${fmtDateTime(r.received_at)} · ${r.customer}`;
    // 입력 중이던 칸(상태 메모 · 이력)은 다시 그려도 값과 포커스를 지킨다
    const body = $('detail-body');
    const keep = keptInputs(body, r.id);
    body.replaceChildren(...csBody(r, { full: true }));
    restoreInputs(body, keep);
  }

  // 다시 그리기 전에 같은 CS 에서 고쳐 쓰던 칸(저장 전)만 기억했다가 되돌린다
  function keptInputs(box, rowId) {
    return [...box.querySelectorAll('input[data-keep]')]
      .filter((i) => i.dataset.rowId === rowId && i.value !== i.dataset.orig)
      .map((i) => [i.dataset.keep, i.value, document.activeElement === i]);
  }
  function restoreInputs(box, keep) {
    keep.forEach(([k, v, focused]) => {
      const i = box.querySelector(`input[data-keep="${k}"]`);
      if (i) { i.value = v; if (focused) i.focus(); }
    });
  }

  // 상세 서랍 · 팝업 공통 본문. full: 상세(전부) / 아니면 팝업(조금 짧게)
  function csBody(r, { full }) {
    const shown = disp(r);
    const f = full && state.showOriginal && shown.translated ? L.displayFields(r, null, null, state.lang) : shown;
    const ys = L.ytSeverity(r, state.yt);
    const sk = ys ? ys.key : L.severityKey(r);
    const err = el('p', { class: 'error', hidden: '' });
    const save = (patch, box) => saveRow(r, patch, err, box);
    const nodes = [];

    // 머리: 심각도 · 제목 · 번역 · 고객사 · 기기 · 접수
    const head = el('div', { class: 'd-head' });
    if (sk !== 'normal') head.append(sevBadge(r));
    head.append(el('h2', { class: 'detail-title', text: f.title || t('list.noTitle') }));
    if (shown.translated) {
      const src = t(L.hasHangul(r) ? 'lang.ko' : 'lang.en');
      const bar = el('div', { class: 'tr-bar' }, el('span', { text: full && state.showOriginal ? t('tr.original', { lang: src }) : t('tr.from', { lang: src }) }));
      if (full) {
        const tg = el('button', { type: 'button', class: 'link-btn', text: state.showOriginal ? t('tr.showTranslation') : t('tr.showOriginal') });
        tg.addEventListener('click', () => { state.showOriginal = !state.showOriginal; renderDetail(); });
        bar.append(tg);
      }
      head.append(bar);
    }
    head.append(el('p', { class: 'd-sub' }, el('b', { text: r.customer }), ' · ', deviceLine(r), ' · ', ...receivedNode(r)));
    nodes.push(head);

    // 상태 버튼 줄: 한 번 누르면 바로 저장 (상태를 바꾸면 이전 상태의 메모는 비운다)
    const stBox = el('div', { class: 'd-status' });
    const stRow = el('div', { class: 'st-buttons', role: 'group', 'aria-label': t('d.statusAria') }, ...Object.keys(L.STATUS).map((k) => {
      const b = el('button', { type: 'button', class: 'st-btn' + (r.status === k ? ' on' : ''), 'aria-pressed': String(r.status === k), text: L.statusName(k, state.lang) });
      b.style.setProperty('--c', L.STATUS[k].color);
      b.addEventListener('click', () => {
        if (r.status === k || state.busy) return;
        note.dataset.orig = note.value;   // 상태를 바꾸면 메모는 비워 저장되므로 쓰던 메모를 되살리지 않는다
        save({ status: k, status_note: '' }, stBox);
      });
      return b;
    }));
    const note = el('input', { type: 'text', maxlength: '50', placeholder: t('d.notePh'), 'data-keep': 'note', 'data-row-id': r.id, 'aria-label': t('f.statusNote') });
    note.value = r.status_note;
    note.dataset.orig = r.status_note;
    note.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (!state.busy && note.value.trim() !== r.status_note) { note.dataset.orig = note.value; save({ status_note: note.value.trim() }, stBox); } }
    });
    stBox.append(stRow, note);
    nodes.push(stBox);

    // 속성 4줄: CS 담당 · 심각도 · 티켓 담당 · 접수자
    const asg = el('select', { 'aria-label': t('col.csOwner') });
    fillAssigneeSelect(asg, r.assignee || '');
    asg.addEventListener('change', () => save({ assignee: asg.value }, props));
    const sev = el('select', { 'aria-label': t('col.severity') }, Object.keys(L.SEVERITY).map((k) => el('option', { value: k, text: L.severityLabel(k, state.lang) })));
    sev.value = sk;
    sev.disabled = !!ys;
    sev.addEventListener('change', () => save({ severity: sev.value }, props));
    // 티켓 담당: 트래커에서 읽은 티켓이 있으면 그 담당(없으면 미지정), 트래커에 없는 티켓일 때만 직접 입력
    const ta = L.ticketAssignees(r, state.yt);
    const inTracker = L.ticketInfos(r, state.yt).some((x) => x.yt);
    let taNode;
    if (inTracker) taNode = el('span', { class: ta.names.length ? '' : 'muted', text: ta.names.join(', ') || t('common.unassigned') });
    else if (!r.tickets.length && !r.ticket_assignee) taNode = el('span', { class: 'muted', text: '—' });
    else {
      taNode = el('input', { type: 'text', maxlength: '100', list: 'assignee-names', placeholder: t('d.ticketOwnerPh'), 'aria-label': t('col.ticketOwner') });
      taNode.value = r.ticket_assignee || '';
      taNode.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save({ ticket_assignee: taNode.value.trim() }, props); } });
    }
    const props = el('dl', { class: 'meta' },
      el('dt', { text: t('col.csOwner') }), el('dd', {}, asg),
      el('dt', { text: t('col.severity') }), el('dd', {}, sev, ys ? el('span', { class: 'muted small sev-yt', text: t('sev.fromYt', { ids: ys.ids.join(', ') }) }) : null),
      el('dt', { text: t('col.ticketOwner') }), el('dd', {}, taNode),
      ...(full ? [el('dt', { text: t('col.reporter') }), el('dd', { text: r.reporter })] : []));
    nodes.push(props);

    const mm = L.mismatch(r, state.yt);
    if (mm) nodes.push(el('p', { class: 'mm-warn', text: t(`mm.${mm}Title`) }));

    // 티켓 카드
    nodes.push(el('div', { class: 'detail-section' }, el('h3', { text: t('col.tickets') }),
      ...(r.tickets.length ? L.ticketInfos(r, state.yt).map(ticketCard) : [el('p', { class: 'muted small', text: t('d.noTickets') })])));
    nodes.push(el('div', { class: 'detail-section' }, el('h3', { text: t('detail.desc') }), el('p', { class: 'detail-desc', text: f.description || '—' })));
    if (f.notes) nodes.push(el('div', { class: 'detail-section' }, el('h3', { text: t('side.notes') }), el('p', { class: 'detail-desc', text: f.notes })));

    // 처리 이력 + 한 줄 추가 (날짜가 없으면 오늘 날짜를 붙인다)
    const hist = el('ol', { class: 'history' }, ...(f.timeline.length
      ? f.timeline.map((entry) => { const { when, text } = L.splitTimeline(entry); return el('li', {}, el('span', { class: 'mono muted', text: when || '—' }), el('span', { class: 'hist-dot' }), el('span', { text })); })
      : [el('li', { class: 'muted', text: t('detail.noHistory') })]));
    const add = el('input', { type: 'text', maxlength: '2000', placeholder: t('d.historyPh'), 'data-keep': 'hist', 'data-row-id': r.id, 'data-orig': '', 'aria-label': t('btn.history') });
    const histBox = el('div', { class: 'detail-section' }, el('h3', { text: t('detail.history') }), hist, add);
    add.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      const entry = add.value.trim();
      if (!entry || state.busy) return;   // 다른 저장이 진행 중이면 글을 그대로 두고 기다린다
      add.dataset.orig = add.value;   // 저장되면 다시 그릴 때 이 글을 되살리지 않는다 (실패하면 칸이 그대로 남음)
      save({ timeline: [...r.timeline, L.datedEntry(entry)] }, histBox);
    });
    nodes.push(histBox, err);

    if (full) {
      const edit = el('button', { type: 'button', class: 'btn', text: t('d.fullEdit') });
      edit.addEventListener('click', () => openDialog(r));
      nodes.push(el('div', { class: 'd-foot' }, el('span', { class: 'muted small', text: t('dialog.meta', { created: fmtDateTime(r.created_at), updated: fmtDateTime(r.updated_at) }) }), edit));
    }
    return nodes;
  }

  // 상세의 티켓 카드: 번호(링크) · 상태 · 개발 담당 · 요약
  function ticketCard(info) {
    const { raw, id, yt } = info;
    const link = isSafeUrl(raw) ? ticketNode(raw) : yt ? el('a', { class: 'chip', href: yt.url, target: '_blank', rel: 'noopener noreferrer', text: id }) : ticketNode(raw);
    if (!yt) {
      const hint = !id ? '' : id in state.yt ? t('tickets.notInTracker') : state.ytBusy ? t('list.loading') : '';
      return el('div', { class: 'tk-card' }, el('div', { class: 'tk-top' }, link, hint ? el('span', { class: 'muted small', text: hint }) : null));
    }
    const st = el('span', { class: 'tk-state', text: yt.state || t('tickets.noState') });
    st.style.setProperty('--c', L.ytStateColor(yt));
    return el('div', { class: 'tk-card' },
      el('div', { class: 'tk-top' }, link, st),
      el('div', { class: 'small' + (yt.assignees.length ? '' : ' muted'), text: yt.assignees.join(', ') || t('tickets.noOwner') }),
      yt.summary ? el('div', { class: 'muted small tk-sum', text: yt.summary }) : null);
  }

  // 상세 · 팝업에서 바로 저장 (수정 창과 같은 낙관적 잠금). box 안 입력은 저장하는 동안 잠근다
  async function saveRow(r, patch, errNode, box) {
    if (state.busy) return;
    state.busy = true;
    showError(errNode, '');
    const controls = box ? [...box.querySelectorAll('button, input, select')] : [];
    controls.forEach((n) => { n.disabled = true; });
    const { data, error } = await sb.from('cs_tickets').update(patch)
      .eq('id', r.id)
      .eq('updated_at', r.updated_at)
      .select();
    state.busy = false;
    if (error || data.length === 0) {
      controls.forEach((n) => { n.disabled = false; });
      showError(errNode, error ? t('save.failed', { e: error.message }) : t('conflict'));
      return;
    }
    replaceRow(data[0]);
    toast(t('save.done'));
    rememberNames([data[0].assignee, data[0].ticket_assignee]);
    renderAll();
    loadTranslations([data[0]]);   // 상태 메모·이력이 바뀌었으면 다시 번역
  }

  function closeDetail() { state.selected = null; state.showOriginal = false; renderList(); renderDetail(); }
  $('detail-close').addEventListener('click', closeDetail);
  $('detail-popup').addEventListener('click', () => { if (state.selected) openPopup(state.selected); });

  // ───────────── KPI · 사이드바 ─────────────
  // 위쪽 행동 카드 4장(늘 전체 미해결 기준) + 상태별 칩 · 티켓 연결(지금 보기 기준)
  const CARD_FILTERS = { urgent: { severity: ['hotfix', 'critical'] }, overdue: { age: ['overdue'] }, unassigned: { assignee: [''] }, open: {} };
  function sameFilters(a, b) {
    const norm = (o) => JSON.stringify(Object.keys(o).filter((k) => o[k] && o[k].length).sort().map((k) => [k, [...o[k]].sort()]));
    return norm(a) === norm(b);
  }
  function renderCards() {
    const c = L.actionCounts(state.all, state.yt);
    const cm = currentMonthKST();
    const open = state.all.filter((r) => r.status !== 'done');
    const carried = open.filter((r) => L.isCarried(r, cm));
    const year = cm.slice(0, 4);
    const byMonth = L.carryMonths(carried).map(([ym, n]) => I.monthCount(state.lang, ym, ym.slice(0, 4) === year, n));
    $('card-open').textContent = String(c.open);
    $('card-open-sub').textContent = t('card.openSub', { m: open.length - carried.length, c: carried.length }) + (byMonth.length ? ` (${byMonth.join(' · ')})` : '');
    $('card-urgent').textContent = String(c.urgent);
    $('card-overdue').textContent = String(c.overdue);
    $('card-unassigned').textContent = String(c.unassigned);
    document.querySelectorAll('.cards .card').forEach((b) => {
      const k = b.dataset.card;
      const on = state.view === 'open' && (k === 'open' ? !Object.values(state.filters).some((v) => v && v.length) : sameFilters(state.filters, CARD_FILTERS[k]));
      b.classList.toggle('on', on);
      b.classList.toggle('zero', k !== 'open' && c[k] === 0);
      b.setAttribute('aria-pressed', String(on));
    });

    // 상태별 칩: 지금 보기(미해결 · 이월 · …)의 상태별 건수. 누르면 그 상태만, 다시 누르면 해제
    const base = searchedRows();
    const counts = Object.keys(L.STATUS).map((k) => [k, base.filter((r) => (L.STATUS[r.status] ? r.status : 'open') === k).length]).filter(([, n]) => n > 0);
    $('status-chips').replaceChildren(...counts.map(([k, n]) => {
      const on = isActive('status', k);
      const b = el('button', { type: 'button', class: 'st-chip' + (on ? ' on' : ''), 'aria-pressed': String(on) }, el('span', { class: 'dot' }), el('span', { text: L.statusName(k, state.lang) }), el('b', { text: String(n) }));
      b.style.setProperty('--c', L.STATUS[k].color);
      b.addEventListener('click', () => { state.filters.status = on ? [] : [k]; filtersChanged(); });
      return b;
    }));
    const k = L.kpi(base);
    $('kpi-ticketed').textContent = String(k.ticketed);
    $('kpi-ticketed-of').textContent = String(k.total);
    $('kpi-ticketed-sub').textContent = k.total ? t('kpi.noTicket', { n: k.total - k.ticketed }) : '';
    $('kpi-ticketed-bar').style.width = k.total ? `${Math.round((k.ticketed / k.total) * 100)}%` : '0%';
  }
  document.querySelectorAll('.cards .card').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.card;
    const target = CARD_FILTERS[k];
    // 이미 켜진 카드를 다시 누르면 해제
    const on = b.classList.contains('on') && k !== 'open';
    state.view = 'open';
    state.filters = on ? {} : JSON.parse(JSON.stringify(target));
    saveListPrefs();
    filtersChanged();
  }));

  function isActive(type, value) { return (state.filters[type] || []).includes(value); }
  function toggleFilter(type, value) {
    const cur = state.filters[type] || [];
    state.filters[type] = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
    filtersChanged();
  }
  function filtersChanged() { renderCards(); renderSidebar(); renderList(); }

  // 필터 칩 줄: 종류마다 칩 하나. 누르면 메뉴(항목 · 건수, 여러 개 고르기), 걸린 값은 칩에 이름으로
  const FILTER_TYPES = ['severity', 'status', 'device', 'assignee', 'issue'];
  let openMenu = null;
  function renderFilterChips() {
    const chips = [...FILTER_TYPES, ...(isActive('age', 'overdue') ? ['age'] : [])].map((type) => {
      const vals = state.filters[type] || [];
      const label = t(`fchip.${type}`);
      const chip = el('span', { class: 'fchip' + (vals.length ? ' on' : '') });
      const btn = el('button', { type: 'button', class: 'fchip-btn', 'aria-haspopup': 'true', 'aria-expanded': String(openMenu === type) },
        el('span', { text: type === 'age' ? label : vals.length ? `${label}: ${vals.map((v) => filterValueName(type, v)).join(', ')}` : label }),
        type === 'age' ? null : el('span', { class: 'caret', 'aria-hidden': 'true', text: '▾' }));
      if (type !== 'age') btn.addEventListener('click', (e) => { e.stopPropagation(); openMenu = openMenu === type ? null : type; renderFilterChips(); });
      chip.append(btn);
      if (vals.length) {
        const x = el('button', { type: 'button', class: 'fchip-x', 'aria-label': t('fchip.remove', { name: label }), text: '✕' });
        x.addEventListener('click', () => { state.filters[type] = []; openMenu = null; filtersChanged(); });
        chip.append(x);
      }
      if (openMenu === type) chip.append(filterMenu(type));
      return chip;
    });
    $('filter-chips').replaceChildren(...chips);
    // 메뉴가 화면 오른쪽 밖으로 나가면 칩 오른쪽 끝에 맞춘다 (좁은 화면)
    const menu = $('filter-chips').querySelector('.fmenu');
    if (menu && menu.getBoundingClientRect().right > document.documentElement.clientWidth - 8) menu.classList.add('right');
    $('filters-clear').hidden = !Object.values(state.filters).some((v) => v && v.length);
  }
  function filterMenu(type) {
    // 건수는 지금 보기 + 다른 종류의 필터를 건 상태 기준 (이 종류를 고르면 몇 건이 남는지)
    const others = { ...state.filters, [type]: [] };
    const base = L.applyFilters(searchedRows(), others, summaryView().issues, state.yt);
    const opts = L.filterOptions(base, type, summaryView().issues, state.yt).filter(([v, n]) => n > 0 || isActive(type, v));
    const menu = el('div', { class: 'fmenu', role: 'menu' });
    menu.addEventListener('click', (e) => e.stopPropagation());
    if (!opts.length) menu.append(el('p', { class: 'muted small', text: type === 'issue' ? t('fchip.issueNone') : t('fchip.empty') }));
    opts.forEach(([v, n]) => {
      const on = isActive(type, v);
      const item = el('button', { type: 'button', role: 'menuitemcheckbox', 'aria-checked': String(on), class: 'fmenu-item' + (on ? ' on' : '') },
        el('span', { class: 'check', 'aria-hidden': 'true', text: on ? '✓' : '' }), el('span', { class: 'lbl', text: filterValueName(type, v) }), el('b', { text: String(n) }));
      item.addEventListener('click', () => toggleFilter(type, v));
      menu.append(item);
    });
    return menu;
  }
  document.addEventListener('click', () => { if (openMenu) { openMenu = null; renderFilterChips(); } });
  $('filters-clear').addEventListener('click', () => { state.filters = {}; openMenu = null; filtersChanged(); });

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
    // 주요 이슈 · 특이사항은 AI 가 그 달 CS 를 분석한 결과 (요약 본문은 보이지 않음). 분석 뒤 새로 들어온 건은 안내
    const stale = s && state.rows.length > s.ticket_count ? state.rows.length - s.ticket_count : 0;
    $('summary-meta').textContent = busyHere ? t('report.analyzing') : s ? t('report.analyzed', { when: fmtShort(s.generated_at) }) + (stale ? ` · ${t('report.stale', { n: stale })}` : '') : '';
    $('summary-gen-btn').textContent = t('report.reanalyze');
    $('summary-gen-btn').hidden = !s && !state.rows.length;
    $('summary-gen-btn').disabled = state.summaryBusy || state.loading;
    $('filter-clear').hidden = !Object.values(state.filters).some((v) => v && v.length);
    const mk = L.kpi(state.rows);
    $('report-count').textContent = t('report.count', { n: mk.total, open: mk.open });

    // 주요 이슈
    const issueBox = $('issue-list');
    const view = summaryView();
    const issues = L.issueCounts(view.issues, state.rows);
    if (!s) issueBox.replaceChildren(el('p', { class: 'side-empty', text: busyHere ? t('report.analyzing') : state.rows.length ? t('report.notYet') : t('side.noRows') }));
    else if (!issues.length) issueBox.replaceChildren(el('p', { class: 'side-empty', text: t('sum.oldFormat') }));
    else issueBox.replaceChildren(...(view.noEn ? [el('p', { class: 'side-empty', text: t('sum.noEn') })] : []), ...issues.map((is, i) => {
      // 라벨 + 건수만. 설명은 툴팁으로 내려 사이드바를 짧게 유지한다
      const b = el('button', { type: 'button', class: 'issue-btn' + (isActive('issue', i) ? ' active' : ''), title: is.detail || '' },
        el('span', { class: 'issue-head' }, el('span', { class: 'swatch' }), el('span', { class: 'issue-label', text: is.label })),
        el('b', { text: String(is.count) }));
      b.style.setProperty('--c', L.ISSUE_COLORS[i % L.ISSUE_COLORS.length]);
      b.disabled = is.count === 0;
      b.addEventListener('click', () => filterFromReport('issue', i));
      return b;
    }));

    // 심각도별 (4단계 모두 표시, 0건은 비활성)
    const sevCounts = Object.keys(L.SEVERITY).map((k) => [k, state.rows.filter((r) => L.severityOf(r, state.yt) === k).length]);
    const sevMax = Math.max(1, ...sevCounts.map(([, n]) => n));
    $('severity-list').replaceChildren(...sevCounts.map(([k, n]) => {
      const fill = el('span');
      fill.style.width = `${Math.round((n / sevMax) * 100)}%`;
      fill.style.background = L.SEVERITY[k].color;
      const b = el('button', { type: 'button', class: 'device-btn' + (isActive('severity', k) ? ' active' : '') },
        el('span', { class: 'lbl', text: L.severityLabel(k, state.lang) }),
        el('span', { class: 'bar', 'aria-hidden': 'true' }, fill),
        el('b', { text: String(n) }));
      b.disabled = n === 0 && !isActive('severity', k);
      b.addEventListener('click', () => filterFromReport('severity', k));
      return b;
    }));

    // 기기별
    const devBox = $('device-list');
    const counts = countBy(state.rows, 'device');
    const max = counts.length ? counts[0][1] : 0;
    if (!counts.length) devBox.replaceChildren(el('p', { class: 'side-empty', text: t('side.noRows') }));
    else devBox.replaceChildren(...counts.map(([d, n]) => {
      const fill = el('span');
      fill.style.width = `${Math.round((n / max) * 100)}%`;
      const b = el('button', { type: 'button', class: 'device-btn' + (isActive('device', d) ? ' active' : '') },
        el('span', { class: 'lbl', text: L.deviceLabel(d, state.lang) }),
        el('span', { class: 'bar', 'aria-hidden': 'true' }, fill),
        el('b', { text: String(n) }));
      b.addEventListener('click', () => filterFromReport('device', d));
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
    if (!asgRows.length) asgBox.replaceChildren(el('p', { class: 'side-empty', text: t('side.noRows') }));
    else asgBox.replaceChildren(...asgRows.map(([a, n]) => {
      const fill = el('span');
      fill.style.width = `${Math.round((n / asgMax) * 100)}%`;
      const b = el('button', { type: 'button', class: 'device-btn' + (isActive('assignee', a) ? ' active' : '') },
        el('span', { class: 'lbl' + (a ? '' : ' muted'), text: a || t('common.unassigned') }),
        el('span', { class: 'bar', 'aria-hidden': 'true' }, fill),
        el('b', { text: String(n) }));
      b.addEventListener('click', () => filterFromReport('assignee', a));
      return b;
    }));

    // 특이사항
    const notesBox = $('notes-list');
    const notes = view.notes;
    $('notes-count').textContent = notes.length ? String(notes.length) : '';
    // 한 줄씩 간략하게(전체 문장은 마우스를 올리면), 처음엔 3개만
    const shown = notesOpen ? notes : notes.slice(0, NOTES_SHOWN);
    notesBox.replaceChildren(...(notes.length
      ? [...shown.map((n) => el('p', { class: 'note-line', title: `${n.customer ? n.customer + ' ' : ''}${n.text}` }, n.customer ? el('span', { class: 'cust', text: n.customer }) : null, n.text)),
        ...(notes.length > NOTES_SHOWN ? [moreNotesBtn(notes.length - NOTES_SHOWN)] : [])]
      : [el('p', { class: 'muted', text: busyHere ? t('report.analyzing') : s ? t('common.none') : '—' })]));
  }
  const NOTES_SHOWN = 3;
  let notesOpen = false;
  function moreNotesBtn(n) {
    const b = el('button', { type: 'button', class: 'link-btn', text: notesOpen ? t('notes.less') : t('notes.more', { n }) });
    b.addEventListener('click', () => { notesOpen = !notesOpen; renderSidebar(); });
    return b;
  }
  $('filter-clear').addEventListener('click', () => { state.filters = {}; filtersChanged(); });

  // ───────────── 페이지: 접수 현황 / 월간 리포트 (#report 로 새로고침해도 유지) ─────────────
  let page = location.hash === '#report' ? 'report' : 'list';
  function showPage(p) {
    page = p;
    $('page-list').hidden = p !== 'list';
    $('page-report').hidden = p !== 'report';
    document.querySelectorAll('.tabs .tab').forEach((b) => {
      const on = b.dataset.page === p;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    try { history.replaceState(null, '', p === 'report' ? '#report' : location.pathname + location.search); } catch { /* 무시 */ }
    if (p === 'list' && state.selected) renderDetail();
    if (p === 'report') autoAnalyze();
  }
  document.querySelectorAll('.tabs .tab').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));
  // 리포트에서 이슈 · 막대를 누르면: 접수 현황으로 가서 그 달 접수(완료 포함)를 그 조건으로 걸러 본다
  function filterFromReport(type, value) {
    state.view = 'all';
    state.listMonth = state.month;
    state.filters = { [type]: [value] };
    saveListPrefs();
    showPage('list');
    filtersChanged();
    loadTickets({ rows: visibleRows().slice(0, 300) });
  }
  $('report-csv').addEventListener('click', () => exportCsv(state.rows, `CS_${state.month}.csv`));

  // ───────────── 툴바 ─────────────
  $('prev-month').addEventListener('click', () => changeMonth(shiftMonth(state.month, -1)));
  $('next-month').addEventListener('click', () => changeMonth(shiftMonth(state.month, 1)));
  $('this-month').addEventListener('click', () => changeMonth(currentMonthKST()));
  $('search-input').addEventListener('input', () => { renderCards(); renderList(); loadSearchTickets(); });
  // 단축키: / 로 검색, Esc 로 열린 필터 메뉴 → 상세 순서로 닫기 (입력 중이거나 창이 열려 있으면 그대로)
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === '/' && !typing && !$('app-view').hidden) { e.preventDefault(); $('search-input').focus(); return; }
    if (e.key !== 'Escape') return;
    if (typing) return;   // 입력칸의 Esc 는 그 칸에 맡긴다 (쓰던 글을 잃지 않게. 검색칸은 브라우저가 검색어를 지움)
    if (openMenu) { openMenu = null; renderFilterChips(); return; }
    if (state.selected) { e.preventDefault(); closeDetail(); }
  });
  $('export-btn').addEventListener('click', () => exportCsv());
  $('new-btn').addEventListener('click', () => openDialog(null));

  // ───────────── 등록/수정 폼 ─────────────
  const dialog = $('cs-dialog');
  const form = $('cs-form');

  // after: 이 줄 바로 아래에 넣는다 (없으면 맨 끝)
  function addListItem(name, value = '', after = null) {
    const list = form.querySelector(`[data-list="${name}"]`);
    const input = el('input', {
      type: 'text', maxlength: '2000',
      placeholder: name === 'timeline' ? t('f.timelinePh') : t('f.ticketPh'),
    });
    input.value = value;
    const btn = (text, label, onClick) => {
      const b = el('button', { type: 'button', class: 'btn ghost small', 'aria-label': label, title: label, text });
      b.addEventListener('click', onClick);
      return b;
    };
    const remove = btn('−', t('f.removeItem'), () => row.remove());
    // 처리 타임라인은 손잡이를 끌어 순서를 바꾸고(↑↓ 키도 됨), + 로 바로 아래에 넣을 수 있다
    const tl = name === 'timeline';
    const handle = tl ? dragHandle(() => row) : null;
    const row = el('div', { class: 'list-row' }, handle, input, tl ? btn('+', t('f.insertBelow'), () => addListItem(name, '', row).focus()) : null, remove);
    if (after) after.after(row); else list.append(row);
    return input;
  }

  // 줄 순서 손잡이: 마우스·터치로 끌면 포인터 위치에 맞춰 줄을 옮기고, 포커스된 상태에서 ↑↓ 키로 한 칸씩
  function dragHandle(getRow) {
    const h = el('button', { type: 'button', class: 'drag-handle', 'aria-label': t('f.dragHandle'), title: t('f.dragHandle'), text: '⠿' });
    // 끄는 동안: 잡은 줄은 포인터를 따라 떠서 움직이고, 다른 줄은 비켜 주며, 놓일 자리는 점선 칸으로 표시.
    // DOM 순서는 손을 놓을 때 한 번만 바꾼다 (끄는 중에 줄을 옮기면 화면이 뚝뚝 끊기고 포인터 추적도 끊김)
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const row = getRow();
      const list = row.parentElement;
      const rows = [...list.children].filter((x) => x.classList.contains('list-row'));
      const idx = rows.indexOf(row);
      const rects = rows.map((x) => x.getBoundingClientRect());
      const centers = rects.map((r) => r.top + r.height / 2);
      const gap = rows.length > 1 ? rects[1].top - rects[0].bottom : 6;
      // 화면 좌표(getBoundingClientRect)와 CSS px 의 비율. CSS zoom 이 걸린 화면에서도 위치가 맞게
      const z = (rects[idx].height / row.offsetHeight) || 1;
      const step = (rects[idx].height + gap) / z;   // 비켜 갈 거리 (CSS px)
      const listTop = list.getBoundingClientRect().top;
      const startY = e.clientY;
      const slot = el('div', { class: 'drop-slot', 'aria-hidden': 'true' });
      slot.style.height = `${row.offsetHeight}px`;
      list.append(slot);
      row.classList.add('dragging');
      rows.forEach((x) => { if (x !== row) x.classList.add('shifting'); });
      document.body.classList.add('is-dragging');
      let target = idx;
      const place = (dy) => {
        row.style.transform = `translateY(${dy / z}px)`;
        target = L.dragTarget(centers, idx, centers[idx] + dy);
        rows.forEach((x, j) => { if (x !== row) x.style.transform = `translateY(${L.dragShift(j, idx, target) * step}px)`; });
        // 놓일 자리: 위로 갈 때는 그 줄의 원래 위치, 아래로 갈 때는 그 줄의 아래 끝에 맞춘 위치
        const top = target <= idx ? rects[target].top : rects[target].bottom - rects[idx].height;
        slot.style.top = `${(top - listTop) / z}px`;
      };
      place(0);
      const move = (ev) => place(ev.clientY - startY);
      const end = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', end);
        document.removeEventListener('pointercancel', end);
        rows.forEach((x) => { x.classList.remove('shifting'); x.style.transform = ''; });
        row.classList.remove('dragging');
        document.body.classList.remove('is-dragging');
        slot.remove();
        if (target !== idx) {
          const rest = rows.filter((x) => x !== row);
          if (target >= rest.length) rest[rest.length - 1].after(row); else rest[target].before(row);
        }
        h.focus();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', end);
    });
    h.addEventListener('keydown', (e) => {
      const row = getRow();
      if (e.key === 'ArrowUp' && row.previousElementSibling) { e.preventDefault(); row.previousElementSibling.before(row); h.focus(); }
      if (e.key === 'ArrowDown' && row.nextElementSibling) { e.preventDefault(); row.nextElementSibling.after(row); h.focus(); }
    });
    return h;
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
    form.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
    showError($('form-error'), '');
    setBusy(false);
    setDeleteConfirm(false);
    form.querySelectorAll('.list-items').forEach((l) => l.replaceChildren());

    $('dialog-title').textContent = row ? t('dialog.edit') : t('dialog.new');
    $('delete-btn').hidden = !row;
    resetPasteBox(!row);
    const f = form.elements;
    if (row) {
      f.reporter.value = row.reporter;
      f.customer.value = row.customer;
      f.received_at.value = toLocalInput(row.received_at);
      f.device.value = row.device;
      f.version.value = L.plainVersion(row.version);
      f.title.value = row.title;
      f.status.value = row.status;
      // YouTrack Priority 가 있으면 그 값을 보여 주고 잠근다. 저장할 때는 콘솔에 저장된 값을 그대로 둔다
      const ysf = L.ytSeverity(row, state.yt);
      f.severity.value = ysf ? ysf.key : L.severityKey(row);
      f.severity.disabled = !!ysf;
      $('sev-yt-note').hidden = !ysf;
      if (ysf) $('sev-yt-note').textContent = t('sev.fromYt', { ids: ysf.ids.join(', ') });
      f.status_note.value = row.status_note;
      fillAssigneeSelect(f.assignee, row.assignee || '');
      f.ticket_assignee.value = row.ticket_assignee || '';
      f.description.value = row.description;
      f.notes.value = row.notes;
      row.timeline.forEach((v) => addListItem('timeline', v));
      row.tickets.forEach((v) => addListItem('tickets', v));
      $('form-meta').textContent =
        t('dialog.meta', { created: fmtDateTime(row.created_at), updated: fmtDateTime(row.updated_at) });
    } else {
      try { f.reporter.value = localStorage.getItem(LS_REPORTER) || ''; } catch { /* 저장소 차단 시 무시 */ }
      f.received_at.value = toLocalInput(new Date().toISOString());
      f.status.value = 'open';
      f.severity.value = 'normal';
      f.severity.disabled = false;
      $('sev-yt-note').hidden = true;
      fillAssigneeSelect(f.assignee, '');
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

  // 빈 필수 칸 표시는 채우는 즉시 지운다
  form.addEventListener('input', (e) => { if (e.target.hasAttribute && e.target.hasAttribute('aria-invalid')) e.target.removeAttribute('aria-invalid'); });
  form.addEventListener('change', (e) => { if (e.target.hasAttribute && e.target.hasAttribute('aria-invalid')) e.target.removeAttribute('aria-invalid'); });

  // 한 줄 입력칸에서 Enter 를 눌러도 저장되지 않게. 리스트 항목에서는 새 항목 추가.
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    const list = e.target.closest('[data-list]');
    if (list) addListItem(list.dataset.list, '', e.target.closest('.list-row')).focus();   // 지금 줄 바로 아래에
  });

  function readForm() {
    const f = form.elements;
    const payload = {
      reporter: f.reporter.value.trim(),
      customer: f.customer.value.trim(),
      received_at: fromLocalInput(f.received_at.value),
      device: f.device.value,
      version: L.plainVersion(f.version.value),
      title: f.title.value.trim(),
      status: f.status.value,
      severity: f.severity.disabled && state.editing ? L.severityKey(state.editing) : f.severity.value,
      status_note: f.status_note.value.trim(),
      assignee: f.assignee.value.trim(),
      ticket_assignee: f.ticket_assignee.value.trim(),
      description: f.description.value.trim(),
      notes: f.notes.value.trim(),
      // 새로 쓴 이력에 날짜가 없으면 오늘 날짜를 붙인다 (원래 있던 줄은 그대로)
      timeline: listValues('timeline').map((v) => (state.editing && state.editing.timeline.includes(v) ? v : L.datedEntry(v))),
      tickets: listValues('tickets'),
    };
    const missing = [];
    // 창에 보이는 순서대로
    if (!payload.title) missing.push(t('f.nTitle'));
    if (!payload.customer) missing.push(t('f.nCustomer'));
    if (!DEVICES.includes(payload.device)) missing.push(t('f.nDevice'));
    if (!payload.received_at) missing.push(t('f.nDate'));
    if (!payload.reporter) missing.push(t('f.nReporter'));
    if (!L.STATUS[payload.status]) missing.push(t('f.nStatus'));
    if (!L.SEVERITY[payload.severity]) missing.push(t('f.nSeverity'));
    return { payload, missing };
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { payload, missing } = readForm();
    // 빈 필수 칸은 빨간 테두리로 짚고 첫 칸으로 이동
    const bad = [['title', !payload.title], ['customer', !payload.customer], ['device', !DEVICES.includes(payload.device)], ['received_at', !payload.received_at], ['reporter', !payload.reporter]];
    bad.forEach(([n, b]) => { if (b) form.elements[n].setAttribute('aria-invalid', 'true'); else form.elements[n].removeAttribute('aria-invalid'); });
    if (missing.length) {
      showError($('form-error'), t('f.required', { list: missing.join(', ') }));
      const first = bad.find(([, b]) => b);
      if (first) form.elements[first[0]].focus();
      return;
    }

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
    if (res.error) { showError($('form-error'), t('save.failed', { e: res.error.message })); return; }
    if (res.data.length === 0) { showError($('form-error'), t('conflict')); return; }

    try { localStorage.setItem(LS_REPORTER, payload.reporter); } catch { /* 무시 */ }
    rememberNames([payload.assignee, payload.ticket_assignee]);
    dialog.close();
    toast(target ? t('form.updated') : t('form.created'));
    requestTranslations([res.data[0]]);   // 보던 달 밖의 CS 를 고쳤어도 번역되게
    // 보던 목록에 머문 채 저장한 CS 를 상세에 연다 (지금 보기에 없으면 상세만 열림)
    loadAll({ selected: res.data[0].id });
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
    if (error) { showError($('form-error'), t('del.failed', { e: error.message })); return; }
    if (data.length === 0) { setDeleteConfirm(false); showError($('form-error'), t('conflict')); return; }
    dialog.close();
    toast(t('del.done'));
    loadAll();
  });

  // ───────────── Edge Function 호출 (`ai`, `tickets`) ─────────────
  // 로그인 JWT 는 supabase-js 가 자동으로 붙임. 실패 시 함수가 돌려준 { error } 메시지를 그대로 사용.
  function callAi(body) { return callFn('ai', body); }
  async function callFn(name, body) {
    const { data, error } = await sb.functions.invoke(name, { body: { ...body, lang: state.lang } });   // lang: 오류 문구·붙여넣기 안내 언어
    if (!error) return data;
    let msg = error.message || t('fn.failed');
    if (error.context && typeof error.context.json === 'function') {
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch { /* 본문 없음 */ }
    } else if (/Failed to send|fetch/i.test(msg)) {
      msg = t('fn.unreachable', { name });
    }
    throw new Error(msg);
  }

  // ── 슬랙 메시지 붙여넣기 → 폼 채우기
  function resetPasteBox(show) {
    const box = $('paste-box');
    box.hidden = !show;
    box.open = show;   // 새 CS 는 가장 빠른 길(슬랙 붙여넣기)을 펼쳐 둔다
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
    // 명단에 있는 이름만 고른다. 명단에 없으면 비워 두고 아래 힌트로 알린다
    const parsedAsg = (p.assignee || '').trim();
    const asgKnown = state.assignees.includes(parsedAsg);
    fillAssigneeSelect(f.assignee, asgKnown ? parsedAsg : '');
    const dt = parsedDateToInput(p.received_at);
    if (dt) f.received_at.value = dt;
    f.device.value = p.device && DEVICES.includes(p.device) ? p.device : '';
    f.version.value = L.plainVersion(p.version);
    f.description.value = p.description || '';
    f.notes.value = p.notes || '';
    // 댓글 → 처리 이력. 기존 입력칸은 비우고 순서대로 채운다 (붙여넣기는 새 CS 흐름에서만 쓰임)
    const tl = Array.isArray(p.timeline) ? p.timeline : [];
    form.querySelector('[data-list="timeline"]').replaceChildren();
    tl.forEach((t) => addListItem('timeline', t));
    if (!tl.length) addListItem('timeline');
    const hints = [];
    if (tl.length) hints.push(t('paste.hTimeline', { n: tl.length }));
    if (parsedAsg) hints.push(t(asgKnown ? 'paste.hAsgKnown' : 'paste.hAsgUnknown', { name: parsedAsg }));
    if (!p.received_at) hints.push(t('paste.hNoDate'));
    else if (/^\d{2}:\d{2}$/.test(p.received_at)) hints.push(t('paste.hTimeOnly'));
    if (!p.device) hints.push(t('paste.hNoDevice'));
    if (!p.title) hints.push(t('paste.hNoTitle'));
    if (p.confidence_notes) hints.push(p.confidence_notes);
    $('paste-notes').classList.remove('error');
    showError($('paste-notes'), hints.length ? t('paste.review', { list: hints.join(' / ') }) : '');
  }
  $('paste-btn').addEventListener('click', async () => {
    const text = $('paste-text').value.trim();
    if (!text) { $('paste-status').textContent = t('paste.empty'); return; }
    const btn = $('paste-btn');
    btn.disabled = true;
    $('paste-status').textContent = t('paste.running');
    showError($('paste-notes'), '');
    try {
      const { parsed } = await callAi({ mode: 'parse', text });
      applyParsed(parsed);
      $('paste-status').textContent = t('paste.done');
      // 붙여넣기 칸은 펼친 채로 둔다 (아래 「검토 필요」 안내가 함께 보이게)
      form.elements.title.focus();
    } catch (e) {
      $('paste-status').textContent = '';
      $('paste-notes').classList.add('error');
      showError($('paste-notes'), t('paste.failed', { e: e.message }));
    } finally {
      btn.disabled = false;
    }
  });

  // ── 월간 요약
  async function loadSummary() {
    const seq = ++state.summarySeq;
    state.summary = null;
    state.summaryLoadedMonth = null;
    notesOpen = false;
    renderSidebar();
    const { data, error } = await sb
      .from('cs_monthly_summaries').select('*').eq('month', state.month).maybeSingle();
    if (seq !== state.summarySeq) return;
    if (error) { showError($('summary-error'), t('sum.loadFailed', { e: error.message })); return; }
    showError($('summary-error'), '');
    state.summary = data;
    state.summaryLoadedMonth = state.month;
    renderSidebar();
    autoAnalyze();
  }
  // 리포트를 보고 있는데 그 달 분석 결과가 없으면 AI 분석을 자동으로 (결과는 DB 에 저장되어 달마다 한 번)
  function autoAnalyze() {
    if (page === 'report' && !state.loading && state.summaryLoadedMonth === state.month && !state.summary && state.rows.length && !state.summaryBusy) generateSummary();
  }
  $('summary-gen-btn').addEventListener('click', () => generateSummary());
  async function generateSummary() {
    if (state.summaryBusy) return;
    if (state.loading || !state.rows.length) { toast(t('sum.nothing')); return; }
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
      delete state.filters.issue;   // 이슈 번호가 바뀌므로
      renderSidebar();
      renderList();
      toast(t('report.done'));
    } catch (e) {
      state.summaryBusy = false;
      renderSidebar();
      if (state.month !== month) return;
      showError($('summary-error'), t('sum.failed', { e: e.message }));
    }
  }

  // ───────────── CSV 내보내기 (지금 보이는 목록 그대로) ─────────────
  function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // 엑셀 수식 인젝션 방지
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function exportCsv(rows = visibleRows(), fileName = null) {
    if (state.loading) return;
    if ($('list-error').textContent) { toast(t('csv.noList')); return; }
    if (!rows.length) { toast(t('csv.empty')); return; }
    const header = [t('csv.received'), t('csv.reporter'), t('csv.customer'), t('csv.device'), t('csv.version'), t('csv.title'), t('csv.severity'),
      t('csv.csStatus'), t('csv.csOwner'), t('csv.ticketOwner'), t('csv.ticketStatus'), t('csv.desc'), t('csv.notes'), t('csv.timeline'),
      t('csv.tickets'), t('csv.created'), t('csv.updated')];
    // 사람이 쓴 칸은 화면 언어 쪽 (번역이 없으면 원문)
    const lines = [header, ...rows.map((r) => { const f = disp(r); return [
      fmtDateTime(r.received_at), r.reporter, r.customer, L.deviceLabel(r.device, state.lang), L.plainVersion(r.version),
      f.title, L.severityLabel(L.severityOf(r, state.yt), state.lang), L.statusLabel(r, state.lang, f), r.assignee, L.ticketAssignees(r, state.yt).names.join(', '),
      L.ticketInfos(r, state.yt).filter((x) => x.yt).map((x) => `${x.id} ${x.yt.state}`).join('\n'),
      f.description, f.notes, f.timeline.join('\n'), r.tickets.join('\n'),
      fmtDateTime(r.created_at), fmtDateTime(r.updated_at),
    ]; })].map((cols) => cols.map(csvCell).join(','));
    // BOM 을 붙여야 엑셀에서 한글이 깨지지 않음
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: fileName || `CS_${searchQuery() ? 'search' : state.view}${state.listMonth ? `_${state.listMonth}` : ''}_${toLocalInput(new Date().toISOString()).slice(0, 10)}.csv` });
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
    const fromRows = state.all.flatMap((r) => [r.assignee, r.ticket_assignee]);
    const names = [...new Set([...fromRows, ...saved].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
    $('assignee-names').replaceChildren(...names.map((n) => el('option', { value: n })));
  }

  // ───────────── CS 담당 명단 (cs_assignees) ─────────────
  async function loadAssignees() {
    const { data, error } = await sb.from('cs_assignees').select('name').order('name');
    state.assigneesError = error ? t('asg.loadFailed', { e: error.message }) : '';
    if (error) toast(state.assigneesError + t('asg.schemaHint'));
    if (!error) state.assignees = data.map((x) => x.name).sort((a, b) => a.localeCompare(b, 'ko'));
    if (error && asgDialog.open) showError($('asg-error'), state.assigneesError);
    renderAsgItems();
  }

  // 드롭다운: 미지정 + 명단. 지금 값이 명단에 없으면(삭제된 이름 등) 그대로 고를 수 있게 따로 넣는다.
  function fillAssigneeSelect(sel, current) {
    const opts = [el('option', { value: '', text: t('common.unassigned') }), ...state.assignees.map((n) => el('option', { value: n, text: n }))];
    if (current && !state.assignees.includes(current)) opts.push(el('option', { value: current, text: t('asg.notOnList', { name: current }) }));
    sel.replaceChildren(...opts);
    sel.value = current;
  }

  const asgDialog = $('asg-dialog');
  let asgEditing = null;      // 이름 수정 중인 이름
  let asgDeleting = null;     // 삭제 확인 중인 이름
  let asgBusy = false;
  let asgChanged = false;     // 창을 닫을 때 목록을 다시 읽을지

  function renderAsgItems() {
    if (!asgDialog.open) return;
    const items = state.assignees.map((name) => {
      if (asgEditing === name) {
        const input = el('input', { maxlength: '100', 'aria-label': t('asg.newNameAria', { name }) });
        input.value = name;
        const save = el('button', { type: 'button', class: 'btn primary small', text: t('btn.save') });
        const cancel = el('button', { type: 'button', class: 'btn small', text: t('btn.cancel') });
        const submit = () => renameAssignee(name, input.value.trim());
        save.addEventListener('click', submit);
        cancel.addEventListener('click', () => { asgEditing = null; renderAsgItems(); });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
          if (e.key === 'Escape') { e.preventDefault(); asgEditing = null; renderAsgItems(); }
        });
        setTimeout(() => { input.focus(); input.select(); });
        return el('li', {}, input, save, cancel);
      }
      if (asgDeleting === name) {
        const yes = el('button', { type: 'button', class: 'btn danger small', text: t('btn.delete') });
        const no = el('button', { type: 'button', class: 'btn small', text: t('btn.cancel') });
        yes.addEventListener('click', () => deleteAssignee(name));
        no.addEventListener('click', () => { asgDeleting = null; renderAsgItems(); });
        return el('li', {}, el('span', { class: 'name', text: name }), el('span', { class: 'warn', text: t('asg.removeAsk') }), yes, no);
      }
      const edit = el('button', { type: 'button', class: 'link-btn', text: t('asg.rename') });
      const del = el('button', { type: 'button', class: 'link-btn', text: t('btn.delete') });
      edit.addEventListener('click', () => { asgEditing = name; asgDeleting = null; renderAsgItems(); });
      del.addEventListener('click', () => { asgDeleting = name; asgEditing = null; renderAsgItems(); });
      return el('li', {}, el('span', { class: 'name', text: name }), edit, del);
    });
    $('asg-items').replaceChildren(...(items.length ? items : [el('li', { class: 'muted small', text: t('asg.empty') })]));
    $('asg-items').querySelectorAll('button, input').forEach((n) => { n.disabled = asgBusy; });
  }

  function asgErrorText(error) {
    if (error.code === '23505') return t('asg.dup');
    if (error.code === '23514') return t('asg.invalid');
    return error.message;
  }

  async function asgRun(fn) {
    if (asgBusy) return;
    asgBusy = true;
    showError($('asg-error'), '');
    renderAsgItems();
    const msg = await fn();
    asgBusy = false;
    if (msg) { showError($('asg-error'), msg); renderAsgItems(); return; }
    asgChanged = true;
    asgEditing = null;
    asgDeleting = null;
    await loadAssignees();
  }

  function addAssignee(name) {
    return asgRun(async () => {
      if (!name) return t('asg.needName');
      const { error } = await sb.from('cs_assignees').insert({ name });
      if (error) return asgErrorText(error);
      $('asg-add-input').value = '';
      toast(t('asg.added', { name }));
      return '';
    });
  }
  function renameAssignee(oldName, newName) {
    return asgRun(async () => {
      if (!newName) return t('asg.needNewName');
      if (newName === oldName) { asgEditing = null; renderAsgItems(); return ''; }
      const { data, error } = await sb.rpc('rename_cs_assignee', { old_name: oldName, new_name: newName });
      if (error) return asgErrorText(error);
      toast(t('asg.renamed', { old: oldName, new: newName, n: data }));
      return '';
    });
  }
  function deleteAssignee(name) {
    return asgRun(async () => {
      const { error } = await sb.from('cs_assignees').delete().eq('name', name);
      if (error) return asgErrorText(error);
      toast(t('asg.removed', { name }));
      return '';
    });
  }

  $('asg-manage-btn').addEventListener('click', () => {
    asgEditing = null;
    asgDeleting = null;
    asgChanged = false;
    showError($('asg-error'), '');
    asgDialog.showModal();
    loadAssignees();     // 다른 사람이 바꿨을 수 있으니 열 때마다 최신으로
  });
  $('asg-close').addEventListener('click', () => asgDialog.close());
  asgDialog.addEventListener('close', () => {
    // 이름이 바뀌었을 수 있으니 목록·검색 결과를 다시 읽는다 (열려 있던 상세는 유지)
    if (asgChanged) loadAll({ selected: state.selected });
  });
  $('asg-add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    addAssignee($('asg-add-input').value.trim());
  });

  // ───────────── 초기화 ─────────────
  const statusSelect = form.elements.status;
  // 등록 창의 고정 선택지. 언어를 바꾸면 고른 값은 그대로 두고 글자만 다시 그린다
  function fillStaticSelects() {
    const f = form.elements;
    const keep = [f.device.value, f.severity.value, f.status.value];
    f.device.replaceChildren(el('option', { value: '', text: t('f.choose') }), ...DEVICES.map((d) => el('option', { value: d, text: L.deviceLabel(d, state.lang) })));
    f.severity.replaceChildren(...Object.keys(L.SEVERITY).map((k) => el('option', { value: k, text: L.severityLabel(k, state.lang) })));
    f.status.replaceChildren(...Object.keys(L.STATUS).map((k) => el('option', { value: k, text: L.statusName(k, state.lang) })));
    [f.device.value, f.severity.value, f.status.value] = keep;
  }
  statusSelect.addEventListener('change', () => {
    const orig = state.editing;
    form.elements.status_note.value = orig && statusSelect.value === orig.status ? orig.status_note : '';
  });
  // ───────────── 팝업 상세 ─────────────
  // 상세 패널의 「팝업으로 보기」. 바탕을 눌러도 닫히지 않고 여러 개 띄울 수 있다(같은 CS 는 하나만).
  // 머리글을 끌어 옮기고, 누른 팝업이 맨 앞으로. 달을 옮겨도 남아 있고, 데이터가 바뀌면 다시 그린다.
  const popups = new Map();   // id → { box, row }
  let popupZ = 40;
  function bringFront(box) { box.style.zIndex = String(++popupZ); }
  function openPopup(id) {
    if (popups.has(id)) { bringFront(popups.get(id).box); return; }
    const row = allRows().find((x) => x.id === id);
    if (!row) return;
    const box = el('section', { class: 'cs-popup', role: 'dialog', 'aria-modal': 'false' });
    const w = Math.min(400, innerWidth - 32), h = Math.min(560, innerHeight - 32);
    const { x, y } = L.popupPlace(popups.size, innerWidth, innerHeight, w, h);
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.width = `${w}px`;
    box.addEventListener('pointerdown', () => bringFront(box));
    popups.set(id, { box, row });
    document.body.append(box);
    renderPopup(id);
    // 내용이 길면 처음 높이를 h 로 묶는다 (그 뒤로는 오른쪽 아래 모서리로 자유롭게 늘리고 줄임)
    if (box.offsetHeight > h) box.style.height = `${h}px`;
    bringFront(box);
  }
  function closePopup(id) { const p = popups.get(id); if (p) { p.box.remove(); popups.delete(id); } }
  function renderPopups() { [...popups.keys()].forEach(renderPopup); }
  // 머리글을 잡고 끌어 옮긴다 (화면 밖으로 다 나가지 않게)
  function popupDrag(head, box) {
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      const sx = e.clientX - box.offsetLeft, sy = e.clientY - box.offsetTop;
      const move = (ev) => {
        box.style.left = `${Math.max(8 - box.offsetWidth + 80, Math.min(ev.clientX - sx, innerWidth - 80))}px`;
        box.style.top = `${Math.max(0, Math.min(ev.clientY - sy, innerHeight - 40))}px`;
      };
      const end = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', end); };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', end);
    });
  }
  // 머리글 두 번 클릭: 크게 보기 ↔ 원래 크기·위치
  function togglePopupBig(box) {
    const keys = ['left', 'top', 'width', 'height'];
    if (box.dataset.prev) {
      const prev = JSON.parse(box.dataset.prev);
      keys.forEach((k) => { box.style[k] = prev[k]; });
      delete box.dataset.prev;
      return;
    }
    box.dataset.prev = JSON.stringify(Object.fromEntries(keys.map((k) => [k, box.style[k]])));
    const b = L.popupBig(innerWidth, innerHeight);
    Object.assign(box.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
  }
  // 팝업도 상세와 같은 본문: 상태 버튼 · 상태 메모 · CS 담당 · 심각도 · 이력 추가를 바로 바꿀 수 있다
  function renderPopup(id) {
    const p = popups.get(id);
    const r = allRows().find((x) => x.id === id) || p.row;   // 목록에서 빠져도 마지막으로 본 내용을 유지
    p.row = r;
    const f = disp(r);
    const inList = allRows().some((x) => x.id === id);
    const openBtn = el('button', { type: 'button', class: 'btn xs', text: t('popup.openInDetail') });
    openBtn.disabled = !inList;
    openBtn.addEventListener('click', () => { state.selected = id; state.showOriginal = false; renderList(); renderDetail(); });
    const closeBtn = el('button', { type: 'button', class: 'btn icon xs', 'aria-label': t('popup.close'), title: t('popup.close'), text: '✕' });
    closeBtn.addEventListener('click', () => closePopup(id));
    const head = el('div', { class: 'popup-head', title: t('popup.drag') },
      el('span', { class: 'mono muted small popup-when', text: `${fmtDateTime(r.received_at)} · ${r.customer}` }),
      el('span', { class: 'panel-head-actions' }, openBtn, closeBtn));
    popupDrag(head, p.box);
    head.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) togglePopupBig(p.box); });
    // 입력 중이던 칸은 다시 그려도 값을 지킨다
    const keep = keptInputs(p.box, r.id);
    const body = el('div', { class: 'popup-body' }, ...csBody(r, { full: false }));
    restoreInputs(body, keep);
    p.box.setAttribute('aria-label', f.title || t('list.noTitle'));
    p.box.replaceChildren(head, body);
  }

  // ───────────── 번역 표시 (cs_ticket_translations) ─────────────
  // 원문은 cs_tickets 그대로. 번역본은 Edge Function `ai` 의 translate 모드가 만들어 저장한다.
  function disp(r) { return L.displayFields(r, L.cachedHash(state.hash[r.id], r), state.tr[r.id], state.lang); }
  async function hashOf(r) {
    const h = L.cachedHash(state.hash[r.id], r);
    if (h) return h;
    const hash = await L.sourceHash(r);
    state.hash[r.id] = { text: L.sourceText(r), hash };
    return hash;
  }
  function trTexts(r) { const f = disp(r); return f.translated ? [f.title, f.description, f.notes, f.status_note, ...f.timeline] : []; }
  function renderTrStatus() { showError($('tr-error'), state.trError); }
  const trPending = new Set();   // 번역 요청 중인 id (같은 CS 를 두 번 보내지 않게)

  // rows 의 번역을 읽어 겹쳐 그린다. request 면 화면 언어 번역이 없거나 오래된 것을 번역 요청
  async function loadTranslations(rows, { request = true } = {}) {
    if (!rows.length) return;
    await Promise.all(rows.map(hashOf));
    const ids = [...new Set(rows.map((r) => r.id))];
    try {
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await sb.from('cs_ticket_translations').select('ticket_id,lang,fields,source_hash').in('ticket_id', ids.slice(i, i + 200));
        if (error) throw error;
        data.forEach((x) => { state.tr[x.ticket_id] = { ...(state.tr[x.ticket_id] || {}), [x.lang]: { fields: x.fields, source_hash: x.source_hash } }; });
      }
    } catch (e) {
      // 번역 테이블이 아직 없어도 목록은 원문으로 그대로 동작한다
      state.trError = t('tr.failed', { e: e.message });
      renderTrStatus();
      return;
    }
    state.trError = '';
    renderTrStatus();
    renderList();
    renderDetail();
    if (request) await requestTranslations(rows);
  }

  async function requestTranslations(rows) {
    const need = [];
    for (const r of rows) {
      const hash = await hashOf(r);   // 원문이 바뀌었으면 새로 계산
      if (!trPending.has(r.id) && L.needsTranslation(r, hash, state.tr[r.id], state.lang)) need.push(r.id);
    }
    const ids = [...new Set(need)];
    if (!ids.length) return;
    ids.forEach((id) => trPending.add(id));
    try {
      for (let i = 0; i < ids.length; i += 20) {
        const { translations } = await callFn('ai', { mode: 'translate', ids: ids.slice(i, i + 20) });
        Object.entries(translations || {}).forEach(([id, v]) => { state.tr[id] = v; });
        renderList();
        renderDetail();
      }
      state.trError = '';
    } catch (e) {
      state.trError = t('tr.failed', { e: e.message });
    } finally {
      ids.forEach((id) => trPending.delete(id));
      renderTrStatus();
    }
  }

  // ── 기존 기록 번역: 번역이 없는 CS 가 남아 있을 때만 사이드바 아래에 보인다
  async function checkBackfill() {
    try { state.backfill.remaining = (await callFn('ai', { mode: 'translate_backfill', dry: true })).remaining || 0; }
    catch { state.backfill.remaining = 0; }   // 함수가 아직 배포 전이면 숨긴다
    renderBackfill();
  }
  function renderBackfill() {
    const b = state.backfill;
    $('backfill-box').hidden = !b.running && !b.msg && b.remaining <= 0;
    $('backfill-status').textContent = b.msg || (b.running ? t('bf.running', { n: b.remaining }) : t('bf.hint', { n: b.remaining }));
    $('backfill-btn').hidden = b.remaining <= 0;
    $('backfill-btn').disabled = b.running;
  }
  $('backfill-btn').addEventListener('click', async () => {
    const b = state.backfill;
    if (b.running) return;
    b.running = true;
    b.msg = '';
    renderBackfill();
    try {
      for (;;) {
        const { translated, remaining } = await callFn('ai', { mode: 'translate_backfill' });
        b.remaining = remaining;
        renderBackfill();
        const step = L.backfillStep(translated, remaining);
        if (step === 'done') break;
        if (step === 'stuck') throw new Error(t('fn.failed'));
      }
      b.msg = t('bf.done');
    } catch (e) {
      b.msg = t('bf.failed', { e: e.message });
    }
    b.running = false;
    renderBackfill();
    loadTranslations(allRows(), { request: false });
  });

  // 월간 요약: 영어 화면이면 영어판 (예전 요약이라 영어판이 없으면 한국어판 + 안내)
  function summaryView() {
    const s = state.summary;
    if (!s) return { issues: [], notes: [], content: '', noEn: false };
    const en = state.lang === 'en' && !!s.content_en;
    return {
      issues: (en ? s.issues_en : s.issues) || [],
      notes: (en ? s.notes_en : s.notes) || [],
      content: en ? s.content_en : s.content,
      noEn: state.lang === 'en' && !s.content_en,
    };
  }

  // ───────────── 언어 ─────────────
  function applyStaticText() {
    document.documentElement.lang = state.lang;
    document.title = t('app.title');
    document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((n) => { n.placeholder = t(n.dataset.i18nPlaceholder); });
    document.querySelectorAll('[data-i18n-aria]').forEach((n) => { n.setAttribute('aria-label', t(n.dataset.i18nAria)); });
    document.querySelectorAll('[data-i18n-title]').forEach((n) => { n.title = t(n.dataset.i18nTitle); });
    document.querySelectorAll('[data-lang-switch]').forEach((box) => {
      box.setAttribute('aria-label', t('lang.aria'));
      box.replaceChildren(...[['ko', '한국어'], ['en', 'English']].map(([l, name]) => {
        const b = el('button', { type: 'button', class: state.lang === l ? 'on' : '', 'aria-pressed': String(state.lang === l), text: name });
        b.addEventListener('click', () => setLang(l));
        return b;
      }));
    });
    renderSortSelect();
    showPage(page);
    fillStaticSelects();
  }
  function setLang(lang) {
    if (lang === state.lang) return;
    state.lang = lang;
    try { localStorage.setItem(LS_LANG, lang); } catch { /* 저장소 차단 시 이번 화면만 */ }
    applyStaticText();
    renderYtStatus();
    renderAll();
    renderBackfill();
    if (dialog.open) $('dialog-title').textContent = state.editing ? t('dialog.edit') : t('dialog.new');
    if (asgDialog.open) renderAsgItems();
    if (signedInAs) requestTranslations(workingRows());   // 새 언어 쪽 번역이 없는 건
  }

  applyStaticText();
  initAuth();
})();
