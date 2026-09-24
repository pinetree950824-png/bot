# AGENTS.md — Matrix E2EE Chat + MatrixRTC E2EE Audio Fix Plan

## 목표

현재 `pinetree950824-png/bot` 프로젝트에서 아래 두 문제를 해결한다.

1. Matrix E2EE가 활성화된 일반 채팅방에서 사용자가 입력한 `m.room.encrypted` 메시지를 Python 봇이 정상적으로 복호화하여 `!play`, `!queue` 등의 명령으로 처리하도록 한다.
2. Element Call / MatrixRTC의 E2EE 음성방에 봇이 참가한 뒤, 봇이 publish한 음악 오디오를 Element Call 클라이언트에서 정상적으로 복호화하여 들을 수 있도록 한다.

기존 일반(비암호화) 채팅과 일반 음성방의 동작은 반드시 유지한다.

---

## 현재 관찰된 증상

### 채팅

- 일반 채팅방: 봇 명령어 정상 인식.
- E2EE 채팅방: 사용자가 입력한 채팅을 봇이 명령으로 인식하지 못함.

Python `bot.py`의 `AsyncClient` 생성 경로를 점검한다. E2EE crypto store/config가 충분히 설정되어 있지 않으면 암호화 메시지가 `RoomMessageText`까지 도달하지 않는다.

### 음성

- 봇이 Element Call / MatrixRTC E2EE room에는 들어감.
- 일반 음성 경로는 별도로 유지되어야 함.
- E2EE room에서 봇의 음악 track이 보이더라도 Element Call에서 소리가 들리지 않을 수 있음.
- 특히 MatrixRTC raw key를 LiveKit FrameCryptor가 실제 Element Call과 동일한 방식으로 파생/사용하는지 검증해야 한다.

---

# 1. Matrix E2EE 채팅 수정

## 요구사항

`matrix-nio[e2e]`가 실제로 활성화되어 있어야 한다.

다음을 확인하고 필요하면 구현한다.

- `ClientConfig(encryption_enabled=True, ...)`
- persistent `store_path`
- 고정된 `device_id`
- access token과 device/store identity의 일관성
- 재시작 후에도 Olm/Megolm session과 room key 유지
- 기존에 Element에서 검증/신뢰한 bot device identity 유지

예상 형태는 다음과 같지만 **현재 설치된 matrix-nio 버전의 정확한 API를 먼저 확인하고 적용**한다.

```python
from nio import AsyncClient, ClientConfig

store_path = Path("./nio_store")
store_path.mkdir(parents=True, exist_ok=True)

client_config = ClientConfig(
    encryption_enabled=True,
    store_sync_tokens=True,
)

self.client = AsyncClient(
    config.MATRIX_HOMESERVER,
    config.MATRIX_USER_ID,
    device_id=config.MATRIX_DEVICE_ID,
    store_path=str(store_path),
    config=client_config,
)

self.client.access_token = config.MATRIX_ACCESS_TOKEN
```

API 이름을 추측하지 말고 설치 버전의 matrix-nio 문서/소스를 확인한다.

## Device identity

- 환경설정에 고정된 `MATRIX_DEVICE_ID`를 둔다.
- 운영 중인 기존 bot device가 있다면 임의로 새 device를 만들지 않는다.
- crypto store를 봇 계정/해당 device 전용으로 유지한다.
- store 파일을 재시작 때 삭제하지 않는다.

## 테스트

최소한 다음을 확인한다.

1. plaintext room에서 `!play ...` 동작.
2. E2EE room에서 `!play ...` 동작.
3. E2EE room에서 `!queue`, `!skip`, `!stop` 등 동작.
4. 봇 자신의 메시지를 명령으로 처리하지 않음.
5. 재시작 후 encrypted message를 계속 복호화.
6. 같은 device/store를 유지하면 기존 Megolm session이 재사용됨.
7. 다른 계정/다른 device와 crypto store를 공유하지 않음.
8. raw key, access token, Olm/Megolm session secret 등을 로그에 남기지 않음.

기존 `RoomMessageText` callback 구조는 유지한다. E2EE가 정상 초기화되면 복호화된 텍스트가 기존 명령 처리 경로에 들어가도록 한다.

---

# 2. MatrixRTC / Element Call E2EE

현재 의도된 구조:

```text
Matrix JS SDK
    ↓
MatrixRTCSessionManager / MatrixRTCSession
    ↓
MatrixRTC EncryptionKeyChanged
    ↓
MatrixRtcE2eeController
    ↓
LiveKit KeyProvider
    ↓
@livekit/rtc-node
    ↓
LocalAudioTrack
    ↓
Element Call
```

현재 `matrix_rtc_e2ee.js`에는 participant-specific raw key를 위한 `setRawKey(participantIdentity, key, keyIndex)` 경로가 있으며, `@livekit/rtc-node`에는 patch-package를 통한 변경이 있을 수 있다.

반드시 실제 실행 경로를 확인한다.

---

# 3. 가장 중요한 문제: Element Call과 동일한 key derivation

MatrixRTC의 `EncryptionKeyChanged`에서 받은 raw key를 그냥 native LiveKit에 전달하는 것만으로는 충분하지 않을 수 있다.

Element Call의 현재 구현을 직접 확인해서 다음 파이프라인과 동일한 semantics를 보장한다.

```text
MatrixRTC encryption key
        ↓
HKDF / 실제 Element Call의 key derivation
        ↓
LiveKit key material
        ↓
FrameCryptor
```

다음 항목은 절대 추측하지 않는다.

- HKDF salt
- HKDF info/context
- key length
- ratchet settings
- keyring size
- participant identity 변환
- key index 처리
- FFI protobuf field 이름

반드시 현재 checkout된 Element Call과 현재 설치된 `@livekit/rtc-node` 소스를 대조한다.

---

# 4. LiveKit E2EE 설정 점검

현재 `matrix_rtc_e2ee.js`에서 다음을 실제 SDK와 대조한다.

- `EncryptionType.GCM`
- `keyDerivationFunction`
- `ratchetWindowSize`
- `keyringSize`
- `failureTolerance`
- `ratchetSalt`

Element Call의 현재 구현과 동일한 값/의미를 우선 적용한다.

현재 관찰된 Element Call 기준은 대체로:

```text
ratchetWindowSize = 10
keyringSize = 256
HKDF-based derivation
```

이 값들은 고정 사실로 취급하지 말고 현재 버전의 Element Call 소스로 확인한다.

`keyringSize` / `keyRingSize`처럼 비슷한 필드를 동시에 넣지 않는다. 설치된 SDK의 실제 option 이름만 사용한다.

---

# 5. participant identity

MatrixRTC의 `rtcBackendIdentity`를 1차 기준으로 사용한다.

다음 ID를 임의로 혼용하지 않는다.

```text
userId
 deviceId
rtcBackendIdentity
```

Element Call과 Matrix JS SDK가 실제 어떤 identity를 participant encryption key에 사용하는지 확인한다.

같은 raw key를 여러 임의 identity에 중복 설치하는 fallback은 피한다.

---

# 6. setSharedKey 주의

목적은 Element Call의 per-participant media E2EE다.

따라서 MatrixRTC participant-specific key를 무조건:

```js
keyProvider.setSharedKey(...)
```

로 넣지 않는다.

핵심은 participant-specific key 설치다.

```js
keyProvider.setRawKey(
    participantIdentity,
    key,
    keyIndex,
)
```

단, `setRawKey`가 public API인지 internal/fork API인지는 실제 SDK에서 확인한다.

---

# 7. patch-package

`@livekit/rtc-node`를 수정하는 경우 반드시 다음을 확인한다.

1. `package.json`의 patch-package 적용 경로.
2. `patches/@livekit+rtc-node+<version>.patch` 존재 여부.
3. patch 대상 버전과 package-lock 실제 버전 일치 여부.
4. `npm ci` 후 patch 자동 적용 여부.
5. 가능한 경우 exact version으로 SDK 고정.
6. 런타임에서 `KeyProvider.prototype.setRawKey`가 존재하는지 확인.
7. JS 함수가 존재하는 것뿐 아니라 native FFI까지 raw key가 전달되는지 검증.

중요:

```text
setRawKey 함수가 존재함
        ≠
native KeyProvider에 raw key가 실제 설치됨
```

둘 다 검증한다.

---

# 8. MatrixRTC lifecycle

다음 순서를 유지한다.

```text
MatrixRTC session 생성
    ↓
crypto/E2EE 초기화
    ↓
EncryptionKeyChanged listener 등록
    ↓
manageMediaKeys 활성화
    ↓
MatrixRTC join
    ↓
LiveKit connect
    ↓
LiveKit E2EE manager 활성화
    ↓
buffered MatrixRTC keys 설치
    ↓
audio track publish
```

키가 LiveKit 연결보다 먼저 올 수 있으므로 buffering을 유지한다.

LiveKit 연결 후 buffered keys를 flush한다.

재접속 시 현재 MatrixRTC session이 가지고 있는 key를 다시 적용한다. `reemitEncryptionKeys()` 같은 API를 사용할 경우 설치된 SDK 버전에 실제 존재하는지 확인한다.

---

# 9. E2EE mode

설정 의미:

```text
off
    → media E2EE 사용 안 함

auto
    → room/RTC 상태를 확인해 필요할 때 E2EE 활성화

required
    → E2EE 초기화/key installation 실패 시 fallback하지 않고 실패
```

`required` 모드에서는 다음 오류를 숨기지 않는다.

- crypto initialization failure
- LiveKit E2EE manager 없음
- key provider 없음
- raw-key adapter 없음
- FFI patch 실패
- MatrixRTC encryption key 설치 실패
- key derivation 설정 실패

---

# 10. Logging

권장 로그:

```text
[E2EE] MatrixRTC crypto initialized
[E2EE] MatrixRTC media key received
[E2EE] MatrixRTC key buffered
[E2EE] LiveKit E2EE manager enabled
[E2EE] MatrixRTC media key installed
[E2EE] buffered keys flushed
[E2EE] local audio track published
```

다음은 절대 출력하지 않는다.

```text
raw encryption key
access token
Olm session key
Megolm session key
JWT
private key
crypto store secret
```

진단이 필요하면 key index, identity, length, 짧은 digest 정도만 허용한다.

---

# 11. 음성 문제 진단 순서

## A. 먼저 일반 음성방

암호화되지 않은 Element Call 방에서 다음이 전부 정상인지 확인한다.

```text
bot joins
FFmpeg audio source
LocalAudioTrack
publishTrack
Element client hears sound
```

일반 방에서도 안 들리면 E2EE 문제로 판단하지 말고 audio/LiveKit publishing부터 수정한다.

## B. E2EE 음성방

일반 방이 정상일 때만 아래 순서로 본다.

```text
MatrixRTC key received?
        ↓
key index correct?
        ↓
participant identity correct?
        ↓
raw key installed?
        ↓
Element Call과 동일한 key derivation?
        ↓
FrameCryptor enabled?
        ↓
encrypted RTP published?
        ↓
Element decrypt succeeds?
```

---

# 12. 테스트

기존 unit/mock test는 유지한다.

하지만 다음을 명확히 구분한다.

```text
unit/mock tests
    !=
real Element Call interoperability
```

## 채팅

- plaintext room command
- encrypted room command
- restart + encrypted message
- device/store persistence

## 음성

- normal voice room
- E2EE voice room
- bot joins before another participant
- bot joins after another participant
- key arrives before LiveKit connect
- key arrives after LiveKit connect
- key rotation
- reconnect
- remote participant leaves/rejoins
- bot restart with same device/store

---

# 13. 최종 Acceptance Test

최종적으로 다음이 성공해야 한다.

```text
Element Call E2EE room
        ↓
Bot joins
        ↓
Bot receives MatrixRTC media key
        ↓
Bot derives/installs key with same semantics as Element Call
        ↓
Bot publishes encrypted audio
        ↓
Element Call receives bot track
        ↓
Element Call decrypts frames
        ↓
Human hears music
```

이 테스트가 성공하기 전에는 E2EE 음성 지원이 완료되었다고 판단하지 않는다.

---

# 구현 원칙

1. 현재 설치된 SDK 버전을 먼저 확인한다.
2. public API와 internal/FFI API를 구분한다.
3. 현재 Element Call 소스를 기준으로 protocol compatibility를 확인한다.
4. API 이름을 추측하지 않는다.
5. dependency version과 lockfile, patch 버전을 일치시킨다.
6. 기존 plaintext chat/voice 기능을 깨지 않는다.
7. `required` 모드에서는 E2EE 실패를 조용히 숨기지 않는다.
8. secret/key material을 로그에 남기지 않는다.
9. "함수가 존재한다"가 아니라 "실제로 암복호화가 된다"를 최종 기준으로 삼는다.
