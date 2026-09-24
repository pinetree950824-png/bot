import asyncio
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import sys

from bot import IntegratedBot
from config import Config

logger = logging.getLogger(__name__)

_instance_lock_file = None


def acquire_instance_lock():
    global _instance_lock_file
    lock_path = Path("data/musicbot.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        _instance_lock_file = open(lock_path, "a+")
        if sys.platform == "win32":
            import msvcrt
            msvcrt.locking(_instance_lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(_instance_lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (IOError, OSError):
        print("\n" + "=" * 60)
        print("[CRITICAL] Another instance of Matrix Music Bot is already running!")
        print("Please close any existing running bot windows or terminate existing python processes.")
        print("=" * 60 + "\n")
        sys.exit(1)


class CleanLogNoiseFilter(logging.Filter):
    def __init__(self, enable_matrixrtc_filter: bool):
        super().__init__()
        self._enable_matrixrtc_filter = bool(enable_matrixrtc_filter)

    def filter(self, record: logging.LogRecord) -> bool:
        if not self._enable_matrixrtc_filter:
            return True

        message = record.getMessage()
        noisy_parts = (
            "[MatrixRTCSession",
            "MembershipManager",
            "RestartDelayedEvent",
            "Date.now:",
            "Queue: [",
        )
        if any(part in message for part in noisy_parts):
            return False
        return True


def setup_logging(config: Config):
    config.LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    formatter = logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)

    file_handler = RotatingFileHandler(
        filename=config.LOG_FILE,
        maxBytes=config.LOG_MAX_BYTES,
        backupCount=config.LOG_BACKUPS,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)

    clean_file_handler = None
    if config.CLEAN_LOG_ENABLED:
        config.CLEAN_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        clean_file_handler = RotatingFileHandler(
            filename=config.CLEAN_LOG_FILE,
            maxBytes=config.LOG_MAX_BYTES,
            backupCount=config.LOG_BACKUPS,
            encoding="utf-8",
        )
        clean_file_handler.setFormatter(formatter)
        clean_file_handler.addFilter(CleanLogNoiseFilter(config.CLEAN_LOG_FILTER_MATRIXRTC_NOISE))

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers.clear()
    root.addHandler(stream_handler)
    root.addHandler(file_handler)
    if clean_file_handler is not None:
        root.addHandler(clean_file_handler)


async def main():
    config = Config()
    setup_logging(config)
    bot = IntegratedBot(config)

    try:
        await bot.start()
    except KeyboardInterrupt:
        logger.info("Shutting down...")


if __name__ == "__main__":
    acquire_instance_lock()
    asyncio.run(main())
