export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 디버깅용 로그
  console.log("Cloudflare Pages Function triggered:", request.method, url.pathname);

  // 1) POST /upload -> 업로드 처리
  if (request.method === 'POST' && url.pathname === '/upload') {
    try {
      const formData = await request.formData();
      const file = formData.get('file');
      if (!file) {
        return new Response(
          JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }),
          { status: 400 }
        );
      }

      // 이미지라면 Sightengine로 검열
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

        // nudity.is_nude == true 이면 검열 처리
        if (sightResult.nudity && sightResult.nudity.is_nude === true) {
          return new Response(
            JSON.stringify({ success: false, error: '이미지가 검열되었습니다.' }),
            { status: 400 }
          );
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

      // 중복 체크 후 코드 확정
      let code;
      for (let i = 0; i < 5; i++) {
        code = generateRandomCode(8);
        const existing = await env.IMAGES.get(code);
        if (!existing) break;
      }
      if (!code) {
        return new Response(
          JSON.stringify({ success: false, error: '코드 생성 실패' }),
          { status: 500 }
        );
      }

      // R2에 파일 저장
      const fileBuffer = await file.arrayBuffer();
      await env.IMAGES.put(code, fileBuffer, {
        httpMetadata: { contentType: file.type }
      });

      // 업로드된 URL 반환
      const imageUrl = `https://${url.host}/${code}`;
      return new Response(
        JSON.stringify({ success: true, url: imageUrl }),
        { headers: { 'Content-Type': 'application/json' } }
      );

    } catch (err) {
      return new Response(
        JSON.stringify({ success: false, error: err.message }),
        { status: 500 }
      );
    }
  }

  // 2) GET /{8자리코드} -> R2에서 파일 반환
  else if (request.method === 'GET' && /^\/[A-Za-z0-9]{8}$/.test(url.pathname)) {
    const code = url.pathname.slice(1);
    const object = await env.IMAGES.get(code);
    if (!object) {
      return new Response('Not Found', { status: 404 });
    }
    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
    return new Response(object.body, { headers });
  }

  // 그 외 -> 404 처리
  return new Response('Not Found', { status: 404 });
}
