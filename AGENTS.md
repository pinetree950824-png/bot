# AGENTS.md

## 목적

이 저장소의 `call_worker`에 MatrixRTC per-participant media E2EE를 실제 Element Call과 상호 운용 가능하도록 구현한다.

현재 기준 commit:

- Repository: `https://github.com/pinetree950824-png/bot`
- Commit: `dc120c8bb734210c7d867e2c151322700de6f76d`

목표는 다음을 동시에 만족하는 것이다.

1. 기존 일반 MatrixRTC/LiveKit 음성방 동작을 깨뜨리지 않는다.
2. Element Call의 E2EE 음성방에서 봇이 MatrixRTC media key를 수신한다.
3. 수신한 MatrixRTC raw media key를 LiveKit native E2EE 계층에 participant별 key로 설치한다.
4. FFmpeg → PCM → `AudioSource` → `LocalAudioTrack` → LiveKit publish 기존 오디오 경로를 유지한다.
5. key rotation, reconnect, participant 재입장 상황에서도 키 상태를 정상적으로 복구한다.
6. E2EE required 모드에서 key 설치에 실패했는데도 조용히 성공한 것처럼 진행하지 않는다.
7. 암호키 원문 및 민감한 crypto material을 로그에 출력하지 않는다.

---

## 중요: 프로토콜 레이어 구분

다음 두 가지를 혼동하지 않는다.

### Matrix room E2EE

`m.room.encryption`으로 보호되는 Matrix room event의 E2EE.

### MatrixRTC media E2EE

Element Call의 실시간 미디어를 LiveKit/WebRTC frame encryption으로 보호하는 별도 계층.

목표는 후자이며, MatrixRTC가 제공하는 media key를 LiveKit의 participant-specific E2EE key로 연결해야 한다.

---

## 현재 구조

현재 worker는 대략 다음 흐름을 사용한다.

```text
Matrix JS SDK
    |
    +-- initRustCrypto()
    |
    +-- MatrixRTCSessionManager
    |
    +-- MatrixRTCSession
    |      |
    |      +-- manageMediaKeys: true
    |      +-- EncryptionKeyChanged
    |
    v
MatrixRtcE2eeController
    |
    v
LiveKit E2EE KeyProvider
    |
    v
LiveKit Room
    |
    +-- AudioSource
    +-- LocalAudioTrack
    +-- publishTrack()
```

오디오 자체의 기존 경로는 유지한다.

```text
YouTube / local source
        |
        v
      FFmpeg
        |
        v
       PCM
        |
        v
    AudioSource
        |
        v
 LocalAudioTrack
        |
        v
 LiveKit publish
```

---

## 이번 구현에서 반드시 지켜야 할 점

### 1. MatrixRTC key event를 기준으로 동작할 것

Matrix JS SDK의 MatrixRTC session에서 `EncryptionKeyChanged` 이벤트를 받아 key를 처리한다.

이 이벤트에서 중요한 값은 다음이다.

- `key`
- `keyIndex`
- `membership`
- `rtcBackendIdentity`

`rtcBackendIdentity`는 participant-specific LiveKit identity와 연결되는 값으로 취급한다.

키 자체는 로그에 기록하지 않는다.

---

### 2. `manageMediaKeys: true` 유지

MatrixRTC session 생성 시 E2EE가 활성화된 경우 media key 관리가 켜져 있어야 한다.

예상 구조:

```js
manageMediaKeys: e2eeEnabled
```

또한 LiveKit 연결이 늦어져 MatrixRTC key가 먼저 도착할 수 있으므로, 아직 LiveKit에 연결되지 않았다면 key를 메모리에 buffering한 뒤 연결 후 다시 적용한다.

---

### 3. `reemitEncryptionKeys()` 활용

LiveKit 연결 후 MatrixRTC session에 이미 저장되어 있는 key를 다시 controller가 받을 수 있도록 `reemitEncryptionKeys()`를 활용한다.

이렇게 해야 다음 순서도 정상 동작한다.

```text
MatrixRTC key 수신
      |
      v
LiveKit 아직 연결 안 됨
      |
      v
bufferedKeys
      |
      v
LiveKit connect
      |
      v
attachLivekitRoom()
      |
      v
buffered key flush
```

---

## 가장 중요한 문제: LiveKit Node raw participant key injection

현재 `@livekit/rtc-node`의 공개 `KeyProvider` API는 participant-specific key를 넣을 때 raw key bytes를 직접 인자로 받는 형태가 아니다.

따라서 다음과 같은 호출을 단순히 사용하는 것은 올바른 구현으로 간주하지 않는다.

```js
keyProvider.setKey(participantIdentity, rawKey, keyIndex)
```

현재 Node SDK에서 `setKey()`의 공개 API와 MatrixRTC의 raw key 데이터 모델은 직접 일치하지 않는다.

### 하지 말 것

현재 코드처럼 `@livekit/rtc-node/dist/...` 내부 파일을 직접 읽어 내부 protobuf request를 조작하면서 임의의 `key` field를 집어넣는 monkey-patch를 장기 구현으로 사용하지 않는다.

특히 다음과 같은 방식은 제거 대상이다.

```js
SetKeyRequest({
    participantIdentity,
    key: rawKey,
    keyIndex,
})
```

이것은 LiveKit native 계층에서 실제 raw key를 정상 등록한다고 보장되지 않는다.

---

## 권장 구현 방향

### A. `matrix_rtc_e2ee.js`

controller에서는 MatrixRTC → LiveKit 경계를 명확하게 하나로 만든다.

개념적으로 다음 API를 사용한다.

```js
keyProvider.setRawKey(
    participantIdentity,
    rawKey,
    keyIndex,
)
```

단, 이 메서드는 현재 stock `@livekit/rtc-node`에 없을 수 있다. 따라서 아래 B가 필요하다.

### B. LiveKit Node SDK 최소 fork/adapter

`@livekit/rtc-node`의 native E2EE 계층에 raw participant key를 넣을 수 있는 명확한 경로를 추가한다.

개념적으로:

```text
KeyProvider.setRawKey(participantIdentity, key, keyIndex)
        |
        v
E2eeRequest
        |
        v
SetRawKeyRequest
    + participantIdentity
    + key
    + keyIndex
        |
        v
LiveKit native E2EE key store
```

protobuf/FFI/native 구조를 실제 설치된 SDK 버전에 맞춰 구현한다.

**API 이름, protobuf field 번호, native FFI 함수 이름을 추측해서 만들지 않는다.**

반드시 실제 설치된 `@livekit/rtc-node` 버전의 source/generated protobuf/native binding을 확인한 뒤 수정한다.

---

## `matrix_rtc_e2ee.js`에서의 권장 변경

### 1. 내부 FFI monkey-patch 제거

다음 종류의 코드를 제거한다.

```js
const ffiPath = path.resolve(...);
const protoPath = path.resolve(...);
require(ffiPath);
require(protoPath);
```

그리고 `KeyProvider.prototype.setKey`를 monkey-patch하는 코드도 제거한다.

내부 dist 파일에 의존하는 구현은 SDK minor/patch update에 취약하다.

---

### 2. `applyKey()` 단순화

현재 MatrixRTC `EncryptionKeyChanged`에서 받은 값을 participant-specific raw key로 설치하는 것이 핵심이다.

권장 흐름:

```js
applyKey(rtcBackendIdentity, membership, key, keyIndex, isOwnKey) {
    if (!this.keyProvider) {
        throw new Error("LiveKit E2EE key provider is not attached");
    }

    const participantIdentity =
        rtcBackendIdentity ||
        (membership?.userId && membership?.deviceId
            ? `${membership.userId}:${membership.deviceId}`
            : null);

    if (!participantIdentity) {
        throw new Error(
            "MatrixRTC encryption key has no participant identity",
        );
    }

    if (typeof this.keyProvider.setRawKey !== "function") {
        throw new Error(
            "LiveKit KeyProvider does not support raw participant keys",
        );
    }

    this.keyProvider.setRawKey(
        participantIdentity,
        key,
        keyIndex,
    );
}
```

실제 구현에서는 위 예시의 메서드명을 실제 fork/adapter API와 맞춘다.

---

## `setSharedKey()` 사용 금지 원칙

Element Call의 per-participant media E2EE를 목표로 하는 경우 MatrixRTC participant key를 `setSharedKey()`로 처리하지 않는다.

특히 다음처럼 동시에 처리하지 않는다.

```js
setSharedKey(key, keyIndex);
setKey(identity, key, keyIndex);
```

목표 모델은 다음과 같다.

```text
participant identity -> participant-specific raw key -> keyIndex
```

shared-key 모델이 별도로 필요하다면 별도 코드 경로로 명시적으로 구분한다.

---

## E2EE required 모드의 실패 처리

E2EE가 required인 경우 다음 오류를 조용히 무시하지 않는다.

- LiveKit E2EE manager 없음
- KeyProvider 없음
- raw-key API 없음
- native FFI/raw-key 설치 실패
- participant identity 없음
- malformed MatrixRTC key

예상 동작:

```text
required + key installation failure
                |
                v
        hard failure / join abort
```

즉, 다음과 같은 fallback은 피한다.

```js
try {
    installRawKey(...);
} catch {
    // continue anyway
}
```

`auto` 또는 `disabled` 모드에서는 기존 정책에 맞게 graceful fallback을 허용할 수 있지만, `required`에서는 반드시 명시적으로 실패시킨다.

---

## `attachLivekitRoom()` 권장 정책

LiveKit room이 연결된 뒤 E2EE manager와 key provider를 검증한다.

개념:

```js
attachLivekitRoom(livekitRoom) {
    if (!this.enabled || !livekitRoom) return;

    this.livekitRoom = livekitRoom;

    if (!livekitRoom.e2eeManager) {
        return this.handleE2eeFailure(
            "LiveKit E2EE manager is unavailable",
        );
    }

    this.keyProvider = livekitRoom.e2eeManager.keyProvider;

    if (!this.keyProvider) {
        return this.handleE2eeFailure(
            "LiveKit E2EE key provider is unavailable",
        );
    }

    livekitRoom.e2eeManager.setEnabled(true);

    // Flush keys that arrived before LiveKit connected.
    this.flushBufferedKeys();
}
```

`handleE2eeFailure()`는 `required`일 때 join을 중단시키고, `auto`일 때만 기존 정책으로 fallback한다.

---

## key buffering

반드시 다음 케이스를 지원한다.

### 케이스 1

```text
EncryptionKeyChanged
        |
        v
LiveKit 없음
        |
        v
buffer
```

### 케이스 2

```text
LiveKit connect
        |
        v
buffer flush
```

### 케이스 3

```text
participant rejoin
        |
        v
new EncryptionKeyChanged
        |
        v
replace key by keyIndex
```

### 케이스 4

```text
reconnect
        |
        v
reemitEncryptionKeys()
        |
        v
restore native key state
```

key buffer는 불필요하게 무한정 커지지 않도록 dedupe/update 정책을 둔다.

권장 key identity:

```text
participantIdentity + keyIndex
```

같은 participant/index가 다시 들어오면 최신 key가 이전 값을 덮어쓰도록 한다.

---

## 로그 보안

절대 로그로 출력하지 않는다.

- raw media key
- Uint8Array key bytes
- protobuf 전체 request
- crypto secret
- access token / LiveKit JWT
- Matrix access token

허용되는 로그 예:

```text
MatrixRTC media key received: participant=@bot:example.org device=ABC keyIndex=3
LiveKit E2EE key installed: participant=@bot:example.org keyIndex=3
```

단, 실제 운영 코드에서는 Matrix user ID/device ID도 필요한 범위만 출력한다.

---

## dependency 고정

현재 저장소는 다음과 같은 dependency 범위를 사용한다.

```json
"@livekit/rtc-node": "^0.13.24",
"matrix-js-sdk": "^41.0.0-rc.0"
```

내부 FFI/protobuf/native API를 수정하거나 의존하는 순간 semver range를 그대로 두지 않는 것을 권장한다.

실제로 검증한 버전을 명시적으로 고정하고 `package-lock.json`을 commit한다.

예:

```json
"@livekit/rtc-node": "0.13.24",
"matrix-js-sdk": "41.0.0-rc.0"
```

단, **실제 구현 후 검증된 정확한 버전으로 바꿔야 한다.** 숫자를 추측해서 고정하지 않는다.

---

## 테스트 요구사항

### 단위 테스트

최소 다음을 검증한다.

1. MatrixRTC `EncryptionKeyChanged` 수신
2. participant identity 계산
3. keyIndex 보존
4. raw key가 `setRawKey` adapter에 전달됨
5. key가 로그에 노출되지 않음
6. LiveKit 연결 전에 받은 key buffering
7. LiveKit 연결 후 buffered key flush
8. 같은 participant + keyIndex의 key replacement
9. participant leave/rejoin 처리
10. E2EE required 모드에서 provider 없음/설치 실패 시 hard failure

### 실제 통합 테스트

mock provider만으로 완료 판정하지 않는다.

반드시 실제 다음 흐름을 검증한다.

```text
Element Call E2EE room
        |
        v
MatrixRTC join
        |
        v
EncryptionKeyChanged
        |
        v
Bot MatrixRTC controller
        |
        v
LiveKit native E2EE key store
        |
        v
LiveKit encrypted audio track
        |
        v
Element Call client
        |
        v
audio is audible
```

검증 시:

- 일반 음성방에서도 음성이 들리는지
- E2EE 음성방에서도 음성이 들리는지
- 봇 재접속 후에도 들리는지
- 다른 참가자 입장/퇴장 후에도 들리는지
- key rotation 후에도 들리는지
- bot stop/join/leave 이후 native resource가 정상 정리되는지

를 확인한다.

---

## 테스트에서 특히 피할 오판

다음만 통과했다고 E2EE가 동작한다고 결론 내리지 않는다.

```text
mock KeyProvider.setKey() 호출됨
mock setRawKey() 호출됨
EncryptionKeyChanged event 발생함
LiveKit Room.connect() 성공함
```

최종 성공 기준은 실제 Element Call client가 bot이 publish한 encrypted audio를 복호화하여 들을 수 있는 것이다.

---

## 구현 작업 순서

1. 현재 `matrix_rtc_e2ee.js`의 monkey-patch 제거
2. 현재 설치된 `@livekit/rtc-node`의 E2EE 관련 실제 source/generated protobuf/FFI 구조 조사
3. native layer가 raw participant key를 받을 수 있는 최소 확장 지점 결정
4. `KeyProvider.setRawKey(participantIdentity, key, keyIndex)` adapter/API 구현
5. `matrix_rtc_e2ee.js`에서 adapter만 사용하도록 수정
6. `setSharedKey()` 기반 우회 제거
7. E2EE required failure handling 강화
8. buffered key / reconnect / reemit 경로 검증
9. package version lock + lockfile 정리
10. unit test 보강
11. 실제 Element Call E2EE room에서 end-to-end test

---

## 중요한 원칙

### API 추측 금지

현재 설치된 SDK의 실제 파일과 generated code를 확인하지 않고 함수명이나 protobuf field를 만들지 않는다.

### stock SDK와 fork 구분

`@livekit/rtc-node`를 수정했다면 다음을 명확히 구분한다.

```text
stock npm package
vs
patched/forked package
```

배포/설치/재현 방법도 코드와 함께 문서화한다.

### 기존 일반 음성방 regression 금지

E2EE가 꺼진 일반 room에서는 현재 음악 재생 기능이 기존과 동일하게 작동해야 한다.

### E2EE 성공 여부는 실제 복호화로 판정

프로세스가 살아 있는 것, room에 join한 것, track을 publish한 것만으로 E2EE 성공으로 판정하지 않는다.

---

## 참고 기준

구현 중 다음 프로젝트의 실제 현재 source/API를 우선 확인한다.

- Matrix JS SDK `matrixrtc` source
- Element Call의 `perParticipantE2EE` 구현
- LiveKit Node SDK E2EE implementation
- LiveKit native/FFI protobuf definitions

현재 저장소 commit의 코드는 참고 대상으로 삼되, 현재 설치된 dependency의 실제 API가 최우선이다.
