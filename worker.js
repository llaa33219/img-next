// worker.js

/**
 * Cloudflare Workers 환경에서 동작하는 이미지 업로드 및 제공 API
 * 
 * 환경변수:
 * - IMAGES: Cloudflare R2 바인딩 (이미지 저장용)
 * - SIGHTENGINE_API_USER: Sightengine API 사용자 아이디
 * - SIGHTENGINE_API_SECRET: Sightengine API 비밀키
 */

export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      // POST /upload: 이미지/영상 업로드
      if (request.method === 'POST' && url.pathname === '/upload') {
        try {
          const formData = await request.formData();
          const file = formData.get('file');
          if (!file) {
            return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }), { status: 400 });
          }
  
          // 이미지인 경우에만 Sightengine를 통한 검열 진행 (영상은 검열 생략)
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
  
            // 검열 결과 체크 – is_nude가 true이면 부적절한 이미지로 판단
            if (sightResult.nudity && sightResult.nudity.is_nude === true) {
              return new Response(JSON.stringify({ success: false, error: '이미지가 검열되었습니다.' }), { status: 400 });
            }
          }
  
          // 8자리 랜덤 코드 생성 (알파벳 대소문자와 숫자)
          const generateRandomCode = (length = 8) => {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            let result = '';
            for (let i = 0; i < length; i++) {
              result += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return result;
          };
  
          // 중복 확인 후 코드 생성 (최대 5회 시도)
          let code;
          for (let i = 0; i < 5; i++) {
            code = generateRandomCode(8);
            const existing = await env.IMAGES.get(code);
            if (!existing) break;
          }
          if (!code) {
            return new Response(JSON.stringify({ success: false, error: '코드 생성 실패' }), { status: 500 });
          }
  
          // 파일 저장: R2에 저장 시 httpMetadata에 contentType 기록
          const fileBuffer = await file.arrayBuffer();
          await env.IMAGES.put(code, fileBuffer, {
            httpMetadata: { contentType: file.type }
          });
  
          // 업로드된 URL 생성 (요청 호스트를 사용)
          const imageUrl = `https://${url.host}/${code}`;
          return new Response(JSON.stringify({ success: true, url: imageUrl }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
        }
      }
      // GET /{8자리코드}: 저장된 이미지/영상 제공
      else if (request.method === 'GET' && /^\/[A-Za-z0-9]{8}$/.test(url.pathname)) {
        const code = url.pathname.slice(1); // 앞의 '/' 제거
        const object = await env.IMAGES.get(code);
        if (!object) {
          return new Response('Not Found', { status: 404 });
        }
        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
        return new Response(object.body, { headers });
      }
      // 그 외 경로는 404 처리
      else {
        return new Response('Not Found', { status: 404 });
      }
    }
  }
  