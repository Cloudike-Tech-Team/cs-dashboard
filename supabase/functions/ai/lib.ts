// 순수 함수 모음. Deno/브라우저 API 에 의존하지 않아 deno test 로 바로 검증 가능.
import { DEVICES, type Device } from './prompts.ts';

export const MAX_PARSE_CHARS = 8000;

export class BadRequest extends Error {
  status = 400;
}

export type ParseRequest = { mode: 'parse'; text: string };
export type SummarizeRequest = { mode: 'summarize'; month: string };

export function validateRequest(body: unknown): ParseRequest | SummarizeRequest {
  if (!body || typeof body !== 'object') throw new BadRequest('요청 본문이 비어 있습니다.');
  const b = body as Record<string, unknown>;
  if (b.mode === 'parse') {
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text) throw new BadRequest('분석할 텍스트가 없습니다.');
    if (text.length > MAX_PARSE_CHARS) throw new BadRequest(`텍스트가 너무 깁니다 (최대 ${MAX_PARSE_CHARS}자).`);
    return { mode: 'parse', text };
  }
  if (b.mode === 'summarize') {
    const month = typeof b.month === 'string' ? b.month : '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new BadRequest('month 는 YYYY-MM 형식이어야 합니다.');
    return { mode: 'summarize', month };
  }
  throw new BadRequest('mode 는 parse 또는 summarize 여야 합니다.');
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

export type Status = 'open' | 'done' | 'unknown';

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
};

export const STATUS_LABEL: Record<Status, string> = { open: '처리 중', done: '완료', unknown: '원인 미확인' };

// "처리 중(로그 대기)" 형태. 모델 입력과 마크다운에 공통 사용.
export function statusText(r: Pick<Ticket, 'status' | 'status_note'>): string {
  const base = STATUS_LABEL[r.status] ?? r.status;
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
  lines.push('[CS 목록] 번호. 날짜 | 고객사 | 기기 | 버전 | 제목 | 현상 | 특이사항 | 타임라인 | 티켓 | 상태');
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
  return {
    reporter: strOrNull(o.reporter),
    customer: strOrNull(o.customer),
    title: str(o.title),
    received_at,
    device,
    version: str(o.version),
    description: str(o.description),
    notes: str(o.notes),
    confidence_notes: str(o.confidence_notes),
  };
}
