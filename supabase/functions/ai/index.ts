// CS 대시보드 AI Edge Function
//   mode=parse     : 슬랙 메시지 텍스트 → 폼 필드 JSON
//   mode=summarize : 해당 월 cs_tickets → 월간 요약 마크다운 (cs_monthly_summaries 에 저장)
// 인증: 요청 JWT 로 auth.getUser() 가 성공해야만 Claude 를 호출한다.
// 배포: npx supabase functions deploy ai --no-verify-jwt   (검증은 여기서 직접 함)

import Anthropic from 'npm:@anthropic-ai/sdk@0.133.0';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { MODEL, PARSE_SCHEMA, PARSE_SYSTEM, SUMMARY_SCHEMA, SUMMARY_SYSTEM, TRANSLATE_SCHEMA, TRANSLATE_SYSTEM } from './prompts.ts';
import {
  BadRequest, buildSummaryMarkdown, mapIssueIndexes, MAX_TRANSLATE_IDS, MAX_TRANSLATE_ROWS_PER_CALL, monthRange, normalizeParsed,
  normalizeSummary, normalizeTranslation, sourceHash, summaryUserMessage, translateInput, validateRequest, type Ticket, type TrSource,
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
    if (error) throw new HttpError(500, '번역 조회 실패: ' + error.message);
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
    catch { throw new HttpError(502, '모델 응답을 해석하지 못했습니다. 다시 시도하세요.'); }
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
      if (error) throw new HttpError(500, '번역 저장 실패: ' + error.message);
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

async function allTicketSources(sb: Sb): Promise<TrSource[]> {
  const rows: TrSource[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb.from('cs_tickets').select(TR_COLS)
      .order('received_at', { ascending: true }).order('id', { ascending: true }).range(offset, offset + PAGE - 1);
    if (error) throw new HttpError(500, 'CS 목록 조회 실패: ' + error.message);
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

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function textOf(res: Anthropic.Message): string {
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function checkStop(res: Anthropic.Message, what: string) {
  if (res.stop_reason === 'refusal') throw new HttpError(502, `${what}: 모델이 요청을 거부했습니다.`);
  if (res.stop_reason === 'max_tokens') throw new HttpError(502, `${what}: 출력이 잘렸습니다. 다시 시도하세요.`);
  console.log(JSON.stringify({ what, model: res.model, usage: res.usage }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST 만 지원합니다.' }, 405);

  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) throw new HttpError(500, 'ANTHROPIC_API_KEY 가 설정되지 않았습니다. supabase secrets set 으로 등록하세요.');

    // ── 인증: 요청자의 JWT 로 Supabase 클라이언트 생성 → RLS 가 그대로 적용됨
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) throw new HttpError(401, '로그인이 필요합니다.');
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
    );
    const { data: { user }, error: authErr } = await sb.auth.getUser();
    if (authErr || !user) throw new HttpError(401, '로그인 세션이 유효하지 않습니다. 다시 로그인하세요.');

    const body = validateRequest(await req.json().catch(() => null));
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
        messages: [{ role: 'user', content: `다음 슬랙 메시지를 구조화하세요.\n\n<message>\n${body.text}\n</message>` }],
      });
      checkStop(res, 'parse');
      let parsed: unknown;
      try { parsed = JSON.parse(textOf(res)); }
      catch { throw new HttpError(502, '모델 응답을 해석하지 못했습니다. 다시 시도하세요.'); }
      return json({ parsed: normalizeParsed(parsed) });
    }

    // ── translate: 지정한 CS 중 번역이 없거나 오래된 것만
    if (body.mode === 'translate') {
      const { data, error } = await sb.from('cs_tickets').select(TR_COLS).in('id', body.ids);
      if (error) throw new HttpError(500, 'CS 조회 실패: ' + error.message);
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
    if (qErr) throw new HttpError(500, 'CS 목록 조회 실패: ' + qErr.message);
    if (!rows || rows.length === 0) throw new HttpError(400, `${body.month} 에는 요약할 CS가 없습니다.`);
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
    catch { throw new HttpError(502, '모델 응답을 해석하지 못했습니다. 다시 시도하세요.'); }
    const { issues: rawIssues, notes } = normalizeSummary(raw);
    const issues = mapIssueIndexes(rawIssues, tickets);
    const content = buildSummaryMarkdown(body.month, tickets, issues, notes);

    const { data: saved, error: upErr } = await sb
      .from('cs_monthly_summaries')
      .upsert({
        month: body.month,
        content,
        issues,
        notes,
        ticket_count: tickets.length,
        generated_by: user.id,
        generated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (upErr) throw new HttpError(500, '요약 저장 실패: ' + upErr.message);
    return json({ summary: saved });
  } catch (e) {
    if (e instanceof BadRequest || e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof Anthropic.APIError) {
      console.error('anthropic', e.status, e.message);
      const msg = e.status === 401 ? 'Claude API 키가 잘못되었습니다.'
        : e.status === 429 ? 'Claude API 요청 한도에 걸렸습니다. 잠시 후 다시 시도하세요.'
        : `Claude API 오류 (${e.status ?? '?'}): ${e.message}`;
      return json({ error: msg }, 502);
    }
    console.error(e);
    return json({ error: '알 수 없는 오류: ' + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
