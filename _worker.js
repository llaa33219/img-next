// ==============================
// 전역: 중복 요청 관리 Map
// ==============================
const requestsInProgress = {};

// ==============================
// 전역: 레이트 리미팅 관리 Map
// ==============================
const rateLimitData = new Map(); // IP별 요청 기록
const blockedIPs = new Map(); // 차단된 IP와 해제 시간

// 레이트 리미팅 검사 함수
function checkRateLimit(clientIP) {
  const now = Date.now();
  
  // 차단된 IP 확인
  if (blockedIPs.has(clientIP)) {
    const blockInfo = blockedIPs.get(clientIP);
    if (now < blockInfo.unblockTime) {
      const remainingTime = Math.ceil((blockInfo.unblockTime - now) / 1000);
      return {
        blocked: true,
        reason: blockInfo.reason,
        remainingTime: remainingTime
      };
    } else {
      // 차단 시간이 지났으므로 해제
      blockedIPs.delete(clientIP);
    }
  }
  
  // 현재 IP의 요청 기록 가져오기 또는 생성
  if (!rateLimitData.has(clientIP)) {
    rateLimitData.set(clientIP, {
      requests: [],
      lastCleanup: now
    });
  }
  
  const ipData = rateLimitData.get(clientIP);
  
  // 오래된 요청 기록 정리 (1시간 이상 된 것)
  if (now - ipData.lastCleanup > 60000) { // 1분마다 정리
    ipData.requests = ipData.requests.filter(time => now - time < 3600000); // 1시간
    ipData.lastCleanup = now;
  }
  
  // 현재 요청 추가
  ipData.requests.push(now);
  
  // 1분 내 요청 수 확인 (20개 초과시 5분 차단)
  const oneMinuteAgo = now - 60000;
  const recentRequests = ipData.requests.filter(time => time > oneMinuteAgo);
  
  if (recentRequests.length > 20) {
    const unblockTime = now + (5 * 60 * 1000); // 5분 후
    blockedIPs.set(clientIP, {
      unblockTime: unblockTime,
      reason: '1분 내 20개 초과 업로드'
    });
    return {
      blocked: true,
      reason: '1분 내 20개 초과 업로드로 인한 5분 차단',
      remainingTime: 300
    };
  }
  
  // 1시간 내 요청 수 확인 (100개 초과시 1시간 차단)
  const oneHourAgo = now - 3600000;
  const hourlyRequests = ipData.requests.filter(time => time > oneHourAgo);
  
  if (hourlyRequests.length > 100) {
    const unblockTime = now + (60 * 60 * 1000); // 1시간 후
    blockedIPs.set(clientIP, {
      unblockTime: unblockTime,
      reason: '1시간 내 100개 초과 업로드'
    });
    return {
      blocked: true,
      reason: '1시간 내 100개 초과 업로드로 인한 1시간 차단',
      remainingTime: 3600
    };
  }
  
  return { blocked: false };
}

// 메모리 정리 함수 (주기적으로 호출)
function cleanupOldData() {
  const now = Date.now();
  const oneHourAgo = now - 3600000;
  
  // 오래된 요청 기록 정리
  for (const [ip, data] of rateLimitData.entries()) {
    data.requests = data.requests.filter(time => time > oneHourAgo);
    if (data.requests.length === 0) {
      rateLimitData.delete(ip);
    }
  }
  
  // 만료된 차단 기록 정리
  for (const [ip, blockInfo] of blockedIPs.entries()) {
    if (now >= blockInfo.unblockTime) {
      blockedIPs.delete(ip);
    }
  }
  
  console.log(`[Cleanup] 레이트 리미팅 데이터 정리 완료. 활성 IP: ${rateLimitData.size}, 차단된 IP: ${blockedIPs.size}`);
}

// CORS 헤더 추가 함수
function addCorsHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

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
      // 클라이언트 IP 가져오기
      const clientIP = request.headers.get('CF-Connecting-IP') || 
                      request.headers.get('X-Forwarded-For') || 
                      request.headers.get('X-Real-IP') || 
                      'unknown';
      
      // 레이트 리미팅 검사
      const rateLimitResult = checkRateLimit(clientIP);
      if (rateLimitResult.blocked) {
        console.log(`[Rate Limit] IP ${clientIP} 차단됨: ${rateLimitResult.reason}`);
        return new Response(JSON.stringify({
          success: false,
          error: `보안상 업로드가 제한되었습니다. ${rateLimitResult.reason}. ${rateLimitResult.remainingTime}초 후 다시 시도하세요.`,
          rateLimited: true,
          remainingTime: rateLimitResult.remainingTime
        }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // 요청이 웹 인터페이스에서 왔는지 외부에서 왔는지 확인
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

    // 2) [POST] /api/upload => API 전용 업로드 엔드포인트 (외부용)
    else if (request.method === 'POST' && path === '/api/upload') {
      // 클라이언트 IP 가져오기
      const clientIP = request.headers.get('CF-Connecting-IP') || 
                      request.headers.get('X-Forwarded-For') || 
                      request.headers.get('X-Real-IP') || 
                      'unknown';
      
      // 레이트 리미팅 검사
      const rateLimitResult = checkRateLimit(clientIP);
      if (rateLimitResult.blocked) {
        console.log(`[Rate Limit] API IP ${clientIP} 차단됨: ${rateLimitResult.reason}`);
        const response = new Response(JSON.stringify({
          success: false,
          error: `보안상 업로드가 제한되었습니다. ${rateLimitResult.reason}. ${rateLimitResult.remainingTime}초 후 다시 시도하세요.`,
          rateLimited: true,
          remainingTime: rateLimitResult.remainingTime
        }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
        return addCorsHeaders(response);
      }
      
      const response = await handleUpload(request, env);
      return addCorsHeaders(response);
    }

    // 3) [GET] /api => API 문서 제공
    else if (request.method === 'GET' && path === '/api') {
      return new Response(renderApiDocs(url.host), {
        headers: { 'Content-Type': 'text/html; charset=UTF-8' }
      });
    }

    // 4) [GET] /{코드 또는 커스텀 이름} => R2 파일 or HTML
    else if (request.method === 'GET' && url.pathname.length > 1) {
      if (url.pathname.includes('.')) {
        return env.ASSETS.fetch(request);
      }
      if (url.pathname.indexOf(',') !== -1) {
        const codes = url.pathname.slice(1).split(',').map(decodeURIComponent);
        if (url.searchParams.get('raw') === '1') {
          const object = await env.IMAGES.get(codes[0]);
          if (!object) return new Response('Not Found', { status: 404 });
          const headers = new Headers();
          headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
          return new Response(object.body, { headers });
        }
        const objects = await Promise.all(codes.map(async code => ({
          code,
          object: await env.IMAGES.get(code)
        })));
        let mediaTags = "";
        for (const { code, object } of objects) {
          if (object && object.httpMetadata?.contentType?.startsWith('video/')) {
            mediaTags += `<video src="https://${url.host}/${code}?raw=1"></video>\n`;
          } else {
            mediaTags += `<img src="https://${url.host}/${code}?raw=1" alt="Uploaded Media" onclick="toggleZoom(this)">\n`;
          }
        }
        return new Response(renderHTML(mediaTags, url.host), {
          headers: { "Content-Type": "text/html; charset=UTF-8" }
        });
      } else {
        const key = decodeURIComponent(url.pathname.slice(1));
        const object = await env.IMAGES.get(key);
        if (!object) return new Response('Not Found', { status: 404 });
        if (url.searchParams.get('raw') === '1') {
          const headers = new Headers();
          headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
          return new Response(object.body, { headers });
        } else {
          let mediaTag = "";
          if (object.httpMetadata?.contentType?.startsWith('video/')) {
            mediaTag = `<video src="https://${url.host}/${key}?raw=1"></video>\n`;
          } else {
            mediaTag = `<img src="https://${url.host}/${key}?raw=1" alt="Uploaded Media" onclick="toggleZoom(this)">\n`;
          }
          return new Response(renderHTML(mediaTag, url.host), {
            headers: { 'Content-Type': 'text/html; charset=UTF-8' }
          });
        }
      }
    }

    // 5) 그 외 => 기본 정적 에셋
    return env.ASSETS.fetch(request);
  }
};

// 메인 업로드 처리 함수
async function handleUpload(request, env) {
  const formData = await request.formData();
  const files = formData.getAll('file');
  let customName = formData.get('customName');

  if (!files || files.length === 0) {
    return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const allowedImageTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  const allowedVideoTypes = ["video/mp4", "video/webm", "video/ogg", "video/x-msvideo", "video/avi", "video/msvideo"];
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      if (!allowedImageTypes.includes(file.type)) {
        return new Response(JSON.stringify({ success: false, error: '지원하지 않는 이미지 형식입니다.' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }
    } else if (file.type.startsWith('video/')) {
      if (!allowedVideoTypes.includes(file.type)) {
        return new Response(JSON.stringify({ success: false, error: '지원하지 않는 동영상 형식입니다.' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }
    } else {
      return new Response(JSON.stringify({ success: false, error: '지원하지 않는 파일 형식입니다.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // 1) 검열
  try {
    for (const file of files) {
      const r = file.type.startsWith('image/')
        ? await handleImageCensorship(file, env)
        : await handleVideoCensorship(file, env);
      if (!r.ok) return r.response;
    }
  } catch (e) {
    console.log("검열 과정에서 예상치 못한 오류 발생:", e);
    return new Response(JSON.stringify({
      success: false,
      error: `검열 처리 중 오류: ${e.message}`
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  // 2) R2 업로드
  let codes = [];
  if (customName && files.length === 1) {
    customName = customName.replace(/ /g, "_");
    if (await env.IMAGES.get(customName)) {
      return new Response(JSON.stringify({
        success: false,
        error: '이미 사용 중인 이름입니다. 다른 이름을 선택해주세요.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const buffer = await files[0].arrayBuffer();
    await env.IMAGES.put(customName, buffer, {
      httpMetadata: { contentType: files[0].type }
    });
    codes.push(customName);
  } else {
    for (const file of files) {
      const code = await generateUniqueCode(env);
      const buffer = await file.arrayBuffer();
      await env.IMAGES.put(code, buffer, {
        httpMetadata: { contentType: file.type }
      });
      codes.push(code);
    }
  }

  const host = request.headers.get('host') || 'example.com';
  const finalUrl = `https://${host}/${codes.join(",")}`;
  const rawUrls = codes.map(code => `https://${host}/${code}?raw=1`);
  console.log(">>> 업로드 완료 =>", finalUrl);

  // API 응답에 추가 정보 포함
  return new Response(JSON.stringify({ 
    success: true, 
    url: finalUrl,
    rawUrls: rawUrls,
    codes: codes,
    fileTypes: files.map(file => file.type)
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// 이미지 검열 - Gemini API 사용
async function handleImageCensorship(file, env) {
  try {
    const buf = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    const geminiApiKey = env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return { ok: false, response: new Response(JSON.stringify({
          success: false, error: 'Gemini API 키가 설정되지 않았습니다.'
        }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      };
    }

    let imageBase64 = base64;
    if (buf.byteLength > 3 * 1024 * 1024) {
      try {
        const dataUrl = `data:${file.type};base64,${base64}`;
        const resizedResp = await fetch(new Request(dataUrl, {
          cf: { image: { width: 800, height: 800, fit: "inside" } }
        }));
        if (resizedResp.ok) {
          const resizedBuf = await resizedResp.blob().then(b => b.arrayBuffer());
          imageBase64 = arrayBufferToBase64(resizedBuf);
        }
      } catch (e) {
        console.log("이미지 리사이징 실패:", e);
      }
    }

    const requestBody = {
      contents: [{
        parts: [
          { text:
            "이 이미지에 부적절한 콘텐츠가 포함되어 있는지 확인해주세요. 각 카테고리별로 true 또는 false로만 답변해주세요:\n\n" +
            "1. 노출/선정적 이미지: true/false\n" +
            "2. 폭력/무기: true/false\n" +
            "3. 약물/알코올: true/false\n" +
            "4. 욕설/혐오 표현: true/false\n" +
            "5. 기타 유해 콘텐츠: true/false\n\n" +
            "각 줄에 숫자와 true/false만 답변하세요. 추가 설명은 하지 마세요."
           },
          { inlineData: { mimeType: file.type, data: imageBase64 } }
        ]
      }],
      generationConfig: { temperature: 0.1, topK: 40, topP: 0.95, maxOutputTokens: 256 }
    };

    const analysis = await callGeminiAPI(geminiApiKey, requestBody);
    if (!analysis.success) {
      return { ok: false, response: new Response(JSON.stringify({
          success: false, error: `Gemini API 호출 오류: ${analysis.error}`
        }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      };
    }

    const bad = isInappropriateContent(analysis.text);
    if (bad.isInappropriate) {
      return { ok: false, response: new Response(JSON.stringify({
          success: false, error: `검열됨: ${bad.reasons.join(", ")}`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      };
    }
    return { ok: true };
  } catch (e) {
    console.log("handleImageCensorship error:", e);
    return { ok: false, response: new Response(JSON.stringify({
        success: false, error: `이미지 검열 중 오류 발생: ${e.message}`
      }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    };
  }
}

// 동영상 검열 - Gemini Video 파일 업로드 API 사용
async function handleVideoCensorship(file, env) {
  try {
    console.log(`비디오 크기: ${(file.size / (1024 * 1024)).toFixed(2)}MB`);
    const geminiApiKey = env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return { ok: false, response: new Response(JSON.stringify({
          success: false, error: 'Gemini API 키가 설정되지 않았습니다.'
        }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      };
    }

    // 1) Resumable upload 시작
    const startResp = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=resumable&key=${geminiApiKey}`,
      { method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': file.size,
          'X-Goog-Upload-Header-Content-Type': file.type,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file: { display_name: 'video_upload' } })
      }
    );
    if (!startResp.ok) {
      const err = await startResp.text();
      throw new Error(`Resumable upload start 실패: ${startResp.status} ${err}`);
    }
    let uploadUrl =
      startResp.headers.get('X-Goog-Upload-URL') ||
      startResp.headers.get('Location');

    if (!uploadUrl) {
      // Response 본문을 두 번 읽으려면 clone() 사용
      const cloneForJson = startResp.clone();
      const cloneForText = startResp.clone();

      // JSON 바디에서 가능한 필드 확인
      const json = await cloneForJson.json().catch(() => null);
      uploadUrl = json?.uploadUri || json?.uploadUrl || json?.resumableUri;

      if (!uploadUrl) {
        const hdrs = [...startResp.headers]
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n');
        const textBody = await cloneForText.text().catch(() => '');
        throw new Error(
          `Resumable 업로드 URL을 가져올 수 없습니다.\n응답 헤더:\n${hdrs}\n응답 바디:\n${textBody}`
        );
      }
    }

    // 2) 파일 업로드 및 finalize
    const buffer = await file.arrayBuffer();
    const uploadResp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': file.size,
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize'
      },
      body: buffer
    });
    if (!uploadResp.ok) {
      const err = await uploadResp.text();
      throw new Error(`비디오 업로드 실패: ${uploadResp.status} ${err}`);
    }

    // 3) 업로드 완료 응답에서 resource name 추출
    const uploadResult = await uploadResp.json();
    // file 객체 내부의 name 필드를 사용합니다.
       const resourceName = uploadResult.file?.name;
        if (!resourceName) {
         throw new Error(
           `업로드 완료 후 resource name을 확인할 수 없습니다. 응답: ${JSON.stringify(uploadResult)}`
         );
      }
    // 4) 처리 완료 대기 (PROCESSING → ACTIVE)
    const statusUrl = uploadResult.file?.uri + `?key=${env.GEMINI_API_KEY}`;
    let statusResp = await fetch(statusUrl);
    if (!statusResp.ok) {
      throw new Error(`파일 상태 조회 실패: ${statusResp.status}`);
    }
    let myfile = await statusResp.json();
    while (myfile.state === 'PROCESSING') {
      console.log('비디오 처리 중...');
      await new Promise(r => setTimeout(r, 5000));
      statusResp = await fetch(statusUrl);
      if (!statusResp.ok) {
        throw new Error(`파일 상태 조회 실패: ${statusResp.status}`);
      }
      myfile = await statusResp.json();
    }
    if (myfile.state !== 'ACTIVE') {
      throw new Error(`비디오 파일이 활성 상태가 아닙니다: ${myfile.state}`);
    }

    // 5) 검열 요청
    const fileUri = uploadResult.file.uri;
    const requestBody = {
      contents: [{
        parts: [
          { text:
              "이 비디오에 부적절한 콘텐츠가 포함되어 있는지 확인해주세요. 각 카테고리별로 true 또는 false로만 답변해주세요:\n\n" +
              "1. 노출/선정적 이미지: true/false\n" +
              "2. 폭력/무기: true/false\n" +
              "3. 약물/알코올: true/false\n" +
              "4. 욕설/혐오 표현: true/false\n" +
              "5. 기타 유해 콘텐츠: true/false\n\n" +
              "각 줄에 숫자와 true/false만 답변하세요. 추가 설명은 하지 마세요."
             },
          { file_data: { mime_type: file.type, file_uri: fileUri } }
        ]
      }],
      generationConfig: { temperature: 0.1, topK: 40, topP: 0.95, maxOutputTokens: 256 }
    };
    const analysis = await callGeminiAPI(geminiApiKey, requestBody);
    if (!analysis.success) {
      throw new Error(analysis.error);
    }
    const bad = isInappropriateContent(analysis.text);
    if (bad.isInappropriate) {
      return { ok: false, response: new Response(JSON.stringify({
          success: false, error: `검열됨: ${bad.reasons.join(', ')}`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } }) };
    }
    return { ok: true };
  } catch (e) {
    console.log('handleVideoCensorship 오류:', e);
    return { ok: false, response: new Response(JSON.stringify({
        success: false, error: `동영상 검열 중 오류 발생: ${e.message}`
      }), { status: 500, headers: { 'Content-Type': 'application/json' } }) };
  }
}

// Gemini API 호출 함수
async function callGeminiAPI(apiKey, requestBody) {
  let retryCount = 0;
  const maxRetries = 3, retryDelay = 2000;
  while (retryCount < maxRetries) {
    try {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`;
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      if (!response.ok) {
        if (response.status === 429 && retryCount < maxRetries - 1) {
          retryCount++;
          console.log(`할당량 초과, 재시도 ${retryCount}/${maxRetries}`);
          await new Promise(r => setTimeout(r, retryDelay));
          continue;
        }
        console.log('Gemini API 호출 실패:', {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries([...response.headers])
        });
        const errText = await response.text();
        return { success: false, error: `API 오류 (${response.status}): ${response.statusText}` };
      }
      const data = await response.json();
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) {
        // 안전한 디버깅 정보만 로그
        console.log('Gemini API 응답 상태:', {
          hasCandidates: !!data.candidates,
          candidatesLength: data.candidates?.length || 0,
          hasContent: !!data.candidates?.[0]?.content,
          hasParts: !!data.candidates?.[0]?.content?.parts,
          partsLength: data.candidates?.[0]?.content?.parts?.length || 0,
          hasText: !!data.candidates?.[0]?.content?.parts?.[0]?.text,
          responseKeys: Object.keys(data || {})
        });
        return { success: false, error: 'Gemini API에서 유효한 응답을 받지 못했습니다. API 키 또는 요청 형식을 확인해주세요.' };
      }
      return { success: true, text: content };
    } catch (e) {
      retryCount++;
      console.log(`API 호출 오류, 재시도 ${retryCount}/${maxRetries}:`, e);
      if (retryCount < maxRetries) {
        await new Promise(r => setTimeout(r, retryDelay));
      } else {
        return { success: false, error: `API 호출 오류: ${e.message}` };
      }
    }
  }
  return { success: false, error: '최대 재시도 횟수 초과' };
}

// =======================
// 부적절한 내용 분석 함수 (교체 버전)
// =======================
function isInappropriateContent(responseText) {
  // 카테고리 인덱스 → 사용자 표시용 이름 매핑
  const categoryMap = {
    1: '선정적 콘텐츠',
    2: '폭력/무기 콘텐츠',
    3: '약물/알코올 관련 콘텐츠',
    4: '욕설/혐오 표현',
    5: '기타 유해 콘텐츠'
  };

  // 결과 저장소
  const flagged = [];

  // 응답을 줄별로 순회하며 다양한 패턴 파싱
  responseText.split(/\r?\n/).forEach(line => {
    // 패턴 1: "숫자. true/false" 형태
    let m = line.match(/^\s*([1-5])\.\s*(true|false)\b/i);
    if (!m) {
      // 패턴 2: "숫자: true/false" 형태
      m = line.match(/^\s*([1-5]):\s*(true|false)\b/i);
    }
    if (!m) {
      // 패턴 3: "숫자 - true/false" 형태
      m = line.match(/^\s*([1-5])\s*[-–]\s*(true|false)\b/i);
    }
    if (!m) {
      // 패턴 4: 단순히 "true" 또는 "false"만 있는 경우 (순서대로 1-5 매핑)
      const trueMatch = line.match(/^\s*(true|false)\b/i);
      if (trueMatch) {
        const lineIndex = responseText.split(/\r?\n/).indexOf(line);
        if (lineIndex >= 0 && lineIndex < 5) {
          m = [null, (lineIndex + 1).toString(), trueMatch[1]];
        }
      }
    }
    
    if (m) {
      const idx = Number(m[1]);
      const val = m[2].toLowerCase() === 'true';
      if (val && categoryMap[idx]) {
        flagged.push(categoryMap[idx]);
      }
    }
  });

  return {
    isInappropriate: flagged.length > 0,
    reasons: flagged
  };
}

// MP4 재생길이 간단 추출 함수
async function getMP4Duration(file) {
  try {
    const buffer = await file.arrayBuffer(), dv = new DataView(buffer), u = new Uint8Array(buffer);
    for (let i=0; i<u.length-4; i++) {
      if (u[i]===109 && u[i+1]===118 && u[i+2]===104 && u[i+3]===100) {
        const vs = dv.getUint8(i-4+8);
        const ts = vs===0 ? dv.getUint32(i-4+20) : dv.getUint32(i-4+28);
        const du = vs===0 ? dv.getUint32(i-4+24) : (dv.getUint32(i-4+32)*2**32 + dv.getUint32(i-4+36));
        return du/ts;
      }
    }
    return null;
  } catch (e) {
    console.log("getMP4Duration error:", e);
    return null;
  }
}

// 고유 8자 코드 생성
async function generateUniqueCode(env, length=8) {
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let t=0; t<10; t++) {
    let code=''; for (let i=0;i<length;i++) code+=chars.charAt(Math.floor(Math.random()*chars.length));
    if (!(await env.IMAGES.get(code))) return code;
  }
  throw new Error("코드 생성 실패");
}

// ArrayBuffer -> base64
function arrayBufferToBase64(buffer) {
  let bin='', bytes=new Uint8Array(buffer);
  for (let b of bytes) bin+=String.fromCharCode(b);
  return btoa(bin);
}

// 최종 HTML 렌더
function renderHTML(mediaTags, host) {
  return `<!DOCTYPE html>
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
        /* color: white; */
        /* border: none; */
        /* border-radius: 20px; */
        /* padding: 10px 20px; */
        /* margin: 20px 0; */
        /* width: 600px; */
        height: 61px;
        /* box-shadow: 0 4px 6px rgba(0, 0, 0, 0.2); */
        cursor: pointer;
        transition: background-color 0.3s ease, transform 0.1s ease, box-shadow 0.3s ease;
        font-weight: bold;
        font-size: 18px;
        text-align: center;
    }
  
    button:hover {
        /* background-color: #005BDD; */
        /* transform: translateY(2px); */
        /* box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2); */
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
    
    #imageContainer img {
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
  
    #imageContainer img.landscape {
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
    .player-container video {
        width: 40vw;
        height: auto;
        }
    /* Custom Context Menu Styles */
    .custom-context-menu {
      position: absolute;
      background: white;
      border: 1px solid #ccc;
      padding: 5px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.2);
      z-index: 1000;
      border-radius: 10px;
    }
    .custom-context-menu button {
        display: block;
        width: 100%;
        border: none;
        background: none;
        /* padding: 5px 10px; */
        text-align: left;
        cursor: pointer;
    }
    .custom-context-menu button:hover {
      background: #eee;
    }
  </style>
  <link rel="stylesheet" href="https://llaa33219.github.io/BLOUplayer/videoPlayer.css">
  <script src="https://llaa33219.github.io/BLOUplayer/videoPlayer.js"></script>
</head>
<body>
  <div class="header-content">
    <img src="https://i.imgur.com/2MkyDCh.png" alt="Logo" style="width: 120px; height: auto; cursor: pointer;" onclick="location.href='/';">
      <h1 class="title-img-desktop">이미지 공유</h1>
      <h1 class="title-img-mobile">이미지<br>공유</h1>
  </div>
  <div id="imageContainer">
    ${mediaTags}
  </div>
  <div class="custom-context-menu" id="customContextMenu" style="display: none;">
      <button id="copyImage">이미지 복사</button>
      <button id="copyImageurl">이미지 링크 복사</button>
      <button id="downloadImage">다운로드</button>
      <button id="downloadImagepng">png로 다운로드</button>
  </div>
  <script>
    function toggleZoom(elem) {
      if (!elem.classList.contains('landscape') && !elem.classList.contains('portrait')) {
        let width=0, height=0;
        if (elem.tagName.toLowerCase()==='img') {
          width=elem.naturalWidth; height=elem.naturalHeight;
        } else if (elem.tagName.toLowerCase()==='video') {
          width=elem.videoWidth; height=elem.videoHeight;
        }
        if(width && height){
          if(width>=height) elem.classList.add('landscape');
          else elem.classList.add('portrait');
        }
      }
      elem.classList.toggle('expanded');
    }
    document.getElementById('toggleButton')?.addEventListener('click',function(){
      window.location.href='/';
    });
    
    // Custom Context Menu Functionality
    let currentImage = null;
    const contextMenu = document.getElementById('customContextMenu');

    document.getElementById('imageContainer').addEventListener('contextmenu', function(e) {
        if(e.target.tagName.toLowerCase() === 'img'){
            e.preventDefault();
            currentImage = e.target;
            contextMenu.style.top = e.pageY + 'px';
            contextMenu.style.left = e.pageX + 'px';
            contextMenu.style.display = 'block';
        }
    });

    // Hide context menu on document click
    document.addEventListener('click', function(e) {
        if(contextMenu.style.display === 'block'){
            contextMenu.style.display = 'none';
        }
    });

    // "이미지 복사" 버튼 클릭
    document.getElementById('copyImage').addEventListener('click', async function(){
        if(currentImage){
            try {
                const response = await fetch(currentImage.src);
                const blob = await response.blob();
                await navigator.clipboard.write([
                    new ClipboardItem({ [blob.type]: blob })
                ]);
                alert('이미지 복사됨');
            } catch(err) {
                alert('이미지 복사 실패: ' + err.message);
            }
        }
    });

    // "이미지 링크 복사" 버튼 클릭
    document.getElementById('copyImageurl').addEventListener('click', async function(){
        if(currentImage){
            try {
                await navigator.clipboard.writeText(currentImage.src);
                alert('이미지 링크 복사됨');
            } catch(err) {
                alert('이미지 링크 복사 실패: ' + err.message);
            }
        }
    });

    // "다운로드" 버튼 클릭 (원본 이미지 다운로드)
    document.getElementById('downloadImage').addEventListener('click', function(){
        if(currentImage){
            const a = document.createElement('a');
            a.href = currentImage.src;
            a.download = 'image';
            document.body.appendChild(a);
            a.click();
            a.remove();
        }
    });

    // "png로 다운로드" 버튼 클릭 (이미지를 png로 변환하여 다운로드)
    document.getElementById('downloadImagepng').addEventListener('click', function(){
        if(currentImage){
            const canvas = document.createElement('canvas');
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = function(){
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                canvas.toBlob(function(blob){
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = 'image.png';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                }, 'image/png');
            };
            img.src = currentImage.src;
        }
    });
  </script>
</body>
</html>`;
}

// API 문서 HTML 렌더링
function renderApiDocs(host) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="https://i.imgur.com/2MkyDCh.png" type="image/png">
  <title>이미지 공유 API 문서</title>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      color: #333;
    }
    h1, h2, h3 {
      color: #0066cc;
    }
    .endpoint {
      background-color: #f5f5f5;
      border-left: 4px solid #0066cc;
      padding: 10px;
      margin: 20px 0;
    }
    code {
      background-color: #f0f0f0;
      padding: 2px 5px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
    }
    pre {
      background-color: #f0f0f0;
      padding: 15px;
      border-radius: 5px;
      overflow-x: auto;
      font-family: 'Courier New', monospace;
    }
    .method {
      font-weight: bold;
      color: #ffffff;
      border-radius: 3px;
      padding: 2px 5px;
      margin-right: 5px;
    }
    .get {
      background-color: #61affe;
    }
    .post {
      background-color: #49cc90;
    }
    .delete {
      background-color: #f93e3e;
    }
    .put {
      background-color: #fca130;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 10px;
      text-align: left;
    }
    th {
      background-color: #f0f0f0;
    }
    .example {
      margin-top: 20px;
    }
    .header {
      display: flex;
      align-items: center;
      margin-bottom: 20px;
    }
    .header img {
      width: 60px;
      height: auto;
      margin-right: 15px;
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <img src="https://i.imgur.com/2MkyDCh.png" alt="Logo">
    <h1>이미지 공유 API 문서</h1>
  </div>
  
  <p>이 API는 외부 애플리케이션에서 이미지 및 동영상을 업로드하고 공유할 수 있는 기능을 제공합니다. 모든 콘텐츠는 업로드 전 자동 검열됩니다.</p>
  
  <h2>엔드포인트</h2>
  
  <div class="endpoint">
    <h3><span class="method post">POST</span> /api/upload</h3>
    <p>이미지 또는 동영상 파일을 업로드합니다. 모든 파일은 자동으로 부적절한 콘텐츠 검열을 거칩니다.</p>
    
    <h4>요청 형식</h4>
    <p>요청은 <code>multipart/form-data</code> 형식이어야 합니다.</p>
    
    <table>
      <tr>
        <th>파라미터</th>
        <th>타입</th>
        <th>필수</th>
        <th>설명</th>
      </tr>
      <tr>
        <td>file</td>
        <td>File</td>
        <td>예</td>
        <td>업로드할 이미지 또는 동영상 파일. 여러 파일 업로드 가능.</td>
      </tr>
      <tr>
        <td>customName</td>
        <td>String</td>
        <td>아니오</td>
        <td>사용자 지정 파일 이름 (단일 파일 업로드 시에만 유효).</td>
      </tr>
    </table>
    
    <h4>지원 파일 형식</h4>
    <ul>
      <li>이미지: JPEG, PNG, GIF, WEBP</li>
      <li>동영상: MP4, WEBM, OGG, AVI</li>
    </ul>
    
    <h4>응답</h4>
    <p>성공 시 응답 (200 OK):</p>
    <pre>{
  "success": true,
  "url": "https://${host}/ABC123",
  "rawUrls": ["https://${host}/ABC123?raw=1"],
  "codes": ["ABC123"],
  "fileTypes": ["image/jpeg"]
}</pre>
    
    <p>파일 형식 오류 (400 Bad Request):</p>
    <pre>{
  "success": false,
  "error": "지원하지 않는 파일 형식입니다."
}</pre>
    
    <p>검열 실패 (400 Bad Request):</p>
    <pre>{
  "success": false,
  "error": "검열됨: 선정적 콘텐츠, 폭력/무기 콘텐츠"
}</pre>
    
    <p>서버 오류 (500 Internal Server Error):</p>
    <pre>{
  "success": false,
  "error": "검열 처리 중 오류: [오류 메시지]"
}</pre>
    
    <p>레이트 리미팅 (429 Too Many Requests):</p>
    <pre>{
  "success": false,
  "error": "보안상 업로드가 제한되었습니다. 1분 내 20개 초과 업로드로 인한 5분 차단. 300초 후 다시 시도하세요.",
  "rateLimited": true,
  "remainingTime": 300
}</pre>
  </div>
  
  <h2>레이트 리미팅</h2>
  <div class="endpoint">
    <h3>업로드 제한</h3>
    <p>보안을 위해 다음과 같은 레이트 리미팅이 적용됩니다:</p>
    <ul>
      <li><strong>1분 제한:</strong> 동일한 IP에서 1분 내 20개 이상 업로드 시 5분간 차단</li>
      <li><strong>1시간 제한:</strong> 동일한 IP에서 1시간 내 100개 이상 업로드 시 1시간 차단</li>
    </ul>
    <p>제한 초과 시 HTTP 429 상태 코드와 함께 차단 해제까지 남은 시간이 응답됩니다.</p>
  </div>
  
  <h2>코드 예제</h2>
  
  <div class="example">
    <h3>cURL</h3>
    <pre>curl -X POST https://${host}/api/upload \
  -F "file=@/path/to/image.jpg"</pre>
  </div>
  
  <div class="example">
    <h3>JavaScript (fetch)</h3>
    <pre>const formData = new FormData();
formData.append('file', fileInput.files[0]);

fetch('https://${host}/api/upload', {
  method: 'POST',
  body: formData
})
.then(response => response.json())
.then(data => {
  if (data.success) {
    console.log('업로드 성공:', data.url);
  } else {
    console.error('업로드 실패:', data.error);
  }
})
.catch(error => {
  console.error('요청 오류:', error);
});</pre>
  </div>
  
  <div class="example">
    <h3>Python (requests)</h3>
    <pre>import requests

url = 'https://${host}/api/upload'
files = {'file': open('image.jpg', 'rb')}

response = requests.post(url, files=files)
data = response.json()

if data['success']:
    print('업로드 성공:', data['url'])
else:
    print('업로드 실패:', data['error'])</pre>
  </div>
  
  <h2>노트</h2>
  <ul>
    <li>모든 업로드된 파일은 자동 검열 시스템을 통과해야 합니다.</li>
    <li>대용량 파일 업로드 시 서버 처리 시간이 길어질 수 있습니다.</li>
    <li>기본적으로 랜덤 코드가 생성되지만, <code>customName</code> 파라미터를 통해 사용자 지정 이름을 부여할 수 있습니다.</li>
    <li>동일한 사용자 지정 이름이 이미 존재하는 경우 업로드가 실패합니다.</li>
    <li>외부 도메인에서 API 요청 시 CORS 헤더가 자동으로 추가됩니다.</li>
  </ul>
</body>
</html>`;
}
