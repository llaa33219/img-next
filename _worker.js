export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      console.log("Worker triggered:", request.method, url.pathname);
  
      // 1) POST /upload -> 다중 업로드 처리
      if (request.method === 'POST' && url.pathname === '/upload') {
        try {
          const formData = await request.formData();
          const files = formData.getAll('file');
          if (!files || files.length === 0) {
            return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }), { status: 400 });
          }
  
          const codes = [];
          // 선택된 모든 파일에 대해 처리
          for (const file of files) {
            // 이미지인 경우 Sightengine 검열
            if (file.type.startsWith('image/')) {
              const sightForm = new FormData();
              sightForm.append('media', file, 'upload');
              sightForm.append('models', 'nudity');
              sightForm.append('api_user', env.SIGHTENGINE_API_USER);
              sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);
  
              const sightResponse = await fetch('https://api.sightengine.com/1.0/check.json', {
                method: 'POST',
                body: sightForm
              });
              const sightResult = await sightResponse.json();
              if (sightResult.nudity && sightResult.nudity.is_nude === true) {
                // 검열된 파일은 저장하지 않고 건너뜁니다.
                continue;
              }
            }
  
            // 8자리 랜덤 코드 생성
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
  
          if (codes.length === 0) {
            return new Response(JSON.stringify({ success: false, error: '업로드 가능한 파일이 없습니다.' }), { status: 400 });
          }
  
          // 업로드된 URL: 여러 코드를 콤마로 구분
          const urlCodes = codes.join(',');
          const imageUrl = `https://${url.host}/${urlCodes}`;
          return new Response(JSON.stringify({ success: true, url: imageUrl }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
        }
      }
      // 2) GET /{코드 또는 다중 코드} -> 이미지 반환 또는 HTML 래퍼 페이지 제공
      else if (request.method === 'GET' && /^\/[A-Za-z0-9,]+$/.test(url.pathname)) {
        const codesStr = url.pathname.slice(1);
        
        // 다중 이미지: 코드에 쉼표가 포함된 경우
        if (codesStr.includes(',')) {
          const codes = codesStr.split(',').filter(c => c.length === 8);
          // HTML 래퍼 페이지에서 각 이미지는 ?raw=1 URL을 사용해 원본을 요청
          let imagesHtml = '';
          for (const code of codes) {
            const rawUrl = `https://${url.host}/${code}?raw=1`;
            imagesHtml += `<img src="${rawUrl}" alt="Image ${code}" style="cursor: zoom-in; margin: 10px;">\n`;
          }
          const htmlContent = `<!DOCTYPE html>
  <html lang="ko">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>이미지 공유 - 다중 이미지</title>
    <style>
      body {
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        margin: 0;
        padding: 20px;
        background: #f0f0f0;
      }
      #imageContainer {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        align-items: center;
      }
      #imageContainer img {
        max-width: 40vw;
        max-height: 50vh;
        transition: transform 0.3s ease;
      }
      #imageContainer img.expanded {
        transform: scale(2);
        z-index: 1000;
      }
    </style>
  </head>
  <body>
    <div id="imageContainer">
      ${imagesHtml}
    </div>
    <script>
      document.querySelectorAll('#imageContainer img').forEach(img => {
        img.addEventListener('click', () => {
          img.classList.toggle('expanded');
        });
      });
    </script>
  </body>
  </html>`;
          return new Response(htmlContent, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
        }
        // 단일 코드 처리
        else {
          const code = codesStr;
          const object = await env.IMAGES.get(code);
          if (!object) {
            return new Response('Not Found', { status: 404 });
          }
          // query parameter "raw"가 있으면 원본 이미지 반환
          if (url.searchParams.has('raw')) {
            const headers = new Headers();
            headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
            return new Response(object.body, { headers });
          }
          // 기본: HTML 래퍼 페이지
          const imageUrl = `https://${url.host}/${code}?raw=1`;
          const htmlContent = `<!DOCTYPE html>
  <html lang="ko">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>이미지 공유</title>
    <style>
      body {
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        margin: 0;
        padding: 20px;
      }
      #imageContainer img {
        max-width: 40vw;
        max-height: 50vh;
        cursor: zoom-in;
        transition: transform 0.3s ease;
      }
      #imageContainer img.expanded {
        transform: scale(2);
        z-index: 1000;
      }
    </style>
  </head>
  <body>
    <div id="imageContainer">
      <img src="${imageUrl}" alt="Uploaded Image">
    </div>
    <script>
      document.querySelector('#imageContainer img').addEventListener('click', function() {
        this.classList.toggle('expanded');
      });
    </script>
  </body>
  </html>`;
          return new Response(htmlContent, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
        }
      }
      
      // 3) 그 외의 요청은 정적 파일(ASSETS) 서빙
      return env.ASSETS.fetch(request);
    }
  };
  