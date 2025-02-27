export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      console.log("Incoming Request:", {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers)
      });
      console.log("Worker triggered:", request.method, url.pathname);
  
      const arrayBufferToBase64 = (buffer) => {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
      };
  
      async function getMP4Duration(file) {
        try {
          const buffer = await file.arrayBuffer();
          const dv = new DataView(buffer);
          const uint8 = new Uint8Array(buffer);
          for (let i = 0; i < uint8.length - 4; i++) {
            if (uint8[i] === 109 && uint8[i + 1] === 118 && uint8[i + 2] === 104 && uint8[i + 3] === 100) {
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
          return null;
        }
      }
  
      // 전역 디버그 로그 배열
      let allDebugLogs = [];
  
      if (request.method === 'POST' && url.pathname === '/upload') {
        try {
          const formData = await request.formData();
          const files = formData.getAll('file');
          if (!files || files.length === 0) {
            return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.', debug: allDebugLogs.join(" | ") }), { status: 400 });
          }
  
          for (const file of files) {
            if (file.type.startsWith('image/')) {
              let fileForCensorship = file;
              try {
                const buffer = await file.arrayBuffer();
                const base64 = arrayBufferToBase64(buffer);
                const dataUrl = `data:${file.type};base64,${base64}`;
                const reqForResize = new Request(dataUrl, {
                  cf: { image: { width: 600, height: 600, fit: "inside" } }
                });
                const resizedResponse = await fetch(reqForResize);
                fileForCensorship = await resizedResponse.blob();
              } catch (e) {
                fileForCensorship = file;
              }
  
              const sightForm = new FormData();
              sightForm.append('media', fileForCensorship.slice(0, fileForCensorship.size, fileForCensorship.type), 'upload');
              sightForm.append('models', 'nudity,wad,offensive');
              sightForm.append('api_user', env.SIGHTENGINE_API_USER);
              sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);
  
              const sightResponse = await fetch('https://api.sightengine.com/1.0/check.json', {
                method: 'POST',
                body: sightForm
              });
              const sightResult = await sightResponse.json();
  
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
                return new Response(JSON.stringify({ success: false, error: "검열됨: " + reasons.join(", "), debug: allDebugLogs.join(" | ") }), { status: 400 });
              }
            } else if (file.type.startsWith('video/')) {
              if (file.size > 50 * 1024 * 1024) {
                return new Response(JSON.stringify({ success: false, error: "영상 용량이 50MB를 초과합니다.", debug: allDebugLogs.join(" | ") }), { status: 400 });
              }
  
              let videoDuration = await getMP4Duration(file);
              if (videoDuration === null) {
                videoDuration = 0;
              }
  
              if (videoDuration < 60) {
                const videoThreshold = 0.5;
                const sightForm = new FormData();
                sightForm.append('media', file, 'upload');
                sightForm.append('models', 'nudity,wad,offensive');
                sightForm.append('api_user', env.SIGHTENGINE_API_USER);
                sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);
  
                const sightResponse = await fetch('https://api.sightengine.com/1.0/video/check-sync.json', {
                  method: 'POST',
                  body: sightForm
                });
                const sightResult = await sightResponse.json();
  
                let reasons = [];
                let frames = [];
                if (sightResult.data && sightResult.data.frames) {
                  frames = Array.isArray(sightResult.data.frames) ? sightResult.data.frames : [sightResult.data.frames];
                } else if (sightResult.frames) {
                  frames = Array.isArray(sightResult.frames) ? sightResult.frames : [sightResult.frames];
                }
  
                if (frames.length > 0) {
                  for (const frame of frames) {
                    if (frame.nudity) {
                      for (const key in frame.nudity) {
                        if (["suggestive_classes", "context", "none"].includes(key)) continue;
                        if (Number(frame.nudity[key]) >= videoThreshold) {
                          reasons.push("선정적 콘텐츠");
                          break;
                        }
                      }
                    }
                    if (frame.offensive && frame.offensive.prob !== undefined && Number(frame.offensive.prob) >= videoThreshold) {
                      reasons.push("욕설/모욕적 콘텐츠");
                    }
                    if (frame.wad) {
                      for (const key in frame.wad) {
                        if (Number(frame.wad[key]) >= videoThreshold) {
                          reasons.push("잔인하거나 위험한 콘텐츠");
                          break;
                        }
                      }
                    }
                  }
                } else {
                  if (sightResult.data && sightResult.data.nudity) {
                    for (const key in sightResult.data.nudity) {
                      if (["suggestive_classes", "context", "none"].includes(key)) continue;
                      if (Number(sightResult.data.nudity[key]) >= videoThreshold) {
                        reasons.push("선정적 콘텐츠");
                        break;
                      }
                    }
                  }
                  if (sightResult.data && sightResult.data.offensive && sightResult.data.offensive.prob !== undefined && Number(sightResult.data.offensive.prob) >= videoThreshold) {
                    reasons.push("욕설/모욕적 콘텐츠");
                  }
                  if (sightResult.data && sightResult.data.wad) {
                    for (const key in sightResult.data.wad) {
                      if (Number(sightResult.data.wad[key]) >= videoThreshold) {
                        reasons.push("잔인하거나 위험한 콘텐츠");
                        break;
                      }
                    }
                  }
                }
                if (reasons.length > 0) {
                  return new Response(JSON.stringify({ success: false, error: "검열됨: " + reasons.join(", "), debug: allDebugLogs.join(" | ") }), { status: 400 });
                }
              } else {
                // 1분 이상인 경우: 전체 파일을 전송하고 'start'와 'length' 파라미터(초)를 통해 40초 단위로 요청
                const videoThreshold = 0.5;
                let reasons = [];
                const segmentLength = 40;
                let segments = [];
                for (let currentStart = 0; currentStart < videoDuration; currentStart += segmentLength) {
                  segments.push({ start: currentStart, length: Math.min(segmentLength, videoDuration - currentStart) });
                }
  
                for (let i = 0; i < segments.length; i++) {
                  const seg = segments[i];
                  allDebugLogs.push(`Segment ${i+1}/${segments.length}: seconds [${seg.start} ~ ${seg.start + seg.length}]`);
  
                  const segmentForm = new FormData();
                  segmentForm.append('media', file, 'upload');
                  segmentForm.append('start', seg.start.toString());
                  segmentForm.append('length', seg.length.toString());
                  segmentForm.append('models', 'nudity,wad,offensive');
                  segmentForm.append('api_user', env.SIGHTENGINE_API_USER);
                  segmentForm.append('api_secret', env.SIGHTENGINE_API_SECRET);
  
                  const startTime = Date.now();
                  const segmentResponse = await fetch('https://api.sightengine.com/1.0/video/check-sync.json', {
                    method: 'POST',
                    body: segmentForm
                  });
                  const durationFetch = Date.now() - startTime;
                  const segmentResult = await segmentResponse.json();
                  allDebugLogs.push(`Segment ${i+1} response (took ${durationFetch}ms): ${JSON.stringify(segmentResult)}`);
  
                  let frames = [];
                  if (segmentResult.data && segmentResult.data.frames) {
                    frames = Array.isArray(segmentResult.data.frames) ? segmentResult.data.frames : [segmentResult.data.frames];
                  } else if (segmentResult.frames) {
                    frames = Array.isArray(segmentResult.frames) ? segmentResult.frames : [segmentResult.frames];
                  }
  
                  if (frames.length > 0) {
                    for (const frame of frames) {
                      if (frame.nudity) {
                        for (const key in frame.nudity) {
                          if (["suggestive_classes", "context", "none"].includes(key)) continue;
                          if (Number(frame.nudity[key]) >= videoThreshold) {
                            reasons.push("선정적 콘텐츠");
                            break;
                          }
                        }
                      }
                      if (frame.offensive && frame.offensive.prob !== undefined && Number(frame.offensive.prob) >= videoThreshold) {
                        reasons.push("욕설/모욕적 콘텐츠");
                      }
                      if (frame.wad) {
                        for (const key in frame.wad) {
                          if (Number(frame.wad[key]) >= videoThreshold) {
                            reasons.push("잔인하거나 위험한 콘텐츠");
                            break;
                          }
                        }
                      }
                    }
                  } else {
                    if (segmentResult.data && segmentResult.data.nudity) {
                      for (const key in segmentResult.data.nudity) {
                        if (["suggestive_classes", "context", "none"].includes(key)) continue;
                        if (Number(segmentResult.data.nudity[key]) >= videoThreshold) {
                          reasons.push("선정적 콘텐츠");
                          break;
                        }
                      }
                    }
                    if (segmentResult.data && segmentResult.data.offensive && segmentResult.data.offensive.prob !== undefined && Number(segmentResult.data.offensive.prob) >= videoThreshold) {
                      reasons.push("욕설/모욕적 콘텐츠");
                    }
                    if (segmentResult.data && segmentResult.data.wad) {
                      for (const key in segmentResult.data.wad) {
                        if (Number(segmentResult.data.wad[key]) >= videoThreshold) {
                          reasons.push("잔인하거나 위험한 콘텐츠");
                          break;
                        }
                      }
                    }
                  }
  
                  if (reasons.length > 0) {
                    return new Response(JSON.stringify({ success: false, error: "검열됨: " + reasons.join(", "), debug: allDebugLogs.join(" | ") }), { status: 400 });
                  }
                }
              }
            }
          }
  
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
              return new Response(JSON.stringify({ success: false, error: '코드 생성 실패', debug: allDebugLogs.join(" | ") }), { status: 500 });
            }
            const fileBuffer = await file.arrayBuffer();
            await env.IMAGES.put(code, fileBuffer, {
              httpMetadata: { contentType: file.type }
            });
            codes.push(code);
          }
          const urlCodes = codes.join(",");
          const imageUrl = `https://${url.host}/${urlCodes}`;
          return new Response(JSON.stringify({ success: true, url: imageUrl, debug: allDebugLogs.join(" | ") }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message, debug: allDebugLogs.join(" | ") }), { status: 500 });
        }
      }
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
          if (object && object.httpMetadata && object.httpMetadata.contentType && object.httpMetadata.contentType.startsWith('video/')) {
            mediaTags += `<video src="https://${url.host}/${code}?raw=1" controls onclick="toggleZoom(this)"></video>\n`;
          } else {
            mediaTags += `<img src="https://${url.host}/${code}?raw=1" alt="Uploaded Media" onclick="toggleZoom(this)">\n`;
          }
        }
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
    
    /* 기존 스타일 유지 */
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
      cursor: zoom-in; /* 기본 상태에서는 확대 아이콘 */
    }

    /* 가로가 긴 경우 */
    #imageContainer img.landscape,
    #imageContainer video.landscape {
      width: 40vw;
      height: auto;
      max-width: 40vw;
      max-height: 50vh;
      cursor: zoom-in; /* 기본 상태에서는 확대 아이콘 */
    }

    /* 세로가 긴 경우 */
    #imageContainer img.portrait,
    #imageContainer video.portrait {
      width: auto;
      height: 50vh;
      max-width: 40vw;
      max-height: 50vh;
      cursor: zoom-in; /* 기본 상태에서는 확대 아이콘 */
    }
  
    /* 확대된 상태의 가로가 긴 경우 */
    #imageContainer img.expanded.landscape,
    #imageContainer video.expanded.landscape {
      width: 80vw;
      height: auto;
      max-width: 80vw;
      max-height: 100vh;
      cursor: zoom-out;
    }

    /* 확대된 상태의 세로가 긴 경우 */
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
  
    /* 수정된 검열된 이미지 스타일 */
    .censored {
      position: relative;
      display: inline-block;
      /* 이미지 자체는 숨기고 오버레이로만 표시 */
      width: 100%;
      height: 100%;
    }
  
    .censored img,
    .censored video {
      display: none; /* 미디어 숨김 */
    }
  
    .censored .overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0, 0, 0, 0.8); /* 검열 배경 */
      display: flex;
      justify-content: center;
      align-items: center;
      color: white;
      font-size: 24px;
      font-weight: bold;
      text-shadow: 2px 2px 4px #000;
      pointer-events: none;
    }
  
    /* 사용자 정의 컨텍스트 메뉴 스타일 수정 */
    .custom-context-menu {
      color: #000; /* 텍스트 색상을 검정으로 설정 */
      position: absolute;
      background-color: #e0e0e0;
      z-index: 1000;
      width: 150px;
      display: none; /* 기본적으로 숨김 */
      flex-direction: column;
      border-radius: 8px; /* 컨텍스트 메뉴의 모서리를 둥글게 설정 */
      box-shadow: none; /* 그림자 제거 */
      padding: 0; /* 내부 여백 제거 */
      
      /* 추가된 스타일 */
      overflow: hidden; /* 메뉴 내에서 넘치는 부분 숨김 */
      box-sizing: border-box; /* 패딩과 보더를 포함한 크기 계산 */
    }

    .custom-context-menu button {
      color: #000;
      background-color: #e7e7e7;
      text-align: left;
      width: 100%;
      cursor: pointer;
      font-size: 16px; /* 글자 크기 유지 */
      padding: 6px 10px; /* 버튼 세로 길이 조정 */
      margin: 0; /* 버튼 간 공간 제거 */
      border: none; /* 기본 테두리 제거 */
      border-radius: 0; /* 모서리 둥글지 않게 설정 */
      box-shadow: none; /* 그림자 제거 */
      
      /* 추가된 스타일 */
      box-sizing: border-box; /* 패딩과 보더를 포함한 크기 계산 */
      
      /* Transition 재정의: transform을 제외하고 background-color와 box-shadow만 포함 */
      transition: background-color 0.3s ease, box-shadow 0.3s ease;
      
      /* 기본 transform 제거 */
      transform: none;
    }

    .custom-context-menu button:hover {
      background-color: #9c9c9c;
      box-shadow: none;
      
      /* 호버 시 transform 제거 */
      transform: none;
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
      document.getElementById('toggleButton').addEventListener('click', function(){
        window.location.href = '/';
      });
    </script>
  </body>
</html>`;
        return new Response(htmlContent, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
      }
    
      return env.ASSETS.fetch(request);
    }
};
