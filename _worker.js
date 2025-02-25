export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    console.log("Worker triggered:", request.method, url.pathname);

    // 1) POST /upload -> 업로드 처리 (변경 없음)
    if (request.method === 'POST' && url.pathname === '/upload') {
      try {
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) {
          return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }), { status: 400 });
        }

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
            return new Response(JSON.stringify({ success: false, error: '이미지가 검열되었습니다.' }), { status: 400 });
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

        // R2에 파일 저장
        const fileBuffer = await file.arrayBuffer();
        await env.IMAGES.put(code, fileBuffer, {
          httpMetadata: { contentType: file.type }
        });

        // 업로드된 URL 반환
        const imageUrl = `https://${url.host}/${code}`;
        return new Response(JSON.stringify({ success: true, url: imageUrl }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
      }
    }

    // 2) GET /{8자리코드} -> R2에서 파일 반환 혹은 HTML 래퍼 페이지 제공
    else if (request.method === 'GET' && /^\/[A-Za-z0-9]{8}$/.test(url.pathname)) {
      const code = url.pathname.slice(1);
      const object = await env.IMAGES.get(code);
      if (!object) {
        return new Response('Not Found', { status: 404 });
      }
      
      // Accept 헤더 확인
      const accept = request.headers.get("Accept") || "";
      if (accept.includes("text/html")) {
        // 브라우저에서 직접 접근한 경우 → HTML 래퍼 페이지 반환
        // 래퍼 페이지 내의 <img> 태그에는 ?raw=1을 붙여, 다시 이 Worker가 호출되더라도 Accept 헤더가 이미지용이 되어 원본 이미지를 반환하게 함
        const imageUrl = `https://${url.host}/${code}?raw=1`;
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
    #imageContainer img {
      width: 40vw;
      height: auto;
      max-width: 40vw;
      max-height: 50vh;
      display: block;
      margin: 20px auto;
      cursor: zoom-in;
      transition: all 0.3s ease;
      object-fit: contain;
    }
  </style>
</head>
<body>
  <div class="header-content">
    <img src="https://i.imgur.com/2MkyDCh.png" alt="Logo" style="width: 120px; height: auto; cursor: pointer;" onclick="location.href='https://bloupla.net/';">
    <h1>이미지 공유</h1>
  </div>
  <div id="imageContainer">
    <img src="${imageUrl}" alt="Uploaded Image">
  </div>
</body>
</html>`;
        return new Response(htmlContent, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
      } else {
        // Accept 헤더에 text/html이 없는 경우(예: <img> 태그 등) → 원본 이미지 반환
        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
        return new Response(object.body, { headers });
      }
    }

    // 3) 그 외의 요청은 정적 파일(ASSETS) 서빙
    return env.ASSETS.fetch(request);
  }
};
