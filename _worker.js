// ==============================
// Cloudflare Workers 메인 진입점
// ==============================

import { checkRateLimit, cleanupOldData } from './rate-limiter.js';
import { handleUpload } from './upload-handler.js';
import { addCorsHeaders } from './utils.js';
import { renderHTML, renderApiDocs } from './html-templates.js';

// ==============================
// 전역: 중복 요청 관리 Map
// ==============================
const requestsInProgress = {};

export default {
  async fetch(request, env, ctx) {
    // 주기적으로 메모리 정리 (10분마다)
    const now = Date.now();
    if (!this.lastCleanup || now - this.lastCleanup > 600000) {
      ctx.waitUntil(Promise.resolve().then(() => cleanupOldData()));
      this.lastCleanup = now;
    }
    
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');

    // OPTIONS 요청 처리 (CORS preflight)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // 1) [POST] /upload 또는 /upload/ => 업로드 처리 (웹 인터페이스)
    if (request.method === 'POST' && path === '/upload') {
      return await handlePostUpload(request, env, ctx, url, false);
    }

    // 2) [POST] /api/upload => API 전용 업로드 엔드포인트 (외부용)
    else if (request.method === 'POST' && path === '/api/upload') {
      return await handlePostUpload(request, env, ctx, url, true);
    }

    // 3) [GET] /api => API 문서 제공
    else if (request.method === 'GET' && path === '/api') {
      return new Response(renderApiDocs(url.host), {
        headers: { 'Content-Type': 'text/html; charset=UTF-8' }
      });
    }

    // 4) [GET] /{코드 또는 커스텀 이름} => R2 파일 or HTML
    else if (request.method === 'GET' && url.pathname.length > 1) {
      return await handleGetRequest(request, env, url);
    }

    // 5) 그 외 => 기본 정적 에셋
    return env.ASSETS.fetch(request);
  }
};

/**
 * POST 업로드 요청 처리 함수
 * @param {Request} request - 요청 객체
 * @param {Object} env - 환경 변수
 * @param {Object} ctx - 컨텍스트
 * @param {URL} url - URL 객체
 * @param {boolean} isApiEndpoint - API 엔드포인트 여부
 * @returns {Response} - 응답 객체
 */
async function handlePostUpload(request, env, ctx, url, isApiEndpoint) {
  // 클라이언트 IP 가져오기
  const clientIP = request.headers.get('CF-Connecting-IP') || 
                  request.headers.get('X-Forwarded-For') || 
                  request.headers.get('X-Real-IP') || 
                  'unknown';
  
  // 레이트 리미팅 검사
  const rateLimitResult = checkRateLimit(clientIP);
  if (rateLimitResult.blocked) {
    console.log(`[Rate Limit] ${isApiEndpoint ? 'API ' : ''}IP ${clientIP} 차단됨: ${rateLimitResult.reason}`);
    const response = new Response(JSON.stringify({
      success: false,
      error: `보안상 업로드가 제한되었습니다. ${rateLimitResult.reason}. ${rateLimitResult.remainingTime}초 후 다시 시도하세요.`,
      rateLimited: true,
      remainingTime: rateLimitResult.remainingTime
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' }
    });
    return isApiEndpoint ? addCorsHeaders(response) : response;
  }
  
  // API 엔드포인트는 항상 CORS 헤더 추가
  if (isApiEndpoint) {
    const response = await handleUpload(request, env);
    return addCorsHeaders(response);
  }
  
  // 웹 인터페이스 업로드 - 외부 요청 확인
  const isExternalRequest = request.headers.get('Origin') && 
                           !request.headers.get('Origin').includes(url.host);
  
  const cfReqId = request.headers.get('Cf-Request-Id') || '';
  if (cfReqId) {
    if (requestsInProgress[cfReqId]) {
      console.log(`[Dedup] 중복 요청 감지 => Cf-Request-Id=${cfReqId}. 기존 Promise 공유.`);
      const response = await requestsInProgress[cfReqId].promise;
      return isExternalRequest ? addCorsHeaders(response) : response;
    } else {
      let resolveFn, rejectFn;
      const promise = new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      requestsInProgress[cfReqId] = { promise, resolve: resolveFn, reject: rejectFn };
      ctx.waitUntil((async () => {
        await new Promise(r => setTimeout(r, 60000));
        delete requestsInProgress[cfReqId];
      })());

      let finalResp;
      try {
        finalResp = await handleUpload(request, env);
        requestsInProgress[cfReqId].resolve(finalResp);
      } catch (err) {
        console.log("handleUpload error:", err);
        const failResp = new Response(
          JSON.stringify({ success: false, error: err.message }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
        requestsInProgress[cfReqId].reject(failResp);
        finalResp = failResp;
      }
      return isExternalRequest ? addCorsHeaders(finalResp) : finalResp;
    }
  } else {
    const response = await handleUpload(request, env);
    return isExternalRequest ? addCorsHeaders(response) : response;
  }
}

/**
 * GET 요청 처리 함수
 * @param {Request} request - 요청 객체
 * @param {Object} env - 환경 변수
 * @param {URL} url - URL 객체
 * @returns {Response} - 응답 객체
 */
async function handleGetRequest(request, env, url) {
  // 정적 파일 요청
  if (url.pathname.includes('.')) {
    return env.ASSETS.fetch(request);
  }
  
  // 쉼표로 구분된 여러 코드 처리
  if (url.pathname.indexOf(',') !== -1) {
    const codes = url.pathname.slice(1).split(',').map(decodeURIComponent);
    
    // raw=1 파라미터가 있으면 첫 번째 파일만 raw로 반환
    if (url.searchParams.get('raw') === '1') {
      const code = codes[0];
      const rangeHeader = request.headers.get('Range');
      
      // Range 요청 처리 (비디오 시간 이동을 위해 필요)
      if (rangeHeader) {
        const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1]);
          
          // 먼저 전체 파일 정보를 가져와서 전체 크기 확인
          const fullObject = await env.IMAGES.get(code);
          if (!fullObject) return new Response('Not Found', { status: 404 });
          
          const totalSize = fullObject.size;
          const end = rangeMatch[2] ? parseInt(rangeMatch[2]) : totalSize - 1;
          const length = end - start + 1;
          
          // Range 요청으로 해당 부분만 가져오기
          const object = await env.IMAGES.get(code, {
            range: { offset: start, length: length }
          });
          
          if (!object) return new Response('Not Found', { status: 404 });
          
          const headers = new Headers();
          headers.set('Content-Type', fullObject.httpMetadata?.contentType || 'application/octet-stream');
          headers.set('Accept-Ranges', 'bytes');
          headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
          headers.set('Content-Length', length.toString());
          
          return new Response(object.body, { status: 206, headers });
        }
      }
      
      // Range 요청이 없으면 전체 파일 반환
      const object = await env.IMAGES.get(code);
      if (!object) return new Response('Not Found', { status: 404 });
      const headers = new Headers();
      headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Content-Length', object.size.toString());
      return new Response(object.body, { headers });
    }
    
    // 여러 파일을 HTML로 렌더링
    const objects = await Promise.all(codes.map(async code => ({
      code,
      object: await env.IMAGES.get(code)
    })));
    
    let mediaTags = "";
    for (const { code, object } of objects) {
      if (object && object.httpMetadata?.contentType?.startsWith('video/')) {
        mediaTags += `<video src="https://${url.host}/${code}?raw=1" controls preload="auto"></video>\n`;
      } else {
        mediaTags += `<img src="https://${url.host}/${code}?raw=1" alt="Uploaded Media">\n`;
      }
    }
    
    return new Response(renderHTML(mediaTags, url.host), {
      headers: { "Content-Type": "text/html; charset=UTF-8" }
    });
  } 
  
  // 단일 코드 처리
  else {
    const key = decodeURIComponent(url.pathname.slice(1));
    
    // raw=1 파라미터가 있으면 파일 자체를 반환
    if (url.searchParams.get('raw') === '1') {
      const rangeHeader = request.headers.get('Range');
      
      // Range 요청 처리 (비디오 시간 이동을 위해 필요)
      if (rangeHeader) {
        const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1]);
          
          // 먼저 전체 파일 정보를 가져와서 전체 크기 확인
          const fullObject = await env.IMAGES.get(key);
          if (!fullObject) return new Response('Not Found', { status: 404 });
          
          const totalSize = fullObject.size;
          const end = rangeMatch[2] ? parseInt(rangeMatch[2]) : totalSize - 1;
          const length = end - start + 1;
          
          // Range 요청으로 해당 부분만 가져오기
          const object = await env.IMAGES.get(key, {
            range: { offset: start, length: length }
          });
          
          if (!object) return new Response('Not Found', { status: 404 });
          
          const headers = new Headers();
          headers.set('Content-Type', fullObject.httpMetadata?.contentType || 'application/octet-stream');
          headers.set('Accept-Ranges', 'bytes');
          headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
          headers.set('Content-Length', length.toString());
          
          return new Response(object.body, { status: 206, headers });
        }
      }
      
      // Range 요청이 없으면 전체 파일 반환
      const object = await env.IMAGES.get(key);
      if (!object) return new Response('Not Found', { status: 404 });
      const headers = new Headers();
      headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Content-Length', object.size.toString());
      return new Response(object.body, { headers });
    } 
    
    // HTML로 렌더링
    else {
      const object = await env.IMAGES.get(key);
      if (!object) return new Response('Not Found', { status: 404 });
      
      let mediaTag = "";
      if (object.httpMetadata?.contentType?.startsWith('video/')) {
        mediaTag = `<video src="https://${url.host}/${key}?raw=1" controls preload="auto"></video>\n`;
      } else {
        mediaTag = `<img src="https://${url.host}/${key}?raw=1" alt="Uploaded Media">\n`;
      }
      return new Response(renderHTML(mediaTag, url.host), {
        headers: { 'Content-Type': 'text/html; charset=UTF-8' }
      });
    }
  }
}
