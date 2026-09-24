# AGENTS.md — MatrixRTC / Element Call E2EE interop implementation guide

## Goal

Modify the existing Matrix music bot so that it continues to work in ordinary MatrixRTC voice rooms and can also publish audio into Element Call rooms using MatrixRTC per-participant media E2EE.

The repository already contains:

- a Python bot/front-end
- `call_worker/` in Node.js
- `matrix-js-sdk`
- `@livekit/rtc-node`
- FFmpeg → PCM → `AudioSource` → `LocalAudioTrack` → LiveKit publishing
- `call_worker/src/matrix_rtc_e2ee.js`
- a `patch-package` patch for `@livekit/rtc-node`

Do not replace the existing audio pipeline. Integrate E2EE into it.

## Current architecture

Expected runtime flow:

```text
Matrix client / Rust crypto
        |
        v
MatrixRTCSessionManager
        |
        v
MatrixRTCSession
  manageMediaKeys: true
        |
        | EncryptionKeyChanged
        v
MatrixRtcE2eeController
        |
        | participant identity + raw MatrixRTC media key + key index
        v
LiveKit KeyProvider.setRawKey(...)
        |
        v
LiveKit native E2EE / FrameCryptor
        |
        v
Encrypted audio track
        |
        v
Element Call participant
```

Ordinary non-E2EE rooms must continue to work without requiring E2EE-specific configuration.

## Important distinction

Do not conflate these two layers:

1. Matrix room E2EE (`m.room.encryption`)
2. MatrixRTC media E2EE (media keys used by LiveKit/WebRTC frame encryption)

Element Call per-participant media E2EE is the target behavior. Room-message encryption alone is not sufficient for encrypted voice media.

## Critical current implementation facts

### `matrix_rtc_e2ee.js`

The controller should:

- detect/enable MatrixRTC media key management
- listen for `EncryptionKeyChanged`
- buffer keys received before LiveKit is connected
- replay buffered keys after LiveKit E2EE is attached
- handle key rotation/replacement
- avoid logging raw key material
- use participant-specific identities (`rtcBackendIdentity` when supplied)
- use a raw-key setter on the LiveKit provider
- fail loudly in `required` mode when the E2EE path is unavailable

Do NOT use the old approach of calling the public LiveKit `setKey()` with raw key bytes. The public Node API does not use that signature.

The desired controller-side call is:

```js
keyProvider.setRawKey(
    participantIdentity,
    key,
    keyIndex,
);
```

where:

- `participantIdentity` is the MatrixRTC backend identity / participant identity
- `key` is the raw MatrixRTC media key (`Uint8Array`/Buffer-compatible data)
- `keyIndex` is the MatrixRTC media key index

### Do not silently fall back

If E2EE is configured as `required`, these are hard failures:

- no LiveKit E2EE manager
- no key provider
- no `setRawKey()` support
- failure to install a MatrixRTC media key
- failure to enable the LiveKit E2EE manager

Do not silently continue as though the room were secure.

## LiveKit Node SDK patch

The repository currently uses a `patch-package` patch for:

```text
@livekit/rtc-node 0.13.24
```

The purpose is to expose a raw participant-key path, because the public Node API does not provide the exact MatrixRTC raw-key injection API needed by the controller.

Expected conceptual API:

```js
setRawKey(participantIdentity, key, keyIndex)
```

The patch must be internally consistent across:

- TypeScript/source layer
- generated JS layer if applicable
- FFI/protobuf layer
- native request wiring
- exported `KeyProvider` API

Do not only add a JavaScript method that does nothing.

Do not invent protobuf fields. Inspect the exact installed SDK version and generated FFI types before changing them.

## Dependency rule

The project currently pins:

```json
"@livekit/rtc-node": "0.13.24",
"matrix-js-sdk": "41.0.0-rc.0"
```

Keep versions pinned unless the task explicitly calls for an upgrade.

Do not change `^0.13.24` back to a floating range.

The LiveKit patch is version-specific. If upgrading `@livekit/rtc-node`, re-validate the patch against that exact version instead of assuming internal FFI compatibility.

`package-lock.json` must remain consistent with `package.json` and the patch.

Prefer `npm ci` for reproducible installation.

## Element Call E2EE compatibility — key derivation

A major interoperability point is the key derivation configuration.

Do NOT assume that injecting the raw MatrixRTC key is enough. The LiveKit E2EE key provider must derive frame keys in a way compatible with Element Call.

Element Call's current Matrix key provider uses HKDF-based derivation for the MatrixRTC media key path. Therefore the bot must be checked for matching LiveKit configuration.

The current bot code should be evaluated for settings equivalent to:

```js
keyProviderOptions: {
    ratchetSalt: Buffer.from("LKFrameEncryptionKey"),
    ratchetWindowSize: 10,
    keyRingSize: 256,
    failureTolerance: -1,
    keyDerivationFunction: KeyDerivationFunction.HKDF,
},
```

However, **do not assume `KeyDerivationFunction.HKDF` exists in the pinned `@livekit/rtc-node@0.13.24` build**. Verify the installed package exports and implementation first.

If the pinned version does not expose the required KDF configuration, investigate one of these options:

1. a supported configuration path already present in 0.13.24
2. a minimal, well-scoped patch to expose the required native setting
3. a carefully justified SDK version upgrade followed by revalidation of all patches

Do not fake an enum or pass a value that the native layer ignores.

## Element Call compatibility references

Use the current upstream implementation as the interoperability reference, but verify against the exact versions in use.

Relevant upstream areas:

- Element Call Matrix E2EE provider:
  https://github.com/element-hq/element-call/blob/main/src/e2ee/matrixKeyProvider.ts
- Element Call E2EE URL/config documentation:
  https://github.com/element-hq/element-call/blob/main/docs/url_params.md
- Matrix JS SDK MatrixRTC session:
  https://github.com/matrix-org/matrix-js-sdk/blob/v41.0.0-rc.0/src/matrixrtc/MatrixRTCSession.ts
- Matrix JS SDK MatrixRTC encryption manager:
  https://github.com/matrix-org/matrix-js-sdk/blob/v41.0.0-rc.0/src/matrixrtc/EncryptionManager.ts
- LiveKit Node E2EE implementation:
  https://github.com/livekit/node-sdks/tree/main/packages/livekit-rtc

When upstream changes, verify the actual checked-out/installed API instead of relying only on documentation or memory.

## MatrixRTC event handling

The controller should use the actual SDK event payload shape.

For `EncryptionKeyChanged`, expect data corresponding to:

- key
- key index
- membership
- RTC backend identity

Do not invent a different membership or identity format.

Prefer `rtcBackendIdentity` for the LiveKit participant key identity when available.

If a fallback is required, construct it only from verified MatrixRTC membership semantics; do not create arbitrary identity strings.

## Key buffering and lifecycle

The expected lifecycle is:

```text
MatrixRTC key arrives
      |
      +-- LiveKit E2EE ready --> install immediately
      |
      +-- LiveKit not ready --> buffer by participant/index
                                  |
                                  v
                            LiveKit attached
                                  |
                                  v
                         replay buffered keys
```

Required cases:

- first local key
- first remote key
- remote participant joins later
- key rotation
- same participant sends a newer key index
- reconnect
- LiveKit reconnect after MatrixRTC remains alive
- MatrixRTC session recreation

Do not log key bytes.

When replacing a key, make sure stale keys do not remain selected for the active participant/index combination.

## `join_call.js` integration

The E2EE controller must be connected to the actual execution path.

Required order conceptually:

```js
create MatrixRTC session/controller
await checkAndInitCrypto()
bind MatrixRTC encryption events
join MatrixRTC with manageMediaKeys enabled when appropriate
connect LiveKit with E2EE options when appropriate
attach the LiveKit room to the E2EE controller
create/publish audio track
```

The following mistakes are regressions:

- importing `matrix_rtc_e2ee.js` but never instantiating it
- creating a controller but not binding `EncryptionKeyChanged`
- calculating `manageMediaKeys` but not passing it to `joinRTCSession()`
- calculating LiveKit E2EE options but not passing them to `Room.connect()`
- attaching the E2EE controller after keys are irretrievably discarded
- publishing audio without a functioning E2EE provider when E2EE is required

## Normal room compatibility

The bot must retain normal non-E2EE functionality.

Expected behavior:

```text
Normal room
  -> existing MatrixRTC/LiveKit path
  -> no E2EE requirement
  -> audio publishes normally

E2EE room
  -> MatrixRTC media keys enabled
  -> LiveKit E2EE enabled
  -> MatrixRTC keys installed into LiveKit
  -> encrypted audio published
```

Avoid making the entire worker E2EE-only.

## Testing requirements

Unit tests are useful but insufficient.

### Unit/integration tests should cover

- controller initialization
- E2EE mode detection
- `EncryptionKeyChanged` handling
- buffering before LiveKit attach
- buffer flush after LiveKit attach
- key replacement
- key rotation
- reconnect/re-attach
- missing key provider
- missing `setRawKey()`
- required vs auto mode
- no key material in logs
- `joinRTCSession()` options include `manageMediaKeys` when required
- LiveKit `Room.connect()` receives the expected E2EE options
- patched `setRawKey()` exists in the actual installed package

### Important limitation

A test suite that merely checks:

```js
typeof KeyProvider.prototype.setRawKey === "function"
```

does NOT prove interoperability.

Likewise, a mock key provider does not prove that the native LiveKit E2EE layer accepts and uses the MatrixRTC key.

### Required real-world test

Use an actual Element Call per-participant E2EE room.

Validate:

1. Element Call joins the room.
2. Bot joins the same MatrixRTC call.
3. MatrixRTC key exchange occurs.
4. Bot receives the participant-specific media key.
5. Bot installs the raw key into the native LiveKit key provider.
6. Bot publishes an encrypted audio track.
7. Element Call receives the track and successfully decrypts audio.
8. Add/remove participants.
9. Trigger key rotation if possible.
10. Reconnect the bot without restarting the Matrix account.
11. Verify audio still decrypts after reconnect.

This is the decisive interoperability test.

## Security/logging rules

Never log:

- raw MatrixRTC keys
- derived LiveKit keys
- crypto secrets
- access tokens/JWTs in full
- device private keys

Allowed diagnostic information includes:

- key index
- participant identity (where safe/necessary)
- whether a key was buffered/installed
- success/failure state
- error messages with secret material removed

## Common mistakes to avoid

### Mistake 1: Using public `setKey()` with raw bytes

Wrong:

```js
keyProvider.setKey(identity, rawKey, keyIndex)
```

The public Node API does not have this meaning.

Use the explicit raw-key adapter introduced by the project patch.

### Mistake 2: Using `setSharedKey()` for per-participant MatrixRTC keys

Do not convert participant-specific MatrixRTC keys into shared-key state unless the protocol explicitly calls for shared-key mode.

Target mode here is per-participant media E2EE.

### Mistake 3: Assuming raw-key injection alone guarantees compatibility

Key derivation, ratcheting, cipher mode, salt, key ring/window size, and participant identity semantics all matter.

### Mistake 4: Swallowing required-mode failures

A secure-room join must not silently degrade to unencrypted media.

### Mistake 5: Testing only mocks

Mock tests cannot verify native LiveKit frame encryption interoperability.

## Code quality

- Preserve the existing architecture.
- Keep changes localized.
- Add comments explaining why the `@livekit/rtc-node` patch exists.
- Avoid broad monkey patches of unrelated SDK methods.
- Prefer explicit APIs over prototype monkey-patching where possible.
- Do not duplicate key state in multiple incompatible key stores.
- Keep async error handling deterministic.
- Keep logging useful but secret-free.

## Acceptance criteria

A change is considered complete only when all of the following are true:

- normal non-E2EE rooms continue to work
- E2EE rooms enable MatrixRTC media keys correctly
- `EncryptionKeyChanged` keys reach the LiveKit key provider
- the raw-key path is implemented all the way through native FFI
- LiveKit uses Element Call-compatible E2EE derivation/configuration
- key rotation/reconnect works
- no secrets are logged
- pinned dependencies and `package-lock.json` are consistent
- automated tests pass
- real Element Call interoperability has been verified

Do not claim “E2EE works” based only on unit-test success. The final proof is that an actual Element Call client can hear the bot's encrypted audio in an E2EE MatrixRTC room.
