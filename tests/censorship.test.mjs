// clef-omni 검열 로직 테스트 — env.AI 목으로 실제 모델 응답 형태를 시뮬레이션
import { handleImageCensorship, handleVideoCensorship } from '../censorship.js';

const CATS = ['nudity','partial_nudity','violence','gore','drugs','hate',
              'harassment','self_harm','illegal','spam','child_exploitation','extremist'];

let passed = 0, failed = 0;
function check(name, cond, extra='') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
}

// env.AI 목: answers를 만들어주는工厂
function mockAI(answerFactory) {
  return {
    AI: {
      run: async (model, body) => {
        if (!body || body.model !== 'clef-omni') throw new Error('bad model selector');
        if (!body.state) throw new Error('missing state');
        if (!body.questions || Object.keys(body.questions).length !== 12) throw new Error('bad questions');
        return { model: 'clef-omni', answers: answerFactory(body), usage: { input_tokens: 10, output_tokens: 1 } };
      }
    }
  };
}

const allFalse = () => Object.fromEntries(CATS.map(c => [c, { type:'noul', noul: 0.05 }]));
const allTrue  = () => Object.fromEntries(CATS.map(c => [c, { type:'noul', noul: 0.97 }]));

// 최소 유효 이미지 (1x1 PNG)
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function file(type, bytes, name='t.bin') {
  return new File([new Uint8Array(bytes)], name, { type });
}
function pngFile(bytes = 64) { return file('image/png', bytes, 'a.png'); }

// --- 1. 적절한 이미지 → 통과 ---
{
  console.log('\n[1] 적절한 이미지 → 통과');
  const r = await handleImageCensorship(pngFile(), mockAI(allFalse));
  check('ok=true', r.ok === true, JSON.stringify(r));
}

// --- 2. 부적절 이미지 (nudity high) → 거부 + 사유 ---
{
  console.log('\n[2] 부적절 이미지 → 거부');
  const r = await handleImageCensorship(pngFile(), mockAI(() => ({
    ...allFalse(), nudity: { type:'noul', noul: 0.93 }
  })));
  check('ok=false', r.ok === false);
  const body = JSON.parse(await r.response.text());
  check('성적/노출 사유 포함', body.error.includes('성적/노출'), body.error);
  check('status 400', r.response.status === 400);
}

// --- 3. 임계값 경계: 0.5 이상은 거부, 0.49는 통과 ---
{
  console.log('\n[3] 임계값 경계 (0.5)');
  const hi = await handleImageCensorship(pngFile(), mockAI(() => ({
    ...allFalse(), violence: { type:'noul', noul: 0.5 }
  })));
  check('0.5 → 거부', hi.ok === false);
  const lo = await handleImageCensorship(pngFile(), mockAI(() => ({
    ...allFalse(), violence: { type:'noul', noul: 0.49 }
  })));
  check('0.49 → 통과', lo.ok === true);
}

// --- 4. 일부 응답 누락 → fail-closed 거부 ---
{
  console.log('\n[4] 응답 일부 누락 → fail-closed');
  const a = allFalse(); delete a.hate;
  const r = await handleImageCensorship(pngFile(), mockAI(() => a));
  check('ok=false', r.ok === false);
  const body = JSON.parse(await r.response.text());
  check('해석 불가 메시지', body.error.includes('확인할 수 없어'), body.error);
}

// --- 5. answers 자체가 비어있음 → fail-closed ---
{
  console.log('\n[5] answers 비어있음 → fail-closed');
  const r = await handleImageCensorship(pngFile(), mockAI(() => ({})));
  check('ok=false', r.ok === false);
}

// --- 6. env.AI 없음 → 500 거부 ---
{
  console.log('\n[6] env.AI 미바인딩 → 거부');
  const r = await handleImageCensorship(pngFile(), {});
  check('ok=false', r.ok === false);
  check('status 500', r.response.status === 500);
}

// --- 7. 미지원 이미지 포맷(GIF) → 거부(압축 실패 경로 포함) ---
{
  console.log('\n[7] 미지원 이미지 포맷(GIF) → 거부');
  const gif = file('image/gif', 64, 'a.gif');
  const r = await handleImageCensorship(gif, mockAI(allFalse));
  check('ok=false', r.ok === false, JSON.stringify(r.ok));
  const body = JSON.parse(await r.response.text());
  check('형식 안내 메시지', /JPEG|PNG|WebP/.test(body.error), body.error);
}

// --- 8. 미지원 영상 포맷(AVI) → 거부 ---
{
  console.log('\n[8] 미지원 영상 포맷(AVI) → 거부');
  const avi = file('video/x-msvideo', 64, 'a.avi');
  const r = await handleVideoCensorship(avi, mockAI(allFalse));
  check('ok=false', r.ok === false);
  const body = JSON.parse(await r.response.text());
  check('MP4/WebM 안내', /MP4|WebM/.test(body.error), body.error);
}

// --- 9. MP4 영상 → videos 배열로 전달되는지 + 적절 → 통과 ---
{
  console.log('\n[9] MP4 영상 → 통과');
  let captured = null;
  const env = { AI: { run: async (model, body) => {
    captured = body;
    return { model:'clef-omni', answers: allFalse(), usage:{input_tokens:1,output_tokens:1} };
  }}};
  const r = await handleVideoCensorship(file('video/mp4', 64, 'a.mp4'), env);
  check('ok=true', r.ok === true, JSON.stringify(r));
  check('videos에 전달', Array.isArray(captured?.videos) && captured.videos.length === 1);
  check('videos는 data:video/mp4', String(captured?.videos?.[0]).startsWith('data:video/mp4;base64,'), String(captured?.videos?.[0]).slice(0,30));
  check('images 미사용', captured?.images === undefined);
}

// --- 10. 부적절 영상 → 거부 ---
{
  console.log('\n[10] 부적절 영상 → 거부');
  const r = await handleVideoCensorship(file('video/mp4',64,'a.mp4'), mockAI(() => ({
    ...allFalse(), gore: { type:'noul', noul: 0.88 }, extremist: { type:'noul', noul: 0.77 }
  })));
  check('ok=false', r.ok === false);
  const body = JSON.parse(await r.response.text());
  check('고어 사유', body.error.includes('고어'), body.error);
  check('극단주의 사유', body.error.includes('극단주의'), body.error);
}

// --- 11. images 키로 전달 + 데이터 URL 형태 ---
{
  console.log('\n[11] 이미지 → images 데이터 URL');
  let captured = null;
  const env = { AI: { run: async (m, b) => { captured = b; return { model:'clef-omni', answers: allFalse(), usage:{input_tokens:1,output_tokens:1} }; }}};
  await handleImageCensorship(pngFile(), env);
  check('images 1개', Array.isArray(captured?.images) && captured.images.length === 1);
  check('data:image/png;base64,', String(captured?.images?.[0]).startsWith('data:image/png;base64,'));
  check('videos 미사용', captured?.videos === undefined);
}

// --- 12. 모델 호출 예외 → fail-closed 거부(500) ---
{
  console.log('\n[12] 모델 호출 예외 → 거부');
  const env = { AI: { run: async () => { throw new Error('boom'); } } };
  const r = await handleImageCensorship(pngFile(), env);
  check('ok=false', r.ok === false);
  check('status 500', r.response.status === 500);
}

// --- 13. 질문 스키마가 noul 타입 + criteria 포함 ---
{
  console.log('\n[13] 질문 스키마 형식');
  let captured = null;
  const env = { AI: { run: async (m,b)=>{ captured=b; return { model:'clef-omni', answers: allFalse(), usage:{input_tokens:1,output_tokens:1} }; }}};
  await handleImageCensorship(pngFile(), env);
  const q = captured.questions;
  check('12개 질문', Object.keys(q).length === 12);
  check('모두 noul', Object.values(q).every(x => x.type === 'noul'));
  check('모두 instructions 존재', Object.values(q).every(x => typeof x.instructions === 'string' && x.instructions.length > 0));
  check('모두 criteria.true/false', Object.values(q).every(x => x.criteria && x.criteria.true && x.criteria.false));
  check('state 존재', typeof captured.state === 'string' && captured.state.length > 0);
}

console.log(`\n===== ${passed} passed, ${failed} failed =====`);
process.exit(failed ? 1 : 0);
