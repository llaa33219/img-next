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
  
      // 헬퍼 함수: Cloudflare Stream의 영상 처리가 완료될 때까지 polling
      const waitForStreamProcessing = async (videoId) => {
        const maxAttempts = 5;
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const assetResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_STREAM_ACCOUNT_ID}/stream/${videoId}`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`
            }
          });
          const assetData = await assetResponse.json();
          if (assetData.result && assetData.result.status === "ready") {
            return;
          }
          await delay(2000);
        }
        throw new Error("Cloudflare Stream video processing timeout");
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
              // 영상 검열: Cloudflare Stream을 사용하여 프레임 추출 후,
              // 각 프레임의 결과 중 최대값을 검사합니다.
              // -------------------------------------------
              let duration = null;
              try {
                const headerBuffer = await file.slice(0, 1024 * 1024).arrayBuffer();
                if (file.type === 'video/mp4' || (file.name && file.name.toLowerCase().endsWith('.mp4'))) {
                  duration = parseMp4Duration(headerBuffer);
                }
              } catch (e) {
                duration = null;
              }
              if (duration === null || duration <= 0) {
                duration = 1; // fallback 값
              }
              const effectiveDuration = Math.min(duration, 30);
  
              // Cloudflare Stream 업로드 (고객 하위 도메인 사용 및 경로 변경, Accept 헤더 추가)
              const streamUploadResponse = await fetch(`https://customer-8z0vdylu97ytcbll.cloudflarestream.com/direct_upload?direct_upload=true`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
                  'Content-Type': file.type,
                  'Accept': 'application/json'
                },
                body: file
              });
              const streamUploadResult = await streamUploadResponse.json();
              if (!streamUploadResponse.ok || !streamUploadResult.result || !streamUploadResult.result.uid) {
                throw new Error("Cloudflare Stream 업로드 실패");
              }
              const videoId = streamUploadResult.result.uid;
  
              // Cloudflare Stream의 영상 처리 완료 대기
              await waitForStreamProcessing(videoId);
  
              const frameCount = 10;
              const framePromises = [];
              for (let i = 0; i < frameCount; i++) {
                const timestamp = (i / (frameCount - 1)) * effectiveDuration;
                const thumbnailUrl = `https://videodelivery.net/${videoId}/thumbnails/thumbnail.jpg?time=${timestamp}&width=600&height=600&fit=inside`;
                framePromises.push(
                  fetch(thumbnailUrl).then(async res => {
                    if (!res.ok) {
                      const text = await res.text();
                      throw new Error(`프레임 추출 실패: ${res.status} ${res.statusText}: ${text}`);
                    }
                    return res.blob();
                  })
                );
              }
  
              let frameBlobs;
              try {
                frameBlobs = await Promise.all(framePromises);
              } catch (e) {
                return new Response(JSON.stringify({ success: false, error: "영상 프레임 추출 실패: " + e.message }), { status: 400 });
              }
  
              // 추출된 각 프레임에 대해 이미지 검열 API 병렬 호출
              const censorshipPromises = frameBlobs.map(frameBlob => {
                const sightForm = new FormData();
                sightForm.append('media', frameBlob.slice(0, frameBlob.size, frameBlob.type), 'upload');
                sightForm.append('models', 'nudity,wad,offensive');
                sightForm.append('api_user', env.SIGHTENGINE_API_USER);
                sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);
                return fetch('https://api.sightengine.com/1.0/check.json', {
                  method: 'POST',
                  body: sightForm
                }).then(async res => {
                  const contentType = res.headers.get('content-type') || '';
                  if (contentType.includes('application/json')) {
                    return res.json();
                  } else {
                    const text = await res.text();
                    throw new Error(`검열 API 응답이 JSON이 아님: ${text}`);
                  }
                });
              });
  
              let frameResults;
              try {
                frameResults = await Promise.all(censorshipPromises);
              } catch (e) {
                return new Response(JSON.stringify({ success: false, error: "검열 API 요청 실패: " + e.message }), { status: 400 });
              }
  
              // 10개 프레임 결과 중 각 카테고리(선정성, 욕설, 위험)의 최대값을 계산
              let maxNudity = 0;
              let nudityFlag = false;
              let maxOffensive = 0;
              let maxWad = 0;
              for (const result of frameResults) {
                if (result.nudity) {
                  const nudityData = result.nudity;
                  if (nudityData.is_nude === true) {
                    nudityFlag = true;
                  }
                  for (const key in nudityData) {
                    if (["suggestive_classes", "context", "none", "is_nude"].includes(key)) continue;
                    const val = Number(nudityData[key]);
                    if (val > maxNudity) {
                      maxNudity = val;
                    }
                  }
                }
                if (result.offensive && result.offensive.prob !== undefined) {
                  const val = Number(result.offensive.prob);
                  if (val > maxOffensive) {
                    maxOffensive = val;
                  }
                }
                if (result.wad) {
                  for (const key in result.wad) {
                    const val = Number(result.wad[key]);
                    if (val > maxWad) {
                      maxWad = val;
                    }
                  }
                }
              }
  
              let reasons = [];
              if (nudityFlag || maxNudity >= 0.5) {
                reasons.push("선정적 콘텐츠");
              }
              if (maxOffensive >= 0.5) {
                reasons.push("욕설/모욕적 콘텐츠");
              }
              if (maxWad >= 0.5) {
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
