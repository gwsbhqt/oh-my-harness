import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from browser_use import Browser, BrowserError
from browser_use.protocol import CONTROL_SCHEMAS, checked_reply, mcp_result, native_value


def test_two_browsers_offer_identical_control_and_debug_schemas():
    cra, chrome = Browser("cra"), Browser("chrome")
    assert cra.tools() == chrome.tools()
    assert len(CONTROL_SCHEMAS) == 33
    assert set(CONTROL_SCHEMAS) <= set(dir(cra))
    assert {"debug_trace_start", "debug_heap_snapshot"} <= set(dir(chrome))
    assert "folder_create" in chrome.capabilities()["unsupported"]
    assert "folder_create" in cra.capabilities()["control"]
    schema = next(tool for tool in cra.tools() if tool["name"] == "page_fill")
    assert set(schema["inputSchema"]["required"]) == {"tabId", "text"}


@pytest.mark.parametrize("target", ["chrome", "cra"])
def test_reject_invalid_arguments_before_opening_browser(target):
    browser = Browser(target)
    browser._dispatch = AsyncMock()
    for args in [{"tabId":3}, {"tabId":"a", "extra":True}, {"tabId":"a", "clickCount":4}]:
        with pytest.raises(BrowserError, match="page_click") as failure:
            asyncio.run(browser.page_click(**args))
        assert failure.value.outcome == "not_sent"
    browser._dispatch.assert_not_awaited()


def test_batch_binds_to_outer_tab_stops_and_preserves_first_result():
    browser = Browser("chrome")
    browser._chrome.call = AsyncMock(side_effect=[{"status": "completed"}, BrowserError("stale_ref", "stale")])
    steps = [{"tool":"page_click", "arguments":{"tabId":"other", "ref":"first"}},
             {"tool":"page_click", "arguments":{"ref":"gone"}}, {"tool":"page_read"}]
    with pytest.raises(BrowserError) as failure:
        asyncio.run(browser.page_batch(tabId="work", steps=steps))
    assert [call.args[1]["tabId"] for call in browser._chrome.call.await_args_list] == ["work", "work"]
    messages = [block["text"] for block in failure.value.data["content"]]
    assert "completed" in messages[0] and "stale" in messages[1] and "not run" in messages[2]


def test_events_and_multimodal_cra_receipts_are_preserved():
    result = {"content":[{"type":"image", "mimeType":"image/png", "data":"AA=="},
                         {"type":"text", "text":"viewport"}]}
    assert native_value("page_screenshot", result) is result
    assert mcp_result(result) is result
    assert native_value("tabs_list", mcp_result([{"id":"example"}])) == [{"id":"example"}]
    with pytest.raises(BrowserError) as error:
        checked_reply("page_click", {"content":[{"type":"text", "text":"Input may be partial"}], "isError":True})
    assert error.value.outcome == "unknown"


def test_same_tab_input_cannot_interleave_in_a_session():
    async def run():
        browser = Browser("cra")
        entered, resume = asyncio.Event(), asyncio.Event()
        log = []
        async def action(name, args):
            log.append(name)
            if name == "page_click":
                entered.set()
                await resume.wait()
        browser._dispatch = action
        first = asyncio.create_task(browser.page_click(tabId="work", ref="one"))
        await entered.wait()
        second = asyncio.create_task(browser.page_read(tabId="work"))
        await asyncio.sleep(0)
        assert log == ["page_click"]
        resume.set()
        await asyncio.gather(first, second)
        assert log == ["page_click", "page_read"]
        await browser.aclose()
        with pytest.raises(BrowserError, match="closed"):
            await browser.tabs_list()
    asyncio.run(run())


def test_dsh_uses_one_native_cra_call_and_retains_its_receipt(monkeypatch):
    import sys
    from types import SimpleNamespace

    click = AsyncMock(return_value=mcp_result({"status":"completed", "trustedEvents":{"click":1}}))
    native_tools = {"mcp__cra__page_click": click}
    monkeypatch.setitem(sys.modules, "dsh_kernel", SimpleNamespace(tools=native_tools))
    browser = Browser("cra")
    result = asyncio.run(browser.page_click(tabId="example-tab", ref="e1"))
    assert result["trustedEvents"]["click"] == 1
    click.assert_awaited_once_with({"tabId":"example-tab", "ref":"e1"})
    assert browser._cra_client is None and browser._google_client is None
    with pytest.raises(BrowserError) as failure:
        asyncio.run(browser.page_read(tabId="example-tab"))
    assert failure.value.outcome == "not_sent"
