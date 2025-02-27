// ------------------------------
// 전역: 중복 요청 관리용 Map
//  { [cfReqId]: { promise, resolve, reject } }
// ------------------------------
const requestsInProgress = {};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    console.log("Incoming Request:", {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers)
    });

    // ----------------------------------------
    // Dedup & Share logic (POST /upload)
    // ----------------------------------------
    if (request.method === 'POST' && url.pathname === '/upload') {
      const cfReqId = request.headers.get('Cf-Request-Id') || '';

      if (cfReqId) {
        // 이미 이 cfReqId로 진행 중인가?
        if (requestsInProgress[cfReqId]) {
          console.log(`[Dedup] 중복 요청 감지 (Cf-Request-Id=${cfReqId}). 기존 진행 중인 Promise 사용.`);
          // 중복 요청 -> 기존 promise 결과를 그대로 반환
          return requestsInProgress[cfReqId].promise;
        } else {
          // 새롭게 진행
          let resolveFn, rejectFn;
          const promise = new Promise((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
          });
          requestsInProgress[cfReqId] = { promise, resolve: resolveFn, reject: rejectFn };

          // 일정 시간 뒤 메모리 해제(1분 후)
          ctx.waitUntil((async () => {
            await new Promise(r => setTimeout(r, 60000));
            delete requestsInProgress[cfReqId];
          })());

          // 실제 업로드 검열 처리
          let finalResp;
          try {
            finalResp = await handleUpload(request, env, ctx);
            requestsInProgress[cfReqId].resolve(finalResp);
          } catch (err) {
            console.log("handleUpload error:", err);
            const failResp = new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
            requestsInProgress[cfReqId].reject(failResp);
            finalResp = failResp;
          }
          return finalResp;
        }
      } else {
        // Cf-Request-Id가 없으면 그냥 처리
        return handleUpload(request, env, ctx);
      }
    }

    // ----------------------------------------
    // GET /{코드} -> R2 파일 or 전체 HTML
    // ----------------------------------------
    else if (request.method === 'GET' && /^\/[A-Za-z0-9,]{8,}(,[A-Za-z0-9]{8})*$/.test(url.pathname)) {
      if (url.searchParams.get('raw') === '1') {
        // 원본 바이너리 반환
        const code = url.pathname.slice(1).split(",")[0];
        const object = await env.IMAGES.get(code);
        if (!object) {
          return new Response('Not Found', { status: 404 });
        }
        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
        return new Response(object.body, { headers });
      }

      // HTML 페이지
      const codes = url.pathname.slice(1).split(",");
      const objects = await Promise.all(codes.map(async code => {
        const object = await env.IMAGES.get(code);
        return { code, object };
      }));
      let mediaTags = "";
      for (const { code, object } of objects) {
        if (object && object.httpMetadata && object.httpMetadata.contentType?.startsWith('video/')) {
          mediaTags += `<video src="https://${url.host}/${code}?raw=1" controls onclick="toggleZoom(this)"></video>\n`;
        } else {
          mediaTags += `<img src="https://${url.host}/${code}?raw=1" alt="Uploaded Media" onclick="toggleZoom(this)">\n`;
        }
      }
      const htmlContent = renderHTML(mediaTags, url.host);
      return new Response(htmlContent, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
    }

    // ---------------------------
    // 그 외 -> 기본 에셋
    // ---------------------------
    return env.ASSETS.fetch(request);
  }
};

// =============================
// 메인 업로드+검열+업로드 처리 함수
// =============================
async function handleUpload(request, env, ctx) {
  const formData = await request.formData();
  const files = formData.getAll('file');
  if (!files || files.length === 0) {
    return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }), { status: 400 });
  }

  // 1) 검열
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      const result = await handleImageCensorship(file, env);
      if (!result.ok) return result.response;
    } else if (file.type.startsWith('video/')) {
      const result = await handleVideoCensorship(file, env);
      if (!result.ok) return result.response;
    }
  }

  // 2) R2 업로드
  let codes = [];
  for (const file of files) {
    const code = await generateUniqueCode(env);
    const fileBuffer = await file.arrayBuffer();
    await env.IMAGES.put(code, fileBuffer, {
      httpMetadata: { contentType: file.type }
    });
    codes.push(code);
  }
  const urlCodes = codes.join(",");
  const host = request.headers.get('host') || 'example.com';
  const finalUrl = `https://${host}/${urlCodes}`;
  console.log(">>> 업로드 완료 =>", finalUrl);

  return new Response(JSON.stringify({ success: true, url: finalUrl }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// =============================
// 이미지 검열
// =============================
async function handleImageCensorship(file, env) {
  try {
    // 리사이징
    let fileForCensorship = file;
    try {
      const buf = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(buf);
      const dataUrl = `data:${file.type};base64,${base64}`;
      const reqResize = new Request(dataUrl, {
        cf: { image: { width: 600, height: 600, fit: "inside" } }
      });
      const resizedResp = await fetch(reqResize);
      if (resizedResp.ok) {
        fileForCensorship = await resizedResp.blob();
      }
    } catch(e) {
      console.log("이미지 리사이즈 실패:", e);
    }

    // SightEngine
    const sightForm = new FormData();
    sightForm.append('media', fileForCensorship, 'upload');
    sightForm.append('models', 'nudity,wad,offensive');
    sightForm.append('api_user', env.SIGHTENGINE_API_USER);
    sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);

    const resp = await fetch('https://api.sightengine.com/1.0/check.json', {
      method: 'POST',
      body: sightForm
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return {
        ok:false,
        response:new Response(JSON.stringify({success:false,error:`이미지 검열 API 실패: ${errText}`}),{status:400})
      };
    }
    let data;
    try {
      data = await resp.json();
    } catch(e) {
      const fallback = await resp.text();
      return {
        ok:false,
        response:new Response(JSON.stringify({success:false,error:`이미지 검열 JSON 파싱 오류: ${fallback}`}),{status:400})
      };
    }

    let reasons = [];
    if (data.nudity) {
      const { is_nude, raw, partial } = data.nudity;
      if (is_nude===true || (raw&&raw>0.3) || (partial&&partial>0.3)) reasons.push("선정적 콘텐츠");
    }
    if (data.offensive && data.offensive.prob>0.3) reasons.push("욕설/모욕적 콘텐츠");
    if (data.wad && (data.wad.weapon>0.3 || data.wad.alcohol>0.3 || data.wad.drugs>0.3)) reasons.push("잔인하거나 위험한 콘텐츠");

    if (reasons.length>0) {
      return {
        ok:false,
        response:new Response(JSON.stringify({success:false,error:`검열됨: ${reasons.join(", ")}`}),{status:400})
      };
    }
    return {ok:true};
  } catch(e) {
    console.log("handleImageCensorship error:", e);
    return {
      ok:false,
      response:new Response(JSON.stringify({success:false,error:e.message}),{status:500})
    };
  }
}

// =============================
// 동영상 검열
// =============================
async function handleVideoCensorship(file, env) {
  try {
    // 용량 제한
    if (file.size>50*1024*1024) {
      return {
        ok:false,
        response:new Response(JSON.stringify({success:false,error:"영상 용량이 50MB를 초과합니다."}),{status:400})
      };
    }

    // mp4 길이
    let videoDuration = await getMP4Duration(file);
    if (!videoDuration) videoDuration=0;

    // ---------------------
    // 1분 미만 => check-sync
    // ---------------------
    if (videoDuration<60 && videoDuration!==0) {
      const sightForm = new FormData();
      sightForm.append('media', file, 'upload');
      sightForm.append('models','nudity,wad,offensive');
      sightForm.append('api_user', env.SIGHTENGINE_API_USER);
      sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);

      const syncResp=await fetch('https://api.sightengine.com/1.0/video/check-sync.json',{
        method:'POST',
        body:sightForm
      });
      if(!syncResp.ok) {
        let errText=await syncResp.text();
        return {ok:false,response:new Response(JSON.stringify({success:false,error:`동영상(sync) API 실패: ${errText}`}),{status:400})};
      }
      let data;
      try {
        data=await syncResp.json();
      } catch(e) {
        let fallback=await syncResp.text();
        return {ok:false,response:new Response(JSON.stringify({success:false,error:`동영상(sync) JSON 파싱 오류: ${fallback}`}),{status:400})};
      }

      // frames
      let frames=[];
      if (data.data && data.data.frames) frames=Array.isArray(data.data.frames)?data.data.frames:[data.data.frames];
      else if (data.frames) frames=Array.isArray(data.frames)?data.frames:[data.frames];

      let found=checkFramesForCensorship(frames, data.data, 0.5);
      if(found.length>0) {
        return {ok:false,response:new Response(JSON.stringify({success:false,error:`검열됨: ${found.join(", ")}`}),{status:400})};
      }
      return {ok:true};
    }
    // ---------------------
    // 1분 이상 => async=1
    // ---------------------
    else {
      const sightForm=new FormData();
      sightForm.append('media', file, 'upload');
      sightForm.append('models','nudity,wad,offensive');
      sightForm.append('api_user', env.SIGHTENGINE_API_USER);
      sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);
      sightForm.append('async','1');

      // 비동기 업로드
      let initResp=await fetch('https://api.sightengine.com/1.0/video/check.json',{
        method:'POST',
        body:sightForm
      });
      if(!initResp.ok) {
        let errText=await initResp.text();
        return {ok:false,response:new Response(JSON.stringify({success:false,error:`비동기 업로드 실패: ${errText}`}),{status:400})};
      }
      let initData;
      try {
        initData=await initResp.json();
      } catch(e) {
        let fallback=await initResp.text();
        return {ok:false,response:new Response(JSON.stringify({success:false,error:`비동기 업로드 JSON 오류: ${fallback}`}),{status:400})};
      }
      if(initData.status==='failure') {
        return {ok:false,response:new Response(JSON.stringify({success:false,error:`비동기 업로드 실패: ${initData.error}`}),{status:400})};
      }
      if(!initData.request||!initData.request.id) {
        return {ok:false,response:new Response(JSON.stringify({success:false,error:`비동기 응답에 request.id 없음`}),{status:400})};
      }

      let reqId=initData.request.id;

      // 폴링
      let finalData=null;
      let maxAttempts=6; // 5초씩 6회 => 30초
      while(maxAttempts>0) {
        await new Promise(r=>setTimeout(r,5000));
        const statusUrl=`https://api.sightengine.com/1.0/video/check.json?request_id=${reqId}&models=nudity,wad,offensive&api_user=${env.SIGHTENGINE_API_USER}&api_secret=${env.SIGHTENGINE_API_SECRET}`;
        let statusResp=await fetch(statusUrl);
        if(!statusResp.ok) {
          let errText=await statusResp.text();
          return {ok:false,response:new Response(JSON.stringify({success:false,error:`비동기 폴링 실패: ${errText}`}),{status:400})};
        }
        let statusData;
        try {
          statusData=await statusResp.json();
        } catch(e) {
          let fallback=await statusResp.text();
          return {ok:false,response:new Response(JSON.stringify({success:false,error:`폴링 JSON 오류: ${fallback}`}),{status:400})};
        }

        if(statusData.status==='failure') {
          return {ok:false,response:new Response(JSON.stringify({success:false,error:`비동기 검열 실패: ${statusData.error}`}),{status:400})};
        }
        if(statusData.progress_status==='finished') {
          finalData=statusData;
          break;
        }
        maxAttempts--;
      }
      if(!finalData) {
        return {ok:false,response:new Response(JSON.stringify({success:false,error:`비동기 검열이 30초 내에 끝나지 않았습니다.`}),{status:408})};
      }

      // 최종 결과
      let frames=[];
      if (finalData.data && finalData.data.frames) frames=Array.isArray(finalData.data.frames)?finalData.data.frames:[finalData.data.frames];
      else if (finalData.frames) frames=Array.isArray(finalData.frames)?finalData.frames:[finalData.frames];

      let found=checkFramesForCensorship(frames, finalData.data, 0.5);
      if(found.length>0) {
        return {ok:false,response:new Response(JSON.stringify({success:false,error:`검열됨: ${found.join(", ")}`}),{status:400})};
      }
      return {ok:true};
    }
  } catch(e) {
    console.log("handleVideoCensorship error:", e);
    return {
      ok:false,
      response:new Response(JSON.stringify({success:false,error:e.message}),{status:500})
    };
  }
}

// =============================
// 유니크 코드 생성 (R2 키)
// =============================
async function generateUniqueCode(env, length=8) {
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for(let attempt=0; attempt<10; attempt++){
    let code='';
    for(let i=0; i<length; i++){
      code += chars.charAt(Math.floor(Math.random()*chars.length));
    }
    const existing=await env.IMAGES.get(code);
    if(!existing) return code;
  }
  throw new Error("코드 생성 실패");
}

// =============================
// HTML 전체 페이지 렌더
// =============================
function renderHTML(mediaTags, host) {
  // 아래 HTML: upload-container, copy-button, toggleZoom, .header-content, .title-img-desktop 등 전부 포함
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

    #imageContainer img,
    #imageContainer video {
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

    #imageContainer img.landscape,
    #imageContainer video.landscape {
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
    <h1>이미지 공유</h1>
  </div>
  <div id="imageContainer">
    ${mediaTags}
  </div>
  <script>
    function toggleZoom(elem) {
      if (!elem.classList.contains('landscape') && !elem.classList.contains('portrait')) {
        let width = 0, height = 0;
        if (elem.tagName.toLowerCase() === 'img') {
          width = elem.naturalWidth;
          height = elem.naturalHeight;
        } else if (elem.tagName.toLowerCase() === 'video') {
          width = elem.videoWidth;
          height = elem.videoHeight;
        }
        if (width && height) {
          if (width >= height) {
            elem.classList.add('landscape');
          } else {
            elem.classList.add('portrait');
          }
        }
      }
      elem.classList.toggle('expanded');
    }
    document.getElementById('toggleButton')?.addEventListener('click', function(){
      window.location.href = '/';
    });
  </script>
</body>
</html>`;
}
