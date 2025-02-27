// 전역 변수: 최근 처리한 요청 ID들
const seenRequests = new Set();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    console.log("Incoming Request:", {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers)
    });

    // =======================
    // 1) Dedup (중복 방지)
    // =======================
    if (request.method === 'POST' && url.pathname === '/upload') {
      const cfReqId = request.headers.get('Cf-Request-Id');
      if (cfReqId) {
        if (seenRequests.has(cfReqId)) {
          // 이미 처리한 요청 => 중복
          console.log(`중복 요청 감지: Cf-Request-Id=${cfReqId}`);
          return new Response(JSON.stringify({
            success: false,
            error: '중복 요청 (이미 처리 중)이므로 업로드가 취소되었습니다.'
          }), { status: 409 });
        } else {
          // 처음 보는 cfReqId => 저장
          seenRequests.add(cfReqId);
          // 60초 후 제거하여 메모리 누수 방지
          ctx.waitUntil((async () => {
            await new Promise(r => setTimeout(r, 60000));
            seenRequests.delete(cfReqId);
          })());
        }
      }
    }

    // 헬퍼 함수1: ArrayBuffer -> Base64
    const arrayBufferToBase64 = (buffer) => {
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    };

    // 헬퍼 함수2: MP4 파일에서 mvhd 박스를 찾아 duration(초)
    async function getMP4Duration(file) {
      try {
        const buffer = await file.arrayBuffer();
        const dv = new DataView(buffer);
        const uint8 = new Uint8Array(buffer);
        for (let i = 0; i < uint8.length - 4; i++) {
          if (
            uint8[i] === 109 && // 'm'
            uint8[i + 1] === 118 && // 'v'
            uint8[i + 2] === 104 && // 'h'
            uint8[i + 3] === 100 // 'd'
          ) {
            const boxStart = i - 4;
            const version = dv.getUint8(boxStart + 8);
            if (version === 0) {
              const timescale = dv.getUint32(boxStart + 20);
              const duration = dv.getUint32(boxStart + 24);
              return duration / timescale;
            } else if (version === 1) {
              const timescale = dv.getUint32(boxStart + 28);
              const high = dv.getUint32(boxStart + 32);
              const low = dv.getUint32(boxStart + 36);
              const duration = high * Math.pow(2, 32) + low;
              return duration / timescale;
            }
          }
        }
        return null;
      } catch (e) {
        console.log("getMP4Duration error:", e);
        return null;
      }
    }

    // 헬퍼 함수3: frames/data를 분석해 유해 여부 판단
    function checkFramesForCensorship(frames, data, threshold) {
      let reasons = [];
      if (frames && frames.length > 0) {
        for (const frame of frames) {
          if (frame.nudity) {
            for (const key in frame.nudity) {
              if (["suggestive_classes", "context", "none"].includes(key)) continue;
              if (Number(frame.nudity[key]) >= threshold) {
                reasons.push("선정적 콘텐츠");
                break;
              }
            }
          }
          if (frame.offensive && frame.offensive.prob !== undefined && Number(frame.offensive.prob) >= threshold) {
            reasons.push("욕설/모욕적 콘텐츠");
          }
          if (frame.wad) {
            for (const key in frame.wad) {
              if (Number(frame.wad[key]) >= threshold) {
                reasons.push("잔인하거나 위험한 콘텐츠");
                break;
              }
            }
          }
          if (reasons.length > 0) break;
        }
      } else {
        // frames가 없으면 data 최상위 nudity/offensive/wad
        if (data && data.nudity) {
          for (const key in data.nudity) {
            if (["suggestive_classes", "context", "none"].includes(key)) continue;
            if (Number(data.nudity[key]) >= threshold) {
              reasons.push("선정적 콘텐츠");
              break;
            }
          }
        }
        if (data && data.offensive && data.offensive.prob !== undefined && Number(data.offensive.prob) >= threshold) {
          reasons.push("욕설/모욕적 콘텐츠");
        }
        if (data && data.wad) {
          for (const key in data.wad) {
            if (Number(data.wad[key]) >= threshold) {
              reasons.push("잔인하거나 위험한 콘텐츠");
              break;
            }
          }
        }
      }
      return reasons;
    }

    // ============================
    // POST /upload => 검열 -> R2 업로드
    // ============================
    if (request.method === 'POST' && url.pathname === '/upload') {
      try {
        const formData = await request.formData();
        const files = formData.getAll('file');
        if (!files || files.length === 0) {
          return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }), { status: 400 });
        }

        // 1) 파일별 검열
        for (const file of files) {
          console.log(`Processing file: type=${file.type}, size=${file.size}`);

          if (file.type.startsWith('image/')) {
            // --------------------------
            // 이미지 => check.json
            // --------------------------
            let fileForCensorship = file;
            try {
              // 이미지 리사이징 (600px)
              const buffer = await file.arrayBuffer();
              const base64 = arrayBufferToBase64(buffer);
              const dataUrl = `data:${file.type};base64,${base64}`;
              const reqForResize = new Request(dataUrl, {
                cf: { image: { width: 600, height: 600, fit: "inside" } }
              });
              const resizedResponse = await fetch(reqForResize);
              if (resizedResponse.ok) {
                fileForCensorship = await resizedResponse.blob();
              }
            } catch (e) {
              console.log("이미지 리사이즈 실패:", e);
              fileForCensorship = file;
            }

            // Sightengine API
            const sightForm = new FormData();
            sightForm.append('media', fileForCensorship, 'upload');
            sightForm.append('models', 'nudity,wad,offensive');
            sightForm.append('api_user', env.SIGHTENGINE_API_USER);
            sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);

            const sightResp = await fetch('https://api.sightengine.com/1.0/check.json', {
              method: 'POST',
              body: sightForm
            });
            if (!sightResp.ok) {
              const errText = await sightResp.text();
              return new Response(JSON.stringify({ success: false, error: `이미지 검열 API 실패: ${errText}` }), { status: 400 });
            }
            let sightResult;
            try {
              sightResult = await sightResp.json();
            } catch (err) {
              const fallback = await sightResp.text();
              return new Response(JSON.stringify({ success: false, error: `이미지 검열 JSON 파싱 오류: ${fallback}` }), { status: 400 });
            }

            // 결과 분석
            let reasons = [];
            if (sightResult.nudity) {
              const { is_nude, raw, partial } = sightResult.nudity;
              if (is_nude === true || (raw && raw > 0.3) || (partial && partial > 0.3)) {
                reasons.push("선정적 콘텐츠");
              }
            }
            if (sightResult.offensive && sightResult.offensive.prob > 0.3) {
              reasons.push("욕설/모욕적 콘텐츠");
            }
            if (sightResult.wad && (sightResult.wad.weapon > 0.3 || sightResult.wad.alcohol > 0.3 || sightResult.wad.drugs > 0.3)) {
              reasons.push("잔인하거나 위험한 콘텐츠");
            }
            if (reasons.length > 0) {
              return new Response(JSON.stringify({ success: false, error: "검열됨: " + reasons.join(", ") }), { status: 400 });
            }

          } else if (file.type.startsWith('video/')) {
            // --------------------------
            // 동영상
            // --------------------------
            if (file.size > 50 * 1024 * 1024) {
              return new Response(JSON.stringify({ success: false, error: "영상 용량이 50MB를 초과합니다." }), { status: 400 });
            }

            // mp4 길이
            let videoDuration = await getMP4Duration(file);
            if (!videoDuration) videoDuration = 0;

            if (videoDuration < 60 && videoDuration !== 0) {
              // 1분 미만 => check-sync
              console.log("1분 미만 => video/check-sync.json");
              const sightForm = new FormData();
              sightForm.append('media', file, 'upload');
              sightForm.append('models', 'nudity,wad,offensive');
              sightForm.append('api_user', env.SIGHTENGINE_API_USER);
              sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);

              let sightResp = await fetch('https://api.sightengine.com/1.0/video/check-sync.json', {
                method: 'POST',
                body: sightForm
              });
              if (!sightResp.ok) {
                let errText = await sightResp.text();
                return new Response(JSON.stringify({ success: false, error: `동영상(sync) API 실패: ${errText}` }), { status: 400 });
              }
              let sightResult;
              try {
                sightResult = await sightResp.json();
              } catch (err) {
                let fallback = await sightResp.text();
                return new Response(JSON.stringify({ success: false, error: `동영상(sync) JSON 파싱 오류: ${fallback}` }), { status: 400 });
              }

              let frames = [];
              if (sightResult.data && sightResult.data.frames) {
                frames = Array.isArray(sightResult.data.frames) ? sightResult.data.frames : [sightResult.data.frames];
              } else if (sightResult.frames) {
                frames = Array.isArray(sightResult.frames) ? sightResult.frames : [sightResult.frames];
              }
              let found = checkFramesForCensorship(frames, sightResult.data, 0.5);
              if (found.length > 0) {
                return new Response(JSON.stringify({ success: false, error: "검열됨: " + found.join(", ") }), { status: 400 });
              }

            } else {
              // 1분 이상 => async=1
              console.log("1분 이상 => video/check.json (async=1)");
              const sightForm = new FormData();
              sightForm.append('media', file, 'upload');
              sightForm.append('models', 'nudity,wad,offensive');
              sightForm.append('api_user', env.SIGHTENGINE_API_USER);
              sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);
              sightForm.append('async', '1');

              // 비동기 업로드(한번만)
              let initialResp = await fetch('https://api.sightengine.com/1.0/video/check.json', {
                method: 'POST',
                body: sightForm
              });
              if (!initialResp.ok) {
                let errText = await initialResp.text();
                return new Response(JSON.stringify({ success: false, error: `비동기 업로드 실패: ${errText}` }), { status: 400 });
              }
              let initialResult;
              try {
                initialResult = await initialResp.json();
              } catch (err) {
                let fallback = await initialResp.text();
                return new Response(JSON.stringify({ success: false, error: `비동기 업로드 JSON 오류: ${fallback}` }), { status: 400 });
              }
              console.log("async initResult:", initialResult);

              if (initialResult.status === 'failure') {
                return new Response(JSON.stringify({ success: false, error: `비동기 업로드 실패: ${initialResult.error}` }), { status: 400 });
              }
              if (!initialResult.request || !initialResult.request.id) {
                return new Response(JSON.stringify({ success: false, error: "비동기 응답에 request.id 없음" }), { status: 400 });
              }
              const requestId = initialResult.request.id;
              console.log("=> requestId =", requestId);

              // 폴링
              let finalData = null;
              let maxAttempts = 6; // 5초씩 6회 => 30초
              while (maxAttempts > 0) {
                await new Promise(r => setTimeout(r, 5000));

                const statusUrl = `https://api.sightengine.com/1.0/video/check.json?request_id=${requestId}&models=nudity,wad,offensive&api_user=${env.SIGHTENGINE_API_USER}&api_secret=${env.SIGHTENGINE_API_SECRET}`;
                let statusResp = await fetch(statusUrl);
                if (!statusResp.ok) {
                  let errText = await statusResp.text();
                  return new Response(JSON.stringify({ success: false, error: `비동기 폴링 실패: ${errText}` }), { status: 400 });
                }
                let statusResult;
                try {
                  statusResult = await statusResp.json();
                } catch (err) {
                  let fallback = await statusResp.text();
                  return new Response(JSON.stringify({ success: false, error: `폴링 JSON 오류: ${fallback}` }), { status: 400 });
                }

                console.log("폴링 =>", statusResult);

                if (statusResult.status === 'failure') {
                  return new Response(JSON.stringify({ success: false, error: `비동기 검열 실패: ${statusResult.error}` }), { status: 400 });
                }
                if (statusResult.progress_status === 'finished') {
                  finalData = statusResult;
                  break;
                }
                maxAttempts--;
              }
              if (!finalData) {
                return new Response(JSON.stringify({ success: false, error: "비동기 검열이 30초 내에 끝나지 않았습니다." }), { status: 408 });
              }

              // 최종 결과 검사
              let frames = [];
              if (finalData.data && finalData.data.frames) {
                frames = Array.isArray(finalData.data.frames) ? finalData.data.frames : [finalData.data.frames];
              } else if (finalData.frames) {
                frames = Array.isArray(finalData.frames) ? finalData.frames : [finalData.frames];
              }
              let found = checkFramesForCensorship(frames, finalData.data, 0.5);
              if (found.length > 0) {
                return new Response(JSON.stringify({ success: false, error: "검열됨: " + found.join(", ") }), { status: 400 });
              }
            }
          }
        }

        // 2) 검열 통과 => R2 업로드
        console.log(">>> 검열 통과, R2 업로드");
        let codes = [];
        for (const file of files) {
          const generateRandomCode = (length = 8) => {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            let result = '';
            for (let i = 0; i < length; i++) {
              result += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return result;
          };
          let code;
          for (let i = 0; i < 5; i++) {
            code = generateRandomCode(8);
            const existing = await env.IMAGES.get(code);
            if (!existing) break;
          }
          if (!code) {
            return new Response(JSON.stringify({ success: false, error: '코드 생성 실패' }), { status: 500 });
          }
          const fileBuffer = await file.arrayBuffer();
          await env.IMAGES.put(code, fileBuffer, {
            httpMetadata: { contentType: file.type }
          });
          codes.push(code);
        }
        const urlCodes = codes.join(",");
        const imageUrl = `https://${url.host}/${urlCodes}`;
        console.log(">>> 업로드 완료 =>", imageUrl);
        return new Response(JSON.stringify({ success: true, url: imageUrl }), {
          headers: { 'Content-Type': 'application/json' }
        });

      } catch (err) {
        console.log("에러 발생:", err);
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
      }
    }

    // ============================
    // GET /{코드}: 파일 or HTML
    // ============================
    else if (request.method === 'GET' && /^\/[A-Za-z0-9,]{8,}(,[A-Za-z0-9]{8})*$/.test(url.pathname)) {
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

      const codes = url.pathname.slice(1).split(",");
      const objects = await Promise.all(codes.map(async code => {
        const object = await env.IMAGES.get(code);
        return { code, object };
      }));
      let mediaTags = "";
      for (const { code, object } of objects) {
        if (object && object.httpMetadata?.contentType?.startsWith('video/')) {
          mediaTags += `<video src="https://${url.host}/${code}?raw=1" controls onclick="toggleZoom(this)"></video>\n`;
        } else {
          mediaTags += `<img src="https://${url.host}/${code}?raw=1" alt="Uploaded Media" onclick="toggleZoom(this)">\n`;
        }
      }

      // 전체 HTML
      const htmlContent = `<!DOCTYPE html>
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

      return new Response(htmlContent, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
    }

    // 그 외 => 기본 에셋 핸들러
    return env.ASSETS.fetch(request);
  }
};
