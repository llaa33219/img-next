export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      console.log("Worker triggered:", request.method, url.pathname);
  
      // POST /upload : 다중 파일 업로드 처리 (검열 먼저 진행)
      if (request.method === 'POST' && url.pathname === '/upload') {
        try {
          const formData = await request.formData();
          const files = formData.getAll('file');
          if (!files || files.length === 0) {
            return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }), { status: 400 });
          }
          // 1. 검열 단계: 모든 이미지 파일에 대해 검열 API 호출 (검열 통과 못하면 업로드 중단)
          for (const file of files) {
            if (file.type.startsWith('image/')) {
              const sightForm = new FormData();
              // 파일 스트림 소진 방지를 위해 file.slice()로 복제하여 사용
              sightForm.append('media', file.slice(0, file.size, file.type), 'upload');
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
              if (sightResult.nudity && sightResult.nudity.is_nude === true) {
                reasons.push("선정적 콘텐츠");
              }
              if (sightResult.offensive && sightResult.offensive.prob > 0.5) {
                reasons.push("욕설/모욕적 콘텐츠");
              }
              if (sightResult.wad && (sightResult.wad.weapon > 0.5 || sightResult.wad.alcohol > 0.5 || sightResult.wad.drugs > 0.5)) {
                reasons.push("잔인하거나 위험한 콘텐츠");
              }
              if (reasons.length > 0) {
                // 하나라도 검열 실패 시 업로드 중단
                return new Response(JSON.stringify({ success: false, error: "검열됨: " + reasons.join(", ") }), { status: 400 });
              }
            }
          }
    
          // 2. 모든 파일이 검열 통과하면 업로드 진행 (각 파일 별로 R2에 저장)
          let codes = [];
          for (const file of files) {
            // 8자리 랜덤 코드 생성 함수
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
            // 파일 저장 (R2)
            const fileBuffer = await file.arrayBuffer();
            await env.IMAGES.put(code, fileBuffer, {
              httpMetadata: { contentType: file.type }
            });
            codes.push(code);
          }
          // 다중 코드들을 콤마로 연결한 URL 생성
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
        // 만약 URL에 ?raw=1 파라미터가 있으면 원본 이미지 반환
        if (url.searchParams.get('raw') === '1') {
          // 다중 코드 중 첫번째 코드에 대해 원본 이미지 반환
          const code = url.pathname.slice(1).split(",")[0];
          const object = await env.IMAGES.get(code);
          if (!object) {
            return new Response('Not Found', { status: 404 });
          }
          const headers = new Headers();
          headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
          return new Response(object.body, { headers });
        }
        // 브라우저 직접 접근 시 HTML 래퍼 페이지 제공 (확대 기능 포함)
        const codes = url.pathname.slice(1).split(",");
        let imageTags = "";
        for (const code of codes) {
          imageTags += `<img src="https://${url.host}/${code}?raw=1" alt="Uploaded Image" onclick="toggleZoom(this)">\n`;
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
        width: 100%;
        margin-bottom: 20px;
      }
      .header-content img {
        width: 120px;
        cursor: pointer;
        margin-right: 20px;
        border-radius: 14px;
      }
      .header-content h1 {
        font-size: 30px;
        margin: 0;
      }
      .toggle-button {
        background-color: #28a745;
        color: white;
        border: none;
        border-radius: 50%;
        width: 40px;
        height: 40px;
        cursor: pointer;
        font-size: 24px;
        margin-left: 20px;
      }
      #imageContainer img {
        max-width: 90vw;
        max-height: 90vh;
        margin: 10px;
        cursor: zoom-in;
        transition: transform 0.3s ease;
        width: auto;
        height: auto;
      }
      #imageContainer img.expanded {
        transform: scale(2);
        cursor: zoom-out;
      }
    </style>
  </head>
  <body>
    <div class="header-content">
      <img src="https://i.imgur.com/2MkyDCh.png" alt="Logo" onclick="location.href='https://bloupla.net/'">
      <h1>이미지 공유</h1>
      <button class="toggle-button" id="toggleButton">+</button>
    </div>
    <div id="imageContainer">
      ${imageTags}
    </div>
    <script>
      function toggleZoom(img) {
        img.classList.toggle('expanded');
      }
      document.getElementById('toggleButton').addEventListener('click', function(){
        window.location.href = '/';
      });
    </script>
  </body>
  </html>`;
        return new Response(htmlContent, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
      }
    
      // 그 외의 요청은 정적 파일(ASSETS) 서빙
      return env.ASSETS.fetch(request);
    }
  };
