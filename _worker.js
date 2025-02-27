export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    console.log("Incoming Request:", {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers)
    });
    console.log("Worker triggered:", request.method, url.pathname);

    // 헬퍼 함수1: ArrayBuffer -> Base64
    const arrayBufferToBase64 = (buffer) => {
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    };

    // 헬퍼 함수2: MP4 파일에서 mvhd 박스를 찾아 duration(초)를 추출 (버전0,1 지원)
    async function getMP4Duration(file) {
      try {
        const buffer = await file.arrayBuffer();
        const dv = new DataView(buffer);
        const uint8 = new Uint8Array(buffer);
        // 'm','v','h','d' = 109,118,104,100
        for (let i = 0; i < uint8.length - 4; i++) {
          if (uint8[i] === 109 && uint8[i + 1] === 118 && uint8[i + 2] === 104 && uint8[i + 3] === 100) {
            const boxStart = i - 4; // mvhd 박스: size(4)+type(4)
            const version = dv.getUint8(boxStart + 8);
            if (version === 0) {
              // version 0
              const timescale = dv.getUint32(boxStart + 20);
              const duration = dv.getUint32(boxStart + 24);
              return duration / timescale;
            } else if (version === 1) {
              // version 1
              const timescale = dv.getUint32(boxStart + 28);
              const high = dv.getUint32(boxStart + 32);
              const low = dv.getUint32(boxStart + 36);
              const duration = high * Math.pow(2, 32) + low;
              return duration / timescale;
            }
          }
        }
        return null;
      } catch (e) {
        console.log("getMP4Duration error:", e);
        return null;
      }
    }

    // 헬퍼 함수3: frames/data에서 검열 사유를 찾는 함수
    function checkFramesForCensorship(frames, data, threshold) {
      let reasons = [];
      if (frames && frames.length > 0) {
        for (const frame of frames) {
          if (frame.nudity) {
            for (const key in frame.nudity) {
              if (["suggestive_classes", "context", "none"].includes(key)) continue;
              if (Number(frame.nudity[key]) >= threshold) {
                reasons.push("선정적 콘텐츠");
                break;
              }
            }
          }
          if (frame.offensive && frame.offensive.prob !== undefined && Number(frame.offensive.prob) >= threshold) {
            reasons.push("욕설/모욕적 콘텐츠");
          }
          if (frame.wad) {
            for (const key in frame.wad) {
              if (Number(frame.wad[key]) >= threshold) {
                reasons.push("잔인하거나 위험한 콘텐츠");
                break;
              }
            }
          }
          if (reasons.length > 0) break;
        }
      } else {
        // frames가 없으면 data 최상위
        if (data && data.nudity) {
          for (const key in data.nudity) {
            if (["suggestive_classes", "context", "none"].includes(key)) continue;
            if (Number(data.nudity[key]) >= threshold) {
              reasons.push("선정적 콘텐츠");
              break;
            }
          }
        }
        if (data && data.offensive && data.offensive.prob !== undefined && Number(data.offensive.prob) >= threshold) {
          reasons.push("욕설/모욕적 콘텐츠");
        }
        if (data && data.wad) {
          for (const key in data.wad) {
            if (Number(data.wad[key]) >= threshold) {
              reasons.push("잔인하거나 위험한 콘텐츠");
              break;
            }
          }
        }
      }
      return reasons;
    }

    // ---------------------------
    // POST /upload : 다중 파일 업로드 (검열 -> R2 저장)
    // ---------------------------
    if (request.method === 'POST' && url.pathname === '/upload') {
      try {
        const formData = await request.formData();
        const files = formData.getAll('file');
        if (!files || files.length === 0) {
          return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }), { status: 400 });
        }

        for (const file of files) {
          console.log(`Processing file: type=${file.type}, size=${file.size}`);

          // ---------------------------
          // 이미지 검열
          // ---------------------------
          if (file.type.startsWith('image/')) {
            console.log(">>> 이미지 검열 로직");
            let fileForCensorship = file;
            try {
              // 이미지 리사이징(600px) -> 검열 속도↑
              const buffer = await file.arrayBuffer();
              const base64 = arrayBufferToBase64(buffer);
              const dataUrl = `data:${file.type};base64,${base64}`;
              const reqForResize = new Request(dataUrl, {
                cf: { image: { width: 600, height: 600, fit: "inside" } }
              });
              const resizedResponse = await fetch(reqForResize);
              fileForCensorship = await resizedResponse.blob();
            } catch (e) {
              console.log("이미지 리사이즈 실패:", e);
              fileForCensorship = file;
            }

            const sightForm = new FormData();
            sightForm.append('media', fileForCensorship.slice(0, fileForCensorship.size, fileForCensorship.type), 'upload');
            sightForm.append('models', 'nudity,wad,offensive');
            sightForm.append('api_user', env.SIGHTENGINE_API_USER);
            sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);

            console.log("이미지 검열 API 호출");
            const sightResponse = await fetch('https://api.sightengine.com/1.0/check.json', {
              method: 'POST',
              body: sightForm
            });
            const sightResult = await sightResponse.json();
            console.log("이미지 검열 결과:", sightResult);

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
              console.log("이미지 검열 불량:", reasons);
              return new Response(JSON.stringify({ success: false, error: "검열됨: " + reasons.join(", ") }), { status: 400 });
            }

          // ---------------------------
          // 동영상 검열
          // ---------------------------
          } else if (file.type.startsWith('video/')) {
            console.log(">>> 동영상 검열 로직");
            // (1) 용량 체크
            if (file.size > 50 * 1024 * 1024) {
              console.log("영상 용량 초과");
              return new Response(JSON.stringify({ success: false, error: "영상 용량이 50MB를 초과합니다." }), { status: 400 });
            }

            // (2) 길이 체크
            let videoDuration = await getMP4Duration(file);
            if (!videoDuration) videoDuration = 0;
            console.log("동영상 길이(초)=", videoDuration);

            // 1분 미만 & duration>0
            if (videoDuration < 60 && videoDuration !== 0) {
              console.log("1분 미만 => video/check-sync.json");
              const videoThreshold = 0.5;
              const sightForm = new FormData();
              sightForm.append('media', file, 'upload');
              sightForm.append('models', 'nudity,wad,offensive');
              sightForm.append('api_user', env.SIGHTENGINE_API_USER);
              sightForm.append('api_secret', env.SIGHTENGINE_API_SECRET);

              const sightResponse = await fetch('https://api.sightengine.com/1.0/video/check-sync.json', {
                method: 'POST',
                body: sightForm
              });
              const sightResult = await sightResponse.json();
              console.log("1분 미만 영상 검열 결과:", sightResult);

              let frames = [];
              if (sightResult.data && sightResult.data.frames) {
                frames = Array.isArray(sightResult.data.frames) ? sightResult.data.frames : [sightResult.data.frames];
              } else if (sightResult.frames) {
                frames = Array.isArray(sightResult.frames) ? sightResult.frames : [sightResult.frames];
              }
              const found = checkFramesForCensorship(frames, sightResult.data, videoThreshold);
              if (found.length > 0) {
                console.log("1분 미만 동영상 불량:", found);
                return new Response(JSON.stringify({ success: false, error: "검열됨: " + found.join(", ") }), { status: 400 });
              }

            } else {
              // ---------------------------
              // 1분 이상 or duration=0 => async
              // ---------------------------
              console.log("1분 이상 => SightEngine 비동기 API 사용");
              // 1) upload.json -> media_id
              const fileBuffer = await file.arrayBuffer();
              const asyncForm = new FormData();
              asyncForm.append('media', new Blob([fileBuffer], { type: file.type }), 'upload');
              asyncForm.append('api_user', env.SIGHTENGINE_API_USER);
              asyncForm.append('api_secret', env.SIGHTENGINE_API_SECRET);

              const uploadResp = await fetch('https://api.sightengine.com/1.0/upload.json', {
                method: 'POST',
                body: asyncForm
              });
              const uploadResult = await uploadResp.json();
              console.log("upload.json result:", uploadResult);

              if (uploadResult.status === "failure") {
                return new Response(JSON.stringify({ success: false, error: "비디오 upload 실패: " + uploadResult.error }), { status: 400 });
              }
              if (!uploadResult.media) {
                return new Response(JSON.stringify({ success: false, error: "upload 후 media 정보 없음" }), { status: 400 });
              }
              const mediaId = uploadResult.media.id;
              console.log("media_id=", mediaId);

              // 2) video/moderation.json
              const modForm = new FormData();
              modForm.append('media_id', mediaId);
              modForm.append('models', 'nudity,wad,offensive');
              modForm.append('api_user', env.SIGHTENGINE_API_USER);
              modForm.append('api_secret', env.SIGHTENGINE_API_SECRET);

              const modResp = await fetch('https://api.sightengine.com/1.0/video/moderation.json', {
                method: 'POST',
                body: modForm
              });
              const modResult = await modResp.json();
              console.log("moderation.json =>", modResult);

              if (modResult.status === "failure") {
                return new Response(JSON.stringify({ success: false, error: "moderation 실패: " + modResult.error }), { status: 400 });
              }

              // 3) status.json 폴링
              let maxAttempts = 6; // 5초씩 6번 = 30초
              let finalAnalysis = null;
              while (maxAttempts > 0) {
                await new Promise(r => setTimeout(r, 5000)); // 5초 대기
                const statusUrl = `https://api.sightengine.com/1.0/video/status.json?media_id=${mediaId}&api_user=${env.SIGHTENGINE_API_USER}&api_secret=${env.SIGHTENGINE_API_SECRET}`;
                const statusResp = await fetch(statusUrl);
                const statusResult = await statusResp.json();
                console.log("status poll =>", statusResult);

                if (statusResult.status === "finished") {
                  finalAnalysis = statusResult;
                  break;
                }
                if (statusResult.status === "failure") {
                  return new Response(JSON.stringify({ success: false, error: "status check 실패: " + statusResult.error }), { status: 400 });
                }
                maxAttempts--;
              }
              if (!finalAnalysis) {
                return new Response(JSON.stringify({ success: false, error: "비동기 분석이 30초 내에 끝나지 않았습니다." }), { status: 408 });
              }

              // 최종 결과 판정
              const videoThreshold = 0.5;
              let frames = [];
              if (finalAnalysis.data && finalAnalysis.data.frames) {
                frames = Array.isArray(finalAnalysis.data.frames) ? finalAnalysis.data.frames : [finalAnalysis.data.frames];
              } else if (finalAnalysis.frames) {
                frames = Array.isArray(finalAnalysis.frames) ? finalAnalysis.frames : [finalAnalysis.frames];
              }
              const found = checkFramesForCensorship(frames, finalAnalysis.data, videoThreshold);
              if (found.length > 0) {
                console.log("1분 이상 비동기 동영상 불량:", found);
                return new Response(JSON.stringify({ success: false, error: "검열됨: " + found.join(", ") }), { status: 400 });
              }
            }
          }
        }

        // ---------------------------
        // 검열 통과 -> R2 업로드
        // ---------------------------
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
        console.log("업로드 완료 =>", imageUrl);
        return new Response(JSON.stringify({ success: true, url: imageUrl }), {
          headers: { 'Content-Type': 'application/json' }
        });

      } catch (err) {
        console.log("에러 발생:", err);
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
      }
    }

    // ---------------------------
    // GET /{코드}: R2 파일 or HTML 페이지
    // ---------------------------
    else if (request.method === 'GET' && /^\/[A-Za-z0-9,]{8,}(,[A-Za-z0-9]{8})*$/.test(url.pathname)) {
      if (url.searchParams.get('raw') === '1') {
        // 원본 파일 바로 반환
        const code = url.pathname.slice(1).split(",")[0];
        const object = await env.IMAGES.get(code);
        if (!object) {
          return new Response('Not Found', { status: 404 });
        }
        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
        return new Response(object.body, { headers });
      }

      // HTML 페이지 표시
      const codes = url.pathname.slice(1).split(",");
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

      // --- 아래부터는 HTML/CSS/JS 전혀 생략 없이 전체 코드 ---
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
    document.getElementById('toggleButton')?.addEventListener('click', function(){
      window.location.href = '/';
    });
  </script>
</body>
</html>`;
      return new Response(htmlContent, {
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
    }

    // 그 외 -> 기본 에셋
    return env.ASSETS.fetch(request);
  }
};
