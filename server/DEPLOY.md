# 배포 가이드

## Docker (권장)

```bash
cd server
cp .env.example .env
docker compose up -d --build
```

## VPS (Node 18+)

```bash
cd server
cp .env.example .env
npm install
npx playwright install chromium
npm start
```

## 환경 변수

| 변수 | 설명 |
|------|------|
| `CRAWL_MODE=server` | 웹만으로 크롤링 (기본, 배포용) |
| `CRAWL_MODE=extension` | Chrome 확장 브릿지 사용 |
| `PUBLIC_URL` | 공개 URL (선택) |
| `WORDPRESS_*` | WordPress REST API 인증 |
| `OPENAI_*` | 글 생성용 OpenAI (선택) |

## 배포 시 접근 보호 (앞단 인증)

웹 UI에 API 키를 두지 않습니다. **Nginx / Caddy Basic Auth** 또는 VPN으로 사이트 전체를 막으세요.

### Nginx Basic Auth 예시

```bash
# 비밀번호 파일 생성
htpasswd -c /etc/nginx/.htpasswd admin
```

```nginx
server {
  listen 443 ssl http2;
  server_name your-domain.example.com;

  auth_basic "Restricted";
  auth_basic_user_file /etc/nginx/.htpasswd;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # OpenAI 다중 상품 글 생성은 1~3분 걸릴 수 있음
    proxy_read_timeout 600s;
    proxy_connect_timeout 60s;
    proxy_send_timeout 600s;
  }
}
```

`.env`:

```
PUBLIC_URL=https://your-domain.example.com
TRUST_PROXY=true
HOST=127.0.0.1
```

앱은 `127.0.0.1`에만 바인딩하고, 외부 노출은 Nginx만 담당하는 구성을 권장합니다.
