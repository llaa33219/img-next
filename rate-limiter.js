// ==============================
// 레이트 리미팅 관리
// ==============================

// IP별 요청 기록 및 차단 관리
const rateLimitData = new Map();
const blockedIPs = new Map();

/**
 * 레이트 리미팅 검사 함수
 * @param {string} clientIP - 클라이언트 IP 주소
 * @returns {Object} - 차단 여부와 관련 정보
 */
export function checkRateLimit(clientIP) {
  const now = Date.now();
  
  // 차단된 IP 확인
  if (blockedIPs.has(clientIP)) {
    const blockInfo = blockedIPs.get(clientIP);
    if (now < blockInfo.unblockTime) {
      const remainingTime = Math.ceil((blockInfo.unblockTime - now) / 1000);
      return {
        blocked: true,
        reason: blockInfo.reason,
        remainingTime: remainingTime
      };
    } else {
      // 차단 시간이 지났으므로 해제
      blockedIPs.delete(clientIP);
    }
  }
  
  // 현재 IP의 요청 기록 가져오기 또는 생성
  if (!rateLimitData.has(clientIP)) {
    rateLimitData.set(clientIP, {
      requests: [],
      lastCleanup: now
    });
  }
  
  const ipData = rateLimitData.get(clientIP);
  
  // 오래된 요청 기록 정리 (1시간 이상 된 것)
  if (now - ipData.lastCleanup > 60000) { // 1분마다 정리
    ipData.requests = ipData.requests.filter(time => now - time < 3600000); // 1시간
    ipData.lastCleanup = now;
  }
  
  // 현재 요청 추가
  ipData.requests.push(now);
  
  // 1분 내 요청 수 확인 (20개 초과시 5분 차단)
  const oneMinuteAgo = now - 60000;
  const recentRequests = ipData.requests.filter(time => time > oneMinuteAgo);
  
  if (recentRequests.length > 20) {
    const unblockTime = now + (5 * 60 * 1000); // 5분 후
    blockedIPs.set(clientIP, {
      unblockTime: unblockTime,
      reason: '1분 내 20개 초과 업로드'
    });
    return {
      blocked: true,
      reason: '1분 내 20개 초과 업로드로 인한 5분 차단',
      remainingTime: 300
    };
  }
  
  // 1시간 내 요청 수 확인 (100개 초과시 1시간 차단)
  const oneHourAgo = now - 3600000;
  const hourlyRequests = ipData.requests.filter(time => time > oneHourAgo);
  
  if (hourlyRequests.length > 100) {
    const unblockTime = now + (60 * 60 * 1000); // 1시간 후
    blockedIPs.set(clientIP, {
      unblockTime: unblockTime,
      reason: '1시간 내 100개 초과 업로드'
    });
    return {
      blocked: true,
      reason: '1시간 내 100개 초과 업로드로 인한 1시간 차단',
      remainingTime: 3600
    };
  }
  
  return { blocked: false };
}

/**
 * 메모리 정리 함수 (주기적으로 호출)
 */
export function cleanupOldData() {
  const now = Date.now();
  const oneHourAgo = now - 3600000;
  
  // 오래된 요청 기록 정리
  for (const [ip, data] of rateLimitData.entries()) {
    data.requests = data.requests.filter(time => time > oneHourAgo);
    if (data.requests.length === 0) {
      rateLimitData.delete(ip);
    }
  }
  
  // 만료된 차단 기록 정리
  for (const [ip, blockInfo] of blockedIPs.entries()) {
    if (now >= blockInfo.unblockTime) {
      blockedIPs.delete(ip);
    }
  }
  
  console.log(`[Cleanup] 레이트 리미팅 데이터 정리 완료. 활성 IP: ${rateLimitData.size}, 차단된 IP: ${blockedIPs.size}`);
}

