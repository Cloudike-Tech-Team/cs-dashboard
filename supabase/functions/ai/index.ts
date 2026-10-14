// CS 대시보드 AI Edge Function
//   mode=parse     : 슬랙 메시지 텍스트 → 폼 필드 JSON
//   mode=summarize : 해당 월 cs_tickets → 월간 요약 마크다운 (cs_monthly_summaries 에 저장)
// 인증: 요청 JWT 로 auth.getUser() 가 성공해야만 Claude 를 호출한다.
// 배포: npx supabase functions deploy ai --no-verify-jwt   (검증은 여기서 직접 함)

import Anthropic from 'npm:@anthropic-ai/sdk@0.133.0';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { MODEL, PARSE_SCHEMA, PARSE_SYSTEM, SUMMARY_SYSTEM } from './prompts.ts';
import {
  BadRequest, monthRange, normalizeParsed, summaryUserMessage, validateRequest, type Ticket,
} from './lib.ts';

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

    // ── summarize
    const { from, to } = monthRange(body.month);
    const { data: rows, error: qErr } = await sb
      .from('cs_tickets')
      .select('received_at,reporter,customer,device,version,description,notes,timeline,tickets')
      .gte('received_at', from).lt('received_at', to)
      .order('received_at', { ascending: true })
      .limit(2000);
    if (qErr) throw new HttpError(500, 'CS 목록 조회 실패: ' + qErr.message);
    if (!rows || rows.length === 0) throw new HttpError(400, `${body.month} 에는 요약할 CS가 없습니다.`);

    const res = await claude.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SUMMARY_SYSTEM,
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: summaryUserMessage(body.month, rows as Ticket[]) }],
    });
    checkStop(res, 'summarize');
    const content = textOf(res).trim();
    if (!content) throw new HttpError(502, '요약이 비어 있습니다. 다시 시도하세요.');

    const { data: saved, error: upErr } = await sb
      .from('cs_monthly_summaries')
      .upsert({
        month: body.month,
        content,
        ticket_count: rows.length,
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
