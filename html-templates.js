// ==============================
// HTML 템플릿 렌더링
// ==============================

/**
 * 최종 HTML 렌더링
 * @param {string} mediaTags - 미디어 태그들 (img/video)
 * @param {string} host - 호스트명
 * @returns {string} - 렌더링된 HTML
 */
export function renderHTML(mediaTags, host) {
  return `<!DOCTYPE html>
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
        /* color: white; */
        /* border: none; */
        /* border-radius: 20px; */
        /* padding: 10px 20px; */
        /* margin: 20px 0; */
        /* width: 600px; */
        height: 61px;
        /* box-shadow: 0 4px 6px rgba(0, 0, 0, 0.2); */
        cursor: pointer;
        transition: background-color 0.3s ease, transform 0.1s ease, box-shadow 0.3s ease;
        font-weight: bold;
        font-size: 18px;
        text-align: center;
    }
  
    button:hover {
        /* background-color: #005BDD; */
        /* transform: translateY(2px); */
        /* box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2); */
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
    
    #imageContainer img {
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
  
    #imageContainer img.landscape {
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

    /* 전체화면 모달 스타일 */
    .image-modal {
      display: none;
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0, 0, 0, 0.9);
    }

    .modal-content {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
    }

         .modal-image {
       max-width: 90%;
       max-height: 90%;
       transform-origin: center;
       transition: transform 0.3s ease;
       cursor: grab;
       touch-action: manipulation; /* 모바일 더블탭 확대 방지 */
       user-select: none; /* 텍스트 선택 방지 */
       -webkit-user-select: none;
       -moz-user-select: none;
       -ms-user-select: none;
     }

     .modal-image:active {
       cursor: grabbing;
     }

     .modal-image.dragging {
       transition: none; /* 드래그 중 애니메이션 제거 */
       cursor: grabbing;
     }

    /* 컨트롤 패널 */
    .modal-controls {
      position: absolute;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 10px;
      background: rgba(0, 0, 0, 0.7);
      padding: 10px;
      border-radius: 25px;
    }

    .control-btn {
      background: rgba(255, 255, 255, 0.2);
      border: none;
      color: white;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      transition: background 0.3s ease;
    }

    .control-btn:hover {
      background: rgba(255, 255, 255, 0.3);
    }

    /* 닫기 버튼 */
    .modal-close {
      position: absolute;
      top: 20px;
      right: 30px;
      color: white;
      font-size: 40px;
      font-weight: bold;
      cursor: pointer;
      z-index: 1001;
    }

    .modal-close:hover {
      opacity: 0.7;
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
    .player-container video {
        width: 40vw;
        height: auto;
        }
    /* Custom Context Menu Styles */
    .custom-context-menu {
      position: absolute;
      background: white;
      border: 1px solid #ccc;
      padding: 5px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.2);
      z-index: 1000;
      border-radius: 10px;
    }
    .custom-context-menu button {
        display: block;
        width: 100%;
        border: none;
        background: none;
        /* padding: 5px 10px; */
        text-align: left;
        cursor: pointer;
    }
    .custom-context-menu button:hover {
      background: #eee;
    }
  </style>
  <link rel="stylesheet" href="https://llaa33219.github.io/BLOUplayer/videoPlayer.css">
  <script src="https://llaa33219.github.io/BLOUplayer/videoPlayer.js"></script>
</head>
<body>
  <div class="header-content">
    <img src="https://i.imgur.com/2MkyDCh.png" alt="Logo" style="width: 120px; height: auto; cursor: pointer;" onclick="location.href='/';">
      <h1 class="title-img-desktop">이미지 공유</h1>
      <h1 class="title-img-mobile">이미지<br>공유</h1>
  </div>
  <div id="imageContainer">
    ${mediaTags}
  </div>
  
  <!-- 전체화면 이미지 모달 -->
  <div id="imageModal" class="image-modal">
    <span class="modal-close" id="modalClose">&times;</span>
    <div class="modal-content">
      <img id="modalImage" class="modal-image" src="" alt="확대된 이미지" draggable="false">
      <div class="modal-controls">
        <button class="control-btn" id="zoomIn" title="확대">+</button>
        <button class="control-btn" id="zoomOut" title="축소">-</button>
        <button class="control-btn" id="rotateLeft" title="왼쪽 회전">↶</button>
        <button class="control-btn" id="rotateRight" title="오른쪽 회전">↷</button>
        <button class="control-btn" id="resetView" title="원래 크기">⟲</button>
      </div>
    </div>
  </div>
  
  <div class="custom-context-menu" id="customContextMenu" style="display: none;">
      <button id="copyImage">이미지 복사</button>
      <button id="copyImageurl">이미지 링크 복사</button>
      <button id="downloadImage">다운로드</button>
      <button id="downloadImagepng">png로 다운로드</button>
  </div>
  <script>
    // 새로운 이미지 뷰어 기능
    class ImageViewer {
      constructor() {
        this.modal = document.getElementById('imageModal');
        this.modalImage = document.getElementById('modalImage');
        this.closeBtn = document.getElementById('modalClose');
        this.zoomInBtn = document.getElementById('zoomIn');
        this.zoomOutBtn = document.getElementById('zoomOut');
        this.rotateLeftBtn = document.getElementById('rotateLeft');
        this.rotateRightBtn = document.getElementById('rotateRight');
        this.resetBtn = document.getElementById('resetView');
        
        this.scale = 1;
        this.rotation = 0;
        this.posX = 0;
        this.posY = 0;
        this.isDragging = false;
        this.startX = 0;
        this.startY = 0;
        
        this.init();
      }
      
      init() {
        // 이벤트 리스너 등록
        this.closeBtn.addEventListener('click', () => this.closeModal());
        this.modal.addEventListener('click', (e) => {
          if (e.target === this.modal) this.closeModal();
        });
        
        // 컨트롤 버튼 이벤트
        this.zoomInBtn.addEventListener('click', () => this.zoomIn());
        this.zoomOutBtn.addEventListener('click', () => this.zoomOut());
        this.rotateLeftBtn.addEventListener('click', () => this.rotateLeft());
        this.rotateRightBtn.addEventListener('click', () => this.rotateRight());
        this.resetBtn.addEventListener('click', () => this.resetView());
        
                 // 마우스 드래그 이벤트
         this.modalImage.addEventListener('mousedown', (e) => this.startDrag(e));
         document.addEventListener('mousemove', (e) => this.drag(e));
         document.addEventListener('mouseup', () => this.endDrag());
         
         // 터치 드래그 이벤트 (모바일)
         this.modalImage.addEventListener('touchstart', (e) => this.startTouch(e));
         document.addEventListener('touchmove', (e) => this.touchMove(e));
         document.addEventListener('touchend', () => this.endDrag());
         
         // 브라우저 기본 드래그 및 더블탭 확대 방지
         this.modalImage.addEventListener('dragstart', (e) => e.preventDefault());
         this.modalImage.addEventListener('gesturestart', (e) => e.preventDefault());
         this.modalImage.addEventListener('gesturechange', (e) => e.preventDefault());
         this.modalImage.addEventListener('gestureend', (e) => e.preventDefault());
        
        // 마우스 휠로 확대/축소
        this.modalImage.addEventListener('wheel', (e) => this.handleWheel(e));
        
        // ESC 키로 닫기
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && this.modal.style.display === 'block') {
            this.closeModal();
          }
        });
        
        // 이미지 클릭 이벤트 등록
        this.setupImageClickHandlers();
      }
      
      setupImageClickHandlers() {
        document.querySelectorAll('#imageContainer img').forEach(img => {
          this.addClickHandler(img);
        });
      }
      
      addClickHandler(img) {
        img.addEventListener('click', (e) => {
          e.preventDefault();
          this.openModal(img.src);
        });
      }
      
      openModal(imageSrc) {
        this.modalImage.src = imageSrc;
        this.modal.style.display = 'block';
        this.resetView();
        document.body.style.overflow = 'hidden';
      }
      
      closeModal() {
        this.modal.style.display = 'none';
        document.body.style.overflow = 'auto';
      }
      
      zoomIn() {
        this.scale = Math.min(this.scale * 1.2, 5);
        this.updateTransform();
      }
      
      zoomOut() {
        this.scale = Math.max(this.scale / 1.2, 0.1);
        this.updateTransform();
      }
      
      rotateLeft() {
        this.rotation -= 90;
        this.updateTransform();
      }
      
      rotateRight() {
        this.rotation += 90;
        this.updateTransform();
      }
      
      resetView() {
        this.scale = 1;
        this.rotation = 0;
        this.posX = 0;
        this.posY = 0;
        this.updateTransform();
      }
      
             startDrag(e) {
         if (this.scale > 1) {
           this.isDragging = true;
           this.startX = e.clientX - this.posX;
           this.startY = e.clientY - this.posY;
           this.modalImage.classList.add('dragging');
           e.preventDefault();
         }
       }
       
       startTouch(e) {
         if (this.scale > 1 && e.touches.length === 1) {
           this.isDragging = true;
           const touch = e.touches[0];
           this.startX = touch.clientX - this.posX;
           this.startY = touch.clientY - this.posY;
           this.modalImage.classList.add('dragging');
           e.preventDefault();
         }
       }
       
       drag(e) {
         if (this.isDragging) {
           this.posX = e.clientX - this.startX;
           this.posY = e.clientY - this.startY;
           this.updateTransform();
         }
       }
       
       touchMove(e) {
         if (this.isDragging && e.touches.length === 1) {
           const touch = e.touches[0];
           this.posX = touch.clientX - this.startX;
           this.posY = touch.clientY - this.startY;
           this.updateTransform();
           e.preventDefault();
         }
       }
       
       endDrag() {
         if (this.isDragging) {
           this.isDragging = false;
           this.modalImage.classList.remove('dragging');
         }
       }
      
      handleWheel(e) {
        e.preventDefault();
        if (e.deltaY < 0) {
          this.zoomIn();
        } else {
          this.zoomOut();
        }
      }
      
      updateTransform() {
        const transform = \`translate(\${this.posX}px, \${this.posY}px) scale(\${this.scale}) rotate(\${this.rotation}deg)\`;
        this.modalImage.style.transform = transform;
      }
    }
    
    // 이미지 뷰어 초기화
    document.addEventListener('DOMContentLoaded', () => {
      new ImageViewer();
    });
    
    document.getElementById('toggleButton')?.addEventListener('click',function(){
      window.location.href='/';
    });
    
    // Custom Context Menu Functionality
    let currentImage = null;
    const contextMenu = document.getElementById('customContextMenu');

    document.getElementById('imageContainer').addEventListener('contextmenu', function(e) {
        if(e.target.tagName.toLowerCase() === 'img'){
            e.preventDefault();
            currentImage = e.target;
            contextMenu.style.top = e.pageY + 'px';
            contextMenu.style.left = e.pageX + 'px';
            contextMenu.style.display = 'block';
        }
    });

    // Hide context menu on document click
    document.addEventListener('click', function(e) {
        if(contextMenu.style.display === 'block'){
            contextMenu.style.display = 'none';
        }
    });

    // "이미지 복사" 버튼 클릭
    document.getElementById('copyImage').addEventListener('click', async function(){
        if(currentImage){
            try {
                const response = await fetch(currentImage.src);
                const blob = await response.blob();
                await navigator.clipboard.write([
                    new ClipboardItem({ [blob.type]: blob })
                ]);
                alert('이미지 복사됨');
            } catch(err) {
                alert('이미지 복사 실패: ' + err.message);
            }
        }
    });

    // "이미지 링크 복사" 버튼 클릭
    document.getElementById('copyImageurl').addEventListener('click', async function(){
        if(currentImage){
            try {
                await navigator.clipboard.writeText(currentImage.src);
                alert('이미지 링크 복사됨');
            } catch(err) {
                alert('이미지 링크 복사 실패: ' + err.message);
            }
        }
    });

    // "다운로드" 버튼 클릭 (원본 이미지 다운로드)
    document.getElementById('downloadImage').addEventListener('click', function(){
        if(currentImage){
            const a = document.createElement('a');
            a.href = currentImage.src;
            a.download = 'image';
            document.body.appendChild(a);
            a.click();
            a.remove();
        }
    });

    // "png로 다운로드" 버튼 클릭 (이미지를 png로 변환하여 다운로드)
    document.getElementById('downloadImagepng').addEventListener('click', function(){
        if(currentImage){
            const canvas = document.createElement('canvas');
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = function(){
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                canvas.toBlob(function(blob){
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = 'image.png';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                }, 'image/png');
            };
            img.src = currentImage.src;
        }
    });
  </script>
</body>
</html>`;
}

/**
 * API 문서 HTML 렌더링
 * @param {string} host - 호스트명
 * @returns {string} - 렌더링된 API 문서 HTML
 */
export function renderApiDocs(host) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="https://i.imgur.com/2MkyDCh.png" type="image/png">
  <title>이미지 공유 API 문서</title>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      color: #333;
    }
    h1, h2, h3 {
      color: #0066cc;
    }
    .endpoint {
      background-color: #f5f5f5;
      border-left: 4px solid #0066cc;
      padding: 10px;
      margin: 20px 0;
    }
    code {
      background-color: #f0f0f0;
      padding: 2px 5px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
    }
    pre {
      background-color: #f0f0f0;
      padding: 15px;
      border-radius: 5px;
      overflow-x: auto;
      font-family: 'Courier New', monospace;
    }
    .method {
      font-weight: bold;
      color: #ffffff;
      border-radius: 3px;
      padding: 2px 5px;
      margin-right: 5px;
    }
    .get {
      background-color: #61affe;
    }
    .post {
      background-color: #49cc90;
    }
    .delete {
      background-color: #f93e3e;
    }
    .put {
      background-color: #fca130;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 10px;
      text-align: left;
    }
    th {
      background-color: #f0f0f0;
    }
    .example {
      margin-top: 20px;
    }
    .header {
      display: flex;
      align-items: center;
      margin-bottom: 20px;
    }
    .header img {
      width: 60px;
      height: auto;
      margin-right: 15px;
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <img src="https://i.imgur.com/2MkyDCh.png" alt="Logo">
    <h1>이미지 공유 API 문서</h1>
  </div>
  
  <p>이 API는 외부 애플리케이션에서 이미지 및 동영상을 업로드하고 공유할 수 있는 기능을 제공합니다. 모든 콘텐츠는 업로드 전 자동 검열됩니다.</p>
  
  <h2>엔드포인트</h2>
  
  <div class="endpoint">
    <h3><span class="method post">POST</span> /api/upload</h3>
    <p>이미지 또는 동영상 파일을 업로드합니다. 모든 파일은 자동으로 부적절한 콘텐츠 검열을 거칩니다.</p>
    
    <h4>요청 형식</h4>
    <p>요청은 <code>multipart/form-data</code> 형식이어야 합니다.</p>
    
    <table>
      <tr>
        <th>파라미터</th>
        <th>타입</th>
        <th>필수</th>
        <th>설명</th>
      </tr>
      <tr>
        <td>file</td>
        <td>File</td>
        <td>예</td>
        <td>업로드할 이미지 또는 동영상 파일. 여러 파일 업로드 가능.</td>
      </tr>
      <tr>
        <td>customName</td>
        <td>String</td>
        <td>아니오</td>
        <td>사용자 지정 파일 이름 (단일 파일 업로드 시에만 유효).</td>
      </tr>
    </table>
    
    <h4>지원 파일 형식</h4>
    <ul>
      <li>이미지: JPEG, PNG, GIF, WEBP</li>
      <li>동영상: MP4, WEBM, OGG, AVI</li>
    </ul>
    
    <h4>응답</h4>
    <p>성공 시 응답 (200 OK):</p>
    <pre>{
  "success": true,
  "url": "https://${host}/ABC123",
  "rawUrls": ["https://${host}/ABC123?raw=1"],
  "codes": ["ABC123"],
  "fileTypes": ["image/jpeg"]
}</pre>
    
    <p>파일 형식 오류 (400 Bad Request):</p>
    <pre>{
  "success": false,
  "error": "지원하지 않는 파일 형식입니다."
}</pre>
    
    <p>검열 실패 (400 Bad Request):</p>
    <pre>{
  "success": false,
  "error": "검열됨: 선정적 콘텐츠, 폭력/무기 콘텐츠"
}</pre>
    
    <p>서버 오류 (500 Internal Server Error):</p>
    <pre>{
  "success": false,
  "error": "검열 처리 중 오류: [오류 메시지]"
}</pre>
    
    <p>레이트 리미팅 (429 Too Many Requests):</p>
    <pre>{
  "success": false,
  "error": "보안상 업로드가 제한되었습니다. 1분 내 20개 초과 업로드로 인한 5분 차단. 300초 후 다시 시도하세요.",
  "rateLimited": true,
  "remainingTime": 300
}</pre>
  </div>
  
  <h2>레이트 리미팅</h2>
  <div class="endpoint">
    <h3>업로드 제한</h3>
    <p>보안을 위해 다음과 같은 레이트 리미팅이 적용됩니다:</p>
    <ul>
      <li><strong>1분 제한:</strong> 동일한 IP에서 1분 내 20개 이상 업로드 시 5분간 차단</li>
      <li><strong>1시간 제한:</strong> 동일한 IP에서 1시간 내 100개 이상 업로드 시 1시간 차단</li>
    </ul>
    <p>제한 초과 시 HTTP 429 상태 코드와 함께 차단 해제까지 남은 시간이 응답됩니다.</p>
  </div>
  
  <h2>코드 예제</h2>
  
  <div class="example">
    <h3>cURL</h3>
    <pre>curl -X POST https://${host}/api/upload \
  -F "file=@/path/to/image.jpg"</pre>
  </div>
  
  <div class="example">
    <h3>JavaScript (fetch)</h3>
    <pre>const formData = new FormData();
formData.append('file', fileInput.files[0]);

fetch('https://${host}/api/upload', {
  method: 'POST',
  body: formData
})
.then(response => response.json())
.then(data => {
  if (data.success) {
    console.log('업로드 성공:', data.url);
  } else {
    console.error('업로드 실패:', data.error);
  }
})
.catch(error => {
  console.error('요청 오류:', error);
});</pre>
  </div>
  
  <div class="example">
    <h3>Python (requests)</h3>
    <pre>import requests

url = 'https://${host}/api/upload'
files = {'file': open('image.jpg', 'rb')}

response = requests.post(url, files=files)
data = response.json()

if data['success']:
    print('업로드 성공:', data['url'])
else:
    print('업로드 실패:', data['error'])</pre>
  </div>
  
  <h2>노트</h2>
  <ul>
    <li>모든 업로드된 파일은 자동 검열 시스템을 통과해야 합니다.</li>
    <li>대용량 파일 업로드 시 서버 처리 시간이 길어질 수 있습니다.</li>
    <li>기본적으로 랜덤 코드가 생성되지만, <code>customName</code> 파라미터를 통해 사용자 지정 이름을 부여할 수 있습니다.</li>
    <li>동일한 사용자 지정 이름이 이미 존재하는 경우 업로드가 실패합니다.</li>
    <li>외부 도메인에서 API 요청 시 CORS 헤더가 자동으로 추가됩니다.</li>
  </ul>
</body>
</html>`;
}

