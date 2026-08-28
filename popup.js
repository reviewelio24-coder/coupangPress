// 팝업 스크립트
class PopupController {
  constructor() {
    this.isCrawling = false;
    this.reviews = [];
    this.currentTab = null;
    
    this.initializeElements();
    this.attachEventListeners();
    this.checkCurrentPage();
    this.loadStoredData();
    this.loadBridgeSettings();
  }

  initializeElements() {
    this.startBtn = document.getElementById('startBtn');
    this.stopBtn = document.getElementById('stopBtn');
    this.exportBtn = document.getElementById('exportBtn');
    this.viewBtn = document.getElementById('viewBtn');
    this.maxPagesInput = document.getElementById('maxPages');
    this.statusIndicator = document.getElementById('statusIndicator');
    this.statusText = document.querySelector('.status-text');
    this.statusDot = document.querySelector('.status-dot');
    this.progressInfo = document.getElementById('progressInfo');
    this.progressFill = document.getElementById('progressFill');
    this.progressText = document.getElementById('progressText');
    this.resultsSection = document.getElementById('resultsSection');
    this.resultsCount = document.getElementById('resultsCount');
    this.currentPageSpan = document.getElementById('currentPage');
    this.collectedReviewsSpan = document.getElementById('collectedReviews');
    this.reviewModal = document.getElementById('reviewModal');
    this.modalBody = document.getElementById('modalBody');
    this.closeModal = document.getElementById('closeModal');
    this.openDashboardBtn = document.getElementById('openDashboardBtn');
    this.bridgeEnabledInput = document.getElementById('bridgeEnabled');
    this.bridgeApiUrlInput = document.getElementById('bridgeApiUrl');
    this.bridgeBasicUserInput = document.getElementById('bridgeBasicUser');
    this.bridgeBasicPassInput = document.getElementById('bridgeBasicPass');
    this.saveBridgeBtn = document.getElementById('saveBridgeBtn');
    this.bridgeConnStatus = document.getElementById('bridgeConnStatus');
  }

  attachEventListeners() {
    this.startBtn.addEventListener('click', () => this.startCrawling());
    this.stopBtn.addEventListener('click', () => this.stopCrawling());
    this.exportBtn.addEventListener('click', () => this.exportToExcel());
    this.viewBtn.addEventListener('click', () => this.showReviews());
    this.closeModal.addEventListener('click', () => this.hideModal());
    this.openDashboardBtn.addEventListener('click', () => this.openDashboard());
    this.bridgeEnabledInput.addEventListener('change', () => this.saveBridgeSettings());
    this.saveBridgeBtn?.addEventListener('click', () => this.saveBridgeSettings());
    
    
    // 모달 외부 클릭 시 닫기
    this.reviewModal.addEventListener('click', (e) => {
      if (e.target === this.reviewModal) {
        this.hideModal();
      }
    });

    // 메시지 리스너
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      this.handleMessage(request);
    });
  }

  async checkCurrentPage() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      this.currentTab = tab;
      
      if (tab.url && tab.url.includes('coupang.com/vp/products/')) {
        this.updateStatus('ready', '쿠팡 상품 페이지 감지됨');
        this.startBtn.disabled = false;
      } else {
        this.updateStatus('error', '쿠팡 상품 페이지가 아닙니다');
        this.startBtn.disabled = true;
      }
    } catch (error) {
      console.error('현재 페이지 확인 중 오류:', error);
      this.updateStatus('error', '페이지 확인 실패');
    }
  }

  async loadStoredData() {
    try {
      const result = await chrome.storage.local.get(['coupang_reviews']);
      if (result.coupang_reviews) {
        this.reviews = result.coupang_reviews.reviews || [];
        this.updateResultsDisplay();
      }
    } catch (error) {
      console.error('저장된 데이터 로드 중 오류:', error);
    }
  }

  async loadBridgeSettings() {
    try {
      const { bridge_settings: s } = await chrome.storage.local.get(['bridge_settings']);
      this.bridgeEnabledInput.checked = s?.enabled !== false;
      if (this.bridgeApiUrlInput) {
        this.bridgeApiUrlInput.value = s?.apiBaseUrl || 'https://review.choineiu.com';
      }
      if (this.bridgeBasicUserInput) {
        this.bridgeBasicUserInput.value = s?.basicUser || 'admin';
      }
      if (this.bridgeBasicPassInput) {
        this.bridgeBasicPassInput.value = s?.basicPass || '';
      }
      await this.refreshBridgeStatus();
    } catch (error) {
      console.error('연동 설정 로드 오류:', error);
    }
  }

  async refreshBridgeStatus() {
    if (!this.bridgeConnStatus) return;
    this.bridgeConnStatus.className = 'bridge-conn wait';
    this.bridgeConnStatus.textContent = '서버 연결 확인 중…';
    try {
      const st = await chrome.runtime.sendMessage({ type: 'GET_BRIDGE_STATUS' });
      if (!this.bridgeEnabledInput.checked) {
        this.bridgeConnStatus.className = 'bridge-conn bad';
        this.bridgeConnStatus.textContent = '연동 OFF — 체크박스를 켜 주세요';
        return;
      }
      if (st?.serverReachable) {
        this.bridgeConnStatus.className = 'bridge-conn ok';
        this.bridgeConnStatus.textContent = `서버 연결됨 (${st.apiBaseUrl})`;
      } else {
        this.bridgeConnStatus.className = 'bridge-conn bad';
        const hint = st?.error ? ` — ${st.error}` : '';
        const auth = st?.hasBasicAuth ? '' : ' — Basic Auth 비밀번호를 입력하세요';
        this.bridgeConnStatus.textContent =
          `서버 연결 실패 (${st?.apiBaseUrl || '?'})${hint}${auth}`;
      }
    } catch (_) {
      this.bridgeConnStatus.className = 'bridge-conn bad';
      this.bridgeConnStatus.textContent = '백그라운드와 통신 실패 — 확장을 새로고침하세요';
    }
  }

  async saveBridgeSettings() {
    const apiBaseUrl = (this.bridgeApiUrlInput?.value || 'https://review.choineiu.com').trim().replace(/\/$/, '');
    await chrome.runtime.sendMessage({
      type: 'SET_BRIDGE_ENABLED',
      enabled: this.bridgeEnabledInput.checked,
      apiBaseUrl,
      basicUser: this.bridgeBasicUserInput?.value || '',
      basicPass: this.bridgeBasicPassInput?.value || ''
    });
    await this.refreshBridgeStatus();
  }

  async openDashboard() {
    await chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
  }

  async startCrawling() {
    if (this.isCrawling) return;

    try {
      // 현재 페이지가 쿠팡 상품 페이지인지 다시 확인
      await this.checkCurrentPage();
      
      if (!this.currentTab || !this.currentTab.url.includes('coupang.com/vp/products/')) {
        this.updateStatus('error', '쿠팡 상품 페이지에서만 사용할 수 있습니다');
        return;
      }

      this.isCrawling = true;
      this.updateStatus('crawling', '크롤링 시작...');
      this.startBtn.disabled = true;
      this.stopBtn.disabled = false;
      this.progressInfo.style.display = 'block';
      this.resultsSection.style.display = 'none';

      // 콘텐츠 스크립트 주입 및 크롤링 시작
      try {
        // 먼저 콘텐츠 스크립트를 동적으로 주입
        await this.injectContentScript();
        
        // 잠시 대기 후 메시지 전송
        await this.wait(500);
        
        const response = await chrome.tabs.sendMessage(this.currentTab.id, {
          type: 'START_CRAWLING',
          maxPages: parseInt(this.maxPagesInput.value) || 5
        });
        
        console.log('크롤링 시작 메시지 전송 완료:', response);
        
        if (response && response.success) {
          this.updateStatus('crawling', '크롤링이 시작되었습니다...');
        }
        
      } catch (messageError) {
        console.error('메시지 전송 오류:', messageError);
        
        // 콘텐츠 스크립트 주입을 다시 시도
        this.updateStatus('crawling', '콘텐츠 스크립트 주입 중...');
        
        try {
          await this.injectContentScript();
          await this.wait(1000);
          
          const retryResponse = await chrome.tabs.sendMessage(this.currentTab.id, {
            type: 'START_CRAWLING',
            maxPages: parseInt(this.maxPagesInput.value) || 5
          });
          
          console.log('재시도로 크롤링 시작 메시지 전송 완료:', retryResponse);
          
          if (retryResponse && retryResponse.success) {
            this.updateStatus('crawling', '크롤링이 시작되었습니다...');
          }
          
        } catch (retryError) {
          console.error('재시도도 실패:', retryError);
          this.updateStatus('error', '콘텐츠 스크립트 주입 실패. 페이지를 새로고침해주세요.');
          this.resetButtons();
        }
      }

    } catch (error) {
      console.error('크롤링 시작 중 오류:', error);
      this.updateStatus('error', '크롤링 시작 실패: ' + error.message);
      this.resetButtons();
    }
  }

  async stopCrawling() {
    try {
      await chrome.tabs.sendMessage(this.currentTab.id, {
        type: 'STOP_CRAWLING'
      });
      
      this.isCrawling = false;
      this.updateStatus('ready', '크롤링이 중지되었습니다');
      this.resetButtons();
      this.progressInfo.style.display = 'none';
      
    } catch (error) {
      console.error('크롤링 중지 중 오류:', error);
    }
  }

  async exportToExcel() {
    try {
      await chrome.tabs.sendMessage(this.currentTab.id, {
        type: 'EXPORT_EXCEL'
      });
      
      this.showNotification('CSV 파일이 다운로드되었습니다!', 'success');
    } catch (error) {
      console.error('CSV 내보내기 중 오류:', error);
      this.showNotification('CSV 내보내기 실패', 'error');
    }
  }

  showReviews() {
    if (this.reviews.length === 0) {
      this.showNotification('표시할 리뷰가 없습니다', 'warning');
      return;
    }

    this.renderReviews();
    this.reviewModal.style.display = 'flex';
  }

  hideModal() {
    this.reviewModal.style.display = 'none';
  }

  renderReviews() {
    this.modalBody.innerHTML = '';
    
    this.reviews.slice(0, 20).forEach(review => { // 처음 20개만 표시
      const reviewElement = document.createElement('div');
      reviewElement.className = 'review-item';
      
      const stars = '★'.repeat(review.rating || 0) + '☆'.repeat(5 - (review.rating || 0));
      
      reviewElement.innerHTML = `
        <div class="review-header">
          <span class="review-rating">${stars} (${review.rating || 0}/5)</span>
          <span class="review-author">${review.author || '익명'}</span>
        </div>
        <div class="review-title">${review.title || '제목 없음'}</div>
        <div class="review-content">${review.content || '내용 없음'}</div>
        <div class="review-meta">
          <span>${review.date || '날짜 없음'}</span>
          <span>도움됨: ${review.helpful || 0}</span>
        </div>
      `;
      
      this.modalBody.appendChild(reviewElement);
    });

    if (this.reviews.length > 20) {
      const moreElement = document.createElement('div');
      moreElement.style.textAlign = 'center';
      moreElement.style.padding = '10px';
      moreElement.style.color = '#7f8c8d';
      moreElement.textContent = `... 및 ${this.reviews.length - 20}개 더`;
      this.modalBody.appendChild(moreElement);
    }
  }

  handleMessage(request) {
    switch (request.type) {
      case 'CRAWLING_COMPLETE':
        this.handleCrawlingComplete(request.data);
        break;
      case 'CRAWLING_ERROR':
        this.handleCrawlingError(request.error);
        break;
      case 'CRAWLING_PROGRESS':
        this.handleCrawlingProgress(request.data);
        break;
    }
  }

  handleCrawlingComplete(data) {
    this.isCrawling = false;
    this.reviews = data.reviews || [];
    
    this.updateStatus('success', `크롤링 완료! ${data.totalReviews}개 리뷰 수집`);
    this.updateResultsDisplay();
    this.resetButtons();
    this.progressInfo.style.display = 'none';
    
    this.showNotification(`${data.totalReviews}개 리뷰가 성공적으로 수집되었습니다!`, 'success');
  }

  handleCrawlingError(error) {
    this.isCrawling = false;
    this.updateStatus('error', `크롤링 오류: ${error}`);
    this.resetButtons();
    this.progressInfo.style.display = 'none';
    
    this.showNotification('크롤링 중 오류가 발생했습니다', 'error');
  }

  handleCrawlingProgress(data) {
    const progress = (data.currentPage / data.maxPages) * 100;
    this.progressFill.style.width = `${progress}%`;
    this.progressText.textContent = `페이지 ${data.currentPage}/${data.maxPages} 크롤링 중... (${data.pageReviews}개 리뷰 수집)`;
    this.currentPageSpan.textContent = data.currentPage;
    this.collectedReviewsSpan.textContent = `${data.collectedReviews}개`;
    
    console.log('크롤링 진행 상황:', data);
  }

  updateStatus(type, message) {
    this.statusText.textContent = message;
    this.statusDot.className = 'status-dot';
    
    switch (type) {
      case 'ready':
        this.statusDot.classList.add('active');
        break;
      case 'crawling':
        this.statusDot.classList.add('crawling');
        break;
      case 'success':
        this.statusDot.classList.add('active');
        break;
      case 'error':
        this.statusDot.style.background = '#e74c3c';
        break;
    }
  }

  updateResultsDisplay() {
    if (this.reviews.length > 0) {
      this.resultsSection.style.display = 'block';
      this.resultsCount.textContent = `${this.reviews.length}개 리뷰`;
      this.collectedReviewsSpan.textContent = `${this.reviews.length}개`;
    }
  }

  resetButtons() {
    this.startBtn.disabled = false;
    this.stopBtn.disabled = true;
    this.isCrawling = false;
    this.progressInfo.style.display = 'none';
  }

  // 대기 함수
  wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 콘텐츠 스크립트 동적 주입
  async injectContentScript() {
    try {
      console.log('콘텐츠 스크립트 주입 시작...');
      
      // 먼저 콘텐츠 스크립트가 이미 로드되었는지 확인
      try {
        await chrome.tabs.sendMessage(this.currentTab.id, { type: 'PING' });
        console.log('콘텐츠 스크립트가 이미 로드되어 있습니다.');
        return;
      } catch (pingError) {
        console.log('콘텐츠 스크립트가 로드되지 않았습니다. 주입을 시작합니다.');
      }
      
      // 현재 탭에 content.js 주입
      await chrome.scripting.executeScript({
        target: { tabId: this.currentTab.id },
        files: ['content.js']
      });
      
      console.log('콘텐츠 스크립트 주입 완료');
      
    } catch (error) {
      console.error('콘텐츠 스크립트 주입 오류:', error);
      throw error;
    }
  }



  showNotification(message, type = 'info') {
    // 간단한 알림 표시 (실제로는 더 정교한 알림 시스템을 구현할 수 있음)
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      padding: 10px 15px;
      border-radius: 5px;
      color: white;
      font-size: 12px;
      z-index: 10000;
      max-width: 200px;
    `;
    
    switch (type) {
      case 'success':
        notification.style.background = '#27ae60';
        break;
      case 'error':
        notification.style.background = '#e74c3c';
        break;
      case 'warning':
        notification.style.background = '#f39c12';
        break;
      default:
        notification.style.background = '#3498db';
    }
    
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 3000);
  }
}

// 팝업이 로드되면 컨트롤러 초기화
document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});
