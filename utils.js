// ==============================
// 유틸리티 함수들
// ==============================

/**
 * ArrayBuffer를 base64 문자열로 변환
 * @param {ArrayBuffer} buffer - 변환할 버퍼
 * @returns {string} - base64 인코딩된 문자열
 */
export function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

/**
 * 고유 8자 코드 생성
 * @param {Object} env - 환경 변수 (R2 접근용)
 * @param {number} length - 코드 길이 (기본값: 8)
 * @returns {string} - 고유 코드
 */
export async function generateUniqueCode(env, length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let t = 0; t < 10; t++) {
    let code = '';
    for (let i = 0; i < length; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (!(await env.IMAGES.get(code))) return code;
  }
  throw new Error("코드 생성 실패");
}

/**
 * MP4 재생길이 간단 추출 함수
 * @param {File} file - MP4 파일
 * @returns {number|null} - 재생 시간(초) 또는 null
 */
export async function getMP4Duration(file) {
  try {
    const buffer = await file.arrayBuffer();
    const dv = new DataView(buffer);
    const u = new Uint8Array(buffer);
    
    for (let i = 0; i < u.length - 4; i++) {
      if (u[i] === 109 && u[i + 1] === 118 && u[i + 2] === 104 && u[i + 3] === 100) {
        const vs = dv.getUint8(i - 4 + 8);
        const ts = vs === 0 ? dv.getUint32(i - 4 + 20) : dv.getUint32(i - 4 + 28);
        const du = vs === 0 ? dv.getUint32(i - 4 + 24) : (dv.getUint32(i - 4 + 32) * 2 ** 32 + dv.getUint32(i - 4 + 36));
        return du / ts;
      }
    }
    return null;
  } catch (e) {
    console.log("getMP4Duration error:", e);
    return null;
  }
}

/**
 * CORS 헤더 추가 함수
 * @param {Response} response - 원본 응답
 * @returns {Response} - CORS 헤더가 추가된 응답
 */
export function addCorsHeaders(response) {
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

