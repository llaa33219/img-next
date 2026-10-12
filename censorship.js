// ==============================
// 콘텐츠 검열 관리 (Cloudflare Workers AI - clef-omni)
// ==============================

import { arrayBufferToBase64, getMP4Duration } from './utils.js';

// clef-omni 결정 모델이 반환하는 확률을 true/false 판정으로 환산하는 임계값
const DECISION_THRESHOLD = 0.5;

// clef-omni 미디어 제약 (모델 문서 기준)
// images: 최대 4개, 개별 4MiB / 16MP, 합산 8MiB decoded
// videos: 최대 2개, 개별 60초 / 16MiB, 오디오+비디오 합산 16MiB decoded
const CLEF_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const CLEF_VIDEO_MAX_BYTES = 16 * 1024 * 1024;
const CLEF_VIDEO_MAX_SECONDS = 60;
// clef-omni는 요청당 최대 2개 영상만 받음 (문서: videos maxItems 2)
const CLEF_MAX_VIDEOS = 2;
// 분할은 용량 기준이라 길이가 흔들린다. 60초 제한을 확실히 지키기 위한 분할 배수
const SEGMENT_SAFETY_DIVISOR = 3;
// 이미지 압축 타깃: clef-omni 이미지 상한(4MiB) 미만으로 유지
const TARGET_SIZE_KB = 3072; // 3MB

// clef-omni가 natively 지원하는 이미지 포맷 (문서: PNG, JPEG, WebP)
const CLEF_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
// clef-omni가 natively 지원하는 동영상 포맷 (문서 예시: mp4, webm)
const CLEF_VIDEO_TYPES = ['video/mp4', 'video/webm'];

/**
 * 검열 카테고리 정의 - 기존 12개 카테고리를 clef-omni noul(yes/no) 질문으로 1:1 매핑
 * id: clef-omni 질문 키, label: 사용자에게 보여줄 한국어 사유
 */
const CENSORSHIP_CATEGORIES = [
  {
    id: 'nudity',
    label: '성적/노출 콘텐츠',
    question: 'Does this show nudity or sexual content (exposed genitals, sexual acts, suggestive poses)?'
  },
  {
    id: 'partial_nudity',
    label: '부분적 노출/선정적 콘텐츠',
    question: 'Does this show partial nudity or suggestive content (underwear focus, sexual implications, provocative clothing)?'
  },
  {
    id: 'violence',
    label: '폭력/무기 콘텐츠',
    question: 'Does this show violence or weapons (guns, knives, violence depiction, weapons display)?'
  },
  {
    id: 'gore',
    label: '극단적 폭력/고어 콘텐츠',
    question: 'Does this show graphic violence or gore (blood, injuries, death, extreme violence)?'
  },
  {
    id: 'drugs',
    label: '약물/알코올 남용 콘텐츠',
    question: 'Does this show drug or alcohol abuse (drug paraphernalia, excessive drinking, drug use)?'
  },
  {
    id: 'hate',
    label: '혐오 발언/욕설',
    question: 'Does this contain hate speech or offensive language (slurs, hate symbols, discriminatory text)?'
  },
  {
    id: 'harassment',
    label: '괴롭힘/따돌림 콘텐츠',
    question: 'Does this contain harassment or bullying (targeting individuals, cyberbullying, intimidation)?'
  },
  {
    id: 'self_harm',
    label: '자해/자살 관련 콘텐츠',
    question: 'Does this show self-harm or suicide content (cutting, suicide methods, self-injury)?'
  },
  {
    id: 'illegal',
    label: '불법 활동',
    question: 'Does this depict illegal activities (theft, fraud, illegal substances, criminal acts)?'
  },
  {
    id: 'spam',
    label: '스팸/사기 콘텐츠',
    question: 'Does this show spam or scam content (fake offers, phishing, misleading information)?'
  },
  {
    id: 'child_exploitation',
    label: '아동 착취',
    question: 'Does this depict child exploitation (minors in inappropriate contexts, child endangerment)?'
  },
  {
    id: 'extremist',
    label: '극단주의 콘텐츠',
    question: 'Does this contain extremist content (terrorist symbols, radical ideologies, dangerous groups)?'
  }
];

/**
 * JSON 응답 생성 헬퍼
 */
function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * 파일을 IVCP API를 통해 압축하고 base64 데이터 반환
 * @param {File} file - 압축할 파일
 * @param {string} type - 파일 타입 ('image' 또는 'video')
 * @param {string} mode - 'compress' (기본) 또는 'split' (영상 분할)
 * @returns {Object} - { base64, mimeType } | { file } | { parts: [{base64, mimeType}] }
 */
async function compressFileForCensorship(file, type, mode = 'compress', targetSizeKB = null) {
  const IVCP_API_BASE = 'https://ivcp.bloupla.net/api';

  try {
    console.log(`[IVCP 압축] ${type} 압축 시작 - 원본 크기: ${(file.size / (1024 * 1024)).toFixed(2)}MB`);

    const formData = new FormData();
    if (type === 'image') {
      formData.append('image', file);
      formData.append('targetSizeKB', TARGET_SIZE_KB.toString());
      formData.append('returnBase64', 'true'); // Base64로 반환 요청
    } else {
      formData.append('video', file);
      formData.append('targetSizeKB', String(targetSizeKB ?? TARGET_SIZE_KB * 2));
      formData.append('compressionMode', mode);
      formData.append('returnBase64', 'true'); // Base64로 반환 요청
    }

    // WebM은 전용 분할 엔드포인트가 있다 (split 모드가 video/mp4 전용)
    const endpoint = type === 'image'
      ? '/compress-image'
      : (mode === 'split' && file.type === 'video/webm' ? '/split-webm' : '/compress-video');
    const response = await fetch(`${IVCP_API_BASE}${endpoint}`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`[IVCP 압축] API 오류 응답: ${errorText}`);
      throw new Error(`IVCP API 오류: ${response.status}`);
    }

    const result = await response.json();

    // 이미 목표 크기 이하인 경우
    if (result.alreadySmaller) {
      console.log(`[IVCP 압축] 파일이 이미 목표 크기 이하입니다.`);
      return { file: file }; // 원본 파일 반환
    }

    if (!result.success) {
      throw new Error('압축 실패: ' + (result.error || '알 수 없는 오류'));
    }

    // 분할 모드: 여러 파트로 나올 수 있다 (parts/files/videos 등 키 이름을 모두 시도)
    const partArray = result.parts || result.files || result.videos || result.clips || result.chunks;
    if (Array.isArray(partArray) && partArray.length > 0) {
      const parts = [];
      for (const part of partArray) {
        const raw = typeof part === 'string' ? part : (part?.base64 || part?.data || part?.url);
        if (!raw) continue;
        const m = String(raw).match(/^data:([^;]+);base64,(.+)$/);
        parts.push(m ? { base64: m[2], mimeType: m[1] } : { base64: String(raw), mimeType: file.type });
        if (typeof part?.duration === 'number') parts[parts.length - 1].duration = part.duration;
      }
      if (parts.length > 0) {
        console.log(`[IVCP 분할] ${parts.length}개 파트 수신 (각 파트 MIME: ${parts.map(p => p.mimeType).join(', ')})`);
        return { parts };
      }
    }

    // Base64 데이터 추출 (API 응답 키는 'base64')
    if (result.base64) {
      const dataUrl = result.base64;
      // data:image/jpeg;base64,... 형식에서 base64 부분만 추출
      const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        const mimeType = matches[1];
        const base64Data = matches[2];
        console.log(`[IVCP 압축] 압축 완료 (Base64) - MIME 타입: ${mimeType}, Base64 길이: ${base64Data.length} 문자`);
        return { base64: base64Data, mimeType: mimeType };
      } else {
        // data: URI 형식이 아닌 순수 base64인 경우
        console.log(`[IVCP 압축] 압축 완료 (Base64) - Base64 길이: ${result.base64.length} 문자`);
        return { base64: result.base64, mimeType: file.type };
      }
    }

    throw new Error('압축된 파일을 받지 못했습니다.');
  } catch (error) {
    console.log(`[IVCP 압축] 압축 실패: ${error.message}`);
    throw error;
  }
}

/**
 * 파일을 clef-omni 입력 규격(데이터 URL)으로 변환
 * - 크기/포맷 제약 확인, 필요 시 압축
 * - Workers는 ffmpeg가 없어 영상 트리밍 불가 → 제약 초과는 명시적으로 거부
 * @param {File} file - 원본 파일
 * @param {'image'|'video'} type - 파일 타입
 * @returns {Object} - { ok:true, dataUrls:[string] } 또는 { ok:false, error }
 */
async function prepareMediaForClef(file, type) {
  const isImage = type === 'image';
  const maxBytes = isImage ? CLEF_IMAGE_MAX_BYTES : CLEF_VIDEO_MAX_BYTES;
  const supportedTypes = isImage ? CLEF_IMAGE_TYPES : CLEF_VIDEO_TYPES;

  console.log(`${isImage ? '이미지' : '동영상'} 크기: ${(file.size / (1024 * 1024)).toFixed(2)}MB`);

  let mimeType = file.type;
  let base64 = null;

  // 1) 포맷 지원 확인 — clef-omni가 디코딩하지 못하는 컨테이너는 변환 없이 통과시킬 수 없다.
  //    이미지 포맷은 WebP/JPEG로 변환이 가능하므로 압축을 한 번 시도한다.
  if (!supportedTypes.includes(mimeType)) {
    if (isImage) {
      console.log(`[포맷 변환] ${mimeType}는 clef-omni 미지원 - 압축으로 JPEG/WebP 변환 시도`);
      try {
        const compressResult = await compressFileForCensorship(file, 'image');
        if (compressResult.base64) {
          base64 = compressResult.base64;
          mimeType = compressResult.mimeType;
        } else if (compressResult.file) {
          mimeType = compressResult.file.type;
          if (CLEF_IMAGE_TYPES.includes(mimeType)) {
            base64 = arrayBufferToBase64(await compressResult.file.arrayBuffer());
          }
        }
      } catch (compressionError) {
        console.log(`[포맷 변환] 압축 실패: ${compressionError.message}`);
      }

      if (!base64 || !CLEF_IMAGE_TYPES.includes(mimeType)) {
        return {
          ok: false,
          error: '이미지 검열은 JPEG, PNG, WebP 형식만 지원합니다. 해당 형식으로 변환 후 다시 시도해주세요.'
        };
      }
      console.log(`[포맷 변환] 완료 - ${mimeType}`);
    } else {
      // 영상 포맷 변환은 Workers 환경에서 불가능(ffmpeg 없음) → fail-closed
      return {
        ok: false,
        error: '동영상 검열은 MP4, WebM 형식만 지원합니다. 해당 형식으로 변환 후 다시 시도해주세요.'
      };
    }
  }

  // 2) 크기 제한 확인 및 압축
  if (!base64 && file.size > maxBytes) {
    console.log(`[압축] clef-omni 제한(${Math.round(maxBytes / 1024 / 1024)}MB) 초과 - 압축 진행`);
    try {
      const compressResult = await compressFileForCensorship(file, type);

      if (compressResult.base64) {
        base64 = compressResult.base64;
        mimeType = compressResult.mimeType;
        console.log(`[압축] 완료 - Base64로 직접 받음 (${base64.length} 문자)`);
      } else if (compressResult.file) {
        mimeType = compressResult.file.type;
        base64 = arrayBufferToBase64(await compressResult.file.arrayBuffer());
        console.log(`[압축] 이미 목표 이하 - Base64 변환 (${base64.length} 문자)`);
      }
    } catch (compressionError) {
      console.log(`[압축] 실패, 원본으로 계속 진행: ${compressionError.message}`);
      // 압축 실패 시 원본으로 계속 진행 (이후 크기 검사에서 걸러짐)
    }
  }

  // 3) base64 미준비 시 원본 인코딩
  if (!base64) {
    console.log(`[인코딩] 원본 파일 Base64 변환 시작`);
    base64 = arrayBufferToBase64(await file.arrayBuffer());
    console.log(`[인코딩] 완료 - Base64 길이: ${base64.length} 문자`);
  }

  // 4) 압축 후에도 하드 제한 초과면 fail-closed (모델에 넘기면 요청 자체가 실패)
  //    base64 패딩("=")을 제외한 정확한 디코딩 바이트 수로 계산
  const decodedBytes = Math.floor(base64.length * 3 / 4)
    - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  if (decodedBytes > maxBytes) {
    return {
      ok: false,
      error: `${isImage ? '이미지' : '동영상'} 용량이 검열 제한(${Math.round(maxBytes / 1024 / 1024)}MB)을 초과하여 검열할 수 없습니다.`
    };
  }

  if (!supportedTypes.includes(mimeType)) {
    return {
      ok: false,
      error: `${isImage ? '이미지' : '동영상'} 형식(${mimeType})을 검열 모델이 처리할 수 없습니다.`
    };
  }

  return { ok: true, dataUrls: [`data:${mimeType};base64,${base64}`], mimeType };
}

/**
 * 긴 영상을 clef-omni 규격(세그먼트당 60초 이하, 최대 2개)으로 나눈다
 *
 * Workers 런타임에는 ffmpeg가 없어 서버에서 직접 자를 수 없다.
 * 대신 이미 사용 중인 IVCP 미디어 서비스의 분할(split) 기능으로 처리한다.
 * clef-omni는 요청당 최대 2개 영상을 받으므로, 분할 결과가 많으면 전체 길이에
 * 비례해 균등하게 최대 CLEF_MAX_VIDEOS개를 고른다(앞부분 편향 방지).
 *
 * @param {File} file - 원본 영상 파일
 * @param {number} durationSec - 원본 영상 길이(초)
 * @returns {Object} - { ok:true, dataUrls:[string] } 또는 { ok:false, error }
 */
async function segmentLongVideo(file, durationSec) {
  console.log(`[영상 분할] ${Math.round(durationSec)}초(>${CLEF_VIDEO_MAX_SECONDS}초) - IVCP 분할 API 호출`);

  // IVCP 분할은 "목표 용량" 기준이라 세그먼트 길이를 직접 지정할 수 없다.
  // 실측 관계: 세그먼트 길이 ≈ (파일크기 / targetSizeKB). 필요한 바이트를 60초 기준으로
  // 잡되 SEGMENT_SAFETY_DIVISOR 로 더 잘게 나누어, 비트레이트가 급변하는 구간에서도
  // 60초를 넘지 않도록 여유를 둔다.
  const bytesPerSecond = file.size / durationSec;
  const targetSeconds = CLEF_VIDEO_MAX_SECONDS / SEGMENT_SAFETY_DIVISOR;
  const targetKB = Math.max(16, Math.ceil((bytesPerSecond * targetSeconds) / 1024));
  console.log(`[영상 분할] ${(bytesPerSecond / 1024).toFixed(1)}KB/s, targetSizeKB=${targetKB} (목표 세그먼트 ≈${targetSeconds}초)`);

  let result;
  try {
    result = await compressFileForCensorship(file, 'video', 'split', targetKB);
  } catch (e) {
    console.log(`[영상 분할] 분할 API 호출 실패: ${e.message}`);
    return {
      ok: false,
      error: `긴 동영상은 자동 분할에 실패했습니다. ${CLEF_VIDEO_MAX_SECONDS}초 이하의 동영상으로 잘라서 다시 시도해주세요.`
    };
  }

  // 분할 결과가 parts로 안 오는 경우(단일 base64 등) → 그 값 사용
  let parts = result.parts;
  if (!parts) {
    if (result.base64) {
      parts = [{ base64: result.base64, mimeType: result.mimeType, duration: durationSec }];
    } else if (result.file) {
      parts = [{ base64: arrayBufferToBase64(await result.file.arrayBuffer()), mimeType: result.file.type, duration: durationSec }];
    }
  }

  if (!parts || parts.length === 0) {
    console.log('[영상 분할] 분할 결과 없음');
    return {
      ok: false,
      error: `긴 동영상은 자동 분할에 실패했습니다. ${CLEF_VIDEO_MAX_SECONDS}초 이하의 동영상으로 잘라서 다시 시도해주세요.`
    };
  }

  // 서비스가 duration을 알려준다 → 60초 초과 세그먼트가 있으면 확인 후 제거
  // (용량 기준으로 나누므로 비트레이트가 급변하는 구간은 60초를 넘길 수 있다)
  const tooLong = parts.filter(p => typeof p.duration === 'number' && p.duration > CLEF_VIDEO_MAX_SECONDS);
  if (tooLong.length > 0) {
    console.log(`[영상 분할] ${tooLong.length}개 세그먼트가 ${CLEF_VIDEO_MAX_SECONDS}초 초과 (최대 ${Math.max(...tooLong.map(p => p.duration)).toFixed(1)}초)`);
    // 초과분은 그대로 모델에 넘길 수 없다. 잘라낼 수 없으므로 안전하게 거부.
    return {
      ok: false,
      error: `동영상 일부 구간이 검열 제한(${CLEF_VIDEO_MAX_SECONDS}초)을 초과하여 나눌 수 없습니다. 더 짧게 잘라서 다시 시도해주세요.`
    };
  }

  // 세그먼트 용량 상한 (clef-omni 영상 16MiB)
  const oversized = parts.filter(p => {
    const bytes = Math.floor(p.base64.length * 3 / 4)
      - (p.base64.endsWith('==') ? 2 : p.base64.endsWith('=') ? 1 : 0);
    return bytes > CLEF_VIDEO_MAX_BYTES;
  });
  if (oversized.length > 0) {
    console.log(`[영상 분할] ${oversized.length}개 세그먼트가 ${Math.round(CLEF_VIDEO_MAX_BYTES / 1024 / 1024)}MB 제한 초과`);
    return {
      ok: false,
      error: `동영상을 자동 분할해도 일부 구간이 검열 용량 제한을 초과했습니다. 해상도를 낮추거나 더 짧게 잘라서 다시 시도해주세요.`
    };
  }

  // clef-omni 요청당 최대 2개 — 전체에 균등하게 배분해 선택 (앞부분 편향 방지)
  const selected = parts.length <= CLEF_MAX_VIDEOS
    ? parts
    : Array.from({ length: CLEF_MAX_VIDEOS }, (_, i) =>
        parts[Math.round((i * (parts.length - 1)) / (CLEF_MAX_VIDEOS - 1))]);

  if (selected.length !== parts.length) {
    console.log(`[영상 분할] ${parts.length}개 중 ${CLEF_MAX_VIDEOS}개 균등 선택 (전체 구간 커버)`);
  }

  const dataUrls = selected.map(p => `data:${p.mimeType};base64,${p.base64}`);
  return { ok: true, dataUrls };
}

/**
 * clef-omni에 검열 질문을 던지고 카테고리별 판정 결과를 받는다
 * @param {Object} env - 환경 변수 (Workers AI 바인딩 env.AI 필요)
 * @param {string} mediaKind - 'image' 또는 'video'
 * @param {string[]} dataUrls - 미디어 데이터 URL 배열 (영상은 최대 2개)
 * @returns {Object} - { success, flagged: [{id,label,probability}], missing: [id], usage }
 */
async function runClefCensorship(env, mediaKind, dataUrls) {
  if (!env.AI) {
    return { success: false, error: 'Workers AI 바인딩(env.AI)이 설정되지 않았습니다.' };
  }

  const isImage = mediaKind === 'image';

  // 카테고리별 noul 질문을 questions 스키마로 구성
  const questions = {};
  for (const cat of CENSORSHIP_CATEGORIES) {
    questions[cat.id] = {
      type: 'noul',
      instructions: cat.question,
      criteria: {
        true: `The content shows ${cat.label}. Mark true if there is any doubt.`,
        false: `The content is appropriate in this category (${cat.label}).`
      }
    };
  }

  const requestBody = {
    model: 'clef-omni',
    state: isImage
      ? 'Evaluate this image for inappropriate content across all categories. Judge the whole image, including any text, symbols, watermarks, or edited/obfuscated regions. Be strict.'
      : 'Evaluate this video for inappropriate content across all categories. Judge the entire video including every frame, any briefly visible content, on-screen text, and the audio track. Be strict.',
    questions,
    ...(isImage ? { images: dataUrls } : { videos: dataUrls })
  };

  console.log(`[clef-omni 요청] ${mediaKind}, 질문 ${Object.keys(questions).length}개, 미디어 ${dataUrls.length}개, 총 ${dataUrls.reduce((n, u) => n + u.length, 0)}자`);
  console.log(`[clef-omni 요청] 모델: @cf/cloudflare/clef-omni`);

  let response;
  try {
    response = await env.AI.run('@cf/cloudflare/clef-omni', requestBody);
  } catch (e) {
    console.log(`[clef-omni 호출 실패]: ${e.message}`);
    return { success: false, error: `검열 모델 호출 실패: ${e.message}` };
  }

  const answers = response?.answers;
  if (!answers || typeof answers !== 'object') {
    console.log('[clef-omni 응답 구조 오류]', { response });
    return { success: false, error: '검열 모델에서 유효한 응답을 받지 못했습니다.' };
  }

  // 확률 → true/false 판정 + 누락된 질문 수집
  const flagged = [];
  const missing = [];

  for (const cat of CENSORSHIP_CATEGORIES) {
    const answer = answers[cat.id];
    const probability = typeof answer?.noul === 'number' ? answer.noul : null;

    if (probability === null) {
      missing.push(cat.id);
      continue;
    }

    console.log(`[clef-omni 판정] ${cat.id}: noul=${probability.toFixed(3)} -> ${probability >= DECISION_THRESHOLD ? 'TRUE(부적절)' : 'false'}`);
    if (probability >= DECISION_THRESHOLD) {
      flagged.push({ id: cat.id, label: cat.label, probability });
    }
  }

  console.log(`[clef-omni 완료] 부적절 ${flagged.length}건, 미응답 ${missing.length}건`);
  if (response?.usage) {
    console.log(`[clef-omni usage] input=${response.usage.input_tokens}, output=${response.usage.output_tokens}`);
  }

  return { success: true, flagged, missing, usage: response?.usage };
}

/**
 * 검열 결과에 대한 공통 판정 — 이미지/영상 공통
 * @param {Object} env - 환경 변수
 * @param {File} file - 검열할 파일
 * @param {'image'|'video'} type - 파일 타입
 * @param {string} label - 로그/메시지용 라벨 ('이미지' | '동영상')
 * @returns {Object} - { ok: true } 또는 { ok: false, response }
 */
async function runCensorship(env, file, type, label) {
  if (!env.AI) {
    return {
      ok: false,
      response: jsonResponse({ success: false, error: 'Workers AI 바인딩(env.AI)이 설정되지 않았습니다.' }, 500)
    };
  }

  const media = await prepareMediaForClef(file, type);
  if (!media.ok) {
    console.log(`[${label} 검열 완료] 지원하지 않는 입력 - 업로드 거부: ${media.error}`);
    return { ok: false, response: jsonResponse({ success: false, error: media.error }, 400) };
  }

  let dataUrls = media.dataUrls;

  // 영상이 60초를 넘으면 거부하지 않고 자동 분할해 검열한다
  if (type === 'video' && file.type === 'video/mp4') {
    const duration = await getMP4Duration(file);
    if (typeof duration === 'number' && duration > CLEF_VIDEO_MAX_SECONDS) {
      const segmented = await segmentLongVideo(file, duration);
      if (!segmented.ok) {
        console.log(`[${label} 검열 완료] 분할 실패 - 업로드 거부: ${segmented.error}`);
        return { ok: false, response: jsonResponse({ success: false, error: segmented.error }, 400) };
      }
      dataUrls = segmented.dataUrls;
    }
  }

  const analysis = await runClefCensorship(env, type, dataUrls);
  if (!analysis.success) {
    throw new Error(analysis.error);
  }

  // Fail-closed: 응답을 해석할 수 없으면 통과시키지 않고 거부
  if (analysis.missing.length > 0) {
    console.log(`[${label} 검열 완료] 검열 응답 해석 불가 (미응답 ${analysis.missing.length}건) - 업로드 거부 (fail-closed)`);
    return {
      ok: false,
      response: jsonResponse({
        success: false,
        error: '검열 결과를 확인할 수 없어 업로드가 거부되었습니다. 다시 시도해주세요.'
      }, 400)
    };
  }

  if (analysis.flagged.length > 0) {
    const reasons = analysis.flagged.map(f => f.label);
    console.log(`[${label} 검열 완료] 부적절한 콘텐츠 감지 - 업로드 거부: ${reasons.join(', ')}`);
    return {
      ok: false,
      response: jsonResponse({
        success: false,
        error: `업로드가 거부되었습니다. 부적절한 콘텐츠 감지: ${reasons.join(', ')}`
      }, 400)
    };
  }

  console.log(`[${label} 검열 완료] 적절한 콘텐츠 - 업로드 허용`);
  return { ok: true };
}

/**
 * 이미지 검열 - Workers AI clef-omni
 * @param {File} file - 검열할 이미지 파일
 * @param {Object} env - 환경 변수 (env.AI 바인딩 필요)
 * @returns {Object} - 검열 결과
 */
export async function handleImageCensorship(file, env) {
  try {
    return await runCensorship(env, file, 'image', '이미지');
  } catch (e) {
    console.log('handleImageCensorship 오류:', e);
    return {
      ok: false,
      response: jsonResponse({ success: false, error: `이미지 검열 중 오류 발생: ${e.message}` }, 500)
    };
  }
}

/**
 * 동영상 검열 - Workers AI clef-omni
 * @param {File} file - 검열할 동영상 파일
 * @param {Object} env - 환경 변수 (env.AI 바인딩 필요)
 * @returns {Object} - 검열 결과
 */
export async function handleVideoCensorship(file, env) {
  try {
    return await runCensorship(env, file, 'video', '동영상');
  } catch (e) {
    console.log('handleVideoCensorship 오류:', e);
    return {
      ok: false,
      response: jsonResponse({ success: false, error: `동영상 검열 중 오류 발생: ${e.message}` }, 500)
    };
  }
}
