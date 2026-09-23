const assert = require("assert");
const EventEmitter = require("events");
const { MatrixRTCSessionEvent } = require("matrix-js-sdk/lib/matrixrtc");
const { EncryptionType, KeyProvider } = require("@livekit/rtc-node");
const { MatrixRtcE2eeController, parseBool } = require("../src/matrix_rtc_e2ee");

async function runTests() {
    console.log("Starting comprehensive MatrixRtcE2eeController unit tests...\n");

    // Test 1: parseBool helper
    {
        assert.strictEqual(parseBool("true"), true);
        assert.strictEqual(parseBool("1"), true);
        assert.strictEqual(parseBool("yes"), true);
        assert.strictEqual(parseBool("false"), false);
        assert.strictEqual(parseBool("0"), false);
        assert.strictEqual(parseBool(undefined, true), true);
        assert.strictEqual(parseBool(undefined, false), false);
        console.log("PASS: Test 1 - parseBool helper");
    }

    // Test 2: Mode disabled
    {
        const mockClient = {
            getCrypto: () => null,
            initRustCrypto: async () => {},
        };
        const controller = new MatrixRtcE2eeController({
            matrixClient: mockClient,
            rtcSession: null,
            roomId: "!room1:example.org",
            userId: "@bot:example.org",
            deviceId: "BOTDEV",
            mode: "disabled",
        });

        const active = await controller.checkAndInitCrypto();
        assert.strictEqual(active, false);
        assert.strictEqual(controller.isEnabled, false);
        assert.strictEqual(controller.getLivekitEncryptionOptions(), undefined);
        const joinOpts = controller.getJoinSessionOptions("matrix2_auto");
        assert.strictEqual(joinOpts.manageMediaKeys, false);
        console.log("PASS: Test 2 - Mode disabled");
    }

    // Test 3: Mode auto - unencrypted room
    {
        const mockClient = {
            getCrypto: () => ({ isEncryptionEnabledInRoom: async () => false }),
            initRustCrypto: async () => {},
            getRoom: () => ({ hasEncryptionStateEvent: () => false }),
            isRoomEncrypted: () => false,
        };
        const controller = new MatrixRtcE2eeController({
            matrixClient: mockClient,
            rtcSession: null,
            roomId: "!unencrypted:example.org",
            userId: "@bot:example.org",
            deviceId: "BOTDEV",
            mode: "auto",
        });

        const active = await controller.checkAndInitCrypto();
        assert.strictEqual(active, false);
        assert.strictEqual(controller.isEnabled, false);
        assert.strictEqual(controller.getLivekitEncryptionOptions(), undefined);
        console.log("PASS: Test 3 - Mode auto (unencrypted room)");
    }

    // Test 4: Mode auto - encrypted room
    {
        const mockClient = {
            getCrypto: () => ({ isEncryptionEnabledInRoom: async () => true }),
            initRustCrypto: async () => {},
            getRoom: () => ({ hasEncryptionStateEvent: () => true }),
            isRoomEncrypted: () => true,
        };
        const controller = new MatrixRtcE2eeController({
            matrixClient: mockClient,
            rtcSession: null,
            roomId: "!encrypted:example.org",
            userId: "@bot:example.org",
            deviceId: "BOTDEV",
            mode: "auto",
        });

        const active = await controller.checkAndInitCrypto();
        assert.strictEqual(active, true);
        assert.strictEqual(controller.isEnabled, true);

        const lkOpts = controller.getLivekitEncryptionOptions();
        assert(lkOpts !== undefined);
        assert.strictEqual(lkOpts.encryptionType, EncryptionType.GCM);
        assert.strictEqual(lkOpts.keyProviderOptions.ratchetWindowSize, 16);

        const joinOpts = controller.getJoinSessionOptions("matrix2_auto");
        assert.strictEqual(joinOpts.manageMediaKeys, true);
        assert.strictEqual(joinOpts.callIntent, "audio");
        console.log("PASS: Test 4 - Mode auto (encrypted room)");
    }

    // Test 5: Mode required - forces E2EE
    {
        const mockClient = {
            getCrypto: () => null,
            initRustCrypto: async () => {},
            getRoom: () => ({ hasEncryptionStateEvent: () => false }),
            isRoomEncrypted: () => false,
        };
        const controller = new MatrixRtcE2eeController({
            matrixClient: mockClient,
            rtcSession: null,
            roomId: "!room:example.org",
            userId: "@bot:example.org",
            deviceId: "BOTDEV",
            mode: "required",
        });

        const active = await controller.checkAndInitCrypto();
        assert.strictEqual(active, true);
        assert.strictEqual(controller.isEnabled, true);
        console.log("PASS: Test 5 - Mode required forces E2EE");
    }

    // Test 6: Participant identity calculation (rtcBackendIdentity vs fallback)
    {
        const controller = new MatrixRtcE2eeController({
            matrixClient: {},
            rtcSession: null,
            roomId: "!room:example.org",
            userId: "@bot:example.org",
            deviceId: "BOTDEV",
        });

        // 1. With rtcBackendIdentity
        const id1 = controller.resolveParticipantIdentity("lk_backend_alice", { userId: "@alice:matrix.org", deviceId: "DEV1" });
        assert.strictEqual(id1, "lk_backend_alice");

        // 2. Without rtcBackendIdentity, with membership
        const id2 = controller.resolveParticipantIdentity(null, { userId: "@bob:matrix.org", deviceId: "DEV2" });
        assert.strictEqual(id2, "@bob:matrix.org:DEV2");

        // 3. User only
        const id3 = controller.resolveParticipantIdentity(null, { userId: "@carol:matrix.org" });
        assert.strictEqual(id3, "@carol:matrix.org");

        // 4. Missing everything
        const id4 = controller.resolveParticipantIdentity(null, null);
        assert.strictEqual(id4, null);

        console.log("PASS: Test 6 - Participant identity calculation");
    }

    // Test 7: setRawKey adapter called with raw key, keyIndex, and NO setSharedKey
    {
        const appliedKeys = [];
        let sharedKeyCalled = false;
        const mockKeyProvider = {
            setRawKey: (id, key, idx) => appliedKeys.push({ id, key, idx }),
            setSharedKey: () => { sharedKeyCalled = true; },
        };

        const controller = new MatrixRtcE2eeController({
            matrixClient: {},
            rtcSession: null,
            roomId: "!room:example.org",
            userId: "@bot:example.org",
            deviceId: "BOTDEV",
            mode: "required",
        });
        controller.enabled = true;
        controller.keyProvider = mockKeyProvider;
        controller.livekitRoom = { e2eeManager: { keyProvider: mockKeyProvider } };

        const testKey = new Uint8Array([10, 20, 30, 40]);
        controller.applyKey("lk_p1", { userId: "@u:m.org", deviceId: "D1" }, testKey, 2);

        assert.strictEqual(appliedKeys.length, 1);
        assert.strictEqual(appliedKeys[0].id, "lk_p1");
        assert.deepStrictEqual(appliedKeys[0].key, testKey);
        assert.strictEqual(appliedKeys[0].idx, 2);
        assert.strictEqual(sharedKeyCalled, false, "setSharedKey must NEVER be called for participant keys");

        console.log("PASS: Test 7 - setRawKey called correctly without setSharedKey");
    }

    // Test 8: Security logging - zero raw keys or secrets in logs
    {
        const loggedLines = [];
        const mockSession = new EventEmitter();
        mockSession.reemitEncryptionKeys = () => {};

        const controller = new MatrixRtcE2eeController({
            matrixClient: { getCrypto: () => ({}), isRoomEncrypted: () => true },
            rtcSession: mockSession,
            roomId: "!room:example.org",
            userId: "@bot:example.org",
            deviceId: "BOTDEV",
            mode: "auto",
            logger: (line) => loggedLines.push(line),
        });

        await controller.checkAndInitCrypto();
        controller.bindRtcSessionEvents();

        const sensitiveKey = new Uint8Array([137, 244, 99, 11, 204, 55]);
        mockSession.emit(
            MatrixRTCSessionEvent.EncryptionKeyChanged,
            sensitiveKey,
            0,
            { userId: "@alice:example.org", deviceId: "ALICEDEV" },
            "lk_alice"
        );

        // Verify none of the log lines contain the raw bytes or secret patterns
        for (const line of loggedLines) {
            assert(!line.includes("137"), "Security violation: raw key byte found in logs!");
            assert(!line.includes("244"), "Security violation: raw key byte found in logs!");
            assert(!line.includes("secret"), "Security violation: secret pattern in logs!");
        }

        console.log("PASS: Test 8 - Security logging (zero secrets/keys in logs)");
    }

    // Test 9: Pre-connect buffering, flush on connect, and reemitEncryptionKeys
    {
        const mockSession = new EventEmitter();
        let reemitCalled = false;
        mockSession.reemitEncryptionKeys = () => { reemitCalled = true; };

        const controller = new MatrixRtcE2eeController({
            matrixClient: { getCrypto: () => ({}), isRoomEncrypted: () => true },
            rtcSession: mockSession,
            roomId: "!room:example.org",
            userId: "@bot:example.org",
            deviceId: "BOTDEV",
            mode: "auto",
        });

        await controller.checkAndInitCrypto();
        controller.bindRtcSessionEvents();

        const key1 = new Uint8Array([1, 2, 3]);
        const key2 = new Uint8Array([4, 5, 6]);

        // Key arrived before LiveKit connected
        mockSession.emit(MatrixRTCSessionEvent.EncryptionKeyChanged, key1, 0, { userId: "@alice:m.org", deviceId: "DEV1" }, "lk_alice");
        mockSession.emit(MatrixRTCSessionEvent.EncryptionKeyChanged, key2, 0, { userId: "@bob:m.org", deviceId: "DEV2" }, "lk_bob");

        assert.strictEqual(controller.bufferedKeys.size, 2);

        // Now connect LiveKit
        const applied = [];
        const mockKeyProvider = {
            setRawKey: (id, key, idx) => applied.push({ id, key, idx }),
        };
        let managerEnabled = false;
        const mockRoom = {
            e2eeManager: {
                keyProvider: mockKeyProvider,
                setEnabled: (v) => { managerEnabled = v; },
            },
        };

        controller.attachLivekitRoom(mockRoom);

        assert.strictEqual(controller.bufferedKeys.size, 0, "Buffered keys should be empty after flush");
        assert.strictEqual(managerEnabled, true);
        assert.strictEqual(applied.length, 2);
        assert.strictEqual(reemitCalled, true, "reemitEncryptionKeys should be called on attach");

        console.log("PASS: Test 9 - Pre-connect buffering, flush, and re-emit");
    }

    // Test 10: Deduplication / key replacement (same participant + keyIndex)
    {
        const mockSession = new EventEmitter();
        const controller = new MatrixRtcE2eeController({
            matrixClient: { getCrypto: () => ({}), isRoomEncrypted: () => true },
            rtcSession: mockSession,
            roomId: "!room:example.org",
            userId: "@bot:example.org",
            deviceId: "BOTDEV",
            mode: "auto",
        });

        await controller.checkAndInitCrypto();
        controller.bindRtcSessionEvents();

        const initialKey = new Uint8Array([1, 1, 1]);
        const replacedKey = new Uint8Array([2, 2, 2]);

        // Emit initial key for Alice index 0
        mockSession.emit(MatrixRTCSessionEvent.EncryptionKeyChanged, initialKey, 0, { userId: "@alice:m.org", deviceId: "D1" }, "lk_alice");
        assert.strictEqual(controller.bufferedKeys.size, 1);
        assert.deepStrictEqual(controller.bufferedKeys.get("lk_alice:0").keyBin, initialKey);

        // Emit replaced key for Alice same index 0
        mockSession.emit(MatrixRTCSessionEvent.EncryptionKeyChanged, replacedKey, 0, { userId: "@alice:m.org", deviceId: "D1" }, "lk_alice");
        assert.strictEqual(controller.bufferedKeys.size, 1, "Duplicate participant+keyIndex must be replaced, not appended");
        assert.deepStrictEqual(controller.bufferedKeys.get("lk_alice:0").keyBin, replacedKey);

        console.log("PASS: Test 10 - Deduplication and key replacement");
    }

    // Test 11: Participant rejoin and key rotation (new keyIndex)
    {
        const applied = [];
        const mockKeyProvider = {
            setRawKey: (id, key, idx) => applied.push({ id, key, idx }),
        };
        const mockRoom = {
            e2eeManager: {
                keyProvider: mockKeyProvider,
                setEnabled: () => {},
            },
        };

        const controller = new MatrixRtcE2eeController({
            matrixClient: { getCrypto: () => ({}), isRoomEncrypted: () => true },
            rtcSession: null,
            roomId: "!room:example.org",
            userId: "@bot:example.org",
            deviceId: "BOTDEV",
            mode: "auto",
        });
        controller.enabled = true;
        controller.attachLivekitRoom(mockRoom);

        // Participant joins with index 0
        controller.applyKey("lk_alice", null, new Uint8Array([1]), 0);
        // Participant rotates key or rejoins with index 1
        controller.applyKey("lk_alice", null, new Uint8Array([2]), 1);

        assert.strictEqual(applied.length, 2);
        assert.strictEqual(applied[0].idx, 0);
        assert.strictEqual(applied[1].idx, 1);

        console.log("PASS: Test 11 - Participant rejoin and key rotation");
    }

    // Test 12: E2EE required mode hard failure on missing provider
    {
        const controller = new MatrixRtcE2eeController({
            matrixClient: {},
            rtcSession: null,
            roomId: "!room:example.org",
            userId: "@bot:example.org",
            deviceId: "BOTDEV",
            mode: "required",
        });
        controller.enabled = true;

        // Room without e2eeManager
        const badRoom = { e2eeManager: null };
        assert.throws(() => {
            controller.attachLivekitRoom(badRoom);
        }, /LiveKit E2EE manager is unavailable/);

        // Room with e2eeManager but no keyProvider
        const badRoom2 = { e2eeManager: { keyProvider: null } };
        assert.throws(() => {
            controller.attachLivekitRoom(badRoom2);
        }, /LiveKit E2EE key provider is unavailable/);

        // KeyProvider missing setRawKey
        controller.keyProvider = {};
        assert.throws(() => {
            controller.applyKey("user1", null, new Uint8Array([1]), 0);
        }, /LiveKit KeyProvider does not support raw participant keys/);

        console.log("PASS: Test 12 - E2EE required mode hard failures");
    }

    // Test 13: E2EE auto mode graceful fallback
    {
        const controller = new MatrixRtcE2eeController({
            matrixClient: {},
            rtcSession: null,
            roomId: "!room:example.org",
            userId: "@bot:example.org",
            deviceId: "BOTDEV",
            mode: "auto",
        });
        controller.enabled = true;

        // Should not throw, should set enabled = false
        const badRoom = { e2eeManager: null };
        assert.doesNotThrow(() => {
            controller.attachLivekitRoom(badRoom);
        });
        assert.strictEqual(controller.isEnabled, false);

        console.log("PASS: Test 13 - E2EE auto mode graceful fallback");
    }

    // Test 14: Patched @livekit/rtc-node KeyProvider native method check
    {
        assert(typeof KeyProvider.prototype.setRawKey === "function", "KeyProvider must have setRawKey on prototype");
        console.log("PASS: Test 14 - Patched KeyProvider.prototype.setRawKey exists");
    }

    // Test 15: connectOptions compatibility with LiveKit Room.connect and RoomOptions
    {
        const controller = new MatrixRtcE2eeController({
            matrixClient: {},
            rtcSession: null,
            roomId: "!room:example.org",
            userId: "@bot:example.org",
            deviceId: "BOTDEV",
            mode: "required",
        });
        controller.enabled = true;

        const connectOptions = {
            autoSubscribe: true,
            dynacast: true,
            ...(controller.getLivekitEncryptionOptions() ?? {}),
        };

        // Must have encryption field that LiveKit Room.connect inspects
        assert(connectOptions.encryption !== undefined, "connectOptions must have encryption field");
        assert.strictEqual(connectOptions.encryption.encryptionType, EncryptionType.GCM);
        assert(connectOptions.encryption.keyProviderOptions !== undefined);

        // Also check getJoinSessionOptions
        const joinOpts = controller.getJoinSessionOptions("matrix2_auto");
        assert.strictEqual(joinOpts.manageMediaKeys, true);
        assert.strictEqual(joinOpts.callIntent, "audio");

        console.log("PASS: Test 15 - connectOptions & joinOptions integration compatibility");
    }

    console.log("\nALL 15 TESTS PASSED SUCCESSFULLY! (15/15)");
}

runTests().catch((err) => {
    console.error("TEST FAILED:", err);
    process.exit(1);
});
