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

    // 박스를 찾는 유틸 함수 ([size, type, ...] 구조를 파싱)
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

    // MP4에서 ftyp, moov 두 개 박스를 추출
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

    // 공통 함수: frames/data에서 검열 사유를 찾음
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
        // frames가 아예 없으면 상위 data 값 체크
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

    // ============== 여기서부터 라우터 ==============
    // POST /upload : 다중 파일 업로드 처리 (검열 -> R2 저장 -> 링크 반환)
    if (request.method === 'POST' && url.pathname === '/upload') {
      try {
        const formData = await request.formData();
        const files = formData.getAll('file');
        if (!files || files.length === 0) {
          return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }), { status: 400 });
        }

        // 1. 모든 파일에 대해 검열 통과 여부 확인
        for (const file of files) {
          if (file.type.startsWith('image/')) {
            // (1) 이미지 검열
            // ------------------------------
            let fileForCensorship = file;
            try {
              // 이미지 리사이징: 최대 600px 축소하여 검열 속도↑
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
            // (2) 동영상 검열
            // ------------------------------
            // 1) 용량 체크
            if (file.size > 50 * 1024 * 1024) {
              return new Response(JSON.stringify({ success: false, error: "영상 용량이 50MB를 초과합니다." }), { status: 400 });
            }

            // 2) MP4 길이 추출
            let videoDuration = await getMP4Duration(file);
            if (videoDuration === null) {
              videoDuration = 0;
            }

            if (videoDuration < 60) {
              // ---------------------------
              // 1분 미만: 기존 로직 그대로
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
              // ----------------------------
              // 1분 이상: 40초 단위 구간화
              // ----------------------------
              const videoThreshold = 0.5;
              let reasons = [];
              let debugLogs = [];

              // 전체 파일 arrayBuffer
              const fileBuffer = await file.arrayBuffer();
              const dv = new DataView(fileBuffer);

              // ftyp + moov 추출
              const boxes = extractFtypMoov(fileBuffer);
              if (!boxes) {
                // ftyp/moov 없으면 → 통째로 fallback
                debugLogs.push("Cannot find ftyp/moov, fallback to full check.");

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
                debugLogs.push(`Fallback result: ${JSON.stringify(fallbackResult)}`);

                if (fallbackResult.status === 'failure') {
                  reasons.push(`Fallback check failed: ${fallbackResult.error}`);
                  reasons.push(`DEBUG LOGS: ${debugLogs.join(" | ")}`);
                  return new Response(JSON.stringify({ success: false, error: reasons.join(" | ") }), { status: 400 });
                }

                // 프레임 분석
                let fallbackFrames = [];
                if (fallbackResult.data && fallbackResult.data.frames) {
                  fallbackFrames = Array.isArray(fallbackResult.data.frames) ? fallbackResult.data.frames : [fallbackResult.data.frames];
                } else if (fallbackResult.frames) {
                  fallbackFrames = Array.isArray(fallbackResult.frames) ? fallbackResult.frames : [fallbackResult.frames];
                }
                let fallbackDetected = checkFramesForCensorship(fallbackFrames, fallbackResult.data, videoThreshold);
                if (fallbackDetected.length > 0) {
                  reasons.push("검열됨: " + fallbackDetected.join(", "));
                  reasons.push("DEBUG LOGS: " + debugLogs.join(" | "));
                  return new Response(JSON.stringify({ success: false, error: reasons.join(" | ") }), { status: 400 });
                }
                // 문제없으면 계속
                continue;
              }

              // 비트레이트 계산
              const bitrate = fileBuffer.byteLength / videoDuration;
              // 40초 단위 segments
              let segments = [];
              const segmentLength = 40;
              for (let startSec = 0; startSec < videoDuration; startSec += segmentLength) {
                segments.push({
                  start: startSec,
                  length: Math.min(segmentLength, videoDuration - startSec)
                });
              }

              // 각 세그먼트별 검열
              for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                const startByte = Math.floor(seg.start * bitrate);
                const endByte = Math.floor((seg.start + seg.length) * bitrate);

                debugLogs.push(`Segment ${i+1}/${segments.length}: [${seg.start}~${seg.start+seg.length}s], bytes [${startByte}~${endByte}]`);
                const realEndByte = Math.min(endByte, fileBuffer.byteLength);

                // == break -> continue 로 수정 (한 구간 문제 생겨도 다음 구간 계속)
                if (startByte >= fileBuffer.byteLength) {
                  debugLogs.push(`Segment ${i+1} startByte >= file.size, skip`);
                  continue;
                }
                if (realEndByte <= startByte) {
                  debugLogs.push(`Segment ${i+1} realEndByte <= startByte, skip`);
                  continue;
                }

                // 구간 데이터
                const contentArr = fileBuffer.slice(startByte, realEndByte);
                if (contentArr.byteLength === 0) {
                  debugLogs.push(`Segment ${i+1} is zero bytes. skip`);
                  continue;
                }

                // ftyp + moov + 구간을 합쳐 독립된 MP4처럼 만듦
                const segmentBlob = new Blob([boxes.ftypArr, boxes.moovArr, contentArr], { type: file.type });
                if (segmentBlob.size === 0) {
                  debugLogs.push(`Segment ${i+1} blob is zero size. skip`);
                  continue;
                }

                // SightEngine API로 전송
                const segmentForm = new FormData();
                segmentForm.append('media', segmentBlob, 'upload');
                segmentForm.append('models', 'nudity,wad,offensive');
                segmentForm.append('api_user', env.SIGHTENGINE_API_USER);
                segmentForm.append('api_secret', env.SIGHTENGINE_API_SECRET);

                const segmentResp = await fetch('https://api.sightengine.com/1.0/video/check-sync.json', {
                  method: 'POST',
                  body: segmentForm
                });
                const segmentResult = await segmentResp.json();
                debugLogs.push(`Segment ${i+1} result: ${JSON.stringify(segmentResult)}`);

                if (segmentResult.status === "failure") {
                  // SightEngine API가 chunk를 처리 못했을 경우
                  debugLogs.push(`Segment ${i+1} check failed: ${segmentResult.error}`);
                  // 굳이 여기서 중단하지 않고 계속해볼 수도 있음. 
                  continue;
                }

                // 프레임 분석
                let frames = [];
                if (segmentResult.data && segmentResult.data.frames) {
                  frames = Array.isArray(segmentResult.data.frames) ? segmentResult.data.frames : [segmentResult.data.frames];
                } else if (segmentResult.frames) {
                  frames = Array.isArray(segmentResult.frames) ? segmentResult.frames : [segmentResult.frames];
                }
                let found = checkFramesForCensorship(frames, segmentResult.data, videoThreshold);
                if (found.length > 0) {
                  reasons.push("검열됨: " + found.join(", "));
                  reasons.push("DEBUG LOGS: " + debugLogs.join(" | "));
                  return new Response(JSON.stringify({ success: false, error: reasons.join(" | ") }), { status: 400 });
                }
              }
            }
          }
        }

        // 2. 검열 통과 시, R2에 업로드
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
          // 중복되지 않는 코드 5번 시도
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

        // 업로드 성공 → url 반환
        const urlCodes = codes.join(",");
        const imageUrl = `https://${url.host}/${urlCodes}`;
        return new Response(JSON.stringify({ success: true, url: imageUrl }), {
          headers: { 'Content-Type': 'application/json' }
        });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
      }
    }

    // GET /{코드} : R2에서 파일을 찾아 반환 or HTML로 보여주기 (다중코드 지원)
    else if (request.method === 'GET' && /^\/[A-Za-z0-9,]{8,}(,[A-Za-z0-9]{8})*$/.test(url.pathname)) {
      if (url.searchParams.get('raw') === '1') {
        // raw=1 이면 원본 바이너리 직접 반환
        const code = url.pathname.slice(1).split(",")[0];
        const object = await env.IMAGES.get(code);
        if (!object) {
          return new Response('Not Found', { status: 404 });
        }
        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
        return new Response(object.body, { headers });
      }
      // 아니면 HTML 페이지
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

      return new Response(htmlContent, {
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
    }

    // 그 외 -> 기본 에셋 핸들러
    return env.ASSETS.fetch(request);
  },
};
