// 60초 초과 영상을 거부하지 않고 분할하여 검열하는지 검증
import { handleVideoCensorship } from '../censorship.js';

const CATS = ['nudity','partial_nudity','violence','gore','drugs','hate',
              'harassment','self_harm','illegal','spam','child_exploitation','extremist'];
const allFalse = () => Object.fromEntries(CATS.map(c=>[c,{type:'noul',noul:0.02}]));
const oneBad  = () => ({...allFalse(), nudity:{type:'noul',noul:0.95}});

let passed=0, failed=0;
const check=(n,c,e='')=>{ c?(passed++,console.log('  PASS  '+n)):(failed++,console.log('  FAIL  '+n+' '+e)); };

function makeMp4(durationSec) {
  const box=(t,p)=>{const b=Buffer.alloc(8+p.length);b.writeUInt32BE(8+p.length,0);b.write(t,4,'ascii');p.copy(b,8);return b;};
  const ftyp=box('ftyp',Buffer.from('isomiso2avc1mp41','ascii'));
  const m=Buffer.alloc(100);
  m.writeUInt32BE(0,0); m.writeUInt32BE(0,4); m.writeUInt32BE(0,8);
  m.writeUInt32BE(1000,12); m.writeUInt32BE(Math.round(durationSec*1000),16);
  m.writeUInt32BE(0x00010000,20);
  const moov=box('moov',Buffer.concat([box('mvhd',m),box('trak',Buffer.alloc(8))]));
  return Buffer.concat([ftyp,moov,box('mdat',Buffer.alloc(16))]);
}

const mp4 = (sec)=>new File([makeMp4(sec)],'v.mp4',{type:'video/mp4'});

function makeEnv(answerFactory, opts={}) {
  const calls = { splitRequests: 0, compressRequests: 0, modelBody: null };
  const env = {
    AI:{ run: async (m,b)=>{ calls.modelBody=b;
      return {model:'clef-omni',answers:answerFactory(),usage:{input_tokens:1,output_tokens:1}}; } },
    __calls: calls
  };
  // IVCP fetch 목
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('compress-video')) {
      if (opts.splitFails) return { ok:false, status:500, text:async()=>'{"error":"boom"}' };
      calls.splitRequests++;
      const n = opts.splitParts ?? 3;
      // 분할 결과를 parts 배열로 반환 (서비스 실제 응답 형태 가정)
      const parts = Array.from({length:n},(_,k)=>({ base64: Buffer.from('PART'+(k+1)).toString('base64'), mimeType:'video/mp4' }));
      return { ok:true, status:200, json: async()=>({ success:true, parts }) };
    }
    if (u.includes('compress-image')) return { ok:false, status:500, text:async()=>'{}' };
    throw new Error('unexpected fetch '+u);
  };
  return env;
}

console.log('\n[16] 60초 이하 영상 → 분할 없이 그대로 검열');
{
  const env = makeEnv(allFalse);
  const r = await handleVideoCensorship(mp4(30), env);
  check('ok=true', r.ok===true, JSON.stringify(r.ok));
  check('분할 요청 없음', env.__calls.splitRequests===0, `split=${env.__calls.splitRequests}`);
  check('videos 1개', env.__calls.modelBody?.videos?.length===1);
}

console.log('\n[17] 60초 초과 영상 → 거부하지 않고 분할');
{
  const env = makeEnv(allFalse, {splitParts:3});
  const r = await handleVideoCensorship(mp4(180), env);
  check('ok=true (거부 아님)', r.ok===true, JSON.stringify(r.ok));
  check('분할 API 호출됨', env.__calls.splitRequests===1, `split=${env.__calls.splitRequests}`);
  check('videos 최대 2개', env.__calls.modelBody?.videos?.length===2,
        `n=${env.__calls.modelBody?.videos?.length}`);
}

console.log('\n[18] 분할된 구간에서 부적절 콘텐츠 → 거부');
{
  const env = makeEnv(oneBad, {splitParts:3});
  const r = await handleVideoCensorship(mp4(180), env);
  check('ok=false', r.ok===false);
  const b = JSON.parse(await r.response.text());
  check('성적/노출 사유', b.error.includes('성적/노출'), b.error);
}

console.log('\n[19] 분할 결과가 2개 이하면 그대로 전달');
{
  const env = makeEnv(allFalse, {splitParts:2});
  await handleVideoCensorship(mp4(150), env);
  check('videos 2개', env.__calls.modelBody?.videos?.length===2,
        `n=${env.__calls.modelBody?.videos?.length}`);
}
{
  const env = makeEnv(allFalse, {splitParts:1});
  await handleVideoCensorship(mp4(90), env);
  check('videos 1개', env.__calls.modelBody?.videos?.length===1,
        `n=${env.__calls.modelBody?.videos?.length}`);
}

console.log('\n[20] 분할 API 실패 시에만 명확한 안내와 함께 거부');
{
  const env = makeEnv(allFalse, {splitFails:true});
  const r = await handleVideoCensorship(mp4(180), env);
  check('ok=false', r.ok===false);
  const b = JSON.parse(await r.response.text());
  check('분할 실패 메시지', b.error.includes('분할'), b.error);
  check('60초 안내 포함', b.error.includes('60초'), b.error);
  check('status 400', r.response.status===400);
}

console.log('\n[21] 균등 샘플링 — 양끝 구간 커버 (앞편 편향 없음)');
{
  const env = makeEnv(allFalse, {splitParts:6});
  await handleVideoCensorship(mp4(600), env);
  const vids = env.__calls.modelBody.videos;
  const decode = (u) => Buffer.from(u.split(',')[1],'base64').toString();
  // 6개 중 2개 균등 선택 → 첫 번째(PART1)와 마지막(PART6)여야 함
  check('2개 선택', vids.length===2);
  check('첫 구간(PART1) 포함', decode(vids[0])==='PART1', decode(vids[0]));
  check('마지막 구간(PART6) 포함', decode(vids[1])==='PART6', decode(vids[1]));
  check('중간 구간 아님', decode(vids[0])!=='PART2' && decode(vids[1])!=='PART3');
  check('서로 다른 구간', decode(vids[0])!==decode(vids[1]));
}


// ---- 추가: 실제 서비스 응답 형태(parts에 duration 포함) 반영 ----
console.log('\n[22] duration 메타 반영 — 60초 초과 세그먼트는 안전하게 거부');
{
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('compress-video')) {
      // 서비스가 60초를 초과하는 세그먼트를 뱉는 경우를 시뮬레이션
      const parts = [
        { partNumber:1, duration:18.8, size:70, base64: Buffer.from('A').toString('base64'), },
        { partNumber:2, duration:95.0, size:70, base64: Buffer.from('B').toString('base64') },
      ];
      return { ok:true, status:200, json: async()=>({ success:true, action:'split', totalParts:2, parts }) };
    }
    throw new Error('unexpected');
  };
  const env = { AI:{ run: async()=>({model:'clef-omni',answers:allFalse(),usage:{input_tokens:1,output_tokens:1}}) } };
  const r = await handleVideoCensorship(mp4(180), env);
  check('60초 초과 세그먼트 → 거부', r.ok===false, JSON.stringify(r.ok));
  const b = JSON.parse(await r.response.text());
  check('초과 안내 메시지', b.error.includes('60초'), b.error);
  globalThis.fetch = orig;
}

console.log('\n[23] targetSizeKB가 비트레이트에 맞춰 계산되는지');
{
  let sentTarget = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('compress-video')) {
      // multipart에서 targetSizeKB 추출
      const body = init?.body;
      if (body && typeof body.get === 'function') sentTarget = body.get('targetSizeKB');
      const parts = [{ partNumber:1, duration:18, size:70, base64: Buffer.from('A').toString('base64') }];
      return { ok:true, status:200, json: async()=>({ success:true, action:'split', totalParts:1, parts }) };
    }
    throw new Error('unexpected');
  };
  const env = { AI:{ run: async()=>({model:'clef-omni',answers:allFalse(),usage:{input_tokens:1,output_tokens:1}}) } };
  await handleVideoCensorship(mp4(180), env);
  // 180초 영상, 파일 크기는 mp4()가 만드는 크기. 목표 = bytesPerSec*(60/3)/1024
  const expected = Math.max(16, Math.ceil(((mp4(180).size/180)*(20))/1024));
  check('targetSizeKB 전송됨', sentTarget !== null && sentTarget !== undefined, String(sentTarget));
  check('기대값과 일치', Number(sentTarget) === expected, `sent=${sentTarget} expected=${expected}`);
  check('20초 분할 목표(60/3)', expected >= 16, `expected=${expected}`);
  globalThis.fetch = orig;
}

console.log(`\n===== ${passed} passed, ${failed} failed =====`);
process.exit(failed?1:0);
