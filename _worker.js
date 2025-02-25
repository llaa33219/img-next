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
              // 파일 스트림 소진 방지를 위해 fileForCensorship.slice()로 복제하여 사용
              sightForm.append('media', fileForCensorship.slice(0, fileForCensorship.size, fileForCensorship.type), 'upload');
              // nudity, wad, offensive 모델을 사용하여 다양한 검열 수행
              sightForm.append('models', 'nudity,wad,offensive');
              sightForm.append('api_user', env.SIGHTENGINE_API_USER);
              sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);
  
              const sightResponse = await fetch('https://api.sightengine.com/1.0/check.json', {
                method: 'POST',
                body: sightForm
              });
              const sightResult = await sightResponse.json();
  
              let reasons = [];
              if (sightResult.nudity && (sightResult.nudity.is_nude === true || (sightResult.nudity.raw && sightResult.nudity.raw > 0.5))) {
                reasons.push("선정적 콘텐츠");
              }
              if (sightResult.offensive && sightResult.offensive.prob > 0.5) {
                reasons.push("욕설/모욕적 콘텐츠");
              }
              if (sightResult.wad && (sightResult.wad.weapon > 0.5 || sightResult.wad.alcohol > 0.5 || sightResult.wad.drugs > 0.5)) {
                reasons.push("잔인하거나 위험한 콘텐츠");
              }
              if (reasons.length > 0) {
                return new Response(JSON.stringify({ success: false, error: "검열됨: " + reasons.join(", ") }), { status: 400 });
              }
            } else if (file.type.startsWith('video/')) {
              // 동영상 검열: 동영상은 리사이징 없이 원본 파일로 검열 처리
              const sightForm = new FormData();
              sightForm.append('media', file, 'upload');
              sightForm.append('models', 'nudity,wad,offensive');
              sightForm.append('api_user', env.SIGHTENGINE_API_USER);
              sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);
  
              const sightResponse = await fetch('https://api.sightengine.com/1.0/check-video.json', {
                method: 'POST',
                body: sightForm
              });
              const sightResult = await sightResponse.json();
  
              let reasons = [];
              if (sightResult.nudity && (sightResult.nudity.is_nude === true || (sightResult.nudity.raw && sightResult.nudity.raw > 0.5))) {
                reasons.push("선정적 콘텐츠");
              }
              if (sightResult.offensive && sightResult.offensive.prob > 0.5) {
                reasons.push("욕설/모욕적 콘텐츠");
              }
              if (sightResult.wad && (sightResult.wad.weapon > 0.5 || sightResult.wad.alcohol > 0.5 || sightResult.wad.drugs > 0.5)) {
                reasons.push("잔인하거나 위험한 콘텐츠");
              }
              if (reasons.length > 0) {
                return new Response(JSON.stringify({ success: false, error: "검열됨: " + reasons.join(", ") }), { status: 400 });
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
        align-items: center;
        margin: 0;
        padding: 20px;
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
        width: 120px;
        height: auto;
        cursor: pointer;
      }
      .header-content h1 {
        margin: 0;
      }
      #imageContainer {
        width: 100%;
      }
      /* 제공해주신 CSS 적용 */
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
    </style>
  </head>
  <body>
    <div class="header-content">
      <img src="https://i.imgur.com/2MkyDCh.png" alt="Logo" onclick="location.href='/'">
      <h1>이미지 공유</h1>
      <button class="toggle-button" id="toggleButton" style="background-color: #28a745; color: white; border: none; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; font-size: 24px; margin-left: 20px;">+</button>
    </div>
    <div id="imageContainer">
      ${mediaTags}
    </div>
    <script>
      function toggleZoom(elem) {
        // 만약 가로/세로 클래스가 부여되지 않았다면 자연 사이즈를 기준으로 추가
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
