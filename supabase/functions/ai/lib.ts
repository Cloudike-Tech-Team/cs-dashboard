// 순수 함수 모음. Deno/브라우저 API 에 의존하지 않아 deno test 로 바로 검증 가능.
import { DEVICES, type Device } from './prompts.ts';

export const MAX_PARSE_CHARS = 8000;

// 사용자에게 보이는 오류 문구 (요청의 lang 으로 고른다)
export const MSG: Record<string, { ko: string; en: string }> = {
  emptyBody: { ko: '요청 본문이 비어 있습니다.', en: 'The request body is empty.' },
  badIds: { ko: 'ids 는 1~{n}개의 문자열이어야 합니다.', en: 'ids must be 1 to {n} strings.' },
  noText: { ko: '분석할 텍스트가 없습니다.', en: 'There is no text to analyze.' },
  textTooLong: { ko: '텍스트가 너무 깁니다 (최대 {n}자).', en: 'The text is too long (max {n} characters).' },
  badMonth: { ko: 'month 는 YYYY-MM 형식이어야 합니다.', en: 'month must be in YYYY-MM format.' },
  badMode: { ko: 'mode 는 parse, summarize, translate, translate_backfill 중 하나여야 합니다.', en: 'mode must be parse, summarize, translate or translate_backfill.' },
  postOnly: { ko: 'POST 만 지원합니다.', en: 'Only POST is supported.' },
  noApiKey: { ko: 'ANTHROPIC_API_KEY 가 설정되지 않았습니다. supabase secrets set 으로 등록하세요.', en: 'ANTHROPIC_API_KEY is not set. Add it with supabase secrets set.' },
  loginRequired: { ko: '로그인이 필요합니다.', en: 'Please sign in.' },
  sessionInvalid: { ko: '로그인 세션이 유효하지 않습니다. 다시 로그인하세요.', en: 'Your session has expired. Sign in again.' },
  refused: { ko: '{what}: 모델이 요청을 거부했습니다.', en: '{what}: the model refused the request.' },
  truncated: { ko: '{what}: 출력이 잘렸습니다. 다시 시도하세요.', en: '{what}: the output was cut off. Try again.' },
  badModelJson: { ko: '모델 응답을 해석하지 못했습니다. 다시 시도하세요.', en: 'Could not read the model response. Try again.' },
  trLoadFailed: { ko: '번역 조회 실패: {error}', en: 'Could not load translations: {error}' },
  trSaveFailed: { ko: '번역 저장 실패: {error}', en: 'Could not save translations: {error}' },
  csLoadFailed: { ko: 'CS 목록 조회 실패: {error}', en: 'Could not load CS records: {error}' },
  noRowsMonth: { ko: '{month} 에는 요약할 CS가 없습니다.', en: 'No CS to summarize in {month}.' },
  summarySaveFailed: { ko: '요약 저장 실패: {error}', en: 'Could not save the summary: {error}' },
  apiKeyWrong: { ko: 'Claude API 키가 잘못되었습니다.', en: 'The Claude API key is invalid.' },
  rateLimited: { ko: 'Claude API 요청 한도에 걸렸습니다. 잠시 후 다시 시도하세요.', en: 'Claude API rate limit reached. Try again shortly.' },
  apiError: { ko: 'Claude API 오류 ({status}): {error}', en: 'Claude API error ({status}): {error}' },
  unknownError: { ko: '알 수 없는 오류: {error}', en: 'Unexpected error: {error}' },
};
export function msg(lang: string, key: string, params: Record<string, unknown> = {}): string {
  const m = MSG[key];
  const s = m ? (lang === 'en' ? m.en : m.ko) : key;
  return s.replace(/\{(\w+)\}/g, (x, k) => (k in params ? String(params[k]) : x));
}

// key·params 를 들고 다니다가 응답할 때 요청 언어로 바꾼다. message 는 한국어(로그용)
export class BadRequest extends Error {
  status = 400;
  constructor(public key: string, public params: Record<string, unknown> = {}) { super(msg('ko', key, params)); }
}

export type Lang = 'ko' | 'en';
export type ParseRequest = { mode: 'parse'; text: string; lang: Lang };
export type SummarizeRequest = { mode: 'summarize'; month: string; lang: Lang };
export type TranslateRequest = { mode: 'translate'; ids: string[]; lang: Lang };
export type BackfillRequest = { mode: 'translate_backfill'; dry: boolean; lang: Lang };
export type AiRequest = ParseRequest | SummarizeRequest | TranslateRequest | BackfillRequest;

export const MAX_TRANSLATE_IDS = 20;

export function validateRequest(body: unknown): AiRequest {
  if (!body || typeof body !== 'object') throw new BadRequest('emptyBody');
  const b = body as Record<string, unknown>;
  const lang: Lang = b.lang === 'en' ? 'en' : 'ko';
  if (b.mode === 'translate') {
    const ids = b.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_TRANSLATE_IDS || !ids.every((x) => typeof x === 'string' && x)) {
      throw new BadRequest('badIds', { n: MAX_TRANSLATE_IDS });
    }
    return { mode: 'translate', ids: ids as string[], lang };
  }
  if (b.mode === 'translate_backfill') return { mode: 'translate_backfill', dry: b.dry === true, lang };
  if (b.mode === 'parse') {
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text) throw new BadRequest('noText');
    if (text.length > MAX_PARSE_CHARS) throw new BadRequest('textTooLong', { n: MAX_PARSE_CHARS });
    return { mode: 'parse', text, lang };
  }
  if (b.mode === 'summarize') {
    const month = typeof b.month === 'string' ? b.month : '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new BadRequest('badMonth');
    return { mode: 'summarize', month, lang };
  }
  throw new BadRequest('badMode');
}

// 'YYYY-MM' → [from, to) ISO. KST(+09:00) 고정 오프셋.
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return {
    from: new Date(`${month}-01T00:00:00+09:00`).toISOString(),
    to: new Date(`${next}-01T00:00:00+09:00`).toISOString(),
  };
}

export type Status = 'open' | 'waiting' | 'delayed' | 'deploy' | 'done' | 'unknown';

export type Ticket = {
  id: string;
  received_at: string;
  reporter: string;
  customer: string;
  device: string;
  version: string;
  title: string;
  status: Status;
  status_note: string;
  description: string;
  notes: string;
  timeline: string[];
  tickets: string[];
  assignee: string;         // 개발팀 CS 담당자
  ticket_assignee: string;  // 티켓 처리 중인 사람
};

// "오민식(티켓 김개발)". 같은 사람이면 이름만, 둘 다 비면 "".
export function assigneeText(r: Pick<Ticket, 'assignee' | 'ticket_assignee'>, lang: Lang = 'ko'): string {
  const a = r.assignee || '', t = r.ticket_assignee || '';
  if (!a && !t) return '';
  if (lang === 'en') return !a ? `(ticket ${t})` : t && t !== a ? `${a} (ticket ${t})` : a;
  if (!a) return `(티켓 ${t})`;
  return t && t !== a ? `${a}(티켓 ${t})` : a;
}

export const STATUS_LABEL: Record<Status, string> = {
  open: '처리 중', waiting: '대기', delayed: '지연', deploy: '배포대기', done: '완료', unknown: '원인 미확인',
};

// "처리 중(로그 대기)" 형태. 모델 입력과 마크다운에 공통 사용.
export const STATUS_LABEL_EN: Record<Status, string> = {
  open: 'In progress', waiting: 'Waiting', delayed: 'Delayed', deploy: 'To deploy', done: 'Done', unknown: 'Unknown',
};
const DEVICE_EN: Record<string, string> = { '웹': 'Web', '기타': 'Other' };
const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function statusText(r: Pick<Ticket, 'status' | 'status_note'>, lang: Lang = 'ko'): string {
  const base = (lang === 'en' ? STATUS_LABEL_EN : STATUS_LABEL)[r.status] ?? r.status;
  return r.status_note ? `${base}(${r.status_note})` : base;
}

// 입력 목록 번호(1부터)의 기준 순서. mapIssueIndexes 도 같은 순서를 쓴다.
export function sortByReceived<T extends Pick<Ticket, 'received_at' | 'id'>>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.received_at.localeCompare(b.received_at) || a.id.localeCompare(b.id));
}

export function deviceCounts(rows: Pick<Ticket, 'device'>[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.device, (counts.get(r.device) ?? 0) + 1);
  const order = (d: string) => { const i = (DEVICES as readonly string[]).indexOf(d); return i < 0 ? DEVICES.length : i; };
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || order(a[0]) - order(b[0]));
}

function kstDate(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// Claude 에 보낼 입력. 집계는 여기서 계산해 상단에 둔다 (LLM 이 숫자를 세지 않게).
export function buildSummaryInput(month: string, rows: Ticket[]): string {
  const [year, mon] = month.split('-');
  const lines: string[] = [];
  lines.push(`[집계] ${year}년 ${Number(mon)}월 · 총 ${rows.length}건 · ` +
    deviceCounts(rows).map(([d, n]) => `${d} ${n}`).join(' · '));
  lines.push('');
  lines.push('[CS 목록] 번호. 날짜 | 고객사 | 기기 | 버전 | 제목 | 현상 | 특이사항 | 타임라인 | 티켓 | 상태 | 담당');
  sortByReceived(rows).forEach((r, i) => {
    lines.push([
      `${i + 1}. ${kstDate(r.received_at)}`,
      r.customer,
      r.device,
      r.version || '-',
      oneLine(r.title) || '-',
      oneLine(r.description) || '-',
      oneLine(r.notes) || '-',
      r.timeline.map(oneLine).join(' → ') || '(없음)',
      r.tickets.join(', ') || '-',
      statusText(r),
      assigneeText(r) || '-',
    ].join(' | '));
  });
  return lines.join('\n');
}

export function summaryUserMessage(month: string, rows: Ticket[]): string {
  const [year, mon] = month.split('-');
  return `${buildSummaryInput(month, rows)}\n\n위 목록으로 ${year}년 ${Number(mon)}월의 주요 이슈와 특이사항을 JSON 으로 작성하세요. ticket_indexes 에는 위 목록의 번호를 넣습니다.`;
}

export type Parsed = {
  reporter: string | null;
  customer: string | null;
  title: string;
  received_at: string | null;
  device: Device | null;
  version: string;
  description: string;
  notes: string;
  timeline: string[];       // 댓글(스레드) → 처리 이력. "MM/DD 작성자: 내용" 한 줄씩, 시간순
  assignee: string;         // 본문·댓글에서 지정된 개발팀 담당자. 없으면 ""
  confidence_notes: string;
};

// 구조화 출력이라 스키마는 보장되지만, 방어적으로 한 번 더 정리.
export function normalizeParsed(raw: unknown): Parsed {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const strOrNull = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const device = (DEVICES as readonly string[]).includes(o.device as string) ? (o.device as Device) : null;
  let received_at = strOrNull(o.received_at);
  if (received_at && !/^(\d{4}-\d{2}-\d{2}T)?\d{2}:\d{2}$/.test(received_at)) received_at = null;
  const timeline = (Array.isArray(o.timeline) ? o.timeline : [])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().slice(0, 2000))
    .filter(Boolean)
    .slice(0, 50);
  return {
    reporter: strOrNull(o.reporter),
    customer: strOrNull(o.customer),
    title: str(o.title),
    received_at,
    device,
    version: str(o.version),
    description: str(o.description),
    notes: str(o.notes),
    timeline,
    assignee: str(o.assignee).slice(0, 100),
    confidence_notes: str(o.confidence_notes),
  };
}

// ───────────── summarize 구조화 출력 처리 ─────────────
export type RawIssue = { label: string; detail: string; ticket_indexes: number[] };
export type Issue = { label: string; detail: string; ticket_ids: string[] };
export type Note = { customer: string; text: string };

export const MAX_ISSUES = 5;
export const MAX_NOTES = 5;

// 구조화 출력이라 형태는 보장되지만 방어적으로 정리. 개수 제한은 여기서(스키마의 maxItems 는 미지원).
export function normalizeSummary(raw: unknown): { issues: RawIssue[]; notes: Note[]; issuesEn: RawIssue[]; notesEn: Note[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const obj = (v: unknown) => (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const rawIssues = arr(o.issues).slice(0, MAX_ISSUES).map(obj);
  const idx = (i: Record<string, unknown>) => arr(i.ticket_indexes).filter((n): n is number => Number.isInteger(n));
  const issues = rawIssues.map((i) => ({ label: str(i.label), detail: str(i.detail), ticket_indexes: idx(i) }));
  // 영어 칸이 비면 한국어 값 (예전 형식 응답 대비)
  const issuesEn = rawIssues.map((i) => ({ label: str(i.label_en) || str(i.label), detail: str(i.detail_en) || str(i.detail), ticket_indexes: idx(i) }));
  const rawNotes = arr(o.notes).slice(0, MAX_NOTES).map(obj).filter((n) => str(n.text));
  const notes = rawNotes.map((n) => ({ customer: str(n.customer), text: str(n.text) }));
  const notesEn = rawNotes.map((n) => ({ customer: str(n.customer), text: str(n.text_en) || str(n.text) }));
  return { issues, notes, issuesEn, notesEn };
}

// 목록 번호(1부터, sortByReceived 순서) → 행 id. 범위 밖·중복은 버리고, 남는 id 가 없거나 라벨이 비면 이슈 제거.
export function mapIssueIndexes(issues: RawIssue[], rows: Pick<Ticket, 'id' | 'received_at'>[]): Issue[] {
  const sorted = sortByReceived(rows);
  const out: Issue[] = [];
  for (const is of issues) {
    const ids = new Set<string>();
    for (const i of is.ticket_indexes) {
      if (Number.isInteger(i) && i >= 1 && i <= sorted.length) ids.add(sorted[i - 1].id);
    }
    const label = oneLine(is.label);
    if (ids.size && label) out.push({ label, detail: oneLine(is.detail), ticket_ids: [...ids] });
  }
  return out;
}

// content 컬럼은 20,000자 제한. 미해결 목록은 LLM max_tokens 로 잘리지 않으므로 여기서 길이를 묶는다.
export const MAX_UNRESOLVED = 30;
const MAX_NOTE_TEXT = 200;
export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// 미해결 목록은 LLM 에 맡기지 않고 status 로 만든다.
// tr: 영어판에서 쓸 번역 칸 (id → en 번역). 없으면 원문
export function unresolvedLines(rows: Ticket[], lang: Lang = 'ko', tr?: Map<string, TrFields>): string[] {
  const en = lang === 'en';
  return sortByReceived(rows).filter((r) => r.status !== 'done').map((r0) => {
    const f = tr && tr.get(r0.id);
    const r = f ? { ...r0, ...f } : r0;
    const what = clip(oneLine(r.title) || oneLine(r.description) || (en ? '(no content)' : '(내용 없음)'), 80);
    // 처리 중: 메모 → 마지막 타임라인. 그 외 상태(대기·지연·배포대기·원인 미확인): 상태 이름(메모).
    const state = clip(r.status === 'open'
      ? r.status_note || (r.timeline.length ? oneLine(r.timeline[r.timeline.length - 1]) : (en ? 'No action yet' : '조치 이력 없음'))
      : statusText(r, lang), 100);
    const tickets = r.tickets.length ? ` · ${clip(r.tickets.join(', '), 100)}` : '';
    const who = assigneeText(r, lang);
    return `**${r.customer}** — ${what} · ${state}${tickets}${who ? ` · ${en ? 'Owner' : '담당'} ${who}` : ''}`;
  });
}

export function buildSummaryMarkdown(month: string, rows: Ticket[], issues: Issue[], notes: Note[], lang: Lang = 'ko', tr?: Map<string, TrFields>): string {
  const [year, mon] = month.split('-');
  const en = lang === 'en';
  const none = en ? '- None' : '- 없음';
  const devices = deviceCounts(rows).map(([d, n]) => `${en ? DEVICE_EN[d] || d : d} ${n}`).join(' · ');
  const lines: string[] = [
    en ? `## CS summary · ${MONTH_EN[Number(mon) - 1]} ${year}` : `## ${year}년 ${Number(mon)}월 CS 요약`, '',
    (en ? `**${rows.length} total** · ` : `**총 ${rows.length}건** · `) + devices, '',
    en ? '### Key issues' : '### 주요 이슈',
  ];
  if (issues.length) issues.forEach((is, i) => lines.push(`${i + 1}. **${is.label}** (${is.ticket_ids.length}${en ? '' : '건'}) — ${is.detail}`));
  else lines.push(none);
  lines.push('', en ? '### Open' : '### 미해결');
  const un = unresolvedLines(rows, lang, tr);
  lines.push(...(un.length ? un.slice(0, MAX_UNRESOLVED).map((l) => `- ${l}`) : [none]));
  if (un.length > MAX_UNRESOLVED) lines.push(en ? `- and ${un.length - MAX_UNRESOLVED} more` : `- 외 ${un.length - MAX_UNRESOLVED}건`);
  lines.push('', en ? '### Notes' : '### 특이사항');
  lines.push(...(notes.length ? notes.map((n) => `- **${n.customer}** ${clip(oneLine(n.text), MAX_NOTE_TEXT)}`) : [none]));
  return lines.join('\n');
}

// ───────────── 번역 (cs_ticket_translations) ─────────────
// 원문 칸. 규칙을 바꾸면 js/lib.js 의 sourceText 도 같이 바꾼다 (양쪽 테스트가 같은 해시를 검사)
export type TrFields = { title: string; description: string; notes: string; status_note: string; timeline: string[] };
export type TrSource = TrFields & { id: string };
export const MAX_TRANSLATE_ROWS_PER_CALL = 10;

export function sourceText(r: Partial<TrFields>): string {
  return JSON.stringify([r.title || '', r.description || '', r.notes || '', r.status_note || '', r.timeline || []]);
}
export async function sourceHash(r: Partial<TrFields>): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceText(r)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// js/lib.js 의 TL_RE 와 같은 규칙. 날짜·시각 앞부분은 번역하지 않고 원문 그대로 다시 붙인다
const TL_RE = /^(?:\d{4}-)?(\d{1,2})[/-](\d{1,2})(?:\s+\d{1,2}:\d{2})?(?:\s+|$)/;
export function splitTimelinePrefix(entry: string): { prefix: string; text: string } {
  const m = entry.match(TL_RE);
  if (m) {
    const mo = Number(m[1]), d = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return { prefix: m[0], text: entry.slice(m[0].length) };
  }
  return { prefix: '', text: entry };
}

// 한 줄에 CS 하나씩 JSON. index 는 1부터
export function translateInput(rows: TrSource[]): string {
  return rows.map((r, i) => JSON.stringify({
    index: i + 1, title: r.title || '', description: r.description || '', notes: r.notes || '', status_note: r.status_note || '',
    timeline: (r.timeline || []).map((t) => splitTimelinePrefix(t).text),
  })).join('\n');
}

// 번역문에서 사라지면 안 되는 것: 고객사·유저 번호, 티켓 ID, URL
const KEEP_RES = [/\bcom\s?\d+/gi, /\buser\s?\d+/gi, /\b[A-Z][A-Z0-9_]*-\d+\b/g, /https?:\/\/\S+/g];
function keepsTokens(orig: string, tr: string): boolean {
  const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  const t = squash(tr);
  return KEEP_RES.every((re) => (orig.match(re) || []).every((tok) => t.includes(squash(tok))));
}

const SCALARS = ['title', 'description', 'notes', 'status_note'] as const;
function pickLang(raw: unknown, orig: TrSource): TrFields {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = {} as TrFields;
  for (const k of SCALARS) {
    const src = orig[k] || '';
    const v = typeof o[k] === 'string' ? (o[k] as string).trim() : '';
    out[k] = !src ? '' : v && keepsTokens(src, v) ? v : src;
  }
  const tl = orig.timeline || [];
  const got = Array.isArray(o.timeline) ? o.timeline : null;
  out.timeline = got && got.length === tl.length && got.every((x) => typeof x === 'string')
    ? tl.map((entry, i) => {
      const { prefix, text } = splitTimelinePrefix(entry);
      const v = (got[i] as string).trim();
      return v && keepsTokens(text, v) ? prefix + v : entry;
    })
    : [...tl];
  return out;
}

// 모델 응답 { items: [{ index, ko, en }] } → id 별 두 언어. 잘못된 칸은 원문으로
export function normalizeTranslation(raw: unknown, rows: TrSource[]): Map<string, { ko: TrFields; en: TrFields }> {
  const out = new Map<string, { ko: TrFields; en: TrFields }>();
  const items = raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const { index, ko, en } = it as { index?: unknown; ko?: unknown; en?: unknown };
    const row = typeof index === 'number' && Number.isInteger(index) ? rows[index - 1] : undefined;
    if (!row || out.has(row.id)) continue;
    out.set(row.id, { ko: pickLang(ko, row), en: pickLang(en, row) });
  }
  return out;
}

// 한 번의 Claude 호출에 넣을 원문 분량. 출력은 ko·en 두 벌이라 입력의 두 배 넘게 나온다 (max_tokens 16000 안에 들게)
export const MAX_CHARS_PER_CALL = 5000;
// 월간 요약은 한국어·영어 이슈·특이사항을 함께 내므로 넉넉히
export const SUMMARY_MAX_TOKENS = 8192;

// 모델 출력이 max_tokens 에서 잘렸음
export class Truncated extends Error {}

// 건수·원문 글자 수 한도로 묶는다. 한 건이 한도를 넘으면 혼자 한 묶음
export function chunkRows(rows: TrSource[], maxRows = MAX_TRANSLATE_ROWS_PER_CALL, maxChars = MAX_CHARS_PER_CALL): TrSource[][] {
  const chunks: TrSource[][] = [];
  let cur: TrSource[] = [], chars = 0;
  for (const r of rows) {
    const n = translateInput([r]).length;
    if (cur.length && (cur.length >= maxRows || chars + n > maxChars)) { chunks.push(cur); cur = []; chars = 0; }
    cur.push(r); chars += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// 묶음마다 call 을 부르고 정규화한다. 출력이 잘리면(Truncated) 반으로 나눠 다시, 한 건만으로 잘리면 그 건은 tooLong 으로.
// 그 밖의 오류는 그대로 던진다.
export async function translateInChunks(
  rows: TrSource[], call: (chunk: TrSource[]) => Promise<unknown>,
  maxRows = MAX_TRANSLATE_ROWS_PER_CALL, maxChars = MAX_CHARS_PER_CALL,
): Promise<{ got: Map<string, { ko: TrFields; en: TrFields }>; tooLong: TrSource[] }> {
  const got = new Map<string, { ko: TrFields; en: TrFields }>();
  const tooLong: TrSource[] = [];
  const run = async (chunk: TrSource[]): Promise<void> => {
    try {
      normalizeTranslation(await call(chunk), chunk).forEach((v, k) => got.set(k, v));
    } catch (e) {
      if (!(e instanceof Truncated)) throw e;
      if (chunk.length === 1) { tooLong.push(chunk[0]); return; }
      const mid = Math.ceil(chunk.length / 2);
      await run(chunk.slice(0, mid));
      await run(chunk.slice(mid));
    }
  };
  for (const c of chunkRows(rows, maxRows, maxChars)) await run(c);
  return { got, tooLong };
}
