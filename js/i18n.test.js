const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I = require('./i18n.js');

test('detectLang: 저장값 우선, 없으면 브라우저 첫 언어가 ko 면 ko, 아니면 en', () => {
  assert.equal(I.detectLang('en', ['ko-KR']), 'en');
  assert.equal(I.detectLang('ko', ['en-US']), 'ko');
  assert.equal(I.detectLang(null, ['ko-KR', 'en']), 'ko');
  assert.equal(I.detectLang(null, ['en-US', 'ko']), 'en');
  assert.equal(I.detectLang(null, []), 'en');
  assert.equal(I.detectLang('xx', ['ko']), 'ko');
});

test('DICT: ko 와 en 의 키가 같다', () => {
  assert.deepEqual(Object.keys(I.DICT.ko).sort(), Object.keys(I.DICT.en).sort());
});

test('t: 자리표시자 치환, 없는 키는 키 그대로', () => {
  assert.equal(I.t('ko', 'nCount', { n: 3 }), '3건');
  assert.equal(I.t('en', 'nCount', { n: 3 }), '3');
  assert.equal(I.t('en', 'no.such.key'), 'no.such.key');
});

test('weekday: 영어 요일 약자를 언어별로', () => {
  assert.equal(I.weekday('ko', 'Wed'), '수');
  assert.equal(I.weekday('en', 'Wed'), 'Wed');
});

test('monthCount: 밀린 미해결 머리글 조각', () => {
  assert.equal(I.monthCount('ko', '2026-10', true, 2), '10월 2');
  assert.equal(I.monthCount('ko', '2025-12', false, 1), '25년 12월 1');
  assert.equal(I.monthCount('en', '2026-10', true, 2), 'Oct 2');
  assert.equal(I.monthCount('en', '2025-12', false, 1), 'Dec 2025 1');
});

// 화면에서 쓰는 키가 두 사전에 모두 있어야 한다 (한쪽이 빠지면 키 이름이 화면에 그대로 나옴)
test('사전 누락 검사: index.html 의 data-i18n* 키와 app.js 의 t() 키', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
  const keys = new Set([
    ...[...html.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)].map((m) => m[1]),
    ...[...app.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]),
  ]);
  const missing = [...keys].filter((k) => !(k in I.DICT.ko) || !(k in I.DICT.en));
  assert.deepEqual(missing, []);
});
