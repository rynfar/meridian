"""Screenshot every desktop screen and the menu-bar panel from preview pages.

    python3 scripts/preview/shoot.py <preview-dir> <screenshot-dir>

<preview-dir> is the output of fixtures.ts. Needs Python Playwright with
Chromium. Fails (exit 1) on any console error, page error or CSP violation.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

PAGES = ["Today", "Traffic", "Cache", "Accounts", "Logs", "Service"]


def main() -> int:
    preview, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    now = json.loads((preview / "clock.json").read_text())["now"]
    problems: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for scheme in ["light", "dark"]:
            for fixture, pages in [("ok", PAGES), ("fallback", ["Today", "Cache"]), ("stopped", ["Today", "Traffic"]), ("unauthorized", ["Today"]), ("loading", ["Today"]), ("partial", ["Today", "Traffic", "Cache"])]:
                page = browser.new_page(viewport={"width": 1180, "height": 760}, color_scheme=scheme, device_scale_factor=2)
                page.clock.install(time=now / 1000)
                page.on("console", lambda m, f=fixture: m.type in ("error", "warning") and problems.append(f"{f} console {m.type}: {m.text}"))
                page.on("pageerror", lambda e, f=fixture: problems.append(f"{f} pageerror: {e}"))
                page.goto((preview / f"window-{fixture}.html").as_uri())
                page.wait_for_timeout(600)
                for name in pages:
                    page.get_by_role("navigation").get_by_text(name, exact=True).first.click()
                    page.wait_for_timeout(500)
                    page.screenshot(path=str(out / f"{fixture}-{name.lower()}-{scheme}.png"))
                page.close()
            for fixture in ["ok", "stopped", "partial"]:
                page = browser.new_page(viewport={"width": 360, "height": 720}, color_scheme=scheme, device_scale_factor=2)
                page.clock.install(time=now / 1000)
                page.on("console", lambda m, f=fixture: m.type in ("error", "warning") and problems.append(f"tray {f} console {m.type}: {m.text}"))
                page.on("pageerror", lambda e, f=fixture: problems.append(f"tray {f} pageerror: {e}"))
                page.goto((preview / f"tray-{fixture}.html").as_uri())
                page.wait_for_timeout(600)
                page.locator("#root").screenshot(path=str(out / f"tray-{fixture}-{scheme}.png"))
                page.close()
        browser.close()
    for problem in problems:
        print(problem)
    print(f"screenshots in {out}; {len(problems)} console problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
