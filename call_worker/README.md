# call_worker: MatrixRTC & LiveKit Audio Worker

This worker process manages MatrixRTC call membership, WebRTC connection to LiveKit, and real-time audio playback for the music bot.

---

## 1. Stock SDK vs Patched Package

### Stock NPM Package Limitation
In stock `@livekit/rtc-node` (v0.13.24):
- The underlying Protobuf definition (`SetKeyRequest` in `e2ee.proto` / `e2ee_pb.cjs`) and the Rust native FFI binary (`livekit-ffi`) support three fields:
  1. `participant_identity` (string)
  2. `key` (bytes)
  3. `key_index` (int32)
- However, the TypeScript SDK wrapper (`src/e2ee.ts` / `dist/e2ee.cjs`) omitted the `key` argument in `setKey(participantIdentity, keyIndex)`. Calling stock `setKey` sends an empty key to the native WebRTC layer, preventing raw participant-specific media key installation.

### Patched Package Enhancement
We extended `KeyProvider` in `@livekit/rtc-node` with a first-class method:
```javascript
keyProvider.setRawKey(participantIdentity, rawKey, keyIndex = 0)
```
This cleanly serializes `SetKeyRequest` with `participant_identity`, `key` (Uint8Array bytes), and `key_index`, delivering raw participant keys to LiveKit's native WebRTC E2EE key store without requiring brittle monkey-patching or internal file require hacks.

### Reproducibility & Deployment
The patch is managed via `patch-package`:
- Patch file: `patches/@livekit+rtc-node+0.13.24.patch`
- `package.json`:
  ```json
  "scripts": {
    "postinstall": "patch-package"
  }
  ```
Whenever `npm install` or `npm ci` is executed, npm automatically applies the patch to `node_modules/@livekit/rtc-node`.

---

## 2. Protocol Layers

1. **Matrix Room E2EE (`m.room.encryption`)**:
   Megolm message encryption for room events (e.g. text commands).
2. **MatrixRTC Media E2EE (Element Call)**:
   WebRTC frame encryption (GCM) for audio/video media streams.
   - MatrixRTC session emits `EncryptionKeyChanged` events with participant media keys.
   - `MatrixRtcE2eeController` catches these events, buffers keys until LiveKit is connected, and installs them into LiveKit's native key store via `keyProvider.setRawKey()`.
   - Never calls `setSharedKey()`, maintaining per-participant encryption boundaries.

---

## 3. Security & Privacy
- Media keys, crypto secrets, JWTs, and access tokens are strictly guarded from all console and log outputs.
- Only participant identities and key indices are recorded for debugging and diagnostics.

---

## 4. Running Tests

To run the unit tests:
```bash
node test/test_matrix_rtc_e2ee.js
```
The test suite validates:
- `parseBool` configuration helper
- `disabled`, `auto`, and `required` E2EE modes
- Participant identity computation (`rtcBackendIdentity` vs fallback)
- `setRawKey` call integrity without `setSharedKey`
- Zero secrets in logs
- Pre-connect key buffering, buffer flushing, and `reemitEncryptionKeys`
- Key deduplication and replacement
- Participant rejoin and key rotation
- E2EE required mode hard failure on missing providers or failure
- Patched `KeyProvider.prototype.setRawKey` method existence
