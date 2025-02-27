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

    // 헬퍼 함수: MP4 파일에서 mvhd 박스를 찾아 duration(초)를 추출 (버전0,1 지원)
    async function getMP4Duration(file) {
      try {
        const buffer = await file.arrayBuffer();
        const dv = new DataView(buffer);
        const uint8 = new Uint8Array(buffer);
        // mvhd 문자열의 아스키 코드: m=109, v=118, h=104, d=100
        for (let i = 0; i < uint8.length - 4; i++) {
          if (uint8[i] === 109 && uint8[i + 1] === 118 && uint8[i + 2] === 104 && uint8[i + 3] === 100) {
            const boxStart = i - 4; // mvhd 박스: size(4)+type(4)
            const version = dv.getUint8(boxStart + 8);
            if (version === 0) {
              // version 0: header = 4+4+1+3+4+4+4+4
              const timescale = dv.getUint32(boxStart + 20);
              const duration = dv.getUint32(boxStart + 24);
              return duration / timescale;
            } else if (version === 1) {
              // version 1: header = 4+4+1+3+8+8+4+8
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
              // 이미지 리사이징: 최대 600px 축소하여 검열 속도 향상
              const buffer = await file.arrayBuffer();
              const base64 = arrayBufferToBase64(buffer);
              const dataUrl = `data:${file.type};base64,${base64}`;
              const reqForResize = new Request(dataUrl, {
                cf: { image: { width: 600, height: 600, fit: "inside" } }
              });
              const resizedResponse = await fetch(reqForResize);
              fileForCensorship = await resizedResponse.blob();
            } catch (e) {
              // 리사이징 실패 시 원본 사용
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
            // -------------------------------------------
            // 동영상 검열 (1분 미만은 그대로, 1분 이상은 구간별로 처리)
            // -------------------------------------------
            // 1) 용량 체크: 50MB 초과면 경고
            if (file.size > 50 * 1024 * 1024) {
              return new Response(JSON.stringify({ success: false, error: "영상 용량이 50MB를 초과합니다." }), { status: 400 });
            }

            // 2) 영상 길이(초) 확인 (mp4 기준)
            let videoDuration = await getMP4Duration(file);
            if (videoDuration === null) {
              videoDuration = 0;
            }

            if (videoDuration < 60) {
              // 1분 미만: 기존 방식 그대로 처리 (이 부분은 수정 X)
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

              let reasons = [];
              let frames = [];
              if (sightResult.data && sightResult.data.frames) {
                frames = Array.isArray(sightResult.data.frames) ? sightResult.data.frames : [sightResult.data.frames];
              } else if (sightResult.frames) {
                frames = Array.isArray(sightResult.frames) ? sightResult.frames : [sightResult.frames];
              }

              if (frames.length > 0) {
                for (const frame of frames) {
                  if (frame.nudity) {
                    for (const key in frame.nudity) {
                      if (["suggestive_classes", "context", "none"].includes(key)) continue;
                      if (Number(frame.nudity[key]) >= videoThreshold) {
                        reasons.push("선정적 콘텐츠");
                        break;
                      }
                    }
                  }
                  if (frame.offensive && frame.offensive.prob !== undefined && Number(frame.offensive.prob) >= videoThreshold) {
                    reasons.push("욕설/모욕적 콘텐츠");
                  }
                  if (frame.wad) {
                    for (const key in frame.wad) {
                      if (Number(frame.wad[key]) >= videoThreshold) {
                        reasons.push("잔인하거나 위험한 콘텐츠");
                        break;
                      }
                    }
                  }
                }
              } else {
                if (sightResult.data && sightResult.data.nudity) {
                  for (const key in sightResult.data.nudity) {
                    if (["suggestive_classes", "context", "none"].includes(key)) continue;
                    if (Number(sightResult.data.nudity[key]) >= videoThreshold) {
                      reasons.push("선정적 콘텐츠");
                      break;
                    }
                  }
                }
                if (sightResult.data && sightResult.data.offensive && sightResult.data.offensive.prob !== undefined && Number(sightResult.data.offensive.prob) >= videoThreshold) {
                  reasons.push("욕설/모욕적 콘텐츠");
                }
                if (sightResult.data && sightResult.data.wad) {
                  for (const key in sightResult.data.wad) {
                    if (Number(sightResult.data.wad[key]) >= videoThreshold) {
                      reasons.push("잔인하거나 위험한 콘텐츠");
                      break;
                    }
                  }
                }
              }
              if (reasons.length > 0) {
                return new Response(JSON.stringify({ success: false, error: "검열됨: " + reasons.join(", ") }), { status: 400 });
              }
            } else {
              // 1분 이상: 영상의 비트레이트를 계산하여 40초 단위로 구간별 검열 요청
              // → 각 청크에 moov(box) 부분을 앞에 추가하여 Sightengine이 제대로 인식하도록 함
              const videoThreshold = 0.5;
              let reasons = []; // 실제 에러 메시지를 담을 배열
              let debugLogs = []; // 디버그 로그를 담을 배열 (나중에 reasons에 추가)
              const bitrate = file.size / videoDuration;
              let segments = [];
              const segmentLength = 40; // 40초 단위 슬라이싱

              // moov 박스 포함 용량(대략 2MB)
              const moovBoxSize = 2 * 1024 * 1024;

              for (let currentStart = 0; currentStart < videoDuration; currentStart += segmentLength) {
                segments.push({
                  start: currentStart,
                  length: Math.min(segmentLength, videoDuration - currentStart)
                });
              }

              for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                const startByte = Math.floor(seg.start * bitrate);
                const endByte = Math.floor((seg.start + seg.length) * bitrate);
                debugLogs.push(`Segment ${i+1}/${segments.length}: seconds [${seg.start} ~ ${seg.start + seg.length}], bytes [${startByte} ~ ${endByte}]`);

                // 실제 endByte가 파일 크기를 넘지 않도록 조정
                const realEndByte = Math.min(endByte, file.size);
                if (startByte >= file.size) {
                  debugLogs.push(`Segment ${i+1} startByte >= file.size, skipping`);
                  break;
                }
                if (realEndByte <= startByte) {
                  debugLogs.push(`Segment ${i+1} realEndByte <= startByte, skipping`);
                  break;
                }

                // (중요) Sightengine이 청크를 독립 MP4로 인식하려면 moov 박스가 필요
                // → 파일의 첫 부분(2MB 정도)을 잘라서 앞에 붙임
                const moovEnd = Math.min(moovBoxSize, file.size);
                const moovBlob = file.slice(0, moovEnd, file.type);

                // 실제 영상 데이터 청크
                const contentBlob = file.slice(startByte, realEndByte, file.type);

                // 두 블롭을 합쳐서 하나의 독립된 MP4로 만듦
                const segmentBlob = new Blob([moovBlob, contentBlob], { type: file.type });
                if (segmentBlob.size === 0) {
                  debugLogs.push(`Segment ${i+1} is zero bytes. Skipping censorship check for this segment.`);
                  continue;
                }

                const segmentForm = new FormData();
                segmentForm.append('media', segmentBlob, 'upload');
                segmentForm.append('models', 'nudity,wad,offensive');
                segmentForm.append('api_user', env.SIGHTENGINE_API_USER);
                segmentForm.append('api_secret', env.SIGHTENGINE_API_SECRET);

                const segmentResponse = await fetch('https://api.sightengine.com/1.0/video/check-sync.json', {
                  method: 'POST',
                  body: segmentForm
                });
                const segmentResult = await segmentResponse.json();
                debugLogs.push(`Segment ${i+1} response: ${JSON.stringify(segmentResult)}`);

                let frames = [];
                if (segmentResult.data && segmentResult.data.frames) {
                  frames = Array.isArray(segmentResult.data.frames) ? segmentResult.data.frames : [segmentResult.data.frames];
                } else if (segmentResult.frames) {
                  frames = Array.isArray(segmentResult.frames) ? segmentResult.frames : [segmentResult.frames];
                }

                if (frames.length > 0) {
                  for (const frame of frames) {
                    if (frame.nudity) {
                      for (const key in frame.nudity) {
                        if (["suggestive_classes", "context", "none"].includes(key)) continue;
                        if (Number(frame.nudity[key]) >= videoThreshold) {
                          reasons.push("선정적 콘텐츠");
                          break;
                        }
                      }
                    }
                    if (frame.offensive && frame.offensive.prob !== undefined && Number(frame.offensive.prob) >= videoThreshold) {
                      reasons.push("욕설/모욕적 콘텐츠");
                    }
                    if (frame.wad) {
                      for (const key in frame.wad) {
                        if (Number(frame.wad[key]) >= videoThreshold) {
                          reasons.push("잔인하거나 위험한 콘텐츠");
                          break;
                        }
                      }
                    }
                  }
                } else {
                  if (segmentResult.data && segmentResult.data.nudity) {
                    for (const key in segmentResult.data.nudity) {
                      if (["suggestive_classes", "context", "none"].includes(key)) continue;
                      if (Number(segmentResult.data.nudity[key]) >= videoThreshold) {
                        reasons.push("선정적 콘텐츠");
                        break;
                      }
                    }
                  }
                  if (segmentResult.data && segmentResult.data.offensive && segmentResult.data.offensive.prob !== undefined && Number(segmentResult.data.offensive.prob) >= videoThreshold) {
                    reasons.push("욕설/모욕적 콘텐츠");
                  }
                  if (segmentResult.data && segmentResult.data.wad) {
                    for (const key in segmentResult.data.wad) {
                      if (Number(segmentResult.data.wad[key]) >= videoThreshold) {
                        reasons.push("잔인하거나 위험한 콘텐츠");
                        break;
                      }
                    }
                  }
                }

                if (reasons.length > 0) {
                  // 에러 발생 시, 디버그 로그도 같이 전달
                  reasons.push("DEBUG LOGS: " + debugLogs.join(" | "));
                  return new Response(JSON.stringify({ success: false, error: "검열됨: " + reasons.join(", ") }), { status: 400 });
                }
              }
            }
          }
        }

        // 2. 검열 통과 후: 각 파일 별로 R2에 저장
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
      // raw 파라미터가 있으면 원본 파일 바로 출력
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
      // 아니면 HTML 페이지로 보여주기
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
      return new Response(htmlContent, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
    }
  
    // 그 외의 경우 -> 기본 에셋 핸들러
    return env.ASSETS.fetch(request);
  }
};
