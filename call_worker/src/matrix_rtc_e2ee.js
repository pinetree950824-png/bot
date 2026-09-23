const { MatrixRTCSessionEvent } = require("matrix-js-sdk/lib/matrixrtc");
const { EncryptionType } = require("@livekit/rtc-node");

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
    constructor({ matrixClient, rtcSession, roomId, userId, deviceId, mode = "auto", logger, onError }) {
        this.matrixClient = matrixClient;
        this.rtcSession = rtcSession;
        this.roomId = roomId;
        this.userId = userId;
        this.deviceId = deviceId;
        this.mode = (mode || "auto").trim().toLowerCase();
        this.logger = typeof logger === "function" ? logger : (msg) => console.log(msg);
        this.onError = typeof onError === "function" ? onError : null;

        this.enabled = false;
        this.roomIsEncrypted = false;
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
     * Handles an E2EE failure according to current mode and room encryption.
     * In "required" mode or when the room is encrypted (m.room.encryption),
     * this throws a fatal Error to abort call joining.
     * In "auto" mode for unencrypted rooms, it logs a warning and gracefully disables E2EE.
     * @param {string} reason
     */
    handleE2eeFailure(reason) {
        this.enabled = false;
        if (this.mode === "required" || this.roomIsEncrypted) {
            const context = this.mode === "required" ? "required mode" : "encrypted room";
            const errorMsg = `MatrixRTC E2EE fatal error (${context}): ${reason}`;
            this.log(`CRITICAL: ${errorMsg}`);
            const error = new Error(errorMsg);
            if (this.onError) {
                try {
                    this.onError(error);
                } catch {
                    // best effort
                }
            }
            throw error;
        }

        this.log(`warning: E2EE failure (${reason}); falling back to non-E2EE`);
        return false;
    }

    /**
     * Initializes Matrix crypto and determines whether E2EE should be enabled.
     * @returns {Promise<boolean>} Whether E2EE is active for this call session
     */
    async checkAndInitCrypto() {
        if (this.mode === "disabled") {
            this.enabled = false;
            this.roomIsEncrypted = false;
            this.log("mode=disabled; E2EE media encryption disabled");
            return false;
        }

        this.roomIsEncrypted = await this.isRoomEncrypted();

        // Initialize Rust crypto if not already initialized
        if (!this.matrixClient.getCrypto?.()) {
            try {
                this.log("initializing matrix rust crypto with in-memory store...");
                await this.matrixClient.initRustCrypto({ useIndexedDB: false });
                this.log("matrix rust crypto initialized successfully");
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return this.handleE2eeFailure(`Matrix crypto initialization failed: ${message}`);
            }
        }

        if (this.mode === "required") {
            this.enabled = true;
            this.log("mode=required; forcing E2EE media encryption");
            return true;
        }

        // auto mode
        if (this.roomIsEncrypted) {
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

            if (room?.currentState?.getStateEvents?.("m.room.encryption", "")) {
                return true;
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
        const e2eeOptions = {
            keyProviderOptions: {
                ratchetSalt: Buffer.from("LKFrameEncryptionKey"),
                ratchetWindowSize: 16,
                failureTolerance: -1,
            },
            encryptionType: EncryptionType.GCM,
        };
        return {
            encryption: e2eeOptions,
            e2ee: e2eeOptions,
            keyProviderOptions: e2eeOptions.keyProviderOptions,
            encryptionType: e2eeOptions.encryptionType,
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
     * Resolves the canonical participant identity for LiveKit.
     * @param {string} rtcBackendIdentity
     * @param {Object} [membership]
     * @returns {string|null}
     */
    resolveParticipantIdentity(rtcBackendIdentity, membership) {
        if (rtcBackendIdentity) return rtcBackendIdentity;
        if (membership?.userId && membership?.deviceId) {
            return `${membership.userId}:${membership.deviceId}`;
        }
        if (membership?.userId) {
            return membership.userId;
        }
        return null;
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

        const participantIdentity = this.resolveParticipantIdentity(rtcBackendIdentity, membership);
        const participantLabel = participantIdentity || "unknown";

        // Security check: NEVER log raw keyBin bytes or secret material. Only log metadata.
        this.log(`MatrixRTC media key received: participant=${participantLabel} keyIndex=${keyIndex} is_own=${isOwnKey} v=${this.keyVersion}`);

        if (this.livekitRoom && this.keyProvider) {
            this.applyKey(rtcBackendIdentity, membership, keyBin, keyIndex);
        } else {
            // Buffer keys until LiveKit is connected and keyProvider attached
            // Deduplication key: participantIdentity + ":" + keyIndex
            const bufferKey = `${participantLabel}:${keyIndex}`;
            this.bufferedKeys.set(bufferKey, {
                rtcBackendIdentity,
                membership,
                keyBin,
                keyIndex,
            });
            this.log(`buffered media key for participant=${participantLabel} keyIndex=${keyIndex} (total_buffered=${this.bufferedKeys.size})`);
        }
    }

    /**
     * Attaches connected LiveKit Room and initializes key provider.
     * @param {import("@livekit/rtc-node").Room} livekitRoom
     */
    attachLivekitRoom(livekitRoom) {
        if (!this.enabled || !livekitRoom) return;

        this.livekitRoom = livekitRoom;

        if (!livekitRoom.e2eeManager) {
            return this.handleE2eeFailure("LiveKit E2EE manager is unavailable");
        }

        this.keyProvider = livekitRoom.e2eeManager.keyProvider;

        if (!this.keyProvider) {
            return this.handleE2eeFailure("LiveKit E2EE key provider is unavailable");
        }

        try {
            livekitRoom.e2eeManager.setEnabled(true);
            this.log("LiveKit E2EE manager enabled successfully");
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return this.handleE2eeFailure(`Failed to enable LiveKit E2EE manager: ${msg}`);
        }

        // Flush keys that arrived before LiveKit connected.
        this.flushBufferedKeys();

        // Re-emit any tracked keys from MatrixRTC session to ensure state completeness
        if (typeof this.rtcSession?.reemitEncryptionKeys === "function") {
            try {
                this.rtcSession.reemitEncryptionKeys();
            } catch (err) {
                // best effort
            }
        }
    }

    /**
     * Flushes buffered keys into the LiveKit key provider.
     */
    flushBufferedKeys() {
        if (this.bufferedKeys.size === 0) return;

        this.log(`flushing ${this.bufferedKeys.size} buffered media keys into LiveKit key provider`);
        const entries = Array.from(this.bufferedKeys.values());
        this.bufferedKeys.clear();

        for (const item of entries) {
            this.applyKey(item.rtcBackendIdentity, item.membership, item.keyBin, item.keyIndex);
        }
    }

    /**
     * Applies a media key into LiveKit key provider as participant-specific key.
     * @param {string} rtcBackendIdentity
     * @param {Object} membership
     * @param {Uint8Array} key
     * @param {number} keyIndex
     */
    applyKey(rtcBackendIdentity, membership, key, keyIndex) {
        if (!this.keyProvider) {
            return this.handleE2eeFailure("LiveKit E2EE key provider is not attached");
        }

        const participantIdentity = this.resolveParticipantIdentity(rtcBackendIdentity, membership);

        if (!participantIdentity) {
            return this.handleE2eeFailure("MatrixRTC encryption key has no participant identity");
        }

        if (typeof this.keyProvider.setRawKey !== "function") {
            return this.handleE2eeFailure("LiveKit KeyProvider does not support raw participant keys");
        }

        if (!key || !(key instanceof Uint8Array || Buffer.isBuffer(key)) || key.length === 0) {
            return this.handleE2eeFailure("Malformed MatrixRTC encryption key (empty or invalid type)");
        }

        try {
            this.keyProvider.setRawKey(participantIdentity, key, keyIndex);
            this.log(`LiveKit E2EE key installed: participant=${participantIdentity} keyIndex=${keyIndex}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return this.handleE2eeFailure(`Failed to install raw media key into LiveKit: ${msg}`);
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
