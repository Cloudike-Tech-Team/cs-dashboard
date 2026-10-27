// CS 대시보드 티켓 조회 Edge Function (YouTrack · Jira)
//   POST { ids: ['NRF-4817', 'CLDA-82', ...] }
//   → { tickets: { 'NRF-4817': { source, summary, state, resolved, assignees, url } }, missing: [...], warnings: [...] }
// 대시보드는 CS 에 연결된 티켓의 담당자·상태를 여기서 읽어 표시만 한다 (DB 에 쓰지 않음).
// JIRA_PROJECTS 에 든 프로젝트 키는 Jira, 나머지는 YouTrack 으로 조회한다.
// 한 트래커가 설정 안 됐거나 실패해도 다른 쪽 결과는 돌려주고, 사유는 warnings 에 담는다.
// 인증: 요청 JWT 로 auth.getUser() 가 성공해야만 트래커를 호출한다.
// secrets:
//   YOUTRACK_TOKEN (영구 토큰 perm:...), YOUTRACK_URL (기본 https://yt.cloudike.io)
//   JIRA_EMAIL + JIRA_TOKEN (Atlassian API 토큰), JIRA_URL (기본 https://cloudike.atlassian.net),
//   JIRA_PROJECTS (기본 CLDA,GOVNIPA)
// 배포: npx supabase functions deploy tickets --no-verify-jwt   (검증은 여기서 직접 함)

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  BadRequest, jiraToTicket, mapLimit, splitBySource, toTicket, validateIds, type YtTicket,
} from './lib.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const YT_FIELDS = 'idReadable,summary,resolved,customFields($type,name,value(name,fullName,login))';
const JIRA_FIELDS = 'summary,status,assignee';
const CONCURRENCY = 6;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// 트래커 하나에서 ID 들을 한 건씩 조회. 없는 이슈(404)는 null.
// ID 검색 쿼리는 없는 ID 가 하나만 섞여도 전체가 실패하므로 한 건씩 묻는다.
async function fetchAll(
  name: string, ids: string[], url: (id: string) => string, headers: Record<string, string>,
  parse: (raw: unknown) => YtTicket,
): Promise<(YtTicket | null)[]> {
  return await mapLimit(ids, CONCURRENCY, async (id) => {
    const res = await fetch(url(id), { headers: { ...headers, Accept: 'application/json' } });
    if (res.status === 404) { await res.body?.cancel(); return null; }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new Error(`${name} 토큰이 잘못되었거나 권한이 없습니다.`);
    }
    if (!res.ok) throw new Error(`${name} 오류 (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return parse(await res.json());
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST 만 지원합니다.' }, 405);

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) throw new HttpError(401, '로그인이 필요합니다.');
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
    );
    const { data: { user }, error: authErr } = await sb.auth.getUser();
    if (authErr || !user) throw new HttpError(401, '로그인 세션이 유효하지 않습니다. 다시 로그인하세요.');

    const ids = validateIds(await req.json().catch(() => null));
    const split = splitBySource(ids, (Deno.env.get('JIRA_PROJECTS') || 'CLDA,GOVNIPA').split(','));

    const tickets: Record<string, YtTicket> = {};
    const missing: string[] = [];
    const warnings: string[] = [];
    const collect = (list: string[], results: (YtTicket | null)[]) => list.forEach((id, i) => {
      const t = results[i];
      if (t) tickets[id] = t; else missing.push(id);
    });

    const jobs: Promise<void>[] = [];

    if (split.youtrack.length) {
      const token = Deno.env.get('YOUTRACK_TOKEN');
      const base = (Deno.env.get('YOUTRACK_URL') || 'https://yt.cloudike.io').replace(/\/+$/, '');
      if (!token) warnings.push('YOUTRACK_TOKEN 이 설정되지 않아 YouTrack 티켓을 읽지 못했습니다.');
      else {
        jobs.push(fetchAll(
          'YouTrack', split.youtrack,
          (id) => `${base}/api/issues/${encodeURIComponent(id)}?fields=${encodeURIComponent(YT_FIELDS)}`,
          { Authorization: `Bearer ${token}` },
          (raw) => toTicket(raw as Parameters<typeof toTicket>[0], base),
        ).then((r) => collect(split.youtrack, r), (e) => { warnings.push(e.message); }));
      }
    }

    if (split.jira.length) {
      const email = Deno.env.get('JIRA_EMAIL');
      const token = Deno.env.get('JIRA_TOKEN');
      const base = (Deno.env.get('JIRA_URL') || 'https://cloudike.atlassian.net').replace(/\/+$/, '');
      if (!email || !token) warnings.push('JIRA_EMAIL · JIRA_TOKEN 이 설정되지 않아 Jira 티켓을 읽지 못했습니다.');
      else {
        jobs.push(fetchAll(
          'Jira', split.jira,
          (id) => `${base}/rest/api/3/issue/${encodeURIComponent(id)}?fields=${JIRA_FIELDS}`,
          { Authorization: `Basic ${btoa(`${email}:${token}`)}` },
          (raw) => jiraToTicket(raw as Parameters<typeof jiraToTicket>[0], base),
        ).then((r) => collect(split.jira, r), (e) => { warnings.push(e.message); }));
      }
    }

    await Promise.all(jobs);
    return json({ tickets, missing, warnings });
  } catch (e) {
    if (e instanceof BadRequest || e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: '알 수 없는 오류: ' + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
