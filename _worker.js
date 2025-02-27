export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 디버깅: 들어온 요청의 기본 정보를 출력합니다.
    console.log("Incoming Request:", {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers)
    });
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

    // 헬퍼 함수: MP4에서 mvhd 박스를 찾아 영상 duration(초)을 추출 (버전0,1 지원)
    async function getMP4Duration(file) {
      try {
        const buffer = await file.arrayBuffer();
        const dv = new DataView(buffer);
        const uint8 = new Uint8Array(buffer);
        for (let i = 0; i < uint8.length - 4; i++) {
          // 'm','v','h','d' = 109,118,104,100
          if (uint8[i] === 109 && uint8[i + 1] === 118 && uint8[i + 2] === 104 && uint8[i + 3] === 100) {
            const boxStart = i - 4;
            const version = dv.getUint8(boxStart + 8);
            if (version === 0) {
              const timescale = dv.getUint32(boxStart + 20);
              const duration = dv.getUint32(boxStart + 24);
              return duration / timescale;
            } else if (version === 1) {
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
        return null;
      }
    }

    // 박스를 찾는 유틸 함수
    function findBox(dv, offset, boxName) {
      while (offset < dv.byteLength) {
        const size = dv.getUint32(offset);
        const name = String.fromCharCode(
          dv.getUint8(offset + 4),
          dv.getUint8(offset + 5),
          dv.getUint8(offset + 6),
          dv.getUint8(offset + 7)
        );
        if (!size || size < 8) {
          return null;
        }
        if (name === boxName) {
          return { start: offset, size };
        }
        offset += size;
      }
      return null;
    }

    // MP4에서 ftyp, moov 박스 추출
    function extractFtypMoov(buffer) {
      const dv = new DataView(buffer);

      const ftypBox = findBox(dv, 0, 'ftyp');
      if (!ftypBox) return null;
      const moovBox = findBox(dv, 0, 'moov');
      if (!moovBox) return null;

      const ftypArr = buffer.slice(ftypBox.start, ftypBox.start + ftypBox.size);
      const moovArr = buffer.slice(moovBox.start, moovBox.start + moovBox.size);
      return { ftypArr, moovArr };
    }

    // 프레임(및 data)에서 검열 사유를 찾는 함수
    function checkFramesForCensorship(frames, data, threshold) {
      let reasons = [];
      if (frames.length > 0) {
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
        // frames가 없으면 data의 최상위 nudity/offensive/wad
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

    // (새) "파일 크기 기반"으로 N개 구간을 만드는 함수
    //  - duration을 전혀 알 수 없을 때 사용
    //  - 1구간 당 5MB로, (파일크기 / 5MB) 구간 수를 생성
    function makeSizeBasedSegments(fileSize, chunkSizeMB = 5) {
      const chunkSize = chunkSizeMB * 1024 * 1024; // 5MB
      let segments = [];
      let startByte = 0;
      let i = 0;
      while (startByte < fileSize) {
        const endByte = Math.min(startByte + chunkSize, fileSize);
        segments.push({ index: i++, startByte, endByte });
        startByte = endByte;
      }
      return segments;
    }

    // ============== 라우터 ==============
    if (request.method === 'POST' && url.pathname === '/upload') {
      try {
        const formData = await request.formData();
        const files = formData.getAll('file');
        if (!files || files.length === 0) {
          return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }), { status: 400 });
        }

        for (const file of files) {
          if (file.type.startsWith('image/')) {
            // =============================
            // 이미지 검열 (원래 로직 그대로)
            // =============================
            let fileForCensorship = file;
            try {
              // 이미지 리사이징
              const buffer = await file.arrayBuffer();
              const base64 = arrayBufferToBase64(buffer);
              const dataUrl = `data:${file.type};base64,${base64}`;
              const reqForResize = new Request(dataUrl, {
                cf: { image: { width: 600, height: 600, fit: "inside" } }
              });
              const resizedResponse = await fetch(reqForResize);
              fileForCensorship = await resizedResponse.blob();
            } catch (e) {
              // 실패 시 원본 사용
              fileForCensorship = file;
            }

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
            // =============================
            // 동영상 검열
            // =============================
            // 1) 용량 체크
            if (file.size > 50 * 1024 * 1024) {
              return new Response(JSON.stringify({ success: false, error: "영상 용량이 50MB를 초과합니다." }), { status: 400 });
            }

            // 2) duration 체크
            let videoDuration = await getMP4Duration(file);
            if (videoDuration === null) videoDuration = 0;

            if (videoDuration < 60 && videoDuration !== 0) {
              // ---------------------------
              // 1분 미만 & duration>0
              // ---------------------------
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

              let frames = [];
              if (sightResult.data && sightResult.data.frames) {
                frames = Array.isArray(sightResult.data.frames) ? sightResult.data.frames : [sightResult.data.frames];
              } else if (sightResult.frames) {
                frames = Array.isArray(sightResult.frames) ? sightResult.frames : [sightResult.frames];
              }

              const found = checkFramesForCensorship(frames, sightResult.data, videoThreshold);
              if (found.length > 0) {
                return new Response(JSON.stringify({ success: false, error: "검열됨: " + found.join(", ") }), { status: 400 });
              }

            } else {
              // -------------------------------------------------------------------
              // 1분 이상 (>=60) 또는 duration==0(=영상길이 파싱 실패) → 여러 구간 검열
              // -------------------------------------------------------------------
              const videoThreshold = 0.5;
              const debugLogs = [];
              let reasons = [];

              // 전체 파일 arrayBuffer
              const fileBuffer = await file.arrayBuffer();
              const boxes = extractFtypMoov(fileBuffer);

              // ftyp/moov가 없다면 → fallback(전체파일 한번에)
              if (!boxes) {
                debugLogs.push("No ftyp/moov found, fallback to single check");
                const fallbackForm = new FormData();
                fallbackForm.append('media', new Blob([fileBuffer], { type: file.type }), 'upload');
                fallbackForm.append('models', 'nudity,wad,offensive');
                fallbackForm.append('api_user', env.SIGHTENGINE_API_USER);
                fallbackForm.append('api_secret', env.SIGHTENGINE_API_SECRET);

                const fallbackResp = await fetch('https://api.sightengine.com/1.0/video/check-sync.json', {
                  method: 'POST',
                  body: fallbackForm
                });
                const fallbackResult = await fallbackResp.json();
                debugLogs.push("fallbackResult=" + JSON.stringify(fallbackResult));

                if (fallbackResult.status === "failure") {
                  reasons.push(`Fallback check failure: ${fallbackResult.error}`);
                  return new Response(JSON.stringify({ success: false, error: reasons.join(", ") }), { status: 400 });
                }

                let fallbackFrames = [];
                if (fallbackResult.data && fallbackResult.data.frames) {
                  fallbackFrames = Array.isArray(fallbackResult.data.frames) ? fallbackResult.data.frames : [fallbackResult.data.frames];
                } else if (fallbackResult.frames) {
                  fallbackFrames = Array.isArray(fallbackResult.frames) ? fallbackResult.frames : [fallbackResult.frames];
                }
                const found = checkFramesForCensorship(fallbackFrames, fallbackResult.data, videoThreshold);
                if (found.length > 0) {
                  reasons.push("검열됨: " + found.join(", "));
                  reasons.push("DEBUG LOGS: " + debugLogs.join(" | "));
                  return new Response(JSON.stringify({ success: false, error: reasons.join(" | ") }), { status: 400 });
                }
                // 문제없으면 통과
                continue;
              }

              // 비디오 길이가 60이상인 경우: 40초 단위로 자름
              // 길이가 0이면: 파일 크기 기준으로 자름(5MB씩)
              let segments;
              let isSizeBased = false;

              if (videoDuration >= 60) {
                // 40초 단위 세그먼트
                const segmentLengthSec = 40;
                const bitrate = fileBuffer.byteLength / videoDuration;
                segments = [];
                for (let startSec = 0; startSec < videoDuration; startSec += segmentLengthSec) {
                  const lengthSec = Math.min(segmentLengthSec, videoDuration - startSec);
                  const startByte = Math.floor(startSec * bitrate);
                  const endByte = Math.floor((startSec + lengthSec) * bitrate);
                  segments.push({ startByte, endByte, secStart: startSec, secLen: lengthSec });
                }
              } else {
                // duration == 0 → 5MB씩 잘라
                isSizeBased = true;
                segments = makeSizeBasedSegments(fileBuffer.byteLength, 5); // 5MB
              }

              // 각 세그먼트 분석
              for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                const startByte = seg.startByte ?? seg.start;
                const endByte = seg.endByte ?? seg.end;

                debugLogs.push(
                  `Segment ${i+1}/${segments.length} bytes [${startByte}~${endByte}]` + 
                  (seg.secStart !== undefined ? ` sec=[${seg.secStart}~${seg.secStart+seg.secLen}]` : '') +
                  (isSizeBased ? ' [sizeBased]' : '')
                );

                if (startByte >= fileBuffer.byteLength) {
                  debugLogs.push(`startByte>=fileLength => skip`);
                  continue;
                }
                const realEnd = Math.min(endByte, fileBuffer.byteLength);
                if (realEnd <= startByte) {
                  debugLogs.push(`realEnd<=startByte => skip`);
                  continue;
                }

                const chunkArr = fileBuffer.slice(startByte, realEnd);
                if (chunkArr.byteLength === 0) {
                  debugLogs.push(`chunkArr=0byte => skip`);
                  continue;
                }

                // ftyp+moov+chunk
                const segmentBlob = new Blob([boxes.ftypArr, boxes.moovArr, chunkArr], { type: file.type });
                if (segmentBlob.size === 0) {
                  debugLogs.push(`segmentBlob=0byte => skip`);
                  continue;
                }

                // Sightengine 검열 요청
                const segForm = new FormData();
                segForm.append('media', segmentBlob, 'upload');
                segForm.append('models', 'nudity,wad,offensive');
                segForm.append('api_user', env.SIGHTENGINE_API_USER);
                segForm.append('api_secret', env.SIGHTENGINE_API_SECRET);

                const segResp = await fetch('https://api.sightengine.com/1.0/video/check-sync.json', {
                  method: 'POST',
                  body: segForm
                });
                const segResult = await segResp.json();
                debugLogs.push(`Segment ${i+1} => ${JSON.stringify(segResult)}`);

                if (segResult.status === "failure") {
                  // 깨진 MP4로 인식됐거나, API 에러
                  debugLogs.push(`Segment ${i+1} => API failure: ${segResult.error}`);
                  // 이번 구간만 스킵 후 계속
                  continue;
                }

                let frames = [];
                if (segResult.data && segResult.data.frames) {
                  frames = Array.isArray(segResult.data.frames) ? segResult.data.frames : [segResult.data.frames];
                } else if (segResult.frames) {
                  frames = Array.isArray(segResult.frames) ? segResult.frames : [segResult.frames];
                }
                const found = checkFramesForCensorship(frames, segResult.data, videoThreshold);
                if (found.length > 0) {
                  reasons.push("검열됨: " + found.join(", "));
                  reasons.push("DEBUG LOGS: " + debugLogs.join(" | "));
                  return new Response(JSON.stringify({ success: false, error: reasons.join(" | ") }), { status: 400 });
                }
              }
              // 모든 세그먼트 처리 끝
            }
          }
        }

        // 2. 검열을 통과했으므로 R2에 저장
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

    // GET /{코드} : R2에서 파일 반환 또는 HTML로 보여주기 (다중 코드 지원)
    else if (request.method === 'GET' && /^\/[A-Za-z0-9,]{8,}(,[A-Za-z0-9]{8})*$/.test(url.pathname)) {
      if (url.searchParams.get('raw') === '1') {
        // raw=1 => 바이너리 직접 반환
        const code = url.pathname.slice(1).split(",")[0];
        const object = await env.IMAGES.get(code);
        if (!object) {
          return new Response('Not Found', { status: 404 });
        }
        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
        return new Response(object.body, { headers });
      }
      // 아니면 HTML
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
      transition: all 0.3s ease;
      object-fit: contain;
      cursor: zoom-in;
    }

    #imageContainer img.landscape,
    #imageContainer video.landscape {
      width: 40vw;
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

      return new Response(htmlContent, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
    }

    // 그 외 -> 기본 에셋 핸들러
    return env.ASSETS.fetch(request);
  }
};
