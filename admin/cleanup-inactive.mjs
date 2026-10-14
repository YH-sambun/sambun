// 미접속 유저 정리 스크립트 (GitHub Actions 'cleanup-inactive' 워크플로에서 실행)
// 마지막 활동 = players.at, saves.sv, Auth 마지막 로그인·토큰 갱신 중 가장 최근 값.
// 이 값이 DAYS일보다 오래된 유저의 players/{uid}, saves/{uid}, Auth 계정을 지운다.
// battles·raids·daily는 게임이 9~11일 뒤 자동 정리하므로 건드리지 않는다.
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { writeFileSync, appendFileSync } from 'node:fs';

const DAYS = Number(process.env.DAYS);
const MODE = process.env.MODE === 'delete' ? 'delete' : 'preview';
const KEEP = new Set((process.env.KEEP_UIDS || '').split(/[\s,]+/).filter(Boolean));
const MAX = Number(process.env.MAX_DELETE) || 100;
const fail = m => { console.log(`::error::${m}`); process.exit(1); };
if (!Number.isFinite(DAYS) || DAYS < 1) fail('days는 1 이상의 숫자여야 합니다');
let SA;
try { SA = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || ''); } catch { fail('FIREBASE_SERVICE_ACCOUNT secret이 비어 있거나 JSON 형식이 아닙니다. 키 파일 내용 전체를 { 부터 } 까지 붙여 넣었는지 확인하세요'); }

initializeApp({ credential: cert(SA) });
const db = getFirestore(), auth = getAuth();
const now = Date.now(), cutoff = now - DAYS * 864e5;
const ms = v => { const t = typeof v === 'number' ? v : Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };
const day = t => t ? new Date(t + 9 * 3600e3).toISOString().slice(0, 10) : '-';

const U = new Map();
const get = uid => { if (!U.has(uid)) U.set(uid, { uid, name: '', last: 0, player: null, save: null, auth: null }); return U.get(uid); };

for (const d of (await db.collection('players').get()).docs) {
  const u = get(d.id); u.player = d.data(); u.name = String(u.player.name || ''); u.last = Math.max(u.last, ms(u.player.at));
}
for (const d of (await db.collection('saves').get()).docs) {
  const u = get(d.id); u.save = d.data(); u.last = Math.max(u.last, ms(u.save.sv));
}
let tok;
do {
  const r = await auth.listUsers(1000, tok);
  for (const a of r.users) {
    const u = get(a.uid);
    u.auth = { anon: a.providerData.length === 0, email: a.email || '', created: a.metadata.creationTime };
    u.last = Math.max(u.last, ms(a.metadata.lastSignInTime), ms(a.metadata.lastRefreshTime), ms(a.metadata.creationTime));
  }
  tok = r.pageToken;
} while (tok);

const targets = [...U.values()].filter(u => u.last < cutoff && !KEEP.has(u.uid)).sort((a, b) => a.last - b.last);

const rows = targets.map(u => `| ${u.name || '(이름 없음)'} | \`${u.uid.slice(0, 6)}…\` | ${day(u.last)} | ${u.player ? 'O' : ''} | ${u.save ? 'O' : ''} | ${u.auth ? (u.auth.anon ? '게스트' : '구글') : ''} | ${u.save ? (u.save.stage ?? '') : ''} |`);
const summary = [
  `## 미접속 유저 정리 (${MODE === 'delete' ? '삭제 실행' : '미리보기'})`,
  `기준: 마지막 활동이 ${day(cutoff)} 이전 (${DAYS}일)`,
  `전체 ${U.size}명 중 대상 ${targets.length}명`, '',
  '| 이름 | uid | 마지막 활동 | players | saves | 계정 | 스테이지 |', '|---|---|---|---|---|---|---|', ...rows,
].join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');

// 삭제 여부와 상관없이 대상자의 원본 데이터를 백업 파일로 남긴다(워크플로가 암호화한 뒤 업로드)
// 공개 저장소라 실행 기록과 요약은 누구나 볼 수 있으므로, 요약에는 uid 앞 6자리만 적는다
writeFileSync('backup.json', JSON.stringify({ at: new Date(now).toISOString(), days: DAYS, mode: MODE,
  users: targets.map(u => ({ uid: u.uid, last: u.last, player: u.player, save: u.save, auth: u.auth })) }, null, 1));

if (MODE !== 'delete') { console.log('\n미리보기만 했습니다. 삭제하려면 mode를 delete로 다시 실행하세요.'); process.exit(0); }
if (targets.length > MAX) throw new Error(`대상 ${targets.length}명이 최대 삭제 수 ${MAX}명을 넘어서 중단했습니다. max_delete를 올려서 다시 실행하세요.`);

let nDoc = 0;
for (let i = 0; i < targets.length; i += 200) {
  const b = db.batch();
  for (const u of targets.slice(i, i + 200)) {
    if (u.player) { b.delete(db.collection('players').doc(u.uid)); nDoc++; }
    if (u.save) { b.delete(db.collection('saves').doc(u.uid)); nDoc++; }
  }
  await b.commit();
}
const authUids = targets.filter(u => u.auth).map(u => u.uid);
let nAuth = 0, errs = [];
for (let i = 0; i < authUids.length; i += 1000) {
  const r = await auth.deleteUsers(authUids.slice(i, i + 1000));
  nAuth += r.successCount; errs.push(...r.errors.map(e => `${authUids[i + e.index]}: ${e.error.message}`));
}
const done = `\n삭제 완료: 문서 ${nDoc}개, 계정 ${nAuth}개${errs.length ? `\n계정 삭제 실패 ${errs.length}건:\n${errs.join('\n')}` : ''}`;
console.log(done);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, done + '\n');
if (errs.length) process.exit(1);
