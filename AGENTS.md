# AGENTS.md — MatrixRTC E2EE 음성방 지원 작업 지침

## 1. 목표

이 저장소(`pinetree950824-png/bot`)의 기존 Matrix Element Call 음악 봇을 유지하면서, **MatrixRTC + LiveKit 기반 E2EE 음성방에서도 봇이 정상적으로 참가하고 오디오를 송출**하도록 확장한다.

최종 동작은 다음과 같다.

```text
Matrix room
  └─ MatrixRTC / Element Call
       └─ LiveKit
            └─ E2EE media
                 └─ Bot
                      └─ PCM audio
                           └─ FFmpeg / YouTube / local source
```

봇이 목표로 하는 기능:

- 일반(비-E2EE) 음성방에서 기존 기능을 그대로 유지
- E2EE 음성방에서 봇이 참가
- E2EE media key를 MatrixRTC 방식으로 처리
- LiveKit E2EE를 활성화
- 기존 `AudioSource -> LocalAudioTrack -> publishTrack()` 오디오 경로를 유지
- Element / Element X 등 호환 클라이언트에서 봇 음성을 정상적으로 청취 가능
- 참가자 입/퇴장 및 key rotation 이후에도 음성이 계속 재생
- E2EE 키/토큰/액세스 토큰을 로그에 노출하지 않음

---

## 2. 현재 저장소 구조를 존중할 것

현재 봇은 이미 MatrixRTC 참가와 LiveKit 접속을 구현하고 있다.

주요 파일:

- `call_worker/src/join_call.js`
- `call_worker/package.json`
- `call_worker_process.py`
- `bot.py`
- `audio_queue.py`
- `config.py`

특히 `call_worker/src/join_call.js`가 핵심 수정 대상이다.

현재 코드에는 다음 구조가 존재한다.

```js
const {
    MatrixRTCSessionManager,
    MatrixRTCSessionEvent,
} = require("matrix-js-sdk/lib/matrixrtc");

const {
    AudioFrame,
    AudioSource,
    LocalAudioTrack,
    Room,
    TrackPublishOptions,
    TrackSource,
} = require("@livekit/rtc-node");
```

그리고 대략:

```text
matrix-js-sdk
  -> MatrixRTCSessionManager
  -> MatrixRTC session
  -> MatrixRTC authorization service
  -> LiveKit URL + JWT
  -> @livekit/rtc-node Room
  -> AudioSource
  -> LocalAudioTrack
  -> publishTrack()
```

이 구조를 최대한 유지한다.

현재 `call_worker/package.json`의 기준 dependency는:

- `@livekit/rtc-node`: `^0.13.24`
- `matrix-js-sdk`: `^41.0.0-rc.0`

이다.

**주의:** `^` 범위 때문에 실제 설치된 버전이 package.json 표기와 다를 수 있다. 구현 전 반드시 `npm ls`/lockfile과 실제 export/API를 확인한다.

---

## 3. 절대로 API를 추측해서 구현하지 말 것

이 작업에서 가장 중요한 규칙이다.

다음과 같은 이름을 문서/설치된 패키지에서 확인하지 않고 임의로 작성하지 않는다.

```text
EncryptionKeyProvider
ExternalE2EEKeyProvider
E2EEOptions
setE2EEKey
setKey
enableE2EE
MatrixRTCEncryptionManager
```

Element Call, `matrix-js-sdk`, `@livekit/rtc-node`, `livekit-client` 사이에서 API 이름과 책임이 다를 수 있다.

반드시 다음 순서로 확인한다.

1. 저장소의 `package-lock.json`/lockfile 확인
2. `npm ls matrix-js-sdk @livekit/rtc-node`
3. `node_modules/@livekit/rtc-node`의 실제 export 확인
4. `node_modules/matrix-js-sdk`의 실제 MatrixRTC 관련 export 확인
5. 현재 Element Call `main` 브랜치의 MatrixRTC E2EE 구현 확인
6. 현재 LiveKit SDK 문서/소스와 대조
7. 확인된 API만 코드에 사용

API가 존재하지 않으면 다른 SDK/버전으로 해결하거나 의존성 버전을 명시적으로 변경한다.

---

## 4. E2EE의 두 계층을 혼동하지 말 것

이 프로젝트에는 두 종류의 E2EE가 관련된다.

### A. Matrix room E2EE

```text
m.room.encrypted
   -> Olm/Megolm
   -> matrix-js-sdk crypto
```

이는 Matrix room event를 보호한다.

### B. MatrixRTC media E2EE

```text
MatrixRTC
   -> media encryption key exchange
   -> LiveKit E2EE
   -> encrypted WebRTC media
```

이번 작업의 핵심은 B다.

Matrix room E2EE가 작동한다고 해서 LiveKit media E2EE가 자동으로 활성화되는 것은 아니다.

반대로 LiveKit E2EE를 켠다고 해서 MatrixRTC의 key exchange가 자동으로 구현되는 것도 아니다.

둘을 명확하게 분리해서 구현한다.

---

## 5. 현재 Element Call 동작을 기준으로 삼을 것

현재 Element Call은 MatrixRTC(MSC4143)와 LiveKit 기반 transport(MSC4195)를 사용한다.

Element Call은 MatrixRTC transport discovery를 통해 LiveKit authorization service를 찾고, call membership을 통해 backend를 선택한 뒤 LiveKit URL/JWT를 얻는다.

현재 Element Call 문서에서 `perParticipantE2EE`는:

> participant별 encryption을 활성화하고, key를 encrypted Matrix room messages를 통해 교환

하는 모드로 정의되어 있다.

따라서 봇도 단순히 LiveKit room에 접속하는 것만으로는 충분하지 않다.

참고:
- Element Call README: https://github.com/element-hq/element-call/blob/main/README.md
- Element Call URL/E2EE 설정: https://github.com/element-hq/element-call/blob/main/docs/url_params.md
- Element Call self-hosting / MatrixRTC transport: https://github.com/element-hq/element-call/blob/main/docs/self_hosting.md

---

## 6. 구현 전략

### Phase 0 — baseline 고정

E2EE 수정 전에 일반 음성방이 정상 작동하는지 확인한다.

검증:

```text
!join
!play <URL>
!queue
!skip
!stop
!leave
```

기존 비-E2EE 음성방에서 음성이 정상적으로 들려야 한다.

이 단계에서 동작하지 않으면 E2EE 작업을 시작하지 않는다.

---

### Phase 1 — 실제 SDK/API 조사

다음 정보를 기록한다.

```text
Node version
matrix-js-sdk 실제 버전
@livekit/rtc-node 실제 버전
matrix-js-sdk MatrixRTC 관련 export
@livekit/rtc-node E2EE 관련 export
```

실제 설치된 SDK에 E2EE media API가 없으면:

- 지원되는 최신 안정 버전으로 업그레이드할지
- `livekit-client` 등 다른 SDK를 사용할지
- Node native SDK를 유지할지

결정한다.

**브라우저 전용 API를 `@livekit/rtc-node`에서 지원한다고 가정하지 않는다.**

---

### Phase 2 — MatrixRTC E2EE key 흐름 파악

Element Call 소스에서 다음을 추적한다.

```text
MatrixRTC session 생성
    ↓
E2EE manager / key manager
    ↓
encrypted Matrix room event 또는 MatrixRTC 관련 key transport
    ↓
participant별 media key
    ↓
LiveKit E2EE key provider
```

특히 다음을 확인한다.

- key 생성 시점
- 최초 참가자에게 key 전달하는 방법
- 새 참가자에게 key를 보내는 방법
- 참가자 퇴장 후 key rotation
- 현재 participant/device를 식별하는 방법
- Matrix room E2EE crypto API와 연결되는 부분
- key version / epoch 처리
- stale key 처리
- 현재 MatrixRTC stable/unstable event type

**Element Call의 구현을 그대로 복사하기보다 현재 matrix-js-sdk가 제공하는 public API를 우선 사용한다.**

---

### Phase 3 — Matrix-js-sdk의 crypto 상태 확보

현재 worker는:

```js
createClient({
    baseUrl,
    accessToken,
    userId,
    deviceId,
    store: new MemoryStore(),
});
```

형태로 client를 만든다.

E2EE media key가 encrypted Matrix events를 통해 전달된다면, 해당 client가 필요한 Matrix E2EE crypto를 실제로 초기화하고 복호화할 수 있어야 한다.

필요할 경우:

```js
await client.initRustCrypto(...)
```

등 현재 SDK가 제공하는 공식 초기화 방법을 검토한다.

단, 단순히 `initRustCrypto()`를 추가하는 것만으로 완료됐다고 간주하지 않는다.

반드시 다음을 검증한다.

- 봇 device가 실제로 verified 상태인지
- room encryption state를 읽을 수 있는지
- 봇이 필요한 encrypted event를 복호화할 수 있는지
- crypto store가 프로세스 재시작 후 필요한 상태를 보존하는지
- 동일 Matrix device에 여러 crypto client가 연결되지 않는지

현재 matrix-js-sdk 문서는 Rust crypto 기반 E2EE를 제공하며, Node에서는 persistent crypto store 구성이 필요할 수 있음을 명시한다.

참고:
https://github.com/matrix-org/matrix-js-sdk

---

### Phase 4 — MatrixRTC media E2EE를 독립 모듈로 분리

`join_call.js`에 모든 E2EE 로직을 직접 섞지 않는다.

가능하면 다음과 같은 모듈을 만든다.

```text
call_worker/src/
├── join_call.js
├── matrix_rtc_e2ee.js
└── ...
```

권장 책임:

```js
class MatrixRtcE2eeController {
    constructor(matrixClient, rtcSession, options) {}

    async initialize() {}

    async handleKeyEvent(event) {}

    async setLivekitKeyProvider(room) {}

    async rotateKey(reason) {}

    async shutdown() {}
}
```

실제 API 이름은 Phase 1/2 조사 후 결정한다.

핵심은:

```text
Matrix event/key handling
```

과

```text
LiveKit media encryption
```

을 분리하는 것이다.

---

## 7. LiveKit 연결 단계 수정

현재 코드는:

```js
const room = new Room();

await room.connect(config.url, config.jwt, {
    autoSubscribe: true,
    dynacast: true,
});
```

이다.

E2EE 모드에서는 다음 순서를 유지한다.

```text
1. MatrixRTC session 준비
2. media E2EE 상태 준비
3. LiveKit E2EE key provider/manager 준비
4. LiveKit Room 생성
5. Room에 E2EE 옵션 적용
6. room.connect()
7. AudioSource 생성
8. LocalAudioTrack 생성
9. publishTrack()
```

가능하면 `room.connect()` 이후에 key provider를 뒤늦게 붙이는 구조는 피한다.

실제 SDK가 요구하는 초기화 순서를 따른다.

---

## 8. AudioSource / FFmpeg는 최대한 변경하지 말 것

현재 audio pipeline은 이미 적절하다.

```text
YouTube / file / stream
        ↓
      FFmpeg
        ↓
48kHz / mono / s16le
        ↓
    AudioFrame
        ↓
   AudioSource
        ↓
 LocalAudioTrack
        ↓
 LiveKit publish
```

E2EE를 추가하면서 다음을 변경하지 않는다.

- sample rate
- channel count
- FFmpeg PCM format
- queue architecture
- volume 처리
- fade-in
- playback lifecycle

E2EE는 transport/media security 계층에만 추가한다.

목표:

```text
AudioSource
   ↓
LocalAudioTrack
   ↓
LiveKit E2EE
   ↓
publishTrack()
```

---

## 9. 일반방 / E2EE방 호환

기존 사용자를 깨뜨리지 않는다.

권장 동작:

```text
room/call E2EE mode detected
        │
        ├── false
        │     └── 기존 LiveKit 연결
        │
        └── true
              └── MatrixRTC E2EE 초기화
                    └── LiveKit E2EE 연결
```

가능하다면 환경변수로 강제 모드를 제공한다.

예:

```text
MATRIX_RTC_E2EE=auto
```

값:

```text
auto
required
disabled
```

의미:

- `auto`: 방/세션 설정에 따라 자동 선택
- `required`: E2EE media를 준비하지 못하면 통화 참가 실패
- `disabled`: 기존 비-E2EE 방식만 사용

기본값은 `auto`를 고려한다.

보안상 E2EE가 필요한 환경에서는 `required`를 사용할 수 있어야 한다.

---

## 10. Key rotation

이 기능을 빠뜨리면 초기 참가자는 들리는데 사람이 나간 뒤 새 참가자에게 음성이 안 들리는 문제가 발생할 수 있다.

반드시 테스트한다.

### Test A

```text
Bot join
User A join
Bot play
```

A가 정상적으로 듣는다.

### Test B

```text
Bot join
User A join
User A leave
User B join
Bot continues playing
```

B가 정상적으로 듣는다.

### Test C

```text
Bot join
A join
B join
A leave
B remains
Bot continues
C join
```

B와 C가 정상적으로 듣는다.

### Test D

```text
Bot join
A join
Bot reconnect
```

재연결 이후에도 Bot audio가 정상적으로 복구되어야 한다.

---

## 11. 절대로 로그에 기록하지 말 것

다음 값은 로그에 출력하지 않는다.

```text
Matrix access token
LiveKit JWT
media encryption key
E2EE key material
Olm/Megolm session key
cross-signing private key
secret storage key
crypto store contents
```

허용되는 디버깅 정보:

```text
room id
user id
device id
call id
LiveKit room name
E2EE enabled/disabled
key generation/version (식별용 숫자만)
participant count
auth mode
connection state
```

단, room ID도 민감한 환경에서는 hash 또는 redaction 옵션을 제공할 수 있다.

---

## 12. 버전 관리 규칙

이번 작업은 다음 계층의 버전에 영향을 받을 수 있다.

```text
matrix-js-sdk
@livekit/rtc-node
Element Call
LiveKit server
MatrixRTC authorization service
Synapse
```

따라서 의존성 변경 시 반드시 이유를 기록한다.

예:

```text
matrix-js-sdk:
  old -> new
  reason: MatrixRTC E2EE public API required

@livekit/rtc-node:
  old -> new
  reason: Node E2EE media API required
```

무조건 최신 버전으로 올리지 않는다.

현재 서버와 호환되는 최소 버전을 우선 찾는다.

---

## 13. 서버 측 요구사항 확인

봇 코드만 수정해서 끝난다고 가정하지 않는다.

Element Call self-hosting 구성에서 다음이 필요할 수 있다.

```text
Synapse
  ├── MatrixRTC / MSC4143 support
  ├── state_after / required MatrixRTC features
  └── RTC transport discovery

MatrixRTC Authorization Service
  └── /livekit/jwt

LiveKit SFU
  └── /livekit/sfu
```

현재 Element Call self-hosting 문서를 기준으로 서버 설정을 확인한다.

참고:
https://github.com/element-hq/element-call/blob/main/docs/self_hosting.md

특히 다음 endpoint를 확인한다.

```text
/_matrix/client/unstable/org.matrix.msc4143/rtc/transports
```

그리고 LiveKit authorization service가 반환하는 URL/JWT가 봇과 Element Call에서 동일한 backend 선택을 가능하게 하는지 확인한다.

---

## 14. 구현 순서

에이전트는 아래 순서를 지킨다.

### Step 1
현재 브랜치 상태 확인.

```bash
git status
git log -1 --oneline
```

### Step 2
dependency 및 lockfile 확인.

```bash
npm ls matrix-js-sdk @livekit/rtc-node
```

### Step 3
SDK에서 실제 E2EE API 검색.

```bash
grep -R "E2EE\|EncryptionKeyProvider\|KeyProvider" node_modules/@livekit/rtc-node node_modules/matrix-js-sdk
```

Windows 환경에서는 PowerShell 등 동등한 검색 명령을 사용한다.

### Step 4
Element Call 최신 구현과 비교.

특히:

```text
perParticipantE2EE
MatrixRTC session
encryption key manager
LiveKit E2EE
key rotation
```

을 추적한다.

### Step 5
최소 변경으로 E2EE controller 추가.

### Step 6
LiveKit connect 전에 E2EE 초기화.

### Step 7
기존 audio publishing 경로 유지.

### Step 8
일반방 regression test.

### Step 9
E2EE 음성방 test.

### Step 10
key rotation / reconnect test.

---

## 15. 테스트 체크리스트

### 일반방

- [ ] join 성공
- [ ] play 성공
- [ ] 음성 청취 가능
- [ ] skip 성공
- [ ] stop 성공
- [ ] leave 성공
- [ ] reconnect 성공

### E2EE 음성방

- [ ] Matrix device verified
- [ ] Matrix room E2EE 정상
- [ ] MatrixRTC join 성공
- [ ] E2EE media key 획득 성공
- [ ] LiveKit E2EE 활성화
- [ ] publish 성공
- [ ] Element에서 봇 음성 청취 가능
- [ ] 참가자 추가 후 정상
- [ ] 참가자 퇴장 후 정상
- [ ] key rotation 후 정상
- [ ] bot reconnect 후 정상

### 보안

- [ ] JWT 로그 없음
- [ ] media key 로그 없음
- [ ] access token 로그 없음
- [ ] private crypto material 로그 없음

---

## 16. 실패 시 진단 순서

E2EE 음성이 안 들릴 경우 다음 순서로 확인한다.

### 1. MatrixRTC 참가 실패인가?

확인:

```text
m.rtc.member
MatrixRTC session state
join outcome
```

### 2. LiveKit authorization 실패인가?

확인:

```text
JWT 발급
LiveKit URL
room name
participant identity
publish permission
```

### 3. LiveKit 연결은 성공했는가?

```text
room.connect()
```

성공 여부 확인.

### 4. publish는 성공했는가?

```text
publishTrack()
publication.sid
```

확인.

### 5. E2EE가 실제로 활성화됐는가?

```text
key provider initialized
key installed
encryption enabled
```

확인.

### 6. Element가 key를 가지고 있는가?

다른 Element 참가자에게 동일 media key가 전달되는지 확인.

### 7. key rotation 이후 문제가 생기는가?

참가자 입/퇴장 직후 재현한다.

---

## 17. 흔한 잘못된 해결책

다음 방식은 사용하지 않는다.

### 잘못된 방법 1

```text
LiveKit 서버에서 E2EE를 끄고 Matrix E2EE만 사용
```

이것은 E2EE 음성방 요구사항을 충족하지 않는다.

### 잘못된 방법 2

```text
Matrix room E2EE key를 그대로 LiveKit key로 사용
```

프로토콜상 동일한 key라고 가정하지 않는다.

### 잘못된 방법 3

```text
Element Call의 브라우저 코드를 그대로 Node에 복사
```

브라우저 WebCrypto/WebWorker/Media APIs와 Node native runtime은 다르다.

### 잘못된 방법 4

```text
API 이름을 추측해서 EncryptionKeyProvider를 import
```

설치된 SDK에서 export 여부를 먼저 확인한다.

### 잘못된 방법 5

```text
E2EE가 안 되므로 FFmpeg/audio pipeline을 수정
```

E2EE 문제와 audio source 문제를 분리한다.

---

## 18. 완료 조건

작업은 다음 조건을 모두 만족해야 완료로 간주한다.

```text
[OK] 일반 MatrixRTC 음성방 기존 기능 유지
[OK] E2EE Matrix room client 정상
[OK] E2EE MatrixRTC 음성방 참가
[OK] LiveKit media E2EE 활성화
[OK] 봇 audio publish
[OK] Element에서 음성 수신
[OK] 참가자 입장/퇴장 후 key rotation 처리
[OK] 재접속 후 복구
[OK] 기존 !play / !stop / !skip 등 기능 유지
[OK] secret material 로그 미노출
```

---

## 19. 참고 자료

현재 구현 기준으로 반드시 확인할 공식/소스 자료:

- Matrix JS SDK
  https://github.com/matrix-org/matrix-js-sdk

- Element Call
  https://github.com/element-hq/element-call

- Element Call URL/E2EE 설정
  https://github.com/element-hq/element-call/blob/main/docs/url_params.md

- Element Call self-hosting / MatrixRTC transport
  https://github.com/element-hq/element-call/blob/main/docs/self_hosting.md

- LiveKit E2EE documentation
  https://docs.livekit.io/transport/encryption/

- 현재 봇 저장소
  https://github.com/pinetree950824-png/bot

- 현재 핵심 worker
  https://github.com/pinetree950824-png/bot/blob/main/call_worker/src/join_call.js

---

## 20. 최종 구현 원칙

핵심은 다음 한 문장이다.

> **기존 봇의 MatrixRTC/LiveKit/audio pipeline은 유지하고, MatrixRTC media-E2EE key management와 LiveKit E2EE를 그 사이에 추가한다.**

즉 목표 구조는:

```text
             Matrix
                │
       matrix-js-sdk
                │
         MatrixRTC session
                │
       ┌────────┴────────┐
       │                 │
  Matrix E2EE       RTC media E2EE
       │                 │
       │          key management
       │                 │
       │            LiveKit
       │                 │
       └────────┬────────┘
                │
           AudioSource
                │
          LocalAudioTrack
                │
             publish
```

기존 기능을 깨뜨리지 않는 것을 최우선으로 하고, E2EE 구현은 반드시 실제 설치된 SDK와 현재 Element Call 구현을 확인한 뒤 진행한다.
