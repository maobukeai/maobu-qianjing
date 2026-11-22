import asyncio
import importlib.util
import inspect
import json
import os
import re
import sys
import threading
import time
import traceback

from playwright.async_api import async_playwright

MAX_SCREENSHOTS_PER_PROFILE = 5
MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
JPEG_QUALITY = 75
FALLBACK_JPEG_QUALITY = 45
ERROR_SCREENSHOT_TIMEOUT_SEC = 5.0
MANUAL_SCREENSHOT_TIMEOUT_SEC = 10.0
SAFE_ARTIFACT_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}\.(?:jpg|png)$")


def read_input() -> dict:
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("runner input is missing")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise TypeError("runner input must be an object")
    return value


def load_script(path: str):
    spec = importlib.util.spec_from_file_location("aliasmode_user_script", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load script: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, os.path.dirname(path))
    spec.loader.exec_module(module)
    run = getattr(module, "run", None)
    if not inspect.iscoroutinefunction(run):
        raise TypeError("Python Playwright script must export async def run")
    return run


def _redact_error(text: str, input_value: dict) -> str:
    if input_value.get("engine") == "firefox" and isinstance(input_value.get("endpoint"), str):
        return text.replace(input_value["endpoint"], "private Firefox endpoint")
    return text


def _append_jsonl(path: str | None, record: dict) -> None:
    if not path:
        return
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _sanitize_label(label: object, fallback: str) -> str:
    text = re.sub(r"[^a-z0-9_-]+", "-", str(label or "").strip().lower()).strip("-")[:40]
    return text or fallback


async def _capture_page_jpeg(target_page, timeout_sec: float) -> bytes | None:
    shot_fn = getattr(target_page, "screenshot", None)
    if not callable(shot_fn):
        return None
    timeout_ms = int(timeout_sec * 1000)
    raw = await asyncio.wait_for(
        shot_fn(type="jpeg", quality=JPEG_QUALITY, timeout=timeout_ms),
        timeout=timeout_sec,
    )
    if not isinstance(raw, (bytes, bytearray)):
        return None
    data = bytes(raw)
    if len(data) > MAX_SCREENSHOT_BYTES:
        retry = await asyncio.wait_for(
            shot_fn(type="jpeg", quality=FALLBACK_JPEG_QUALITY, timeout=timeout_ms),
            timeout=timeout_sec,
        )
        if not isinstance(retry, (bytes, bytearray)):
            return None
        data = bytes(retry)
        if len(data) > MAX_SCREENSHOT_BYTES:
            return None
    return data if len(data) > 0 else None


async def run_script(input_value: dict) -> None:
    browser = None
    playwright = None
    context = None
    page = None

    steps_path = input_value.get("stepsPath")
    if not isinstance(steps_path, str) or not steps_path:
        steps_path = None
    artifacts_dir = input_value.get("artifactsDir")
    if not isinstance(artifacts_dir, str) or not artifacts_dir:
        artifacts_dir = None
    manifest_path = os.path.join(artifacts_dir, "manifest.jsonl") if artifacts_dir else None

    step_counter = 0
    screenshot_count = 0

    async def save_screenshot(label: object, kind: str, explicit_file_name: str | None, timeout_sec: float):
        nonlocal screenshot_count
        if not artifacts_dir or screenshot_count >= MAX_SCREENSHOTS_PER_PROFILE:
            return None
        target_page = page
        if target_page is None and context is not None and getattr(context, "pages", None):
            target_page = context.pages[-1]
        if target_page is None or not callable(getattr(target_page, "screenshot", None)):
            return None
        data = await _capture_page_jpeg(target_page, timeout_sec)
        if data is None or len(data) == 0 or len(data) > MAX_SCREENSHOT_BYTES:
            return None

        index = screenshot_count + 1
        display_label = str(label or ("error-final" if kind == "error" else f"shot-{index}")).strip()[:80] or f"shot-{index}"
        file_name = explicit_file_name or f"shot-{index:02d}-{_sanitize_label(display_label, f'shot-{index}')}.jpg"
        if not SAFE_ARTIFACT_NAME_RE.match(file_name):
            return None

        os.makedirs(artifacts_dir, exist_ok=True)
        target_path = os.path.join(artifacts_dir, file_name)
        with open(target_path, "wb") as handle:
            handle.write(data)
        screenshot_count += 1
        record = {
            "fileName": file_name,
            "label": display_label,
            "mimeType": "image/jpeg",
            "sizeBytes": len(data),
            "capturedAt": int(time.time() * 1000),
            "kind": kind,
        }
        _append_jsonl(manifest_path, record)
        return {**record, "path": target_path}

    async def step(title: str, fn):
        nonlocal step_counter
        step_counter += 1
        safe_title = str(title or "").strip()[:200] or f"Step {step_counter}"
        started_at = int(time.time() * 1000)
        _append_jsonl(steps_path, {
            "index": step_counter,
            "title": safe_title,
            "status": "running",
            "startedAt": started_at,
        })
        try:
            result = fn() if callable(fn) else fn
            if inspect.isawaitable(result):
                result = await result
            finished_at = int(time.time() * 1000)
            _append_jsonl(steps_path, {
                "index": step_counter,
                "title": safe_title,
                "status": "succeeded",
                "startedAt": started_at,
                "finishedAt": finished_at,
                "durationMs": max(0, finished_at - started_at),
            })
            return result
        except BaseException as exc:
            finished_at = int(time.time() * 1000)
            _append_jsonl(steps_path, {
                "index": step_counter,
                "title": safe_title,
                "status": "failed",
                "startedAt": started_at,
                "finishedAt": finished_at,
                "durationMs": max(0, finished_at - started_at),
                "error": _redact_error(str(exc), input_value)[:400],
            })
            raise

    async def screenshot(label: str | None = None):
        try:
            return await save_screenshot(label, "manual", None, MANUAL_SCREENSHOT_TIMEOUT_SEC)
        except Exception:
            return None

    try:
        playwright = await async_playwright().start()
        if input_value.get("engine") == "firefox":
            browser = await playwright.firefox.connect(input_value["endpoint"], timeout=30_000)
        else:
            browser = await playwright.chromium.connect_over_cdp(input_value["endpoint"], timeout=30_000)
        context = browser.contexts[0] if browser.contexts else None
        if context is None:
            raise RuntimeError("猫步·千境 browser context is unavailable")
        page = context.pages[0] if context.pages else await context.new_page()
        run = load_script(sys.argv[1])
        kwargs = {
            "browser": browser,
            "context": context,
            "page": page,
            "profile": input_value.get("profile"),
            "inputs": input_value.get("inputs"),
            "credentials": input_value.get("credentials"),
            "log": lambda *values: print(*values, flush=True),
        }
        try:
            sig = inspect.signature(run)
            accepts_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
            if accepts_var_kw or "step" in sig.parameters:
                kwargs["step"] = step
            if accepts_var_kw or "screenshot" in sig.parameters:
                kwargs["screenshot"] = screenshot
        except (TypeError, ValueError):
            pass
        await run(**kwargs)
    except BaseException:
        try:
            await save_screenshot("Error snapshot", "error", "error-final.jpg", ERROR_SCREENSHOT_TIMEOUT_SEC)
        except BaseException:
            pass
        raise
    finally:
        if browser is not None:
            try:
                await browser.close()
            except Exception:
                pass
        if playwright is not None:
            try:
                await playwright.stop()
            except Exception:
                pass


def main() -> int:
    if len(sys.argv) != 2:
        raise RuntimeError("script path is missing")
    input_value = read_input()

    def watch_parent() -> None:
        sys.stdin.read()
        os._exit(1)

    threading.Thread(target=watch_parent, daemon=True).start()
    try:
        asyncio.run(run_script(input_value))
        return 0
    except BaseException:
        text = _redact_error(traceback.format_exc(), input_value)
        sys.stderr.write(text)
        return 1


if __name__ == "__main__":
    sys.exit(main())
