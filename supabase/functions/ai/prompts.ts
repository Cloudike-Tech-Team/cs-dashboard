// Claude 에 보내는 프롬프트와 출력 스키마. 동작을 바꾸고 싶으면 이 파일만 고치면 됨.

export const DEVICES = [
  '웹', 'CLDAstream Win', 'CLDAstream MAC',
  'PC client Win', 'PC client MAC', 'Android', 'IOS', '기타',
] as const;
export type Device = typeof DEVICES[number];

export const MODEL = 'claude-sonnet-5-5';

// ───────────── parse: 슬랙 메시지 → 폼 필드 ─────────────

export const PARSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reporter', 'customer', 'title', 'received_at', 'device', 'version', 'description', 'notes', 'timeline', 'assignee', 'confidence_notes'],
  properties: {
    reporter: { type: ['string', 'null'], description: '메시지 작성자 이름. 괄호 앞 한글 이름만.' },
    customer: { type: ['string', 'null'], description: '"com 81838 / user 119607" 형식. user 없으면 "com 9163".' },
    title: { type: 'string', description: '고객이 겪는 현상을 20자 안팎 한 줄로. 예) "웹에서 35MB 엑셀 열리지 않음".' },
    received_at: {
      type: ['string', 'null'],
      description: '날짜+시각이면 "YYYY-MM-DDTHH:MM", 시각만 있으면 "HH:MM", 둘 다 없으면 null. 24시간제.',
    },
    device: { anyOf: [{ type: 'string', enum: [...DEVICES] }, { type: 'null' }] },
    version: { type: 'string', description: '버전 번호만. 없으면 빈 문자열.' },
    description: { type: 'string', description: '고객이 겪는 현상 2~4문장. 오류 메시지는 원문 인용.' },
    notes: { type: 'string', description: '첨부파일명, 이미 시도한 조치, 요청사항, 멘션 등 현상 외 정보. 없으면 빈 문자열.' },
    timeline: {
      type: 'array',
      items: { type: 'string' },
      description: '첫 메시지 아래의 댓글(스레드 답글)을 시간순으로 한 줄씩. "MM/DD 작성자: 내용" 형식. 댓글이 없으면 빈 배열.',
    },
    assignee: { type: 'string', description: '본문이나 댓글에서 이 CS 를 맡기로 지정된 개발팀 담당자 이름(한글 이름만). 지정이 없으면 빈 문자열.' },
    confidence_notes: { type: 'string', description: '추측한 항목과 이유. 없으면 빈 문자열.' },
  },
} as const;

export const PARSE_SYSTEM = `당신은 Cloudike CS 담당자가 슬랙에 올린 문의 메시지를 CS 대시보드 등록 폼에 맞게 구조화하는 도우미입니다. 주어진 JSON 스키마에 맞춰서만 답합니다.

입력 구조:
- 붙여넣은 텍스트는 슬랙 메시지 하나와 그 아래 달린 댓글(스레드 답글)들입니다. 슬랙에서 복사하면 보통 "작성자  시각" 줄 다음에 본문이 오고, "N개의 댓글" 같은 줄 뒤에 댓글들이 같은 "작성자  시각 / 내용" 모양으로 이어집니다.
- **첫 메시지(본문)만** reporter·customer·title·received_at·device·version·description·notes 의 근거로 씁니다.
- **댓글은 전부 timeline 으로** 보냅니다. 댓글 내용을 description 이나 notes 에 섞지 않습니다. 댓글에서 밝혀진 원인·조치·결과도 timeline 에만 적습니다.

필드 규칙:
- reporter: 메시지 작성자 이름. "오민식(Minsik.O)" 처럼 괄호가 있으면 괄호 앞 한글 이름만. 작성자를 알 수 없으면 null.
- customer: "com <번호>" 와 "user <번호>" 를 찾아 "com 81838 / user 119607" 형식으로. user 가 없으면 "com 9163". 둘 다 없으면 본문에 나온 고객사명, 그것도 없으면 null.
- title: 고객이 겪는 현상을 20자 안팎 한 줄로. 예) "웹에서 35MB 엑셀 열리지 않음", "트래픽 초과 — 반복 다운로드", "CLDAstream 표시 언어 영어 고정". 오류 메시지 원문보다 현상 요약을 우선. 고객사 번호는 넣지 않습니다.
- received_at: 본문에 날짜와 시각이 모두 있으면 "YYYY-MM-DDTHH:MM" (24시간제, KST). 시각만 있으면 "HH:MM" 만 (예: "02:47 PM" → "14:47"). 둘 다 없으면 null. 날짜 구분선("2026년 10월 12일")이 메시지 위에 있으면 그 날짜를 사용.
- device: 다음 8개 중 하나. 판단 근거가 전혀 없으면 null.
  '웹', 'CLDAstream Win', 'CLDAstream MAC', 'PC client Win', 'PC client MAC', 'Android', 'IOS', '기타'
  매핑:
  · 클다스트림 / CLDAstream / 클라우다이크 스트림 → CLDAstream. OS 언급이 없으면 'CLDAstream Win' 으로 두고 confidence_notes 에 "기기: OS 미확인, Win 으로 가정" 기록. 맥/MAC/macOS 언급 시 'CLDAstream MAC'.
  · "웹에서", 브라우저, 웹 미리보기 → '웹'
  · PC 클라이언트 / 동기화 클라이언트 / 탐색기 → 'PC client Win' (맥 언급 시 'PC client MAC')
  · 안드로이드 / 갤럭시 → 'Android'
  · 아이폰 / 아이패드 / iOS → 'IOS'
  · 결제·트래픽·계정·용량 등 기기와 무관한 문의 → '웹'
- version: 버전 번호(예: 3.19.61)만. 없으면 "".
- description: 고객이 겪는 현상을 2~4문장으로. 오류 메시지 원문은 그대로 인용. 파일 경로·크기 같은 구체 정보는 유지. 제목(title)과 같은 문장을 반복하지 않습니다.
- notes: 첨부파일명, 이미 시도한 조치(예: "비밀번호 재변경 후에도 동일"), 요청사항(예: "월결제→연결제 변경 요청"), 담당자 멘션 등 현상 외 정보. 없으면 "".
- timeline: 댓글 하나당 한 줄, 위에서 아래 순서(시간순) 그대로. 형식은 "MM/DD 작성자: 내용 요약". 작성자는 괄호 앞 한글 이름. 내용은 한 문장으로 줄이되 요청·확인·조치·결과(예: "PC 로그 요청", "계정 비활성화가 원인으로 확인, 재활성화 완료")와 티켓 번호는 유지. 댓글에 날짜가 없고 시각만 있으면 본문 날짜(또는 가장 최근 날짜 구분선)를 쓰고, 날짜 구분선("10월 13일")이 중간에 나오면 그 뒤 댓글은 그 날짜를 씁니다. 날짜를 전혀 알 수 없으면 "MM/DD " 없이 "작성자: 내용"만. 댓글이 없으면 [].
- assignee: 본문이나 댓글에 "담당 @오민식", "민식님 확인 부탁드립니다", "제가 보겠습니다"(댓글 작성자) 처럼 이 CS 를 맡는 개발팀 사람이 드러나면 그 한글 이름만. 단순 멘션이나 참조(cc)는 담당이 아닙니다. 확신이 없으면 "" 로 두고 confidence_notes 에 후보를 적습니다.
- confidence_notes: 추측한 항목과 그 이유. 사용자가 검토할 때 참고용. 없으면 "".

슬랙 UI 잔여물("6개의 댓글", "삭제된 메시지입니다", 파일 크기 표시 등)은 무시합니다.
본문에 없는 내용을 지어내지 않습니다.`;

// ───────────── summarize: 월간 CS 목록 → 주요 이슈·특이사항 JSON ─────────────
// 통계·미해결 목록·마크다운은 모델이 아니라 lib.ts 가 만든다. 모델은 "묶기"와 "기억할 사실 고르기"만 한다.

export const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issues', 'notes'],
  properties: {
    issues: {
      type: 'array',
      description: '비슷한 현상끼리 묶은 주요 이슈. 건수가 많은 순. 3~5개.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'detail', 'ticket_indexes'],
        properties: {
          label: { type: 'string', description: '이슈 이름 12자 안팎. 화면 버튼에 들어감. 예) "트래픽 초과", "CLDAstream 로그인·표시"' },
          detail: { type: 'string', description: '어떤 고객사가 어떤 증상인지 한 문장, 60자 안팎. 고객사 번호(com6384)와 티켓 번호를 포함.' },
          ticket_indexes: { type: 'array', items: { type: 'integer' }, description: '이 이슈에 속하는 CS 목록 번호(1부터).' },
        },
      },
    },
    notes: {
      type: 'array',
      description: '보고서에 꼭 남길 사실. 0~5개.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['customer', 'text'],
        properties: {
          customer: { type: 'string', description: '고객사 번호. 예) "com82171"' },
          text: { type: 'string', description: '수치·경위·후속 조치를 한 문장으로. 예) "9월 초과 — 공유 링크 51개, 외부 약 140개 IP 가 원본 다운로드"' },
        },
      },
    },
  },
} as const;

export const SUMMARY_SYSTEM = `당신은 Cloudike 기술팀의 월간 CS 보고서 작성을 돕습니다. 아래 CS 목록을 읽고 주어진 JSON 스키마에 맞춰 "주요 이슈"와 "특이사항"만 작성합니다. 통계, 미해결 여부, 건수는 시스템이 따로 계산하므로 쓰지 않습니다.

주요 이슈(issues):
- 비슷한 현상끼리 묶어 건수가 많은 순으로 3~5개. CS 가 3건 이하면 그만큼만.
- label: 이슈 이름 12자 안팎. 화면 필터 버튼의 글자이므로 짧고 구체적으로. 예) "트래픽 초과", "CLDAstream 로그인·표시", "웹 대용량 엑셀".
- detail: 어떤 고객사가 어떤 증상인지 한 문장, 60자 안팎. 고객사 번호(com6384 형식)와 티켓 번호(있을 때)를 포함.
- ticket_indexes: 그 이슈에 속하는 CS 의 목록 번호. 한 CS 는 한 이슈에만 넣습니다. 어디에도 묶이지 않는 건은 "기타"로 묶지 말고 제외합니다.

특이사항(notes):
- 다음 달에도 기억해야 할 사실: 수치(용량·건수·IP 수), 경위, 완료된 후속 조치나 재발 방지 조치. 0~5개.
- customer 는 고객사 번호, text 는 한 문장. 목록의 "특이사항"·"타임라인" 열에 있는 내용을 우선합니다.

공통:
- 목록에 없는 내용을 추가하지 않습니다. 추측 표현("~로 보임")은 목록에 근거가 있을 때만 씁니다.
- 한국어, 간결체.`;
