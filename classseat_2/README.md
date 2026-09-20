# 자리배치 프로그램 v2

Firebase + Vercel 기반 학급 자리배치 웹앱. 학생이 직접 정보를 입력하고,
시뮬레이티드 어닐링 알고리즘이 최적 좌석을 계산합니다. **선생님은 학생의
원본 응답(MBTI, 성적, 선호/기피 짝꿍 등)을 절대 볼 수 없고, 최종 좌석 배정만
볼 수 있습니다** — 이 규칙은 UI가 아니라 Firestore 보안 규칙과 서버 아키텍처로
강제됩니다.

## 폴더 구조

```
public/index.html      선생님/학생 화면 (순수 HTML+JS, 빌드 불필요)
api/create-students.js 학생 계정 일괄 생성 (Vercel 서버리스 함수)
api/student-login.js   학생 번호+PIN 로그인 → 커스텀 토큰 발급
api/run-seating.js     좌석배치 계산 실행 — 학생 원본 데이터를 다루는 유일한 곳
lib/firebaseAdmin.js   서버용 Firebase Admin SDK 초기화 + 요청 인증
lib/seatAlgo.js        시뮬레이티드 어닐링 최적화 알고리즘 (순수 함수)
firestore.rules        Firestore 보안 규칙 — 이 프로젝트의 진짜 핵심
vercel.json             서버리스 함수 실행 시간 설정
```

## 1. Firebase 프로젝트 준비

1. https://console.firebase.google.com 에서 새 프로젝트 생성
2. **Authentication** → 로그인 방법에서 "이메일/비밀번호" 활성화
3. **Firestore Database** 생성 (프로덕션 모드)
4. **프로젝트 설정 → 서비스 계정** 에서 "새 비공개 키 생성" → JSON 다운로드
   (이 파일의 `project_id`, `client_email`, `private_key` 세 값을 나중에 씁니다.
   **이 JSON 파일은 절대 Git에 커밋하거나 공개 저장소에 올리지 마세요.**)
5. **프로젝트 설정 → 일반 → 내 앱** 에서 웹 앱을 추가하고 `firebaseConfig` 값을 확인

## 2. 프론트엔드 설정

`public/index.html` 상단의 `firebaseConfig` 객체를 본인 프로젝트 값으로 교체하세요:

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "...",
};
```

이 값들은 브라우저에 노출되어도 괜찮은 공개 설정값입니다 (보안은 Firestore
규칙이 담당합니다).

## 3. Firestore 보안 규칙 배포

Firebase 콘솔의 **Firestore Database → 규칙** 탭에 `firestore.rules` 내용을
그대로 붙여넣고 게시(Publish)하세요. (또는 Firebase CLI가 있다면
`firebase deploy --only firestore:rules`)

## 4. Vercel 배포 + 환경변수 설정

1. 이 폴더를 GitHub 저장소로 만들고 Vercel에 연결 (또는 `vercel` CLI로 직접 배포)
2. Vercel 프로젝트 → **Settings → Environment Variables** 에서 3개 등록:

   | Key | Value |
   |---|---|
   | `FIREBASE_PROJECT_ID` | 서비스 계정 JSON의 `project_id` |
   | `FIREBASE_CLIENT_EMAIL` | 서비스 계정 JSON의 `client_email` |
   | `FIREBASE_PRIVATE_KEY` | 서비스 계정 JSON의 `private_key` (줄바꿈 `\n` 포함된 문자열 그대로 붙여넣기) |

3. 재배포하면 `api/*.js` 함수들이 자동으로 서버리스 엔드포인트로 배포됩니다.

## 5. 로컬 개발

```bash
npm install
npx vercel dev
```

`api/`, `lib/`, `public/` 폴더 구조가 그대로 유지되어야 `require('../lib/...')`
같은 상대경로가 정상 동작합니다.

## 알려진 트러블슈팅

- **`Missing or insufficient permissions` 오류가 규칙/코드/DB 모두 정상인데도
  발생하는 경우**: 브라우저 확장 프로그램(광고 차단기 등)이 Firestore의
  WebChannel 연결 자체를 막아서 SDK가 이를 권한 오류로 잘못 표시하는 경우가
  흔합니다. 시크릿(익명) 모드에서 재현되는지 먼저 확인하세요.
- 반이 0개일 때는 드롭다운 대신 처음부터 "새 반 만들기" 폼을 보여주도록
  처리되어 있습니다 (옵션이 하나뿐이면 `onchange`가 발생하지 않는 문제 회피).

## 데이터 흐름 요약

1. 선생님이 반을 만들고 이름 목록으로 학생 계정을 일괄 생성 (`api/create-students.js`) → PIN이 화면에 한 번만 표시됨
2. 학생이 번호+PIN으로 로그인 (`api/student-login.js`) → 커스텀 클레임(`role`, `classId`, `number`)이 담긴 토큰 발급
3. 학생이 본인 정보를 입력·저장 (브라우저 → Firestore 직접 쓰기, 규칙이 본인 문서/필드만 허용)
4. 선생님이 "배치 실행" 클릭 → `api/run-seating.js`가 Admin SDK로 학생 원본 데이터를
   서버 메모리에서만 읽어 계산하고, 좌석+이름만 남은 안전한 결과를 `results/current`에 저장
5. 선생님 화면은 `results/current`만 읽어서 최종 좌석표를 보여줌 (원본 데이터는 규칙상 애초에 읽을 수 없음)
