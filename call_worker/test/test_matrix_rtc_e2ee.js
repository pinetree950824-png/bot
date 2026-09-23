const assert = require("assert");
const EventEmitter = require("events");
const { MatrixRTCSessionEvent } = require("matrix-js-sdk/lib/matrixrtc");
const { EncryptionType } = require("@livekit/rtc-node");
const { MatrixRtcE2eeController, parseBool } = require("../src/matrix_rtc_e2ee");

async function runTests() {
    console.log("Starting MatrixRtcE2eeController unit tests...\n");

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

    // Test 6: Key event handling, buffering, and flushing to LiveKit
    {
        const mockSession = new EventEmitter();
        mockSession.reemitEncryptionKeys = () => {};

        const loggedLines = [];
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
        assert.strictEqual(controller.isEnabled, true);
        controller.bindRtcSessionEvents();

        // Simulate our own media key emitted before LiveKit connects
        const secretKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
        mockSession.emit(
            MatrixRTCSessionEvent.EncryptionKeyChanged,
            secretKey,
            0,
            { userId: "@bot:example.org", deviceId: "BOTDEV", memberId: "@bot:example.org:BOTDEV" },
            "lk_identity_bot"
        );

        // Verify key was buffered
        assert.strictEqual(controller.bufferedKeys.size, 1);

        // Security check: ensure NO raw key bytes or secret materials are in logged lines!
        for (const line of loggedLines) {
            assert(!line.includes("1,2,3,4,5"), "Security violation: raw key found in logs!");
            assert(!line.includes("secret"), "Security violation: secret found in logs!");
        }

        // Now simulate LiveKit Room connecting and attaching
        const appliedSharedKeys = [];
        const appliedParticipantKeys = [];
        const mockKeyProvider = {
            setSharedKey: (k, idx) => appliedSharedKeys.push({ key: k, index: idx }),
            setKey: (id, k, idx) => appliedParticipantKeys.push({ id, key: k, index: idx }),
        };
        let managerEnabled = false;
        const mockRoom = {
            e2eeManager: {
                keyProvider: mockKeyProvider,
                setEnabled: (v) => { managerEnabled = v; },
            },
            localParticipant: { identity: "lk_identity_bot" },
        };

        controller.attachLivekitRoom(mockRoom);

        // Buffers should have flushed
        assert.strictEqual(controller.bufferedKeys.size, 0);
        assert.strictEqual(managerEnabled, true);
        assert.strictEqual(appliedSharedKeys.length, 1);
        assert.strictEqual(appliedSharedKeys[0].index, 0);
        assert.strictEqual(appliedParticipantKeys.length > 0, true);

        // Simulate another participant joining and receiving remote key
        const remoteKey = new Uint8Array(16).fill(42);
        mockSession.emit(
            MatrixRTCSessionEvent.EncryptionKeyChanged,
            remoteKey,
            1,
            { userId: "@alice:example.org", deviceId: "ALICEDEV" },
            "lk_identity_alice"
        );

        const aliceApplied = appliedParticipantKeys.find((k) => k.id === "lk_identity_alice");
        assert(aliceApplied, "Alice's participant key was not set in LiveKit keyProvider");
        assert.strictEqual(aliceApplied.index, 1);

        // Cleanup
        controller.cleanup();
        assert.strictEqual(controller.isEnabled, false);
        assert.strictEqual(controller.bufferedKeys.size, 0);

        console.log("PASS: Test 6 - Key event handling, buffering, security logging, and flushing");
    }

    console.log("\nALL TESTS PASSED SUCCESSFULLY! (6/6)");
}

runTests().catch((err) => {
    console.error("TEST FAILED:", err);
    process.exit(1);
});
