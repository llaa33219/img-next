export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      console.log("Worker triggered:", request.method, url.pathname);
  
      // 헬퍼 함수: ArrayBuffer -> Base64
      const arrayBufferToBase64 = (buffer) => {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
      };
  
      // MP4 파일에서 mvhd atom을 파싱해 영상 길이(초) 추정
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
  
      // Cloudflare Stream의 영상 처리 완료 대기
      const waitForStreamProcessing = async (videoId) => {
        const maxAttempts = 5;
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const assetResponse = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_STREAM_ACCOUNT_ID}/stream/${videoId}`, 
            {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`
              }
            }
          );
          const assetData = await assetResponse.json();
          if (assetData.result && assetData.result.status === "ready") {
            return;
          }
          await delay(2000);
        }
        throw new Error("Cloudflare Stream video processing timeout");
      };
  
      // 업로드 처리 (POST /upload)
      if (request.method === 'POST' && url.pathname === '/upload') {
        try {
          const formData = await request.formData();
          const files = formData.getAll('file');
          if (!files || files.length === 0) {
            return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }), { status: 400 });
          }
  
          // 1. 검열
          for (const file of files) {
            if (file.type.startsWith('image/')) {
              // 이미지 검열
              let fileForCensorship = file;
              try {
                // 600px 리사이징
                const buffer = await file.arrayBuffer();
                const base64 = arrayBufferToBase64(buffer);
                const dataUrl = `data:${file.type};base64,${base64}`;
                const reqForResize = new Request(dataUrl, {
                  cf: { image: { width: 600, height: 600, fit: "inside" } }
                });
                const resizedResponse = await fetch(reqForResize);
                fileForCensorship = await resizedResponse.blob();
              } catch (e) {
                fileForCensorship = file;
              }
  
              // Sightengine 검열
              const sightForm = new FormData();
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
                return new Response(JSON.stringify({ success: false, error: `검열됨: ${reasons.join(', ')}` }), { status: 400 });
              }
  
            } else if (file.type.startsWith('video/')) {
              // 영상 검열: 프레임 추출용 Cloudflare Stream direct_upload
              let duration = null;
              try {
                const headerBuffer = await file.slice(0, 1024 * 1024).arrayBuffer();
                if (file.type === 'video/mp4' || (file.name && file.name.toLowerCase().endsWith('.mp4'))) {
                  duration = parseMp4Duration(headerBuffer);
                }
              } catch (e) {
                duration = null;
              }
              if (!duration || duration <= 0) duration = 1;
              const effectiveDuration = Math.min(duration, 30);
  
              // 1) direct_upload 초기화 (maxDurationSeconds 필수)
              const directUploadInitResponse = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_STREAM_ACCOUNT_ID}/stream/direct_upload`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
                    'Accept': 'application/json'
                  },
                  body: JSON.stringify({
                    meta: { name: file.name },
                    maxDurationSeconds: 10800, // 3시간 예시 (1~21600 범위)
                    thumbnailTimestampPct: 0
                  })
                }
              );
              const initText = await directUploadInitResponse.text();
              let initResult;
              try {
                initResult = JSON.parse(initText.trim());
              } catch (e) {
                throw new Error(`Cloudflare Stream direct_upload init 실패: JSON 파싱 오류: ${e.message} - 응답: ${initText}`);
              }
              if (!directUploadInitResponse.ok || !initResult.result || !initResult.result.uploadURL || !initResult.result.uid) {
                throw new Error(`Cloudflare Stream direct_upload init 실패: ${initText}`);
              }
              const { uploadURL, uid: videoId } = initResult.result;
  
              // 2) PUT 업로드 (Content-Type 헤더 없이)
              const fileUploadResponse = await fetch(uploadURL, {
                method: 'PUT',
                body: file
              });
              if (!fileUploadResponse.ok) {
                throw new Error(`Cloudflare Stream 파일 업로드 실패: ${fileUploadResponse.status}`);
              }
  
              // 3) 영상 처리 완료 대기
              await waitForStreamProcessing(videoId);
  
              // 4) 썸네일 프레임 추출
              const frameCount = 10;
              const framePromises = [];
              for (let i = 0; i < frameCount; i++) {
                const timestamp = (i / (frameCount - 1)) * effectiveDuration;
                const thumbnailUrl = `https://videodelivery.net/${videoId}/thumbnails/thumbnail.jpg?time=${timestamp}&width=600&height=600&fit=inside`;
                framePromises.push(
                  fetch(thumbnailUrl).then(async res => {
                    if (!res.ok) {
                      const text = await res.text();
                      throw new Error(`프레임 추출 실패(${res.status}): ${text}`);
                    }
                    return res.blob();
                  })
                );
              }
              let frameBlobs;
              try {
                frameBlobs = await Promise.all(framePromises);
              } catch (e) {
                return new Response(JSON.stringify({ success: false, error: `프레임 추출 실패: ${e.message}` }), { status: 400 });
              }
  
              // 5) Sightengine 검열
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
                return new Response(JSON.stringify({ success: false, error: `검열 API 요청 실패: ${e.message}` }), { status: 400 });
              }
  
              // 6) 검열 결과 취합
              let maxNudity = 0;
              let nudityFlag = false;
              let maxOffensive = 0;
              let maxWad = 0;
              for (const result of frameResults) {
                if (result.nudity) {
                  const { is_nude, ...nudityData } = result.nudity;
                  if (is_nude === true) nudityFlag = true;
                  for (const key in nudityData) {
                    if (["suggestive_classes", "context", "none"].includes(key)) continue;
                    const val = Number(nudityData[key]);
                    if (val > maxNudity) maxNudity = val;
                  }
                }
                if (result.offensive?.prob > maxOffensive) {
                  maxOffensive = result.offensive.prob;
                }
                if (result.wad) {
                  for (const key in result.wad) {
                    const val = Number(result.wad[key]);
                    if (val > maxWad) maxWad = val;
                  }
                }
              }
  
              let reasons = [];
              if (nudityFlag || maxNudity >= 0.5) reasons.push("선정적 콘텐츠");
              if (maxOffensive >= 0.5) reasons.push("욕설/모욕적 콘텐츠");
              if (maxWad >= 0.5) reasons.push("잔인하거나 위험한 콘텐츠");
              if (reasons.length > 0) {
                return new Response(JSON.stringify({ success: false, error: `검열됨: ${reasons.join(', ')}` }), { status: 400 });
              }
            }
          }
  
          // 2. 검열 통과 시 R2에 원본 파일 저장 (이미지/영상 모두)
          let codes = [];
          const generateRandomCode = (length = 8) => {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            let result = '';
            for (let i = 0; i < length; i++) {
              result += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return result;
          };
  
          for (const file of files) {
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
      // GET /{코드}
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
        const objects = await Promise.all(codes.map(async code => {
          const object = await env.IMAGES.get(code);
          return { code, object };
        }));
        let mediaTags = "";
        for (const { code, object } of objects) {
          if (object && object.httpMetadata) {
            const ct = object.httpMetadata.contentType || "";
            if (ct.startsWith('video/')) {
              mediaTags += `<video src="https://${url.host}/${code}?raw=1" controls onclick="toggleZoom(this)"></video>\n`;
            } else {
              mediaTags += `<img src="https://${url.host}/${code}?raw=1" alt="Uploaded Media" onclick="toggleZoom(this)">\n`;
            }
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
      #imageContainer img.landscape,
      #imageContainer video.landscape {
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
    </style>
    <link rel="stylesheet" href="https://llaa33219.github.io/BLOUplayer/videoPlayer.css">
    <script src="https://llaa33219.github.io/BLOUplayer/videoPlayer.js"></script>
  </head>
  <body>
    <div class="header-content">
      <img src="https://i.imgur.com/2MkyDCh.png" alt="Logo" style="width: 120px; height: auto; cursor: pointer;" onclick="location.href='/'">
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
    
      // 정적 파일
      return env.ASSETS.fetch(request);
    }
};
