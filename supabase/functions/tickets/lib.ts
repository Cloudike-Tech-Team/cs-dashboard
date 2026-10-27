// YouTrack · Jira 응답 → 대시보드용 티켓 정보. 순수 함수만 둬서 `deno test` 로 검증한다.

export class BadRequest extends Error {
  status = 400;
}

export const MAX_IDS = 300;
// NRF-4817(YouTrack), CLDA-82(Jira) 같은 이슈 ID
export const ID_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

export function validateIds(body: unknown): string[] {
  const ids = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids)) throw new BadRequest('ids 배열이 필요합니다.');
  const out = [...new Set(ids.map((v) => String(v ?? '').trim().toUpperCase()).filter((v) => ID_RE.test(v)))];
  if (out.length > MAX_IDS) throw new BadRequest(`한 번에 ${MAX_IDS}개까지만 조회할 수 있습니다.`);
  return out;
}

export type YtTicket = {
  id: string;
  source: 'youtrack' | 'jira';
  summary: string;
  state: string;       // YouTrack State(NPR 은 '진행 상황') / Jira status 이름. 없으면 ''
  resolved: boolean;   // YouTrack 이 해결로 보는 상태 / Jira statusCategory=done
  assignees: string[]; // Assignee(또는 NPR 의 '개발 담당자')
  url: string;
};

type RawUser = { fullName?: string; name?: string; login?: string };
type RawField = { $type?: string; name?: string; value?: unknown };
type RawIssue = { idReadable?: string; summary?: string; resolved?: number | null; customFields?: RawField[] };

// 프로젝트마다 필드 이름이 다르다 (NPR: '진행 상황' · '개발 담당자'). '요청자' 같은 다른 사용자 필드는 쓰지 않는다.
const ASSIGNEE_FIELDS = ['Assignee', '개발 담당자'];

function userName(u: unknown): string {
  const x = (u ?? {}) as RawUser;
  return x.fullName || x.name || x.login || '';
}

export function toTicket(raw: RawIssue, baseUrl: string): YtTicket {
  const fields = raw.customFields ?? [];
  const stateField = fields.find((f) => f.$type === 'StateIssueCustomField')
    ?? fields.find((f) => f.name === 'State');
  const sv = stateField?.value as { name?: string } | null | undefined;
  const asgField = fields.find((f) => ASSIGNEE_FIELDS.includes(f.name ?? ''));
  const av = asgField?.value;
  const assignees = (Array.isArray(av) ? av : av ? [av] : []).map(userName).filter(Boolean);
  const id = raw.idReadable ?? '';
  return {
    id,
    source: 'youtrack',
    summary: raw.summary ?? '',
    state: sv?.name ?? '',
    resolved: raw.resolved != null,
    assignees,
    url: `${baseUrl.replace(/\/+$/, '')}/issue/${id}`,
  };
}

// Jira 프로젝트 키 목록(JIRA_PROJECTS)에 든 ID 는 Jira, 나머지는 YouTrack 으로 보낸다
export function splitBySource(ids: string[], jiraProjects: string[]): { youtrack: string[]; jira: string[] } {
  const jp = new Set(jiraProjects.map((k) => k.trim().toUpperCase()).filter(Boolean));
  const isJira = (id: string) => jp.has(id.split('-')[0]);
  return { youtrack: ids.filter((id) => !isJira(id)), jira: ids.filter(isJira) };
}

type RawJira = {
  key?: string;
  fields?: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } } | null;
    assignee?: { displayName?: string; emailAddress?: string } | null;
  };
};

export function jiraToTicket(raw: RawJira, siteUrl: string): YtTicket {
  const f = raw.fields ?? {};
  const id = raw.key ?? '';
  const a = f.assignee?.displayName || f.assignee?.emailAddress || '';
  return {
    id,
    source: 'jira',
    summary: f.summary ?? '',
    state: f.status?.name ?? '',
    resolved: f.status?.statusCategory?.key === 'done',
    assignees: a ? [a] : [],
    url: `${siteUrl.replace(/\/+$/, '')}/browse/${id}`,
  };
}

// 동시 요청 수를 제한해 순서대로 결과를 모은다
export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
