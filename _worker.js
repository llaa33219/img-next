// ==============================
// 전역: 중복 요청 관리 Map
// ==============================
const requestsInProgress = {};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // (디버그 용) 요청 로그
    // 실제 운영에서 노출 최소화하려면 주석 처리하거나 console.log 제거
    console.log("Incoming Request:", {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers)
    });

    // =======================================
    // 1) [POST] /upload => 업로드 처리
    // =======================================
    if (request.method === 'POST' && url.pathname === '/upload') {
      const cfReqId = request.headers.get('Cf-Request-Id') || '';

      // ----- 중복 요청 체크 -----
      if (cfReqId) {
        // 이미 진행 중인 요청이라면 Promise 공유
        if (requestsInProgress[cfReqId]) {
          console.log(`[Dedup] 중복 요청 감지 => Cf-Request-Id=${cfReqId}. 기존 Promise 공유.`);
          return requestsInProgress[cfReqId].promise;
        }
        // 아니면 새 Promise 등록
        else {
          let resolveFn, rejectFn;
          const promise = new Promise((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
          });
          requestsInProgress[cfReqId] = { promise, resolve: resolveFn, reject: rejectFn };

          // 일정 시간(1분) 후 메모리 해제
          ctx.waitUntil((async () => {
            await new Promise(r => setTimeout(r, 60000)); // 1분
            delete requestsInProgress[cfReqId];
          })());

          // 실 업로드 처리
          let finalResp;
          try {
            finalResp = await handleUpload(request, env);
            requestsInProgress[cfReqId].resolve(finalResp);
          } catch (err) {
            console.log("handleUpload error:", err);
            const failResp = new Response(
              JSON.stringify({ success: false, error: err.message }),
              { status: 500 }
            );
            requestsInProgress[cfReqId].reject(failResp);
            finalResp = failResp;
          }
          return finalResp;
        }
      }
      // cfReqId 없으면 그냥 업로드 처리
      else {
        return handleUpload(request, env);
      }
    }

    // =======================================
    // 2) [GET] /{코드} => R2 파일 or HTML
    // =======================================
    // 예: /AbCD1234,xyzXYZ12
    else if (
      request.method === 'GET' &&
      /^\/[A-Za-z0-9,]{8,}(,[A-Za-z0-9]{8})*$/.test(url.pathname)
    ) {
      // raw=1 이면 바이너리 원본
      if (url.searchParams.get('raw') === '1') {
        const code = url.pathname.slice(1).split(",")[0];
        const object = await env.IMAGES.get(code);
        if (!object) {
          return new Response('Not Found', { status: 404 });
        }
        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
        return new Response(object.body, { headers });
      }

      // raw=1 아니면 HTML 페이지
      const codes = url.pathname.slice(1).split(",");
      const objects = await Promise.all(
        codes.map(async code => {
          const object = await env.IMAGES.get(code);
          return { code, object };
        })
      );

      let mediaTags = "";
      for (const { code, object } of objects) {
        if (object && object.httpMetadata?.contentType?.startsWith('video/')) {
          // 동영상
          mediaTags += `<video src="https://${url.host}/${code}?raw=1" width: 40vw; height: auto;></video>\n`;
        } else {
          // 이미지
          mediaTags += `<img src="https://${url.host}/${code}?raw=1" alt="Uploaded Media" onclick="toggleZoom(this)">\n`;
        }
      }
      const htmlContent = renderHTML(mediaTags, url.host);
      return new Response(htmlContent, {
        headers: { "Content-Type": "text/html; charset=UTF-8" }
      });
    }

    // =======================================
    // 3) 그 외 => 기본 정적 에셋(ASSETS)
    // =======================================
    return env.ASSETS.fetch(request);
  }
};

// =======================
// 메인 업로드 처리 함수
// =======================
async function handleUpload(request, env) {
  const formData = await request.formData();
  const files = formData.getAll('file');
  if (!files || files.length === 0) {
    return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }), { status: 400 });
  }

  // =========================
  // 1) 검열: 불량이면 저장 안 하고 바로 에러
  // =========================
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      const r = await handleImageCensorship(file, env);
      if (!r.ok) return r.response; // 검열 실패 => 즉시 반환
    } else if (file.type.startsWith('video/')) {
      const r = await handleVideoCensorship(file, env);
      if (!r.ok) return r.response; // 검열 실패 => 즉시 반환
    }
  }

  // =========================
  // 2) R2 업로드 (검열 통과만 저장)
  // =========================
  let codes = [];
  for (const file of files) {
    const code = await generateUniqueCode(env);
    const fileBuffer = await file.arrayBuffer();

    // R2에 업로드
    await env.IMAGES.put(code, fileBuffer, {
      httpMetadata: { contentType: file.type }
    });
    codes.push(code);
  }
  const urlCodes = codes.join(",");
  const host = request.headers.get('host') || 'example.com';
  const finalUrl = `https://${host}/${urlCodes}`; // => 예: https://도메인/AbCD1234

  console.log(">>> 업로드 완료 =>", finalUrl);

  return new Response(JSON.stringify({ success: true, url: finalUrl }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// =======================
// 이미지 검열
// =======================
async function handleImageCensorship(file, env) {
  try {
    // --- (1) 클라우드플레어 이미지 리사이즈 ---
    let fileForCensorship = file;
    try {
      const buf = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(buf);
      const dataUrl = `data:${file.type};base64,${base64}`;

      // cf image resizing (600x600 안에 fit)
      const resizedResp = await fetch(new Request(dataUrl, {
        cf: { image: { width: 600, height: 600, fit: "inside" } }
      }));
      if (resizedResp.ok) {
        fileForCensorship = await resizedResp.blob();
      }
    } catch(e) {
      // 리사이즈 실패 시 그냥 원본으로 검사
      console.log("이미지 리사이즈 실패:", e);
    }

    // --- (2) SightEngine 호출 ---
    const sightForm = new FormData();
    sightForm.append('media', fileForCensorship, 'upload');
    sightForm.append('models','nudity,wad,offensive'); // 성인물, 무기, 욕설 등
    sightForm.append('api_user', env.SIGHTENGINE_API_USER);
    sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);

    const resp = await fetch('https://api.sightengine.com/1.0/check.json', {
      method: 'POST',
      body: sightForm
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return {
        ok: false,
        response: new Response(JSON.stringify({ success: false, error: `이미지 검열 API 실패: ${errText}` }), { status: 400 })
      };
    }
    let data;
    try {
      data = await resp.json();
    } catch(e) {
      let fallback = await resp.text();
      return {
        ok: false,
        response: new Response(JSON.stringify({ success: false, error: `이미지 검열 JSON 오류: ${fallback}` }), { status: 400 })
      };
    }

    // --- (3) 결과판단 ---
    if (data.status === 'failure') {
      // (추가) usage_limit 에러 감지
      // e.g. { "status":"failure", "error":{ "type":"usage_limit","code":37,... } }
      if (data.error && data.error.type === 'usage_limit' && data.error.code === 37) {
        return {
          ok: false,
          response: new Response(JSON.stringify({
            success: false,
            error: "검열 api의 실시간 처리량 문제로 인해 잠시 후 시도해주세요"
          }), { status: 503 })
        };
      }
      // 일반 failure
      return {
        ok: false,
        response: new Response(JSON.stringify({
          success: false,
          error: data.error?.message || "이미지 검열 실패"
        }), { status: 400 })
      };
    }

    // 예: nudity.raw, nudity.partial, wad.weapon, etc.
    let reasons = [];
    if (data.nudity) {
      const { is_nude, raw, partial } = data.nudity;
      if (is_nude === true || (raw && raw > 0.3) || (partial && partial > 0.3)) {
        reasons.push("선정적 콘텐츠(누드)");
      }
    }
    if (data.offensive && data.offensive.prob > 0.3) {
      reasons.push("욕설/모욕적 콘텐츠");
    }
    if (data.wad && (data.wad.weapon > 0.3 || data.wad.alcohol > 0.3 || data.wad.drugs > 0.3)) {
      reasons.push("위험물(무기/약물 등)");
    }

    if (reasons.length > 0) {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ success: false, error: `검열됨: ${reasons.join(", ")}` }),
          { status: 400 }
        )
      };
    }
    return { ok: true }; // 통과
  } catch(e) {
    console.log("handleImageCensorship error:", e);
    return {
      ok: false,
      response: new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 })
    };
  }
}

// =======================
// 동영상 검열
// =======================
async function handleVideoCensorship(file, env) {
  try {
    // (1) 용량 제한 - 여기서는 50MB 예시
    if (file.size > 50 * 1024 * 1024) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ success: false, error: "영상 용량 50MB 초과" }), { status: 400 })
      };
    }

    // (2) 동영상 길이 추출
    let videoDuration = await getMP4Duration(file);
    if (!videoDuration) videoDuration = 0;

    // (3) 1분 미만 => check-sync
    if (videoDuration < 60 && videoDuration !== 0) {
      const sightForm = new FormData();
      sightForm.append('media', file, 'upload');
      sightForm.append('models','nudity,wad,offensive');
      sightForm.append('api_user', env.SIGHTENGINE_API_USER);
      sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);

      const syncResp = await fetch('https://api.sightengine.com/1.0/video/check-sync.json', {
        method:'POST',
        body:sightForm
      });
      if(!syncResp.ok) {
        const errText = await syncResp.text();
        return {
          ok:false,
          response:new Response(JSON.stringify({
            success:false,
            error:`동영상(sync) API 실패: ${errText}`
          }), {status:400})
        };
      }

      let data;
      try {
        data = await syncResp.json();
      } catch(e) {
        const fallback = await syncResp.text();
        return {
          ok:false,
          response:new Response(JSON.stringify({
            success:false,
            error:`동영상(sync) JSON 오류: ${fallback}`
          }), {status:400})
        };
      }

      // (추가) usage_limit 에러 처리
      if (data.status === 'failure') {
        if (data.error && data.error.type === 'usage_limit' && data.error.code === 37) {
          return {
            ok: false,
            response: new Response(JSON.stringify({
              success: false,
              error: "검열 api의 실시간 처리량 문제로 인해 잠시 후 시도해주세요"
            }), { status: 503 })
          };
        }
        return {
          ok: false,
          response: new Response(JSON.stringify({
            success: false,
            error: `동영상(sync) 처리 실패: ${data.error?.message || '알 수 없는 오류'}`
          }), { status: 400 })
        };
      }

      // frames 분석
      let frames = [];
      if (data.data && data.data.frames) {
        frames = Array.isArray(data.data.frames) ? data.data.frames : [data.data.frames];
      } else if (data.frames) {
        frames = Array.isArray(data.frames) ? data.frames : [data.frames];
      }

      let found = checkFramesForCensorship(frames, data.data, 0.5);
      if (found.length>0) {
        return {
          ok:false,
          response:new Response(JSON.stringify({
            success:false,
            error:`검열됨: ${found.join(", ")}`
          }), {status:400})
        };
      }
      return { ok: true };
    }

    // (4) 1분 이상 => async=1
    else {
      const sightForm = new FormData();
      sightForm.append('media', file, 'upload');
      sightForm.append('models','nudity,wad,offensive');
      sightForm.append('api_user', env.SIGHTENGINE_API_USER);
      sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);
      sightForm.append('async','1');

      // 초기 업로드
      const initResp = await fetch('https://api.sightengine.com/1.0/video/check.json', {
        method:'POST',
        body:sightForm
      });
      if(!initResp.ok) {
        const errText = await initResp.text();
        return {
          ok:false,
          response:new Response(JSON.stringify({
            success:false,
            error:`비동기 업로드 실패: ${errText}`
          }), {status:400})
        };
      }

      let initData;
      try {
        initData = await initResp.json();
      } catch(e) {
        const fallback = await initResp.text();
        return {
          ok:false,
          response:new Response(JSON.stringify({
            success:false,
            error:`비동기 업로드 JSON 오류: ${fallback}`
          }), {status:400})
        };
      }

      // (추가) usage_limit 에러 처리
      if (initData.status === 'failure') {
        if (initData.error && initData.error.type === 'usage_limit' && initData.error.code === 37) {
          return {
            ok: false,
            response: new Response(JSON.stringify({
              success: false,
              error: "검열 api의 실시간 처리량 문제로 인해 잠시 후 시도해주세요"
            }), { status: 503 })
          };
        }
        return {
          ok:false,
          response:new Response(JSON.stringify({
            success:false,
            error:`비동기 업로드 실패: ${initData.error}`
          }), {status:400})
        };
      }

      if(!initData.request || !initData.request.id) {
        return {
          ok:false,
          response:new Response(JSON.stringify({
            success:false,
            error:`비동기 응답에 request.id 없음`
          }), {status:400})
        };
      }
      const reqId = initData.request.id;

      // (4)-b 폴링(5초 간격, 최대 6회=30초)
      let finalData = null;
      let maxAttempts = 6;
      while(maxAttempts>0) {
        await new Promise(r => setTimeout(r, 5000));
        const statusUrl = `https://api.sightengine.com/1.0/video/check.json?request_id=${reqId}&models=nudity,wad,offensive&api_user=${env.SIGHTENGINE_API_USER}&api_secret=${env.SIGHTENGINE_API_SECRET}`;
        const statusResp = await fetch(statusUrl);
        if(!statusResp.ok) {
          let errText = await statusResp.text();
          return {
            ok:false,
            response:new Response(JSON.stringify({
              success:false,
              error:`비동기 폴링 실패: ${errText}`
            }), {status:400})
          };
        }

        let statusData;
        try {
          statusData = await statusResp.json();
        } catch(e) {
          const fallback = await statusResp.text();
          return {
            ok:false,
            response:new Response(JSON.stringify({
              success:false,
              error:`폴링 JSON 오류: ${fallback}`
            }), {status:400})
          };
        }

        // (추가) usage_limit 에러 처리
        if (statusData.status === 'failure') {
          if (statusData.error && statusData.error.type === 'usage_limit' && statusData.error.code === 37) {
            return {
              ok: false,
              response: new Response(JSON.stringify({
                success: false,
                error: "검열 api의 실시간 처리량 문제로 인해 잠시 후 시도해주세요"
              }), { status: 503 })
            };
          }
          return {
            ok:false,
            response:new Response(JSON.stringify({
              success:false,
              error:`비동기 검열 실패: ${statusData.error}`
            }), {status:400})
          };
        }

        if(statusData.progress_status === 'finished') {
          finalData = statusData;
          break;
        }
        maxAttempts--;
      }

      if(!finalData) {
        return {
          ok:false,
          response:new Response(JSON.stringify({
            success:false,
            error:`비동기 검열이 30초 내에 끝나지 않음`
          }), {status:408})
        };
      }

      // 4-c 최종 프레임 분석
      let frames = [];
      if (finalData.data && finalData.data.frames) {
        frames = Array.isArray(finalData.data.frames) ? finalData.data.frames : [finalData.data.frames];
      } else if(finalData.frames) {
        frames = Array.isArray(finalData.frames) ? finalData.frames : [finalData.frames];
      }

      let found = checkFramesForCensorship(frames, finalData.data, 0.5);
      if(found.length>0) {
        return {
          ok:false,
          response:new Response(JSON.stringify({
            success:false,
            error:`검열됨: ${found.join(", ")}`
          }), {status:400})
        };
      }
      return {ok:true};
    }
  } catch(e) {
    console.log("handleVideoCensorship error:", e);
    return {
      ok:false,
      response:new Response(JSON.stringify({
        success:false,
        error:e.message
      }), {status:500})
    };
  }
}

// =======================
// MP4 재생길이 간단 추출 함수
// =======================
async function getMP4Duration(file) {
  try {
    const buffer = await file.arrayBuffer();
    const dv = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);
    for (let i = 0; i < uint8.length - 4; i++) {
      // 'm','v','h','d' => 109,118,104,100
      if (uint8[i]===109 && uint8[i+1]===118 && uint8[i+2]===104 && uint8[i+3]===100) {
        const boxStart = i - 4;
        const version = dv.getUint8(boxStart + 8);
        // version 0
        if (version === 0) {
          const timescale = dv.getUint32(boxStart+20);
          const duration = dv.getUint32(boxStart+24);
          return duration / timescale;
        }
        // version 1
        else if (version === 1) {
          const timescale = dv.getUint32(boxStart+28);
          const high = dv.getUint32(boxStart+32);
          const low  = dv.getUint32(boxStart+36);
          const bigDuration = high * 2**32 + low;
          return bigDuration / timescale;
        }
      }
    }
    return null; // 못 찾음
  } catch(e) {
    console.log("getMP4Duration error:", e);
    return null;
  }
}

// =======================
// 프레임 정보 내 검열 유의점 파악
// =======================
function checkFramesForCensorship(frames, rootData, threshold=0.5) {
  let reasons = [];

  for (let f of frames) {
    // nudity
    if (f.nudity) {
      const { raw, partial, sexual_activity } = f.nudity;
      if ((raw && raw > threshold) ||
          (partial && partial > threshold) ||
          (sexual_activity && sexual_activity > threshold)) {
        reasons.push("선정적(누드/성행위)");
        break; // 한 프레임이라도 걸리면 중단
      }
    }
    // offensive
    if (f.offensive && f.offensive.prob > threshold) {
      reasons.push("욕설/모욕");
      break;
    }
    // wad (무기, 알코올, 약물)
    if (f.wad &&
       (f.wad.weapon > threshold || f.wad.alcohol > threshold || f.wad.drugs > threshold)) {
      reasons.push("무기/약물 등");
      break;
    }
  }
  return reasons;
}

// =======================
// 고유 8자 코드 생성
// =======================
async function generateUniqueCode(env, length=8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = '';
    for (let i = 0; i < length; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const existing = await env.IMAGES.get(code);
    if (!existing) return code; // 중복 없으면 리턴
  }
  throw new Error("코드 생성 실패(10회 시도 모두 중복)");
}

// =======================
// ArrayBuffer -> base64
// =======================
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// =======================
// 최종 HTML 렌더
// =======================
function renderHTML(mediaTags, host) {
  // 간단히 이미지/영상만 보여주는 페이지 예시
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="https://i.imgur.com/2MkyDCh.png" type="image/png">
  <title>이미지 공유</title>
  <style>
    body {
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      align-items: center;
      height: 100vh;
      margin: 0;
      padding: 20px;
      overflow: auto;
    }
  
    .upload-container {
      display: flex;
      flex-direction: column;
      align-items: center;
    }
  
    button {
      background-color: #007BFF;
      color: white;
      border: none;
      border-radius: 20px;
      padding: 10px 20px;
      margin: 20px 0;
      width: 600px;
      height: 61px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.2);
      cursor: pointer;
      transition: background-color 0.3s ease, transform 0.1s ease, box-shadow 0.3s ease;
      font-weight: bold;
      font-size: 18px;
      text-align: center;
    }
  
    button:hover {
      background-color: #005BDD;
      transform: translateY(2px);
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    }
  
    button:active {
      background-color: #0026a3;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    }
  
    #fileNameDisplay {
      font-size: 16px;
      margin-top: 10px;
      color: #333;
    }
  
    #linkBox {
      width: 500px;
      height: 40px;
      margin: 20px 0;
      font-size: 16px;
      padding: 10px;
      text-align: center;
      border-radius: 14px;
    }
  
    .copy-button {
      background: url('https://img.icons8.com/ios-glyphs/30/000000/copy.png') no-repeat center;
      background-size: contain;
      border: none;
      cursor: pointer;
      width: 60px;
      height: 40px;
      margin-left: 10px;
      vertical-align: middle;
    }
  
    .link-container {
      display: flex;
      justify-content: center;
      align-items: center;
    }
    
    #imageContainer img {
      width: 40vw;
      height: auto;
      max-width: 40vw;
      max-height: 50vh;
      display: block;
      margin: 20px auto;
      cursor: pointer;
      transition: all 0.3s ease;
      object-fit: contain;
      cursor: zoom-in;
    }
  
    #imageContainer img.landscape {
      width: 40vw;
      height: auto;
      max-width: 40vw;
      cursor: zoom-in;
    }
  
    #imageContainer img.portrait,
    #imageContainer video.portrait {
      width: auto;
      height: 50vh;
      max-width: 40vw;
      cursor: zoom-in;
    }
  
    #imageContainer img.expanded.landscape,
    #imageContainer video.expanded.landscape {
      width: 80vw;
      height: auto;
      max-width: 80vw;
      max-height: 100vh;
      cursor: zoom-out;
    }
  
    #imageContainer img.expanded.portrait,
    #imageContainer video.expanded.portrait {
      width: auto;
      height: 100vh;
      max-width: 80vw;
      max-height: 100vh;
      cursor: zoom-out;
    }
  
    .container {
      text-align: center;
    }
  
    .header-content {
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 20px;
      font-size: 30px;
      text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
    }
  
    .header-content img {
      margin-right: 20px;
      border-radius: 14px;
    }
  
    .toggle-button {
      background-color: #28a745;
      color: white;
      border: none;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      display: none;
      justify-content: center;
      align-items: center;
      cursor: pointer;
      font-size: 24px;
      margin-left: 20px;
    }
  
    .hidden {
      display: none;
    }
  
    .title-img-desktop {
      display: block;
    }
  
    .title-img-mobile {
      display: none;
    }
  
    @media (max-width: 768px) {
      button {
        width: 300px;
      }
      #linkBox {
        width: 200px;
      }
      .header-content {
        font-size: 23px;
      }
      .title-img-desktop {
        display: none;
      }
      .title-img-mobile {
        display: block;
      }
    }
  </style>
  <link rel="stylesheet" href="https://llaa33219.github.io/BLOUplayer/videoPlayer.css">
  <script src="https://llaa33219.github.io/BLOUplayer/videoPlayer.js"></script>
</head>
<body>
  <div class="header-content">
    <img src="https://i.imgur.com/2MkyDCh.png" alt="Logo" style="width: 120px; height: auto; cursor: pointer;" onclick="location.href='/';">
      <h1 class="title-img-desktop">이미지 공유</h1>
      <h1 class="title-img-mobile">이미지<br>공유</h1>
  </div>
  <div id="imageContainer">
    ${mediaTags}
  </div>
  <script>
    function toggleZoom(elem) {
      if (!elem.classList.contains('landscape') && !elem.classList.contains('portrait')) {
        let width=0, height=0;
        if (elem.tagName.toLowerCase()==='img') {
          width=elem.naturalWidth; height=elem.naturalHeight;
        } else if (elem.tagName.toLowerCase()==='video') {
          width=elem.videoWidth; height=elem.videoHeight;
        }
        if(width && height){
          if(width>=height) elem.classList.add('landscape');
          else elem.classList.add('portrait');
        }
      }
      elem.classList.toggle('expanded');
    }
    document.getElementById('toggleButton')?.addEventListener('click',function(){
      window.location.href='/';
    });
  </script>
</body>
</html>`;
}
