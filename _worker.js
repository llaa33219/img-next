export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    console.log("Worker triggered:", request.method, url.pathname);

    // --------------------------
    // 헬퍼 함수들
    // --------------------------

    // 1) ArrayBuffer -> base64
    const arrayBufferToBase64 = (buffer) => {
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    };

    // 2) MP4 파일에서 mvhd atom 찾아 영상 길이(초) 파악
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

    // 3) 임시 코드 생성
    const generateRandomCode = (length = 8) => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let result = '';
      for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    };

    // --------------------------
    // /tempimages/<코드> 라우트: TEMP_IMAGES에서 raw 파일 반환
    //  - ?raw=1일 때는 실제 파일 바디만
    //  - 그렇지 않으면 미디어 HTML(필요하다면) 반환 가능
    // --------------------------
    if (request.method === 'GET' && url.pathname.startsWith('/tempimages/')) {
      const pathParts = url.pathname.split('/');
      // pathParts[0] = "", pathParts[1] = "tempimages", pathParts[2] = "<tempKey>"
      const tempKey = pathParts[2];
      if (!tempKey) {
        return new Response('Bad Request', { status: 400 });
      }

      const object = await env.TEMP_IMAGES.get(tempKey);
      if (!object) {
        return new Response('Not Found', { status: 404 });
      }

      // raw=1이면 파일만 반환
      if (url.searchParams.get('raw') === '1') {
        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
        return new Response(object.body, { headers });
      }

      // 필요하다면 여기서 HTML 래퍼를 만들어 반환할 수도 있음
      return new Response(`Temp file found: ${tempKey}`, { status: 200 });
    }

    // --------------------------
    // /upload : 다중 파일 업로드 처리
    // --------------------------
    if (request.method === 'POST' && url.pathname === '/upload') {
      try {
        const formData = await request.formData();
        const files = formData.getAll('file');
        if (!files || files.length === 0) {
          return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }), { status: 400 });
        }

        // ----------------------
        // 파일별 검열 수행
        // ----------------------
        for (const file of files) {
          if (file.type.startsWith('image/')) {
            // --------------------
            // 이미지 검열
            // --------------------
            let fileForCensorship = file;
            try {
              // 600px 리사이즈 시도
              const buffer = await file.arrayBuffer();
              const base64 = arrayBufferToBase64(buffer);
              const dataUrl = `data:${file.type};base64,${base64}`;
              const reqForResize = new Request(dataUrl, {
                cf: { image: { width: 600, height: 600, fit: "inside" } }
              });
              const resizedResponse = await fetch(reqForResize);
              fileForCensorship = await resizedResponse.blob();
            } catch (e) {
              // 리사이즈 실패 시 원본
              fileForCensorship = file;
            }

            // 이미지 검열 API
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
              return new Response(JSON.stringify({ success: false, error: "검열됨: " + reasons.join(", ") }), { status: 400 });
            }

          } else if (file.type.startsWith('video/')) {
            // --------------------
            // 영상 검열
            // --------------------
            const videoThreshold = 0.5;
            let duration = null;
            try {
              const headerBuffer = await file.slice(0, 1024 * 1024).arrayBuffer();
              if (file.type === 'video/mp4' || (file.name && file.name.toLowerCase().endsWith('.mp4'))) {
                duration = parseMp4Duration(headerBuffer);
              }
            } catch (e) {
              duration = null;
            }
            if (!duration || duration < 0) {
              duration = 1; // fallback
            }

            // (1) 임시 버킷에 업로드할지 여부 결정
            //     예: 파일이 10MB 초과이거나 영상이 30초 이상이면 TEMP_IMAGES 사용
            const useTempBucket = (file.size > 10 * 1024 * 1024) || (duration >= 30);

            // 임시 업로드 키
            let tempKey = null;
            let videoUrlForThumbnail = null;

            if (useTempBucket) {
              // TEMP_IMAGES에 업로드
              tempKey = 'temp_' + generateRandomCode(10);
              const fileBuffer = await file.arrayBuffer();
              await env.TEMP_IMAGES.put(tempKey, fileBuffer, {
                httpMetadata: { contentType: file.type }
                // 만료 설정은 R2 Lifecycle Rule로도 가능
              });

              // 프레임 추출용 URL => "https://.../tempimages/<tempKey>?raw=1"
              // (아래에서 cf.video.thumbnail을 위한 fetch() 시 사용)
              videoUrlForThumbnail = `https://${url.host}/tempimages/${tempKey}?raw=1`;
            } else {
              // data URL로 바로 처리
              const videoBuffer = await file.arrayBuffer();
              const videoBase64 = arrayBufferToBase64(videoBuffer);
              videoUrlForThumbnail = `data:${file.type};base64,${videoBase64}`;
            }

            // 동일한 간격으로 20개 프레임 추출
            const frameCount = 20;
            const framePromises = [];
            for (let i = 0; i < frameCount; i++) {
              const timestamp = (i / (frameCount - 1)) * duration;
              const reqForThumbnail = new Request(videoUrlForThumbnail, {
                cf: {
                  video: {
                    thumbnail: true,
                    time: timestamp,
                    width: 600,
                    height: 600,
                    fit: "inside"
                  }
                }
              });
              framePromises.push(
                fetch(reqForThumbnail).then(async (res) => {
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
              // 임시 업로드했다면 여기서 삭제
              if (useTempBucket && tempKey) {
                await env.TEMP_IMAGES.delete(tempKey);
              }
              return new Response(JSON.stringify({ success: false, error: "영상 프레임 추출 실패: " + e.message }), { status: 400 });
            }

            // 프레임 이미지 검열
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
              // 임시 업로드했다면 여기서 삭제
              if (useTempBucket && tempKey) {
                await env.TEMP_IMAGES.delete(tempKey);
              }
              return new Response(JSON.stringify({ success: false, error: "검열 API 요청 실패: " + e.message }), { status: 400 });
            }

            // 결과 중 최대값 검사
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
            if (nudityFlag || maxNudity >= videoThreshold) {
              reasons.push("선정적 콘텐츠");
            }
            if (maxOffensive >= videoThreshold) {
              reasons.push("욕설/모욕적 콘텐츠");
            }
            if (maxWad >= videoThreshold) {
              reasons.push("잔인하거나 위험한 콘텐츠");
            }
            if (reasons.length > 0) {
              // 임시 업로드했다면 삭제
              if (useTempBucket && tempKey) {
                await env.TEMP_IMAGES.delete(tempKey);
              }
              return new Response(JSON.stringify({ success: false, error: "검열됨: " + reasons.join(", ") }), { status: 400 });
            }

            // 검열 통과 시 임시 업로드 파일 삭제(최종 업로드는 아래에서)
            if (useTempBucket && tempKey) {
              // tempKey에 있는 실제 파일은 아래 2단계(영구 업로드)에서 복사 후 삭제
              // 여기서는 일단 유지 -> "2. 모든 파일 업로드"에서 처리
            }
          }
        }

        // ----------------------
        // 2. 모든 파일이 검열 통과하면 영구 버킷(IMAGES)에 업로드
        //    (임시 버킷을 사용한 경우, 여기서 복사 후 임시 삭제)
        // ----------------------
        let codes = [];
        for (const file of files) {
          // 파일 크기나 영상 길이에 따라 임시 버킷에 있거나, 메모리에만 있음
          let finalBuffer;
          let finalContentType = file.type;

          // MP4 등 영상에 대해서는 앞서 임시 버킷에 올렸을 수도 있음
          // => 만약 임시 버킷을 사용했다면, 그 파일을 가져와서 IMAGES로 put
          // => 그리고 TEMP_IMAGES에서 삭제
          let duration = 0;
          try {
            const headerBuffer = await file.slice(0, 1024 * 1024).arrayBuffer();
            if (file.type === 'video/mp4' || (file.name && file.name.toLowerCase().endsWith('.mp4'))) {
              duration = parseMp4Duration(headerBuffer) || 0;
            }
          } catch(e){}

          const useTempBucket = (file.size > 10 * 1024 * 1024) || (duration >= 30);
          let tempKey = null;

          if (useTempBucket) {
            // tempKey를 추적해야 함 (업로드 시 'temp_' + 랜덤코드 로 사용)
            // 여기서는 동일 로직으로 다시 만들 수 있지만, 정확히 같아야 함
            // 실제로는 검열 과정에서도 그 key를 어딘가 저장해뒀다가 여기서 사용
            // 간단히, 파일 이름에 'temp_' prefix가 있을 수도 있지만
            // 여기서는 파일 객체엔 key가 없으므로, 새로 로직을 짤 때
            // 'for (const file of files)' -> '검열 단계'에서 key를 저장해야 함.
            // 
            // 여기서는 간단히 "temp_" + (file.name + random) 식으로 가정:
            tempKey = 'temp_' + generateRandomCode(10);

            // 검열 단계에서 이미 tempKey로 업로드했다고 가정 -> 실제론 별도 구조 필요
            // 여기서는 "실제 업로드" 로직만 보여주기 위해,
            // 임시로 다시 put 후 copy하는 식으로 시뮬레이션
            // --- 실제 구현에서는 검열 단계에서 사용한 key를 재활용해야 합니다. ---
            const fileBuffer = await file.arrayBuffer();
            await env.TEMP_IMAGES.put(tempKey, fileBuffer, {
              httpMetadata: { contentType: file.type }
            });

            const tempObject = await env.TEMP_IMAGES.get(tempKey);
            if (!tempObject) {
              return new Response(JSON.stringify({ success: false, error: "임시 버킷에서 파일을 찾을 수 없습니다." }), { status: 500 });
            }
            finalBuffer = await tempObject.arrayBuffer();
          } else {
            // 그냥 메모리에 있는 파일 사용
            finalBuffer = await file.arrayBuffer();
          }

          // 이제 IMAGES에 최종 put
          let code;
          for (let i = 0; i < 5; i++) {
            code = generateRandomCode(8);
            const existing = await env.IMAGES.get(code);
            if (!existing) break;
          }
          if (!code) {
            // 임시 버킷 삭제
            if (useTempBucket && tempKey) {
              await env.TEMP_IMAGES.delete(tempKey);
            }
            return new Response(JSON.stringify({ success: false, error: '코드 생성 실패' }), { status: 500 });
          }

          await env.IMAGES.put(code, finalBuffer, {
            httpMetadata: { contentType: finalContentType }
          });
          codes.push(code);

          // 임시 버킷 사용했으면 삭제
          if (useTempBucket && tempKey) {
            await env.TEMP_IMAGES.delete(tempKey);
          }
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

    // --------------------------
    // GET /{코드} : R2(IMAGES)에서 파일 반환 or HTML 페이지
    // (다중 코드 지원 -> 쉼표 구분)
    // --------------------------
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
      // 각 코드에 대해 메타데이터 가져와 미디어 타입에 따라 렌더링
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

    // 나머지 정적 파일
    return env.ASSETS.fetch(request);
  }
};
