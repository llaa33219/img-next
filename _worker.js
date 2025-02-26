export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      console.log("Worker triggered:", request.method, url.pathname);
  
      // 헬퍼 함수: ArrayBuffer를 Base64 문자열로 변환
      const arrayBufferToBase64 = (buffer) => {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
      };

      // 헬퍼 함수: MP4 파일에서 mvhd atom을 찾아 영상 길이(초)를 계산
      const parseMp4Duration = (buffer) => {
        try {
          const view = new DataView(buffer);
          const len = view.byteLength;
          let pos = 0;
          while (pos < len) {
            if (pos + 8 > len) break;
            const size = view.getUint32(pos);
            let type = '';
            for (let i = pos + 4; i < pos + 8; i++) {
              type += String.fromCharCode(view.getUint8(i));
            }
            if (type === 'moov') {
              const moovEnd = pos + size;
              let innerPos = pos + 8;
              while (innerPos < moovEnd) {
                if (innerPos + 8 > len) break;
                const innerSize = view.getUint32(innerPos);
                let innerType = '';
                for (let j = innerPos + 4; j < innerPos + 8; j++) {
                  innerType += String.fromCharCode(view.getUint8(j));
                }
                if (innerType === 'mvhd') {
                  const version = view.getUint8(innerPos + 8);
                  if (version === 1) {
                    const timescale = view.getUint32(innerPos + 20);
                    const duration = Number(view.getBigUint64(innerPos + 24));
                    return duration / timescale;
                  } else {
                    const timescale = view.getUint32(innerPos + 12);
                    const duration = view.getUint32(innerPos + 16);
                    return duration / timescale;
                  }
                }
                innerPos += innerSize;
              }
            }
            pos += size;
          }
          return null;
        } catch (e) {
          return null;
        }
      };
  
      // POST /upload : 다중 파일 업로드 처리 (검열 먼저 진행)
      if (request.method === 'POST' && url.pathname === '/upload') {
        try {
          const formData = await request.formData();
          const files = formData.getAll('file');
          if (!files || files.length === 0) {
            return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }), { status: 400 });
          }
          // 1. 검열 단계: 모든 파일에 대해 검열 API 호출 (검열 통과 못하면 업로드 중단)
          for (const file of files) {
            if (file.type.startsWith('image/')) {
              // -------------------------------------------
              // 이미지 검열
              // -------------------------------------------
              let fileForCensorship = file;
              try {
                // 이미지 리사이징: 최대 가로/세로 600px로 축소하여 검열 속도 향상
                const buffer = await file.arrayBuffer();
                const base64 = arrayBufferToBase64(buffer);
                const dataUrl = `data:${file.type};base64,${base64}`;
                const reqForResize = new Request(dataUrl, {
                  cf: { image: { width: 600, height: 600, fit: "inside" } }
                });
                const resizedResponse = await fetch(reqForResize);
                fileForCensorship = await resizedResponse.blob();
              } catch (e) {
                // 리사이징 실패 시 원본 파일 사용
                fileForCensorship = file;
              }
  
              const sightForm = new FormData();
              // 파일 스트림 소진 방지를 위해 slice()로 복제
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
                return new Response(JSON.stringify({ success: false, error: "검열됨: " + reasons.join(", ") }), { status: 400 });
              }
            } else if (file.type.startsWith('video/')) {
              // -------------------------------------------
              // 동영상 검열 (영상 길이에 따라 분기)
              // -------------------------------------------
              // 영상 검열 API 응답은 "data.frames" 내에 값이 포함됨.
              // 문제 영상 판단 임계치를 0.5로 설정합니다.
              const videoThreshold = 0.5;
              const sightForm = new FormData();
              sightForm.append('media', file, 'upload');
              sightForm.append('models', 'nudity,wad,offensive');
              sightForm.append('api_user', env.SIGHTENGINE_API_USER);
              sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);
  
              // 영상 길이 체크: 1분 미만이면 동기, 이상이면 비동기
              let isShort = false;
              try {
                const headerBuffer = await file.slice(0, 1024 * 1024).arrayBuffer();
                let duration = null;
                if (file.type === 'video/mp4' || (file.name && file.name.toLowerCase().endsWith('.mp4'))) {
                  duration = parseMp4Duration(headerBuffer);
                }
                if (duration !== null) {
                  if (duration < 60) {
                    isShort = true;
                  } else {
                    // 영상 길이가 1분 이상이어도, 파일 크기가 40MB 미만이면 동기 API를 사용하도록 처리 (원래 조건 유지)
                    isShort = file.size < 40 * 1024 * 1024;
                  }
                } else {
                  // 영상 길이 파싱에 실패하면 파일 크기를 fallback 기준으로 사용 (40MB 미만이면 짧은 영상)
                  isShort = file.size < 40 * 1024 * 1024;
                }
              } catch (e) {
                // 에러 발생 시에도 파일 크기를 fallback 기준으로 사용
                isShort = file.size < 40 * 1024 * 1024;
              }
  
              if (isShort) {
                // 1) 짧은 영상: 동기 API
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
                      // "suggestive_classes", "context", "none" 제외하고 각 값이 임계치 이상이면 문제로 판단
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
                  // frames가 없으면 단일 객체 검사
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
                  return new Response(JSON.stringify({ success: false, error: "검열됨: " + reasons.join(", ") }), { status: 400 });
                }
  
              } else {
                // 2) 긴 영상: 비동기 API + 폴링
                const initResponse = await fetch('https://api.sightengine.com/1.0/video/check.json', {
                  method: 'POST',
                  body: sightForm
                });
                const initResult = await initResponse.json();
  
                if (!initResult || initResult.status !== 'success') {
                  return new Response(JSON.stringify({ success: false, error: "비디오 검열 시작 오류" }), { status: 400 });
                }
  
                // job_id를 받아 폴링
                const jobId = initResult.job.id;
                let pollResult;
                let totalWait = 0;
                const POLL_INTERVAL = 5000;  // 5초 간격
                const MAX_WAIT = 30000;      // 최대 30초 대기
  
                while (true) {
                  await new Promise(r => setTimeout(r, POLL_INTERVAL));
                  totalWait += POLL_INTERVAL;
  
                  const pollResponse = await fetch(
                    `https://api.sightengine.com/1.0/video/check.json?job_id=${jobId}&api_user=${env.SIGHTENGINE_API_USER}&api_secret=${env.SIGHTENGINE_API_SECRET}`
                  );
                  pollResult = await pollResponse.json();
  
                  // 완료 시 탈출
                  if (pollResult.status === 'finished') {
                    break;
                  }
                  // 실패 시 에러
                  if (pollResult.status === 'failure') {
                    return new Response(JSON.stringify({ success: false, error: "비디오 분석 실패" }), { status: 400 });
                  }
                  // 타임아웃
                  if (totalWait >= MAX_WAIT) {
                    return new Response(JSON.stringify({ success: false, error: "검열 시간 초과" }), { status: 400 });
                  }
                }
  
                let reasons = [];
                let frames = [];
                if (pollResult.data && pollResult.data.frames) {
                  frames = Array.isArray(pollResult.data.frames) ? pollResult.data.frames : [pollResult.data.frames];
                } else if (pollResult.frames) {
                  frames = Array.isArray(pollResult.frames) ? pollResult.frames : [pollResult.frames];
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
                  if (pollResult.data && pollResult.data.nudity) {
                    for (const key in pollResult.data.nudity) {
                      if (["suggestive_classes", "context", "none"].includes(key)) continue;
                      if (Number(pollResult.data.nudity[key]) >= videoThreshold) {
                        reasons.push("선정적 콘텐츠");
                        break;
                      }
                    }
                  }
                  if (pollResult.data && pollResult.data.offensive && pollResult.data.offensive.prob !== undefined && Number(pollResult.data.offensive.prob) >= videoThreshold) {
                    reasons.push("욕설/모욕적 콘텐츠");
                  }
                  if (pollResult.data && pollResult.data.wad) {
                    for (const key in pollResult.data.wad) {
                      if (Number(pollResult.data.wad[key]) >= videoThreshold) {
                        reasons.push("잔인하거나 위험한 콘텐츠");
                        break;
                      }
                    }
                  }
                }
                if (reasons.length > 0) {
                  return new Response(JSON.stringify({ success: false, error: "검열됨: " + reasons.join(", ") }), { status: 400 });
                }
              }
            }
          }
  
          // 2. 모든 파일이 검열 통과하면 업로드 진행 (각 파일 별로 R2에 저장)
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
          return new Response(JSON.stringify({ success: true, url: imageUrl }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
        }
      }
      // GET /{코드} : R2에서 파일 반환 또는 HTML 래퍼 페이지 제공 (다중 코드 지원)
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
        // 각 코드에 대해 메타데이터를 가져와 미디어 타입에 따라 렌더링
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
        cursor: zoom-in;
      }
    
      /* 가로가 긴 경우 */
      #imageContainer img.landscape,
      #imageContainer video.landscape {
        width: 40vw;
        height: auto;
        max-width: 40vw;
        cursor: zoom-in;
      }
    
      /* 세로가 긴 경우 */
      #imageContainer img.portrait,
      #imageContainer video.portrait {
        width: auto;
        height: 50vh;
        max-width: 40vw;
        cursor: zoom-in;
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
