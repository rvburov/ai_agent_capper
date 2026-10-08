import pytest

from app.core.useragent import clip_user_agent, device_label

CHROME_WIN = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0 Safari/537.36"
)
EDGE_WIN = CHROME_WIN + " Edg/141.0"
SAFARI_IOS = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
)
FIREFOX_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0"
CHROME_ANDROID = (
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36"
)


@pytest.mark.parametrize(
    ("agent", "label"),
    [
        (CHROME_WIN, "Chrome · Windows"),
        (EDGE_WIN, "Edge · Windows"),
        (SAFARI_IOS, "Safari · iOS"),
        (FIREFOX_MAC, "Firefox · macOS"),
        (CHROME_ANDROID, "Chrome · Android"),
        ("curl/8.0", ""),
        (None, ""),
    ],
)
def test_device_label(agent: str | None, label: str) -> None:
    assert device_label(agent) == label


def test_clip() -> None:
    assert clip_user_agent(None) is None
    long_agent = "x" * 2000
    clipped = clip_user_agent(long_agent)
    assert clipped is not None and len(clipped) == 512
