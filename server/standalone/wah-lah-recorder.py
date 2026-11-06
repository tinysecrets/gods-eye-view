#!/usr/bin/env python3
"""WAH-LAH multi-camera rolling buffer and event clip committer.

Only authenticated, registered RTSP streams are ingested. Video-only capture is
deliberate: camera audio is not recorded and LG G8 microphone policy is untouched.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

REGISTRY = Path(os.getenv("WAH_LAH_CAMERA_REGISTRY", "/data/SECURITY_CAMERA_MASTER/CAMERA_REGISTRY.json"))
CREDENTIALS = Path(os.getenv("WAH_LAH_CAMERA_CREDENTIALS", "/home/justin/.config/genie/wah-lah-camera-credentials.json"))
ROOT = Path(os.getenv("WAH_LAH_RECORDING_ROOT", "/data/camera-clips"))
EVENT_LOG = ROOT / "events" / "events.jsonl"
CLIP_INDEX = ROOT / "clip-index.jsonl"
STATUS_FILE = ROOT / "recorder-status.json"
BUFFER_ROOT = Path(os.getenv("WAH_LAH_BUFFER_ROOT", "/dev/shm/wah-lah-camera-buffer"))
FFMPEG = shutil.which("ffmpeg") or "/usr/bin/ffmpeg"
SEGMENT_SECONDS = 5
HLS_LIST_SIZE = 18
HLS_DELETE_THRESHOLD = 6
POLL_SECONDS = 0.5
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def log(message: str) -> None:
    print(f"[{datetime.now().astimezone().isoformat(timespec='seconds')}] {message}", flush=True)


def read_json(path: Path, fallback):
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return fallback


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp, 0o640)
    os.replace(tmp, path)


def safe_id(value: str) -> str:
    value = str(value or "")
    if not SAFE_ID.fullmatch(value):
        raise ValueError("invalid registry identifier")
    return value


def camera_url(camera, secret) -> str:
    username = quote(str(secret.get("username", "")), safe="")
    password = quote(str(secret.get("password", "")), safe="")
    host = str(camera.get("address", ""))
    port = int(camera.get("port") or 554)
    path = str(camera.get("stream_path") or "")
    if not username or not password or not path.startswith("/") or any(c in host for c in "/?#@"):
        raise ValueError("camera connection is incomplete")
    return f"rtsp://{username}:{password}@{host}:{port}{path}"


def parse_hls_durations(playlist: Path) -> dict[str, float]:
    found = {}
    try:
        lines = playlist.read_text(encoding="utf-8", errors="replace").splitlines()
        duration = None
        for line in lines:
            if line.startswith("#EXTINF:"):
                try:
                    duration = float(line.split(":", 1)[1].split(",", 1)[0])
                except Exception:
                    duration = float(SEGMENT_SECONDS)
            elif line and not line.startswith("#"):
                found[line.strip()] = duration or float(SEGMENT_SECONDS)
                duration = None
    except Exception:
        pass
    return found


class WahLahRecorder:
    def __init__(self):
        ROOT.mkdir(parents=True, exist_ok=True)
        EVENT_LOG.parent.mkdir(parents=True, exist_ok=True)
        BUFFER_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(BUFFER_ROOT, 0o700)
        self.workers = {}
        self.sessions = []
        self.registry = {}
        self.credentials = {}
        self.event_offset = EVENT_LOG.stat().st_size if EVENT_LOG.exists() else 0
        self.last_reload = 0.0
        self.last_cleanup = 0.0
        self.last_status = 0.0
        self.stopping = False

    def load_config(self):
        now = time.monotonic()
        if now - self.last_reload < 2:
            return
        self.last_reload = now
        registry = read_json(REGISTRY, {})
        self.registry = {safe_id(c["id"]): c for c in registry.get("cameras", []) if c.get("id")}
        self.credentials = read_json(CREDENTIALS, {})
        self.recording = registry.get("recording", {})
        self.pre_seconds = max(5, min(180, int(self.recording.get("pre_event_seconds", 30))))
        self.post_seconds = max(5, min(600, int(self.recording.get("post_event_seconds", 30))))
        self.retention_hours = max(1, int(self.recording.get("retention_hours", 24)))
        self.max_bytes = max(1, int(self.recording.get("max_gb", 120))) * 1_000_000_000

    def spawn_worker(self, camera_id, camera, secret):
        folder = BUFFER_ROOT / camera_id
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(folder, 0o700)
        playlist = folder / "index.m3u8"
        try:
            url = camera_url(camera, secret)
        except Exception:
            self.workers[camera_id] = {"process": None, "state": "configuration_incomplete", "retry": time.monotonic() + 30}
            return
        command = [
            FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error",
            "-rtsp_transport", "tcp", "-rw_timeout", "10000000", "-i", url,
            "-map", "0:v:0", "-an", "-c:v", "copy",
            "-f", "hls", "-hls_time", str(SEGMENT_SECONDS),
            "-hls_list_size", str(HLS_LIST_SIZE),
            "-hls_delete_threshold", str(HLS_DELETE_THRESHOLD),
            "-hls_flags", "delete_segments+append_list+independent_segments+temp_file",
            "-strftime", "1",
            "-hls_segment_filename", str(folder / "seg_%Y%m%d_%H%M%S.ts"),
            str(playlist),
        ]
        try:
            proc = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, close_fds=True)
            self.workers[camera_id] = {"process": proc, "state": "connecting", "retry": 0, "started": time.time()}
            log(f"camera worker started: {camera_id} (video-only, bounded HLS ring buffer)")
        except Exception as error:
            self.workers[camera_id] = {"process": None, "state": "start_failed", "retry": time.monotonic() + 30}
            log(f"camera worker start failed: {camera_id}: {type(error).__name__}")

    def reconcile_workers(self):
        for camera_id, camera in self.registry.items():
            worker = self.workers.get(camera_id)
            secret = self.credentials.get(camera_id)
            eligible = (camera.get("transport") == "rtsp" and camera.get("port") and
                        camera.get("stream_path") and isinstance(secret, dict) and
                        secret.get("username") and secret.get("password"))
            if not eligible:
                if worker and worker.get("process") and worker["process"].poll() is None:
                    worker["process"].terminate()
                self.workers[camera_id] = {"process": None, "state": "credentials_required", "retry": 0}
                continue
            if worker and worker.get("process") and worker["process"].poll() is None:
                playlist = BUFFER_ROOT / camera_id / "index.m3u8"
                segments = list((BUFFER_ROOT / camera_id).glob("seg_*.ts"))
                worker["state"] = "buffering" if playlist.exists() and segments else "connecting"
                continue
            if worker and time.monotonic() < worker.get("retry", 0):
                continue
            self.spawn_worker(camera_id, camera, secret)
            time.sleep(0.05)

    def read_new_events(self):
        if not EVENT_LOG.exists():
            return
        try:
            size = EVENT_LOG.stat().st_size
            if size < self.event_offset:
                self.event_offset = 0
            with EVENT_LOG.open("r", encoding="utf-8", errors="replace") as handle:
                handle.seek(self.event_offset)
                while True:
                    line = handle.readline()
                    if not line:
                        break
                    self.event_offset = handle.tell()
                    try:
                        event = json.loads(line)
                        self.begin_event(event)
                    except Exception:
                        continue
        except Exception as error:
            log(f"event ledger read warning: {type(error).__name__}")

    def begin_event(self, event):
        event_type = str(event.get("type") or "")
        if event_type not in {"manual_bookmark", "motion", "person", "vehicle", "object"}:
            return
        event_id = str(event.get("event_id") or "")
        if not re.fullmatch(r"[a-fA-F0-9-]{16,64}", event_id):
            return
        camera_value = str(event.get("camera_id") or "all")
        targets = list(self.registry) if camera_value == "all" else [camera_value]
        try:
            event_time = datetime.fromisoformat(str(event.get("timestamp")).replace("Z", "+00:00")).timestamp()
        except Exception:
            event_time = time.time()
        for camera_id in targets:
            if camera_id not in self.registry:
                continue
            folder = ROOT / "events" / datetime.fromtimestamp(event_time).strftime("%Y-%m-%d") / camera_id / f"{event_id}"
            folder.mkdir(parents=True, exist_ok=True, mode=0o750)
            session = {
                "event_id": event_id, "camera_id": camera_id, "event_type": event_type,
                "timestamp": datetime.fromtimestamp(event_time, timezone.utc).isoformat(),
                "start": event_time, "end": event_time + self.post_seconds,
                "folder": folder, "segments": {}, "event": event,
            }
            self.sessions.append(session)
            self.collect_segments(session, include_pre=True)
            log(f"event queued: {event_type} camera={camera_id} id={event_id[:8]}")

    def collect_segments(self, session, include_pre=False):
        camera_id = session["camera_id"]
        source = BUFFER_ROOT / camera_id
        if not source.exists():
            return
        now = time.time()
        lower = session["start"] - self.pre_seconds - SEGMENT_SECONDS if include_pre else session["start"] - 1.0
        upper = session["end"] + SEGMENT_SECONDS if not include_pre else session["start"] + 0.2
        durations = parse_hls_durations(source / "index.m3u8")
        for segment in sorted(source.glob("seg_*.ts")):
            try:
                stat = segment.stat()
                if stat.st_mtime > now - 1.25 or stat.st_mtime < lower or stat.st_mtime > upper:
                    continue
                if segment.name in session["segments"]:
                    continue
                destination = session["folder"] / segment.name
                temp = destination.with_suffix(destination.suffix + ".part")
                shutil.copyfile(segment, temp)
                os.chmod(temp, 0o640)
                os.replace(temp, destination)
                session["segments"][segment.name] = durations.get(segment.name, float(SEGMENT_SECONDS))
            except (FileNotFoundError, PermissionError, OSError):
                continue

    def update_sessions(self):
        now = time.time()
        retained = []
        for session in self.sessions:
            self.collect_segments(session, include_pre=False)
            if now >= session["end"] + SEGMENT_SECONDS + 2:
                self.finalize_session(session)
            else:
                retained.append(session)
        self.sessions = retained

    def finalize_session(self, session):
        folder = session["folder"]
        segments = sorted(session["segments"].items())
        if not segments:
            try:
                shutil.rmtree(folder)
            except Exception:
                pass
            log(f"event had no buffered video: {session['camera_id']} id={session['event_id'][:8]}")
            return
        lines = ["#EXTM3U", "#EXT-X-VERSION:3", f"#EXT-X-TARGETDURATION:{SEGMENT_SECONDS + 1}", "#EXT-X-MEDIA-SEQUENCE:0"]
        for name, duration in segments:
            lines.extend([f"#EXTINF:{duration:.3f},", name])
        lines.append("#EXT-X-ENDLIST")
        playlist = folder / "index.m3u8"
        playlist.write_text("\n".join(lines) + "\n", encoding="utf-8")
        # Assemble the committed event into one browser-friendly MP4 without re-encoding.
        mp4_path = folder / "event.mp4"
        mp4_tmp = folder / "event.mp4.tmp"
        concat_path = folder / ".concat-list.txt"
        try:
            with concat_path.open("w", encoding="utf-8") as handle:
                for name, _duration in segments:
                    handle.write("file '" + str(folder / name).replace("'", "'\''") + "'\n")
            result = subprocess.run(
                [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin",
                 "-f", "concat", "-safe", "0", "-i", str(concat_path),
                 "-map", "0:v:0", "-an", "-c:v", "copy", "-movflags", "+faststart",
                 "-f", "mp4", str(mp4_tmp)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45, check=False,
            )
            if result.returncode == 0 and mp4_tmp.exists() and mp4_tmp.stat().st_size > 0:
                os.chmod(mp4_tmp, 0o640)
                os.replace(mp4_tmp, mp4_path)
        except Exception:
            pass
        finally:
            for temporary in (concat_path, mp4_tmp):
                try:
                    temporary.unlink()
                except FileNotFoundError:
                    pass

        manifest = {
            "clip_id": session["event_id"] + "_" + session["camera_id"],
            "event_id": session["event_id"],
            "camera_id": session["camera_id"],
            "event_type": session["event_type"],
            "timestamp": session["timestamp"],
            "note": str(session["event"].get("note") or "")[:300],
            "pre_event_seconds": self.pre_seconds,
            "post_event_seconds": self.post_seconds,
            "segment_count": len(segments),
            "segments": [name for name, _ in segments],
            "playlist": "index.m3u8",
            "video_only": True,
            "mp4_available": mp4_path.exists(),
        }
        atomic_json(folder / "manifest.json", manifest)
        row = dict(manifest)
        row["playlist_url"] = f"/api/wah-lah/security/clips/{manifest['clip_id']}/index.m3u8"
        with CLIP_INDEX.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        log(f"event clip committed: camera={session['camera_id']} segments={len(segments)} id={session['event_id'][:8]}")

    def cleanup_storage(self):
        now = time.time()
        cutoff = now - self.retention_hours * 3600
        active = {str(s["folder"]) for s in self.sessions}
        folders = []
        for manifest in ROOT.glob("events/*/*/*/manifest.json"):
            folder = manifest.parent
            try:
                if str(folder) in active:
                    continue
                mtime = manifest.stat().st_mtime
                size = sum(p.stat().st_size for p in folder.iterdir() if p.is_file())
                folders.append((mtime, size, folder))
            except Exception:
                continue
        for mtime, size, folder in sorted(folders):
            if mtime < cutoff:
                self.remove_folder(folder)
        total = sum(item[1] for item in folders if item[2].exists())
        for _, _, folder in sorted(folders):
            if total <= self.max_bytes:
                break
            if folder.exists() and self.remove_folder(folder):
                try:
                    total -= sum(p.stat().st_size for p in folder.iterdir() if p.is_file())
                except Exception:
                    pass
                total = sum(p.stat().st_size for p in ROOT.rglob("*") if p.is_file())
        return total

    def remove_folder(self, folder):
        for item in folder.iterdir():
            if item.is_file():
                try:
                    busy = subprocess.run(["fuser", "-s", "--", str(item)], stdout=subprocess.DEVNULL,
                                          stderr=subprocess.DEVNULL).returncode == 0
                except Exception:
                    busy = False
                if busy or item.name.endswith(".part"):
                    return False
        try:
            shutil.rmtree(folder)
            return True
        except Exception:
            return False

    def write_status(self):
        cameras = []
        for camera_id, camera in self.registry.items():
            worker = self.workers.get(camera_id) or {}
            proc = worker.get("process")
            live = bool(proc and proc.poll() is None)
            folder = BUFFER_ROOT / camera_id
            count = len(list(folder.glob("seg_*.ts"))) if folder.exists() else 0
            playlist = folder / "index.m3u8"
            cameras.append({
                "id": camera_id, "name": camera.get("name", camera_id),
                "status": "buffering" if live and count else "connecting" if live else worker.get("state", "credentials_required"),
                "segments_in_ring": count,
                "ring_seconds_approx": count * SEGMENT_SECONDS,
                "live_playlist": f"/api/wah-lah/security/live/{camera_id}/index.m3u8" if live and playlist.exists() else None,
                "audio_capture": "disabled",
            })
        data = {
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "engine": "wah-lah-multicamera-hls-ring",
            "state": "running",
            "recording_root": str(ROOT),
            "buffer_root": str(BUFFER_ROOT),
            "pre_event_seconds": self.pre_seconds,
            "post_event_seconds": self.post_seconds,
            "segment_seconds": SEGMENT_SECONDS,
            "retention_hours": self.retention_hours,
            "max_bytes": self.max_bytes,
            "active_event_sessions": len(self.sessions),
            "cameras": cameras,
        }
        atomic_json(STATUS_FILE, data)

    def run(self):
        log("WAH-LAH recorder online; event-gated video-only ring buffer initialized")
        while not self.stopping:
            self.load_config()
            self.reconcile_workers()
            self.read_new_events()
            self.update_sessions()
            now = time.monotonic()
            if now - self.last_cleanup > 60:
                total = self.cleanup_storage()
                log(f"retention scan complete: committed_bytes={total} cap_bytes={self.max_bytes}")
                self.last_cleanup = now
            if now - self.last_status > 3:
                self.write_status()
                self.last_status = now
            time.sleep(POLL_SECONDS)
        for worker in self.workers.values():
            process = worker.get("process")
            if process and process.poll() is None:
                process.terminate()
        self.write_status()


def main():
    recorder = WahLahRecorder()
    def stop_signal(_sig, _frame):
        recorder.stopping = True
    signal.signal(signal.SIGTERM, stop_signal)
    signal.signal(signal.SIGINT, stop_signal)
    recorder.run()


if __name__ == "__main__":
    main()
