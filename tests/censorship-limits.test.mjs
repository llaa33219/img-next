// 60초 영상 제한 + base64 정확도 경계 테스트
import { handleVideoCensorship, handleImageCensorship } from '../censorship.js';

const CATS = ['nudity','partial_nudity','violence','gore','drugs','hate',
              'harassment','self_harm','illegal','spam','child_exploitation','extremist'];
const allFalse = () => Object.fromEntries(CATS.map(c=>[c,{type:'noul',noul:0.02}]));
const mockAI = () => ({ AI:{ run: async()=>({model:'clef-omni',answers:allFalse(),usage:{input_tokens:1,output_tokens:1}}) }});
const mockCountAI = () => ({ AI:{ run: async()=>({model:'clef-omni',answers:allFalse(),usage:{input_tokens:1,output_tokens:1}}) }});

let passed=0, failed=0;
const check=(n,c,e='')=>{ c?(passed++,console.log('  PASS  '+n)):(failed++,console.log('  FAIL  '+n+' '+e)); };

// 합법적인 mp4 파일 생성 (ftyp + mdat + moov의 mvhd 박스에 duration 기록)
function makeMp4(durationSec) {
  // 최소한의 ISO BMFF 구조: ftyp
  const box = (type, payload) => {
    const size = 8 + payload.length;
    const b = Buffer.alloc(size);
    b.writeUInt32BE(size, 0); b.write(type, 4, 'ascii'); payload.copy(b, 8);
    return b;
  };
  const ftyp = box('ftyp', Buffer.from('isomiso2avc1mp41','ascii'));
  // mvhd(version0): timescale=1000, duration=sec*1000
  const mvhdPayload = Buffer.alloc(100);
  mvhdPayload.writeUInt32BE(0,0);      // version+flags
  mvhdPayload.writeUInt32BE(0,4);      // creation
  mvhdPayload.writeUInt32BE(0,8);      // modification
  mvhdPayload.writeUInt32BE(1000,12);  // timescale
  mvhdPayload.writeUInt32BE(Math.round(durationSec*1000),16); // duration
  mvhdPayload.writeUInt32BE(0x00010000,20); // rate
  const mvhd = box('mvhd', mvhdPayload);
  const moov = box('moov', Buffer.concat([mvhd, box('trak', Buffer.alloc(8))]));
  const mdat = box('mdat', Buffer.alloc(16));
  return Buffer.concat([ftyp, moov, mdat]);
}

// fetch 목 — 분할 API 동작을 결정적으로 재현
function mockFetch(opts = {}) {
  globalThis.fetch = async (url) => {
    if (String(url).includes('compress-video')) {
      if (opts.splitFails) return { ok:false, status:500, text:async()=>'{"error":"boom"}' };
      const parts = Array.from({length: opts.splitParts ?? 3},(_,k)=>({
        base64: Buffer.from('PART'+(k+1)).toString('base64'), mimeType:'video/mp4'
      }));
      return { ok:true, status:200, json: async()=>({ success:true, parts }) };
    }
    if (String(url).includes('compress-image')) return { ok:false, status:500, text:async()=>'{}' };
    throw new Error('unexpected fetch '+url);
  };
}

console.log('\n[14] 영상 60초 제한 — 초과 시 거부가 아니라 분할');
{
  mockFetch();
  const r = await handleVideoCensorship(new File([makeMp4(5)],'s.mp4',{type:'video/mp4'}), mockAI());
  check('5초 영상 → 통과', r.ok===true, JSON.stringify(r.ok));
}
{
  mockFetch();
  const r = await handleVideoCensorship(new File([makeMp4(60)],'e.mp4',{type:'video/mp4'}), mockAI());
  check('정확히 60초 → 분할 없이 통과', r.ok===true, JSON.stringify(r.ok));
}
{
  mockFetch({splitParts:2});
  const r = await handleVideoCensorship(new File([makeMp4(120)],'l.mp4',{type:'video/mp4'}), mockAI());
  check('120초 영상 → 거부가 아닌 통과', r.ok===true, JSON.stringify(r.ok));
}
{
  mockFetch({splitParts:2});
  const r = await handleVideoCensorship(new File([makeMp4(60.5)],'o.mp4',{type:'video/mp4'}), mockAI());
  check('60.5초 → 통과', r.ok===true, JSON.stringify(r.ok));
}
{
  mockFetch({splitFails:true});
  const r = await handleVideoCensorship(new File([makeMp4(120)],'f.mp4',{type:'video/mp4'}), mockAI());
  check('분할 실패 시에만 거부', r.ok===false);
  const b = JSON.parse(await r.response.text());
  check('분할 실패 메시지', b.error.includes('분할'), b.error);
}

console.log('\n[15] base64 크기 경계 (정확한 계산)');
{
  // 4MiB를 살짝 넘는 JPEG 헤더 없는 raw 바이트 → 용량 초과 거부 확인
  const big = Buffer.alloc(4*1024*1024 + 1024, 0xFF);
  // 압축 API를 호출하지 않도록 실제 포맷을 유지하되 크기만 크게 만든다
  const r = await handleImageCensorship(new File([big],'big.jpg',{type:'image/jpeg'}), mockAI());
  // 압축 실패(로컬 네트워크 없음) → 원본 진행 → 크기 초과로 거부되어야 함
  check('4MiB+1KB → 거부', r.ok===false, JSON.stringify(r.ok));
  if (!r.ok) { const b=JSON.parse(await r.response.text()); check('용량 초과 메시지', b.error.includes('용량'), b.error); }
}
{
  // 하한 바로 아래는 통과해야 함 (오버계산 버그가 있으면 여기서 걸림)
  const ok4 = Buffer.alloc(4*1024*1024 - 64*1024, 0xFF);
  const r = await handleImageCensorship(new File([ok4],'ok.jpg',{type:'image/jpeg'}), mockAI());
  check('4MiB-64KB → 통과(허용)', r.ok===true, JSON.stringify(r.ok));
}

console.log(`\n===== ${passed} passed, ${failed} failed =====`);
process.exit(failed?1:0);
