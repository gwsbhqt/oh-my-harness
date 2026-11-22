import asyncio
import struct
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from browser_use import Browser, BrowserError
from browser_use.capture import save_full_page


def result(value):
    import json
    return {"content": [{"type": "text", "text": "Script ran on page and returned:\n```json\n" + json.dumps(value) + "\n```"}]}


def test_full_page_refuses_an_existing_file_or_an_oversized_document(tmp_path):
    output = tmp_path / "capture.png"
    output.write_bytes(b"previous image")
    google = AsyncMock(return_value=result([500, 16385]))
    with pytest.raises(BrowserError) as error:
        asyncio.run(save_full_page(google, 7, str(output)))
    assert error.value.code == "output_exists" and output.read_bytes() == b"previous image"
    google.assert_not_awaited()
    with pytest.raises(BrowserError) as error:
        asyncio.run(save_full_page(google, 7, str(tmp_path / "large.png")))
    assert error.value.code == "unsupported" and google.await_count == 1


def test_resized_upstream_image_never_becomes_a_baseline(tmp_path):
    async def resized(name, params):
        if name == "evaluate_script":
            return result([480, 2000])
        assert name == "take_screenshot" and params["pageId"] == 7 and params["fullPage"]
        Path(params["filePath"]).write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + struct.pack(">II", 307, 1280))
        return {"content": []}

    output = tmp_path / "capture.png"
    with pytest.raises(BrowserError) as error:
        asyncio.run(save_full_page(resized, 7, str(output)))
    assert error.value.code == "capture_size_changed" and not output.exists()


def test_truncated_upstream_file_is_not_published(tmp_path):
    async def truncated(name, params):
        if name == "evaluate_script":
            return result([12, 20])
        Path(params["filePath"]).write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + struct.pack(">II", 12, 20))
        return {"content": []}

    output = tmp_path / "capture.png"
    with pytest.raises(BrowserError) as error:
        asyncio.run(save_full_page(truncated, 7, str(output)))
    assert error.value.code == "image_unavailable" and not output.exists()


def test_mock_tools_require_a_tab_opened_by_this_browser():
    for name, arguments in [("debug_mock_json", {"url": "http://127.0.0.1/items", "json": []}),
                            ("debug_mock_status", {}), ("debug_mock_clear", {})]:
        browser = Browser("cra")
        with pytest.raises(BrowserError) as error:
            asyncio.run(browser.call(name, tabId="borrowed", **arguments))
        assert error.value.code == "unsupported_target" and browser._google_client is None
