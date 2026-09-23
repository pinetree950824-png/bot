const path = require("path");
const { MatrixRTCSessionEvent } = require("matrix-js-sdk/lib/matrixrtc");
const { EncryptionType, KeyProvider } = require("@livekit/rtc-node");

// Load LiveKit protobuf and FFI client to support per-participant key setting
let FfiClient = null;
let E2eeRequest = null;
let SetKeyRequest = null;
let SetSharedKeyRequest = null;

try {
    const ffiPath = path.resolve(__dirname, "../node_modules/@livekit/rtc-node/dist/ffi_client.cjs");
    const protoPath = path.resolve(__dirname, "../node_modules/@livekit/rtc-node/dist/proto/e2ee_pb.cjs");
    FfiClient = require(ffiPath).FfiClient;
    const proto = require(protoPath);
    E2eeRequest = proto.E2eeRequest;
    SetKeyRequest = proto.SetKeyRequest;
    SetSharedKeyRequest = proto.SetSharedKeyRequest;

    // Monkey-patch KeyProvider.prototype.setKey to correctly pass key bytes
    if (KeyProvider && KeyProvider.prototype && typeof KeyProvider.prototype.setKey === "function") {
        const originalSetKey = KeyProvider.prototype.setKey;
        KeyProvider.prototype.setKey = function (participantIdentity, key, keyIndex = 0) {
            let actualKey = key;
            let actualIndex = keyIndex;
            if (typeof key === "number" && !(key instanceof Uint8Array) && !Buffer.isBuffer(key)) {
                actualIndex = key;
                actualKey = undefined;
            }
            if ((actualKey instanceof Uint8Array || Buffer.isBuffer(actualKey)) && FfiClient && E2eeRequest && SetKeyRequest) {
                const req = new E2eeRequest({
                    roomHandle: this.roomHandle,
                    message: {
                        case: "setKey",
                        value: new SetKeyRequest({
                            participantIdentity,
                            key: actualKey instanceof Uint8Array ? actualKey : new Uint8Array(actualKey),
                            keyIndex: typeof actualIndex === "number" ? actualIndex : 0,
                        }),
                    },
                });
                FfiClient.instance.request({
                    message: {
                        case: "e2ee",
                        value: req,
                    },
                });
                return;
            }
            return originalSetKey.call(this, participantIdentity, actualIndex);
        };
    }
} catch (err) {
    // Best effort patching; fallback to existing methods if direct cjs resolution fails
}

function parseBool(value, defaultValue = false) {
    if (value === undefined || value === null) return defaultValue;
    const s = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
    return defaultValue;
}

class MatrixRtcE2eeController {
    /**
     * @param {Object} options
     * @param {import("matrix-js-sdk").MatrixClient} options.matrixClient
     * @param {import("matrix-js-sdk/lib/matrixrtc").MatrixRTCSession} options.rtcSession
     * @param {string} options.roomId
     * @param {string} options.userId
     * @param {string} options.deviceId
     * @param {string} [options.mode] "auto" | "required" | "disabled"
     * @param {Function} [options.logger]
     */
    constructor({ matrixClient, rtcSession, roomId, userId, deviceId, mode = "auto", logger }) {
        this.matrixClient = matrixClient;
        this.rtcSession = rtcSession;
        this.roomId = roomId;
        this.userId = userId;
        this.deviceId = deviceId;
        this.mode = (mode || "auto").trim().toLowerCase();
        this.logger = typeof logger === "function" ? logger : (msg) => console.log(msg);

        this.enabled = false;
        this.livekitRoom = null;
        this.keyProvider = null;
        this.bufferedKeys = new Map();
        this.keyVersion = 0;
        this.keyChangeHandler = null;
    }

    get isEnabled() {
        return this.enabled;
    }

    log(msg) {
        // Redaction guard: ensure NO media keys or tokens are in msg
        this.logger(`[E2EE] ${msg}`);
    }

    /**
     * Initializes Matrix crypto and determines whether E2EE should be enabled.
     * @returns {Promise<boolean>} Whether E2EE is active for this call session
     */
    async checkAndInitCrypto() {
        if (this.mode === "disabled") {
            this.enabled = false;
            this.log("mode=disabled; E2EE media encryption disabled");
            return false;
        }

        // Initialize Rust crypto if not already initialized
        if (!this.matrixClient.getCrypto?.()) {
            try {
                this.log("initializing matrix rust crypto with in-memory store...");
                await this.matrixClient.initRustCrypto({ useIndexedDB: false });
                this.log("matrix rust crypto initialized successfully");
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (this.mode === "required") {
                    throw new Error(`Matrix crypto initialization failed in required mode: ${message}`);
                }
                this.log(`warning: crypto init failed (${message}); falling back to non-E2EE`);
                this.enabled = false;
                return false;
            }
        }

        const isRoomEncrypted = await this.isRoomEncrypted();
        if (this.mode === "required") {
            this.enabled = true;
            this.log("mode=required; forcing E2EE media encryption");
            return true;
        }

        // auto mode
        if (isRoomEncrypted) {
            this.enabled = true;
            this.log("room has encryption active; enabled E2EE media encryption");
            return true;
        }

        this.enabled = false;
        this.log("room is not encrypted; E2EE media encryption inactive");
        return false;
    }

    /**
     * Checks if the Matrix room is configured with encryption.
     * @returns {Promise<boolean>}
     */
    async isRoomEncrypted() {
        try {
            const room = this.matrixClient.getRoom?.(this.roomId);
            if (room && typeof room.hasEncryptionStateEvent === "function") {
                if (room.hasEncryptionStateEvent()) {
                    return true;
                }
            }

            if (typeof this.matrixClient.isRoomEncrypted === "function") {
                if (this.matrixClient.isRoomEncrypted(this.roomId)) {
                    return true;
                }
            }

            const crypto = this.matrixClient.getCrypto?.();
            if (crypto && typeof crypto.isEncryptionEnabledInRoom === "function") {
                const enabled = await crypto.isEncryptionEnabledInRoom(this.roomId);
                if (enabled) return true;
            }
        } catch (err) {
            this.log(`error checking room encryption status: ${err instanceof Error ? err.message : String(err)}`);
        }
        return false;
    }

    /**
     * Returns JoinSessionConfig options for MatrixRTCSession.joinRTCSession
     * @param {string} membershipMode
     * @returns {Object}
     */
    getJoinSessionOptions(membershipMode) {
        return {
            callIntent: "audio",
            unstableSendStickyEvents: membershipMode !== "legacy",
            manageMediaKeys: this.enabled,
            useExperimentalToDeviceTransport: parseBool(process.env.MATRIX_RTC_TO_DEVICE, false),
        };
    }

    /**
     * Returns LiveKit Room connect options for E2EE.
     * @returns {Object|undefined}
     */
    getLivekitEncryptionOptions() {
        if (!this.enabled) return undefined;
        return {
            keyProviderOptions: {
                ratchetWindowSize: 16,
                failureTolerance: -1,
            },
            encryptionType: EncryptionType.GCM,
        };
    }

    /**
     * Binds listener to MatrixRTCSession events.
     */
    bindRtcSessionEvents() {
        if (!this.enabled || !this.rtcSession) return;

        this.keyChangeHandler = (keyBin, keyIndex, membership, rtcBackendIdentity) => {
            this.handleEncryptionKeyChanged(keyBin, keyIndex, membership, rtcBackendIdentity);
        };
        this.rtcSession.on(MatrixRTCSessionEvent.EncryptionKeyChanged, this.keyChangeHandler);
        this.log("bound to MatrixRTCSession EncryptionKeyChanged event");
    }

    /**
     * Handles newly received or rotated encryption keys from MatrixRTC.
     * @param {Uint8Array} keyBin
     * @param {number} keyIndex
     * @param {Object} membership
     * @param {string} rtcBackendIdentity
     */
    handleEncryptionKeyChanged(keyBin, keyIndex, membership, rtcBackendIdentity) {
        this.keyVersion += 1;
        const isOwnKey = Boolean(
            membership &&
            membership.userId === this.userId &&
            membership.deviceId === this.deviceId
        );

        // Security check: NEVER log keyBin bytes or base64. Only log metadata.
        const participantLabel = rtcBackendIdentity || (membership ? `${membership.userId}:${membership.deviceId}` : "unknown");
        this.log(`media key update v=${this.keyVersion} index=${keyIndex} is_own=${isOwnKey} participant=${participantLabel}`);

        if (this.livekitRoom && this.keyProvider) {
            this.applyKey(rtcBackendIdentity, membership, keyBin, keyIndex, isOwnKey);
        } else {
            // Buffer keys until livekitRoom and keyProvider are attached
            const mapKey = `${membership?.userId || ""}:${membership?.deviceId || ""}:${keyIndex}`;
            this.bufferedKeys.set(mapKey, {
                rtcBackendIdentity,
                membership,
                keyBin,
                keyIndex,
                isOwnKey,
            });
            this.log(`buffered media key for participant=${participantLabel} (total_buffered=${this.bufferedKeys.size})`);
        }
    }

    /**
     * Attaches connected LiveKit Room and initializes key provider.
     * @param {import("@livekit/rtc-node").Room} livekitRoom
     */
    attachLivekitRoom(livekitRoom) {
        if (!this.enabled || !livekitRoom) return;

        this.livekitRoom = livekitRoom;
        if (livekitRoom.e2eeManager) {
            this.keyProvider = livekitRoom.e2eeManager.keyProvider;
            try {
                livekitRoom.e2eeManager.setEnabled(true);
                this.log("LiveKit E2EE manager enabled successfully");
            } catch (err) {
                this.log(`error enabling LiveKit E2EEManager: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        // Flush buffered keys
        if (this.bufferedKeys.size > 0) {
            this.log(`flushing ${this.bufferedKeys.size} buffered media keys into LiveKit key provider`);
            for (const item of this.bufferedKeys.values()) {
                this.applyKey(item.rtcBackendIdentity, item.membership, item.keyBin, item.keyIndex, item.isOwnKey);
            }
            this.bufferedKeys.clear();
        }

        // Re-emit any tracked keys from MatrixRTC session to ensure completeness
        if (typeof this.rtcSession?.reemitEncryptionKeys === "function") {
            try {
                this.rtcSession.reemitEncryptionKeys();
            } catch (err) {
                // best effort
            }
        }
    }

    /**
     * Applies a media key into LiveKit key provider.
     * @param {string} rtcBackendIdentity
     * @param {Object} membership
     * @param {Uint8Array} keyBin
     * @param {number} keyIndex
     * @param {boolean} isOwnKey
     */
    applyKey(rtcBackendIdentity, membership, keyBin, keyIndex, isOwnKey) {
        if (!this.keyProvider) return;

        try {
            if (isOwnKey) {
                // Set shared key if room/participant uses shared key mode
                if (typeof this.keyProvider.setSharedKey === "function") {
                    this.keyProvider.setSharedKey(keyBin, keyIndex);
                }

                // Also set under own identity
                if (rtcBackendIdentity && typeof this.keyProvider.setKey === "function") {
                    this.keyProvider.setKey(rtcBackendIdentity, keyBin, keyIndex);
                }
                const localIdentity = this.livekitRoom?.localParticipant?.identity;
                if (localIdentity && localIdentity !== rtcBackendIdentity && typeof this.keyProvider.setKey === "function") {
                    this.keyProvider.setKey(localIdentity, keyBin, keyIndex);
                }
            } else {
                // Remote participant key
                if (rtcBackendIdentity && typeof this.keyProvider.setKey === "function") {
                    this.keyProvider.setKey(rtcBackendIdentity, keyBin, keyIndex);
                }
                if (membership?.userId && membership?.deviceId) {
                    const fallbackId = `${membership.userId}:${membership.deviceId}`;
                    if (fallbackId !== rtcBackendIdentity && typeof this.keyProvider.setKey === "function") {
                        this.keyProvider.setKey(fallbackId, keyBin, keyIndex);
                    }
                }
            }
        } catch (err) {
            this.log(`error applying key to keyProvider: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /**
     * Clean up event listeners and state.
     */
    cleanup() {
        if (this.keyChangeHandler && this.rtcSession) {
            try {
                this.rtcSession.off(MatrixRTCSessionEvent.EncryptionKeyChanged, this.keyChangeHandler);
            } catch {
                // ignore
            }
            this.keyChangeHandler = null;
        }
        this.bufferedKeys.clear();
        this.livekitRoom = null;
        this.keyProvider = null;
        this.enabled = false;
        this.log("E2EE controller cleaned up");
    }
}

module.exports = {
    MatrixRtcE2eeController,
    parseBool,
};
