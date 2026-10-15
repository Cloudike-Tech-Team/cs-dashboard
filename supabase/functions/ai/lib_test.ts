import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  BadRequest, buildSummaryInput, deviceCounts, monthRange, normalizeParsed, sortByReceived, statusText, validateRequest,
} from './lib.ts';

Deno.test('validateRequest: parse 모드', () => {
  assertEquals(validateRequest({ mode: 'parse', text: '  hi ' }), { mode: 'parse', text: 'hi' });
  assertThrows(() => validateRequest({ mode: 'parse', text: '' }), BadRequest);
  assertThrows(() => validateRequest({ mode: 'parse', text: 'x'.repeat(8001) }), BadRequest);
});

Deno.test('validateRequest: summarize 모드', () => {
  assertEquals(validateRequest({ mode: 'summarize', month: '2026-10' }), { mode: 'summarize', month: '2026-10' });
  assertThrows(() => validateRequest({ mode: 'summarize', month: '2026-13' }), BadRequest);
  assertThrows(() => validateRequest({ mode: 'summarize', month: '202610' }), BadRequest);
  assertThrows(() => validateRequest({ mode: 'other' }), BadRequest);
  assertThrows(() => validateRequest(null), BadRequest);
});

Deno.test('monthRange: KST 경계, 12월 넘김', () => {
  assertEquals(monthRange('2026-10'), { from: '2026-09-30T15:00:00.000Z', to: '2026-10-31T15:00:00.000Z' });
  assertEquals(monthRange('2026-12').to, '2026-12-31T15:00:00.000Z');
});

Deno.test('deviceCounts: 건수 내림차순, 동률은 DEVICES 순서', () => {
  assertEquals(
    deviceCounts([{ device: 'Android' }, { device: '웹' }, { device: 'Android' }, { device: '기타' }]),
    [['Android', 2], ['웹', 1], ['기타', 1]],
  );
});

const row = (over = {}) => ({
  id: 'id-1', received_at: '2026-10-12T05:47:00.000Z', reporter: '정양훈', customer: 'com 81838 / user 119607',
  device: 'CLDAstream Win', version: '3.19.61', title: '로그인 실패', status: 'open' as const, status_note: '',
  description: '로그인\n실패', notes: '', timeline: ['10/12 로그 요청'], tickets: ['CLD-1'], ...over,
});

Deno.test('buildSummaryInput: 집계 헤더와 한 줄 행 (제목·상태 포함)', () => {
  const out = buildSummaryInput('2026-10', [
    row(),
    row({ id: 'id-0', device: '웹', received_at: '2026-10-01T01:00:00.000Z', timeline: [], tickets: [], status: 'done', title: '' }),
    row({ id: 'id-2', received_at: '2026-10-13T01:00:00.000Z', status: 'unknown', status_note: '로그 수집 실패' }),
  ]);
  const lines = out.split('\n');
  assertEquals(lines[0], '[집계] 2026년 10월 · 총 3건 · CLDAstream Win 2 · 웹 1');
  assertEquals(lines[2], '[CS 목록] 번호. 날짜 | 고객사 | 기기 | 버전 | 제목 | 현상 | 특이사항 | 타임라인 | 티켓 | 상태');
  assertEquals(lines[3], '1. 10/01 | com 81838 / user 119607 | 웹 | 3.19.61 | - | 로그인 실패 | - | (없음) | - | 완료');
  assertEquals(lines[4], '2. 10/12 | com 81838 / user 119607 | CLDAstream Win | 3.19.61 | 로그인 실패 | 로그인 실패 | - | 10/12 로그 요청 | CLD-1 | 처리 중');
  assertEquals(lines[5], '3. 10/13 | com 81838 / user 119607 | CLDAstream Win | 3.19.61 | 로그인 실패 | 로그인 실패 | - | 10/12 로그 요청 | CLD-1 | 원인 미확인(로그 수집 실패)');
});

Deno.test('sortByReceived: 날짜 오름차순, 동률은 id', () => {
  const r = sortByReceived([row({ id: 'b' }), row({ id: 'a' }), row({ id: 'c', received_at: '2026-10-01T00:00:00.000Z' })]);
  assertEquals(r.map((x) => x.id), ['c', 'a', 'b']);
});

Deno.test('statusText', () => {
  assertEquals(statusText(row()), '처리 중');
  assertEquals(statusText(row({ status: 'open', status_note: '로그 대기' })), '처리 중(로그 대기)');
  assertEquals(statusText(row({ status: 'done' })), '완료');
});

Deno.test('normalizeParsed: 잘못된 기기·날짜는 null, 공백 정리', () => {
  const p = normalizeParsed({
    reporter: ' 정양훈 ', customer: '', title: ' 로그인 안 됨 ', received_at: '14:47', device: '클다스트림',
    version: ' 3.19.61 ', description: 'x', notes: 1, confidence_notes: '',
  });
  assertEquals(p, {
    reporter: '정양훈', customer: null, title: '로그인 안 됨', received_at: '14:47', device: null,
    version: '3.19.61', description: 'x', notes: '', confidence_notes: '',
  });
  assertEquals(normalizeParsed({ received_at: '2026-10-12T14:47' }).received_at, '2026-10-12T14:47');
  assertEquals(normalizeParsed({ received_at: '어제' }).received_at, null);
  assertEquals(normalizeParsed({ device: 'IOS' }).device, 'IOS');
  assertEquals(normalizeParsed(null).version, '');
  assertEquals(normalizeParsed({}).title, '');
});
