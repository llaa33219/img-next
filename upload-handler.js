// ==============================
// 업로드 처리 관리
// ==============================

import { handleImageCensorship, handleVideoCensorship } from './censorship.js';
import { generateUniqueCode } from './utils.js';

/**
 * 메인 업로드 처리 함수
 * @param {Request} request - 요청 객체
 * @param {Object} env - 환경 변수
 * @returns {Response} - 응답 객체
 */
export async function handleUpload(request, env) {
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
  const allowedVideoTypes = ["video/mp4", "video/webm", "video/ogg", "video/x-msvideo", "video/avi", "video/msvideo", "video/quicktime"];
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
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // 1) 검열 - 다중 업로드시 실패한 파일 수집, 단일 업로드시 즉시 중단
  console.log(`[검열 시작] ${files.length}개 파일 검열 시작`);
  const validFiles = [];
  const failedFiles = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    console.log(`[검열 진행] ${i + 1}/${files.length} - ${file.name || 'Unknown'}, ${file.type}, ${(file.size / 1024 / 1024).toFixed(2)}MB`);

    try {
      const r = file.type.startsWith('image/')
        ? await handleImageCensorship(file, env)
        : await handleVideoCensorship(file, env);

      if (!r.ok) {
        console.log(`[검열 실패] ${i + 1}번째 파일에서 검열 실패`);
        // 기존 응답에서 에러 메시지 추출
        let errorMessage = '알 수 없는 오류';
        try {
          const responseText = await r.response.text();
          const errorData = JSON.parse(responseText);
          errorMessage = errorData.error || errorMessage;
        } catch (e) {
          console.log('에러 메시지 파싱 실패:', e);
        }

        const fileInfo = {
          index: i + 1,
          name: file.name || 'Unknown',
          error: errorMessage
        };
        failedFiles.push(fileInfo);

        // 단일 파일 업로드시에만 즉시 중단
        if (files.length === 1) {
          return new Response(JSON.stringify({
            success: false,
            error: `파일 검열 실패: ${errorMessage}`
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
      } else {
        console.log(`[검열 통과] ${i + 1}번째 파일 검열 통과`);
        validFiles.push({ file, index: i + 1 });
      }
    } catch (e) {
      console.log(`[검열 오류] ${i + 1}번째 파일 검열 중 오류:`, e);
      const fileInfo = {
        index: i + 1,
        name: file.name || 'Unknown',
        error: `검열 중 오류: ${e.message}`
      };
      failedFiles.push(fileInfo);

      // 단일 파일 업로드시에만 즉시 중단
      if (files.length === 1) {
        return new Response(JSON.stringify({
          success: false,
          error: `파일 검열 중 오류: ${e.message}`
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }
  }

  console.log(`[검열 완료] ${validFiles.length}개 파일 검열 통과, ${failedFiles.length}개 파일 실패`);

  // 모든 파일이 실패한 경우
  if (validFiles.length === 0) {
    return new Response(JSON.stringify({
      success: false,
      error: '모든 파일이 검열에 실패했습니다.',
      failedFiles: failedFiles
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  // 2) R2 업로드 - 검열 통과한 파일들만 업로드
  let codes = [];
  const uploadSuccessFiles = [];
  const uploadFailedFiles = [];

  if (customName && validFiles.length === 1) {
    customName = customName.replace(/ /g, "_");
    try {
      if (await env.IMAGES.get(customName)) {
        return new Response(JSON.stringify({
          success: false,
          error: '이미 사용 중인 이름입니다. 다른 이름을 선택해주세요.'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      console.log(`[R2 업로드] 커스텀 이름으로 업로드 시작: ${customName}`);
      await env.IMAGES.put(customName, validFiles[0].file.stream(), {
        httpMetadata: { contentType: validFiles[0].file.type },
        size: validFiles[0].file.size
      });
      codes.push(customName);
      uploadSuccessFiles.push({
        index: validFiles[0].index,
        name: validFiles[0].file.name || 'Unknown',
        code: customName
      });
      console.log(`[R2 업로드] 커스텀 이름 업로드 완료: ${customName}`);
    } catch (e) {
      console.log(`[R2 업로드 실패] 커스텀 이름 업로드 오류:`, e);
      return new Response(JSON.stringify({
        success: false,
        error: `파일 업로드 실패: ${e.message}`
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  } else {
    console.log(`[R2 업로드] ${validFiles.length}개 파일 업로드 시작`);
    for (let i = 0; i < validFiles.length; i++) {
      const { file, index } = validFiles[i];
      try {
        console.log(`[R2 업로드] ${i + 1}/${validFiles.length} - ${file.name || 'Unknown'} 업로드 중...`);
        const code = await generateUniqueCode(env);
        await env.IMAGES.put(code, file.stream(), {
          httpMetadata: { contentType: file.type },
          size: file.size
        });
        codes.push(code);
        uploadSuccessFiles.push({
          index: index,
          name: file.name || 'Unknown',
          code: code
        });
        console.log(`[R2 업로드] ${i + 1}/${validFiles.length} - 업로드 완료: ${code}`);
      } catch (e) {
        console.log(`[R2 업로드 실패] ${index}번째 파일 업로드 오류:`, e);
        uploadFailedFiles.push({
          index: index,
          name: file.name || 'Unknown',
          error: `업로드 실패: ${e.message}`
        });

        // 단일 파일 업로드시에만 즉시 중단
        if (validFiles.length === 1) {
          return new Response(JSON.stringify({
            success: false,
            error: `파일 업로드 실패: ${e.message}`
          }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
      }
    }
    console.log(`[R2 업로드] ${uploadSuccessFiles.length}개 파일 업로드 성공, ${uploadFailedFiles.length}개 파일 업로드 실패`);
  }

  // 모든 업로드가 실패한 경우
  if (codes.length === 0) {
    return new Response(JSON.stringify({
      success: false,
      error: '모든 파일 업로드에 실패했습니다.',
      failedFiles: [...failedFiles, ...uploadFailedFiles]
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const host = request.headers.get('host') || 'example.com';
  const finalUrl = codes.length > 0 ? `https://${host}/${codes.join(",")}` : null;
  const rawUrls = codes.map(code => `https://${host}/${code}?raw=1`);
  console.log(">>> 업로드 완료 =>", finalUrl);

  // 전체 실패한 파일 목록 (검열 실패 + 업로드 실패)
  const allFailedFiles = [...failedFiles, ...uploadFailedFiles];

  // API 응답에 성공/실패 정보 포함
  const responseData = {
    success: codes.length > 0,
    url: finalUrl,
    rawUrls: rawUrls,
    codes: codes,
    uploadedFiles: uploadSuccessFiles,
    totalFiles: files.length,
    successCount: uploadSuccessFiles.length,
    failureCount: allFailedFiles.length
  };

  // 실패한 파일이 있으면 추가 정보 포함
  if (allFailedFiles.length > 0) {
    responseData.failedFiles = allFailedFiles;
    responseData.message = `${uploadSuccessFiles.length}개 파일 업로드 성공, ${allFailedFiles.length}개 파일 실패`;
  }

  return new Response(JSON.stringify(responseData), {
    headers: { 'Content-Type': 'application/json' }
  });
}

