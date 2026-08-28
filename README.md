# 📊 쿠팡 리뷰 크롤러

쿠팡 상품 페이지에서 리뷰를 자동으로 수집하는 Chrome 확장 프로그램입니다.

## ✨ 주요 기능

- **📊 자동 리뷰 수집**: 쿠팡 상품 페이지의 모든 리뷰를 자동으로 크롤링
- **📄 Excel 내보내기**: 수집된 리뷰를 CSV 형식으로 다운로드
- **🔍 상세 정보 추출**: 평점, 제목, 내용, 작성자, 작성일, 도움됨 수 등
- **📝 WordPress 자동 발행**: 웹 대시보드에서 URL 입력 → 확장이 크롤링 → WordPress 업로드

## 🚀 설치 방법

1. 이 저장소를 클론하거나 ZIP 파일로 다운로드
2. Chrome 브라우저에서 `chrome://extensions/` 접속
3. "개발자 모드" 활성화
4. "압축해제된 확장 프로그램을 로드합니다" 클릭
5. 프로젝트 폴더 선택

## 📖 사용 방법

### 1. 쿠팡 상품 페이지 접속
- 리뷰를 수집하고 싶은 쿠팡 상품 페이지로 이동

### 2. 확장 프로그램 실행
- 브라우저 우측 상단의 확장 프로그램 아이콘 클릭
- "쿠팡 리뷰 크롤러" 선택

### 3. 크롤링 설정
- **최대 페이지 수**: 크롤링할 최대 페이지 수 설정 (기본값: 5페이지)
- **시작 버튼**: 크롤링 시작

### 4. 크롤링 모니터링
- 실시간으로 진행 상황 확인
- 현재 페이지, 수집된 리뷰 수 등 표시

### 5. 결과 확인 및 내보내기
- **결과 보기**: 수집된 리뷰 목록 확인
- **Excel 내보내기**: CSV 파일로 다운로드

## 📝 WordPress 자동 발행 (웹앱 · 배포)

**Chrome 확장 없이** VPS/Docker에 올려 `https://your-domain.com` 형태로 사용할 수 있습니다.

### 로컬 실행

```bash
cd server
cp .env.example .env
npm install
npx playwright install chromium
npm start
```

→ http://localhost:8787

### Docker 배포

```bash
cd server
cp .env.example .env   # WORDPRESS_*, OPENAI_*, PUBLIC_URL
docker compose up -d --build
```

상세: [server/DEPLOY.md](server/DEPLOY.md)

### 모드

| `CRAWL_MODE` | 용도 |
|--------------|------|
| `server` (기본) | Playwright 서버 크롤링 — **웹만으로 동작** |
| `extension` | 로컬 PC + Chrome 확장 브릿지 (쿠팡 차단 시) |

배포 시 웹 UI에 API 키를 두지 않습니다. **Nginx Basic Auth / VPN** 등 앞단 인증으로 접근을 제한하세요.

### Chrome 확장 (선택)

로컬에서 `CRAWL_MODE=extension`일 때만 필요합니다. 팝업은 **현재 쿠팡 탭** 수동 크롤링용입니다.

## 📊 추출되는 데이터

각 리뷰에서 다음 정보를 추출합니다:

- **ID**: 리뷰 고유 번호
- **평점**: 1-5점 평점
- **제목**: 리뷰 제목
- **내용**: 리뷰 본문
- **작성자**: 리뷰 작성자명
- **작성일**: 리뷰 작성 날짜
- **도움됨**: 다른 사용자들의 도움됨 수
- **상품정보**: 관련 상품 정보

## 🛠️ 기술 스택

- **JavaScript**: 크롤링 로직 및 UI 구현
- **Chrome Extensions API**: 확장 프로그램 기능
- **DOM 조작**: 웹 페이지 데이터 추출
- **Chrome Storage API**: 데이터 저장 및 관리

## 📁 프로젝트 구조

```
reviewchatbot/
├── manifest.json
├── popup.html / popup.js / popup.css
├── content.js
├── background.js
├── server/                 # WordPress 발행 API
│   ├── index.js
│   ├── lib/generatePost.js
│   ├── lib/wordpress.js
│   └── .env.example
└── README.md
```

## ⚙️ 설정 옵션

### 최대 페이지 수
- 크롤링할 최대 페이지 수를 설정할 수 있습니다
- 기본값: 5페이지
- 범위: 1-50페이지

### 크롤링 속도
- 페이지 간 이동 시 적절한 대기 시간을 두어 안정적인 크롤링을 보장합니다
- 너무 빠른 요청으로 인한 차단을 방지합니다

## 🔧 문제 해결

### 크롤링이 중단되는 경우
1. 네트워크 연결 상태 확인
2. 쿠팡 페이지가 정상적으로 로드되었는지 확인
3. 확장 프로그램을 다시 로드

### 리뷰가 수집되지 않는 경우
1. 상품 페이지에 리뷰가 존재하는지 확인
2. 페이지네이션 구조가 변경되었을 수 있음
3. 개발자 도구 콘솔에서 오류 메시지 확인

### Excel 내보내기가 안 되는 경우
1. 브라우저의 다운로드 권한 확인
2. 수집된 리뷰 데이터가 있는지 확인
3. 파일명에 특수문자가 포함되지 않았는지 확인

## 📝 사용 시 주의사항

- **쿠팡 이용약관 준수**: 쿠팡의 로봇 배제 표준(robots.txt) 및 이용약관을 준수하여 사용하세요
- **적절한 사용**: 과도한 요청으로 서버에 부하를 주지 않도록 적절한 간격으로 사용하세요
- **개인정보 보호**: 수집된 리뷰 데이터를 개인정보보호법에 따라 적절히 관리하세요
- **상업적 이용 제한**: 상업적 목적으로 사용할 때는 관련 법규를 확인하세요

## 🤝 기여하기

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 라이선스

이 프로젝트는 MIT 라이선스 하에 배포됩니다. 자세한 내용은 `LICENSE` 파일을 참조하세요.

## 📞 문의

프로젝트에 대한 문의사항이나 버그 리포트가 있으시면 Issues를 통해 알려주세요.

---

**면책조항**: 이 도구는 교육 및 연구 목적으로 제작되었습니다. 사용자는 관련 법규 및 웹사이트 이용약관을 준수할 책임이 있습니다.