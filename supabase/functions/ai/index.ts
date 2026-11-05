// CS 대시보드 AI Edge Function
//   mode=parse     : 슬랙 메시지 텍스트 → 폼 필드 JSON
//   mode=summarize : 해당 월 cs_tickets → 월간 요약 마크다운 (cs_monthly_summaries 에 저장)
// 인증: 요청 JWT 로 auth.getUser() 가 성공해야만 Claude 를 호출한다.
// 배포: npx supabase functions deploy ai --no-verify-jwt   (검증은 여기서 직접 함)

import Anthropic from 'npm:@anthropic-ai/sdk@0.133.0';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { MODEL, PARSE_SCHEMA, PARSE_SYSTEM, SUMMARY_SCHEMA, SUMMARY_SYSTEM, TRANSLATE_SCHEMA, TRANSLATE_SYSTEM } from './prompts.ts';
import {
  BadRequest, msg, buildSummaryMarkdown, mapIssueIndexes, MAX_TRANSLATE_IDS, MAX_TRANSLATE_ROWS_PER_CALL, monthRange, normalizeParsed,
  normalizeSummary, normalizeTranslation, sourceHash, summaryUserMessage, translateInput, validateRequest, type Lang, type Ticket, type TrFields, type TrSource,
} from './lib.ts';

// deno-lint-ignore no-explicit-any
type Sb = SupabaseClient<any, 'public', 'public', any, any>;
const TR_COLS = 'id,title,description,notes,status_note,timeline';
const PAGE = 1000;
const MAX_CHARS_PER_CALL = 12000;   // 한 번의 Claude 호출에 넣을 원문 분량

function isBlank(r: TrSource): boolean {
  return !r.title && !r.description && !r.notes && !r.status_note && !(r.timeline || []).length;
}

// 두 언어 번역이 모두 최신인지. hashes: 원문 해시, have: { id: { ko: hash, en: hash } }
function isFresh(id: string, hash: string, have: Map<string, Record<string, string>>): boolean {
  const h = have.get(id);
  return !!h && h.ko === hash && h.en === hash;
}

async function translationHashes(sb: Sb, ids: string[] | null): Promise<Map<string, Record<string, string>>> {
  const have = new Map<string, Record<string, string>>();
  for (let offset = 0; ; offset += PAGE) {
    let q = sb.from('cs_ticket_translations').select('ticket_id,lang,source_hash').order('ticket_id').order('lang').range(offset, offset + PAGE - 1);
    if (ids) q = q.in('ticket_id', ids);
    const { data, error } = await q;
    if (error) throw new HttpError(500, 'trLoadFailed', { error: error.message });
    for (const t of data as { ticket_id: string; lang: string; source_hash: string }[]) {
      have.set(t.ticket_id, { ...(have.get(t.ticket_id) || {}), [t.lang]: t.source_hash });
    }
    if (data.length < PAGE) return have;
  }
}

// rows 를 묶어 Claude 로 번역하고 cs_ticket_translations 에 upsert. cs_tickets 에는 쓰지 않는다.
async function translateRows(claude: Anthropic, sb: Sb, rows: TrSource[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const chunks: TrSource[][] = [];
  let cur: TrSource[] = [], chars = 0;
  for (const r of rows) {
    const n = translateInput([r]).length;
    if (cur.length && (cur.length >= MAX_TRANSLATE_ROWS_PER_CALL || chars + n > MAX_CHARS_PER_CALL)) { chunks.push(cur); cur = []; chars = 0; }
    cur.push(r); chars += n;
  }
  if (cur.length) chunks.push(cur);

  for (const chunk of chunks) {
    const res = await claude.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: TRANSLATE_SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: TRANSLATE_SCHEMA } },
      messages: [{ role: 'user', content: `다음 CS 기록을 옮기세요.\n\n${translateInput(chunk)}` }],
    });
    checkStop(res, 'translate');
    let raw: unknown;
    try { raw = JSON.parse(textOf(res)); }
    catch { throw new HttpError(502, 'badModelJson'); }
    const got = normalizeTranslation(raw, chunk);
    const upserts = [];
    for (const r of chunk) {
      const tr = got.get(r.id);
      if (!tr) continue;
      const source_hash = await sourceHash(r);
      const translated_at = new Date().toISOString();
      upserts.push({ ticket_id: r.id, lang: 'ko', fields: tr.ko, source_hash, translated_at });
      upserts.push({ ticket_id: r.id, lang: 'en', fields: tr.en, source_hash, translated_at });
      out[r.id] = { ko: { fields: tr.ko, source_hash }, en: { fields: tr.en, source_hash } };
    }
    if (upserts.length) {
      const { error } = await sb.from('cs_ticket_translations').upsert(upserts, { onConflict: 'ticket_id,lang' });
      if (error) throw new HttpError(500, 'trSaveFailed', { error: error.message });
    }
  }
  return out;
}

// 번역이 없거나 원문이 바뀐 CS (오래된 순)
async function staleRows(sb: Sb, rows: TrSource[], ids: string[] | null): Promise<TrSource[]> {
  const have = await translationHashes(sb, ids);
  const stale: TrSource[] = [];
  for (const r of rows) {
    if (isBlank(r)) continue;
    if (!isFresh(r.id, await sourceHash(r), have)) stale.push(r);
  }
  return stale;
}

// 요약 영어판용: 원문이 그대로인(해시 일치) 영어 번역만. 번역 테이블이 없거나 실패하면 빈 맵 (요약은 원문으로)
async function freshEnglish(sb: Sb, rows: Ticket[]): Promise<Map<string, TrFields>> {
  const out = new Map<string, TrFields>();
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { data, error } = await sb.from('cs_ticket_translations').select('ticket_id,fields,source_hash')
      .eq('lang', 'en').in('ticket_id', chunk.map((r) => r.id));
    if (error) { console.error('freshEnglish', error.message); return out; }
    const byId = new Map((data as { ticket_id: string; fields: TrFields; source_hash: string }[]).map((t) => [t.ticket_id, t]));
    for (const r of chunk) {
      const t = byId.get(r.id);
      if (t && t.source_hash === await sourceHash(r)) out.set(r.id, t.fields);
    }
  }
  return out;
}

async function allTicketSources(sb: Sb): Promise<TrSource[]> {
  const rows: TrSource[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb.from('cs_tickets').select(TR_COLS)
      .order('received_at', { ascending: true }).order('id', { ascending: true }).range(offset, offset + PAGE - 1);
    if (error) throw new HttpError(500, 'csLoadFailed', { error: error.message });
    rows.push(...(data as TrSource[]));
    if (data.length < PAGE) return rows;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// key·params 는 응답할 때 요청 언어로 바꾼다 (lib.ts MSG)
class HttpError extends Error {
  constructor(public status: number, public key: string, public params: Record<string, unknown> = {}) { super(msg('ko', key, params)); }
}

function textOf(res: Anthropic.Message): string {
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function checkStop(res: Anthropic.Message, what: string) {
  if (res.stop_reason === 'refusal') throw new HttpError(502, 'refused', { what });
  if (res.stop_reason === 'max_tokens') throw new HttpError(502, 'truncated', { what });
  console.log(JSON.stringify({ what, model: res.model, usage: res.usage }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: msg('ko', 'postOnly') }, 405);

  // 오류 문구 언어. 본문을 먼저 읽어 정한다 (Claude 호출은 아래 인증 뒤에만)
  const rawBody = await req.json().catch(() => null);
  const lang: Lang = rawBody && typeof rawBody === 'object' && (rawBody as Record<string, unknown>).lang === 'en' ? 'en' : 'ko';
  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) throw new HttpError(500, 'noApiKey');

    // ── 인증: 요청자의 JWT 로 Supabase 클라이언트 생성 → RLS 가 그대로 적용됨
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) throw new HttpError(401, 'loginRequired');
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
    );
    const { data: { user }, error: authErr } = await sb.auth.getUser();
    if (authErr || !user) throw new HttpError(401, 'sessionInvalid');

    const body = validateRequest(rawBody);
    // 워크스페이스에 묶이지 않은(기본) API 키는 anthropic-workspace-id 헤더가 필요함.
    // Console → Settings → Workspaces 의 ID (wrkspc_...) 를 ANTHROPIC_WORKSPACE_ID secret 으로 등록.
    const workspaceId = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
    const claude = new Anthropic({
      apiKey,
      defaultHeaders: workspaceId ? { 'anthropic-workspace-id': workspaceId } : undefined,
    });

    // ── parse
    if (body.mode === 'parse') {
      const res = await claude.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: PARSE_SYSTEM,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: PARSE_SCHEMA } },
        messages: [{ role: 'user', content: `다음 슬랙 메시지를 구조화하세요. confidence_notes 언어: ${body.lang === 'en' ? '영어' : '한국어'}\n\n<message>\n${body.text}\n</message>` }],
      });
      checkStop(res, 'parse');
      let parsed: unknown;
      try { parsed = JSON.parse(textOf(res)); }
      catch { throw new HttpError(502, 'badModelJson'); }
      return json({ parsed: normalizeParsed(parsed) });
    }

    // ── translate: 지정한 CS 중 번역이 없거나 오래된 것만
    if (body.mode === 'translate') {
      const { data, error } = await sb.from('cs_tickets').select(TR_COLS).in('id', body.ids);
      if (error) throw new HttpError(500, 'csLoadFailed', { error: error.message });
      const rows = data as TrSource[];
      const stale = await staleRows(sb, rows, body.ids);
      const staleIds = new Set(stale.map((r) => r.id));
      const translations = stale.length ? await translateRows(claude, sb, stale) : {};
      return json({ translations, skipped: rows.filter((r) => !staleIds.has(r.id)).map((r) => r.id) });
    }

    // ── translate_backfill: 전체 CS 중 번역이 없거나 오래된 것을 오래된 순으로 한 번에 MAX_TRANSLATE_IDS 건
    if (body.mode === 'translate_backfill') {
      const stale = await staleRows(sb, await allTicketSources(sb), null);
      if (body.dry || !stale.length) return json({ translated: 0, remaining: stale.length });
      const done = await translateRows(claude, sb, stale.slice(0, MAX_TRANSLATE_IDS));
      const n = Object.keys(done).length;
      return json({ translated: n, remaining: stale.length - n });
    }

    // ── summarize
    const { from, to } = monthRange(body.month);
    const { data: rows, error: qErr } = await sb
      .from('cs_tickets')
      .select('id,received_at,reporter,customer,device,version,title,status,status_note,description,notes,timeline,tickets,assignee,ticket_assignee')
      .gte('received_at', from).lt('received_at', to)
      .order('received_at', { ascending: true })
      .limit(2000);
    if (qErr) throw new HttpError(500, 'csLoadFailed', { error: qErr.message });
    if (!rows || rows.length === 0) throw new HttpError(400, 'noRowsMonth', { month: body.month });
    const tickets = rows as Ticket[];

    const res = await claude.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SUMMARY_SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
      messages: [{ role: 'user', content: summaryUserMessage(body.month, tickets) }],
    });
    checkStop(res, 'summarize');
    let raw: unknown;
    try { raw = JSON.parse(textOf(res)); }
    catch { throw new HttpError(502, 'badModelJson'); }
    const { issues: rawIssues, notes, issuesEn: rawIssuesEn, notesEn } = normalizeSummary(raw);
    const issues = mapIssueIndexes(rawIssues, tickets);
    const content = buildSummaryMarkdown(body.month, tickets, issues, notes);
    // 영어판: 미해결 줄은 저장된 영어 번역(원문이 그대로일 때만) 우선
    const issuesEn = mapIssueIndexes(rawIssuesEn, tickets);
    const contentEn = buildSummaryMarkdown(body.month, tickets, issuesEn, notesEn, 'en', await freshEnglish(sb, tickets));

    const { data: saved, error: upErr } = await sb
      .from('cs_monthly_summaries')
      .upsert({
        month: body.month,
        content,
        issues,
        notes,
        content_en: contentEn,
        issues_en: issuesEn,
        notes_en: notesEn,
        ticket_count: tickets.length,
        generated_by: user.id,
        generated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (upErr) throw new HttpError(500, 'summarySaveFailed', { error: upErr.message });
    return json({ summary: saved });
  } catch (e) {
    if (e instanceof BadRequest || e instanceof HttpError) return json({ error: msg(lang, e.key, e.params) }, e.status);
    if (e instanceof Anthropic.APIError) {
      console.error('anthropic', e.status, e.message);
      const text = e.status === 401 ? msg(lang, 'apiKeyWrong')
        : e.status === 429 ? msg(lang, 'rateLimited')
        : msg(lang, 'apiError', { status: e.status ?? '?', error: e.message });
      return json({ error: text }, 502);
    }
    console.error(e);
    return json({ error: msg(lang, 'unknownError', { error: e instanceof Error ? e.message : String(e) }) }, 500);
  }
});
