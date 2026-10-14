"""Real UI acceptance against the disposable host in supercode-smoke.cjs.

The fixture is DSH's isolated default workspace. Room creation, planning,
approval, pause, and restoration all use rendered controls.
"""
import json
import os
import re
import time
import urllib.request
from urllib.parse import urlparse
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, expect, sync_playwright


qa_root = Path(os.environ["DSH_SUPERCODE_QA_ROOT"])
workspace = Path(os.environ["DSH_SUPERCODE_QA_WORKSPACE"])
control_url = os.environ["DSH_SUPERCODE_QA_CONTROL"]
expected_content = "SuperCode acceptance fixture: independently reviewed.\n"
goal = (
    "Create acceptance.txt containing exactly this line followed by a newline: "
    "SuperCode acceptance fixture: independently reviewed. "
    "Inspect the workspace, propose a task, wait for my approval, have the Builder "
    "write it, have the Reviewer independently read it, and let the Lead accept "
    "the passing review before finishing."
)


def control(path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        control_url + path,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    # This fixture uses local model endpoints, not the account-connection flow.
    # Mark its disposable browser's account onboarding as dismissed before any
    # asynchronous provider discovery can display it over the chat. Account
    # onboarding itself has separate regression coverage.
    page.add_init_script("localStorage.setItem('dshd.accounts.onboarding-dismissed', '1')")
    errors = []
    console_errors = []
    active_requests = set()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.on("request", lambda request: active_requests.add(request.url))
    page.on("requestfinished", lambda request: active_requests.discard(request.url))
    page.on("requestfailed", lambda request: active_requests.discard(request.url))

    def wait_for_app():
        try:
            page.wait_for_load_state("networkidle", timeout=5000)
        except PlaywrightTimeoutError:
            # DSH keeps its event stream open. Record the pending routes, then
            # use the rendered app control as the application readiness signal.
            qa_root.joinpath("persistent-requests.json").write_text(json.dumps(sorted(urlparse(url).path for url in active_requests), indent=2))
        assert not page.get_by_text("Failed to load plugins", exact=True).is_visible(), console_errors
        expect(page.get_by_role("button", name="New SuperCode", exact=True)).to_be_visible(timeout=60000)

    def api(path):
        return page.evaluate(
            """async path => {
                const response = await fetch('/dsh-supercode' + path);
                if (!response.ok) throw new Error(await response.text());
                return response.json();
            }""",
            path,
        )

    def open_app(url, launch=True):
        page.goto(url, wait_until="domcontentloaded", timeout=90000)
        wait_for_app()
        # Only dismiss onboarding; a chat's Continue button is an explicit
        # permission to resume model calls and must never be clicked here.
        notice = page.get_by_text("Preview Notice", exact=True)
        try:
            notice.wait_for(state="visible", timeout=3000)
        except PlaywrightTimeoutError:
            pass
        else:
            page.get_by_role("button", name="Continue", exact=True).click()
        for name in ["Skip for now"]:
            button = page.get_by_role("button", name=name, exact=True)
            try:
                button.wait_for(state="visible", timeout=3000)
            except PlaywrightTimeoutError:
                continue
            button.click()
        expect(page.get_by_role("button", name="New SuperCode", exact=True)).to_be_visible(timeout=20000)
        if launch:
            page.get_by_role("button", name="New SuperCode", exact=True).click()
            panel = page.locator(".wSkVaW_root")
            expect(panel.get_by_role("combobox", name="Team model", exact=True)).to_be_visible(timeout=15000)

    def configure_room(text):
        panel = page.locator(".wSkVaW_root")
        team_model = panel.get_by_role("combobox", name="Team model", exact=True)
        expect(team_model).to_have_value("")
        # Compare the same blank session in both modes, not different phases.
        def geometry():
            return panel.evaluate("""root => {
                const rect = selector => { const r = root.querySelector(selector).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; };
                return { header:rect('header.wSkVaW_header'), card:rect('[data-composer-card]'), workspace:rect('.wSkVaW_heroWorkspaceRow') };
            }""")
        team_geometry = geometry()
        panel.get_by_role("button", name="SuperCode", exact=True).click()
        expect(team_model).to_have_count(0)
        regular_geometry = geometry()
        for part in ["header", "card", "workspace"]:
            for dimension in ["x", "y", "width", "height"]:
                assert abs(team_geometry[part][dimension] - regular_geometry[part][dimension]) <= 1, (part, team_geometry, regular_geometry)
        qa_root.joinpath("native-layout-parity.json").write_text(json.dumps({"regular":regular_geometry,"supercode":team_geometry}, indent=2))
        page.screenshot(path=str(qa_root / "regular-composer.png"), full_page=True)
        panel.get_by_role("button", name="SuperCode", exact=True).click()
        expect(team_model).to_be_visible()
        expect(panel.get_by_role("button", name="Send message", exact=True)).to_be_disabled()
        assert not control("/__qa/state")["transcript"], "An unselected team must not invoke models"
        team_model.select_option(json.dumps(["fixture", "fixture-builder"], separators=(",", ":")))
        editor = panel.locator('[data-composer-card] [contenteditable=true]')
        expect(editor).to_be_editable()
        editor.fill(text)
        panel.get_by_role("button", name="Models and agents", exact=True).click()
        picker = panel.get_by_role("dialog", name="Group agents", exact=True)
        expect(picker).to_be_visible()
        picker.get_by_label("Agents", exact=True).select_option("3")
        for name, model in [("Lead", "fixture-lead"), ("Builder", "fixture-builder"), ("Reviewer", "fixture-reviewer")]:
            section = panel.get_by_role("region", name="Configure " + name, exact=True)
            expect(section.get_by_label(re.compile("^Model"))).to_have_value(json.dumps(["fixture", "fixture-builder"], separators=(",", ":")))
            section.get_by_label(re.compile("^Model")).select_option(json.dumps(["fixture", model], separators=(",", ":")))
        lead_section = panel.get_by_role("region", name="Configure Lead", exact=True)
        lead_section.get_by_label("Reasoning effort", exact=False).select_option("high")
        picker.get_by_role("button", name="Done", exact=True).click()
        expect(picker).not_to_be_visible()
        expect(editor).to_have_text(text)
        panel.get_by_role("button", name="Models and agents", exact=True).click()
        expect(picker.get_by_label("Agents", exact=True)).to_have_value("3")
        expect(lead_section.get_by_label("Reasoning effort", exact=False)).to_have_value("high")
        page.screenshot(path=str(qa_root / "setup-models.png"), full_page=True)
        picker.locator("details.sc-advanced").last.locator("summary").click()
        expect(panel.get_by_label("Time limit (minutes)", exact=True)).to_have_value("60")
        expect(panel.get_by_label("Model call limit", exact=True)).to_have_value("200")
        picker.get_by_role("button", name="Done", exact=True).click()
        before = len(control("/__qa/state")["transcript"])
        page.wait_for_timeout(200)
        assert len(control("/__qa/state")["transcript"]) == before, "Configuring agents must not run them"
        page.screenshot(path=str(qa_root / "group-composer.png"), full_page=True)
        panel.get_by_role("button", name="Send message", exact=True).click()
        expect(panel.get_by_role("log", name="Team conversation", exact=True)).to_be_visible(timeout=20000)
        return next(room for room in api("/bootstrap")["rooms"] if room["goal"] == text)

    def assert_room_layout(panel):
        header = panel.locator("header.wSkVaW_header")
        conversation = panel.get_by_role("log", name="Team conversation", exact=True)
        composer = panel.locator("[data-composer-card]")
        expect(header).to_be_visible()
        expect(composer).to_have_count(1)
        expect(panel.locator(".sc-composer, .sc-session-surface, .sc-welcome")).to_have_count(0)
        expect(panel).to_have_attribute("data-phase", "active")
        expect(header.get_by_text("New session", exact=True)).not_to_be_visible()
        expect(page.get_by_label("Room recovery warnings")).to_have_count(0)
        expect(header.get_by_role("tab", name="Code", exact=True)).to_be_visible()
        expect(header.get_by_role("tab", name="Preview", exact=True)).to_be_visible()
        expect(header.locator(".sc-header-controls")).to_have_count(0)
        boxes = {"panel": panel.bounding_box(), "header": header.bounding_box(), "conversation": conversation.bounding_box(), "composer": composer.bounding_box()}
        assert boxes["header"]["height"] <= 80, boxes
        assert composer.evaluate('el => !!el.closest("[data-composer-seat]")')
        assert panel.locator('[data-composer-card] [contenteditable]').count() == 1
        return boxes

    def assert_primary_button_readable(button):
        styles = button.evaluate("""element => {
            const style = getComputedStyle(element);
            return {foreground: style.color, background: style.backgroundColor};
        }""")
        colors = [[float(value) for value in re.findall(r"[\d.]+", styles[key])] for key in ["foreground", "background"]]
        assert all(len(color) == 3 or color[3] == 1 for color in colors), styles
        def luminance(color):
            channels = [value / 255 for value in color[:3]]
            linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
            return sum(value * weight for value, weight in zip(linear, [0.2126, 0.7152, 0.0722]))
        levels = [luminance(color) for color in colors]
        contrast = (max(levels) + 0.05) / (min(levels) + 0.05)
        assert contrast >= 4.5, {**styles, "contrast": contrast}
        return {**styles, "contrast": contrast}

    def wait_room(room_id, status, timeout=60000):
        deadline = time.monotonic() + timeout / 1000
        while True:
            room = api("/rooms/" + room_id)
            fixture_errors = control("/__qa/state")["fixtureErrors"]
            assert not fixture_errors, fixture_errors
            if room["status"] == status:
                return room
            diagnostic = {key: room.get(key) for key in ["status", "reason", "tasks", "memberStates"]}
            assert room["status"] not in ["blocked", "stopped"], diagnostic
            assert time.monotonic() < deadline, diagnostic
            page.wait_for_timeout(250)

    try:
        open_app(os.environ["DSH_QA_URL"])
        # Reconnaissance occurs after networkidle, before interacting with the form.
        qa_root.joinpath("initial-dom.txt").write_text(page.locator("body").inner_text())
        page.screenshot(path=str(qa_root / "01-setup.png"), full_page=True)
        assert not control("/__qa/state")["transcript"], "Opening SuperCode must not invoke a model"
        room = configure_room('hi')
        room_id = room["id"]
        panel = page.locator(".wSkVaW_root")
        for text, expected in [('hi', 'Hi! Good to see you.'), ('thanks', 'You’re welcome!'), ('can you help?', 'Of course. What would you like help with?')]:
            if text != 'hi':
                panel.locator('[data-composer-card] [contenteditable=true]').fill(text)
                panel.get_by_role('button', name='Send message', exact=True).click()
            settled = wait_room(room_id, 'draft')
            expect(panel.get_by_role('log', name='Team conversation').get_by_text(expected, exact=True).last).to_be_visible()
            assert settled.get('chatOnly') and not settled['tasks'] and not settled['approved']
            assert not settled.get('reason') and not settled.get('pendingOutcome')
            expect(panel.get_by_role('button', name='Continue', exact=True)).to_have_count(0)
            expect(panel.get_by_role('button', name='Approve plan', exact=True)).to_have_count(0)
        greeting_calls = control('/__qa/state')['transcript']
        assert len(greeting_calls) == 3 and all(row['model'] == 'fixture-lead' and row['response'] == 'final' for row in greeting_calls)
        assert not [message for message in settled['messages'] if message['kind'] == 'tool']
        panel.get_by_label('Message recipient', exact=True).select_option('team')
        panel.locator('[data-composer-card] [contenteditable=true]').fill('Hi everyone')
        panel.get_by_role('button', name='Send message', exact=True).click()
        settled = wait_room(room_id, 'draft')
        assert len(control('/__qa/state')['transcript']) == 6
        assert not settled['tasks'] and not [message for message in settled['messages'] if message['kind'] == 'tool']
        page.screenshot(path=str(qa_root / 'greeting-group-chat.png'), full_page=True)
        print('PASS: hi, thanks, ambiguous question and @team greeting use conversation-only replies with zero workspace tools or task plans', flush=True)
        if os.environ.get('DSH_QA_LEGACY_GREETING') == '1':
            original_sessions = {member['id']: member.get('sessionId') for member in settled['members']}
            canonical = settled['chatSessionId']
            replacement = control('/__qa/legacy-restart', {'roomId': room_id, 'sessionId': canonical})
            open_app(replacement['hostURL'], launch=False)
            page.locator('[data-row-key="session:' + canonical + '"]').click()
            before = len(control('/__qa/state')['transcript'])
            expect(panel.get_by_role('button', name='Continue', exact=True)).to_be_visible(timeout=15000)
            page.wait_for_timeout(1000)
            assert len(control('/__qa/state')['transcript']) == before
            panel.get_by_role('button', name='Continue', exact=True).click()
            recovered = wait_room(room_id, 'draft')
            assert recovered.get('chatOnly') and not recovered['tasks'] and not recovered.get('reason')
            assert recovered['chatSessionId'] == canonical
            assert {member['id']: member.get('sessionId') for member in recovered['members']} == original_sessions
            expect(panel.locator('[data-composer-card] [contenteditable=true]')).to_be_enabled()
            print('PASS: real legacy role-less native log resumes into chat without changing native identities or demanding a plan', flush=True)
        panel.get_by_label('Message recipient', exact=True).select_option('lead')
        panel.locator('[data-composer-card] [contenteditable=true]').fill('QA_CHAT_GUARD_PROBE: stay in conversation; do not inspect files.')
        panel.get_by_role('button', name='Send message', exact=True).click()
        expect(panel.get_by_text('Workspace access stayed blocked.', exact=True)).to_be_visible(timeout=30000)
        wait_room(room_id, 'draft')
        print('PASS: even an attempted workspace read is denied by the real native tool guard in chat mode', flush=True)
        panel.locator('[data-composer-card] [contenteditable=true]').fill(goal)
        panel.get_by_role('button', name='Send message', exact=True).click()
        room = wait_room(room_id, 'awaiting-approval')
        assert room['goal'] == goal and not room.get('chatOnly'), 'Concrete work must enter normal planning in the same chat'
        assert room["status"] in ["planning", "awaiting-approval"]
        assert next(member for member in room["members"] if member["id"] == room["leadId"])["effort"] == "high"
        panel = page.locator(".wSkVaW_root")
        expect(panel.get_by_role("complementary", name="Task board", exact=True)).to_have_count(0)
        planned = wait_room(room_id, "awaiting-approval")
        expect(panel.get_by_role("button", name="Approve plan", exact=True)).to_be_visible(timeout=10000)
        assert planned["phase"] == "planning"
        assert not planned["approved"]
        assert len(planned["tasks"]) == 1, planned["tasks"]
        assert any(message.get("memberId") == "builder" and message.get("recipient") == "reviewer" and message["text"].startswith("Peer reply:") for message in planned["messages"])
        assert any(message.get("memberId") == "reviewer" and message["text"].startswith("Peer agreement:") for message in planned["messages"])
        assert not planned["queue"], "The plan must not outrun unanswered peer questions"
        assert not (workspace / "acceptance.txt").exists(), "The file was written before plan approval"
        panel.locator('[data-composer-card] [contenteditable=true]').fill("Explain the plan before I approve it.")
        panel.get_by_role("button", name="Send message", exact=True).click()
        expect(panel.get_by_text("Discussion answer: the builder will write only after you approve the plan.", exact=True)).to_be_visible(timeout=30000)
        discussed = wait_room(room_id, "awaiting-approval")
        assert discussed["runId"] == planned["runId"] and not discussed["approved"]
        assert not (workspace / "discussion-must-not-write.txt").exists()
        assert not (workspace / "acceptance.txt").exists()
        print("PASS: native pre-approval reply arrives without granting file writes", flush=True)
        assert len({row["model"] for row in control("/__qa/state")["transcript"] if row["prompt"]}) == 3
        layout = assert_room_layout(panel)
        approve_button = panel.get_by_role("button", name="Approve plan", exact=True)
        primary_button = assert_primary_button_readable(approve_button)
        approve_button.hover()
        primary_button_hover = assert_primary_button_readable(approve_button)
        conversation = panel.get_by_role("log", name="Team conversation", exact=True)
        rich = conversation.locator(".sc-rich").filter(has=page.get_by_role("heading", name="Implementation plan", exact=True))
        discussion = conversation.get_by_role("region", name="Agent discussion", exact=True).last
        toggle = discussion.locator(".sc-discussion-toggle")
        expect(toggle).to_have_attribute("aria-expanded", "true")
        discussion.get_by_role("button", name="About Builder", exact=True).click()
        member_card = panel.get_by_role("dialog", name="About Builder", exact=True)
        expect(member_card).to_contain_text("fixture / fixture-builder")
        member_card.get_by_role("button", name="Message Builder", exact=True).click()
        expect(member_card).not_to_be_visible()
        expect(panel.get_by_label("Message recipient", exact=True)).to_have_value("builder")
        panel.get_by_label("Message recipient", exact=True).select_option("lead")
        before_inspection = len(control("/__qa/state")["transcript"])
        toggle.click()
        expect(discussion.locator(".sc-discussion-body")).not_to_be_visible()
        toggle.click()
        expect(discussion.locator(".sc-discussion-body")).to_be_visible()
        assert len(control("/__qa/state")["transcript"]) == before_inspection, "Avatar and discussion interactions invoked a model"
        expect(rich).to_have_count(1)
        expect(rich.locator("h3")).to_have_text("Implementation plan")
        expect(rich.locator("strong")).to_contain_text(["Approval is required"])
        expect(rich.locator("ul > li")).to_have_count(3)
        expect(rich.locator("ol > li")).to_have_count(3)
        expect(rich.locator("pre code")).to_contain_text('console.log("supercode-copy-ok");')
        expect(rich.get_by_role("table")).to_be_visible()
        expect(rich.get_by_role("columnheader", name="Verification", exact=True)).to_be_visible()
        external = rich.get_by_role("link", name="Verification reference", exact=True)
        expect(external).to_have_attribute("href", "https://example.com/verification")
        expect(external).to_have_attribute("target", "_blank")
        assert "noopener" in external.get_attribute("rel")
        assert rich.locator('a[href^="javascript:"],a[href^="data:"],script,iframe,img').count() == 0
        assert page.evaluate("globalThis.__SUPERCODE_UNSAFE_EXECUTED__ === undefined")
        browser.contexts[0].grant_permissions(["clipboard-read", "clipboard-write"], origin=page.url.split("?")[0].rstrip("/"))
        copied_code = rich.locator("pre").inner_text()
        assert copied_code.strip() == 'console.log("supercode-copy-ok");'
        toolbar_icons = {}
        for name in [re.compile("^Copy$"), re.compile("^(?:Unwrap|Wrap) lines$")]:
            toolbar_button = rich.get_by_role("button", name=name)
            # Locator actions retry if a polling refresh replaces the native
            # code toolbar while the conversation is smoothly scrolling.
            toolbar_button.hover()
            expect(toolbar_button).to_be_visible()
            icon = toolbar_button.locator("svg")
            expect(icon).to_have_count(1)
            expect(icon).to_be_visible()
            dimensions = icon.bounding_box()
            assert dimensions["width"] >= 10 and dimensions["height"] >= 10, {"button": name.pattern, "icon": dimensions}
            toolbar_icons[name.pattern] = dimensions
        rich.get_by_role("button", name="Copy", exact=True).click()
        assert page.evaluate("navigator.clipboard.readText()") == copied_code
        rich.get_by_role("button", name="Workspace evidence", exact=True).click()
        evidence_dialog = page.get_by_role("dialog", name="Evidence viewer", exact=True)
        expect(evidence_dialog).to_be_visible()
        expect(evidence_dialog.locator("pre")).to_contain_text("SuperCode acceptance workspace")
        evidence_dialog.get_by_role("button", name="Close evidence", exact=True).click()
        expect(evidence_dialog).not_to_be_visible()
        rich.get_by_role("heading", name="Implementation plan", exact=True).scroll_into_view_if_needed()
        page.screenshot(path=str(qa_root / "semantic-rich-plan.png"), full_page=True)
        assert panel.locator("[data-conversation-scroll]").evaluate("element => element.scrollHeight > element.clientHeight + 100"), "Fixture must overflow to exercise scroll preservation"
        conversation.hover()
        page.mouse.wheel(0, -10000)
        page.wait_for_timeout(500)
        reading_top = panel.locator("[data-conversation-scroll]").evaluate("element => element.scrollTop")
        assert reading_top < 10, reading_top
        page.screenshot(path=str(qa_root / "02-plan-awaiting-approval.png"), full_page=True)
        print("PASS: conversational setup preserves choices; real plan uses semantic safe Markdown, copy, evidence links, compact header and aligned board", flush=True)

        panel.get_by_role("button", name="Approve plan", exact=True).click()
        deadline = time.monotonic() + 30
        while not any(row["response"] == "held-after-public-progress" for row in control("/__qa/state")["transcript"]):
            assert time.monotonic() < deadline, "Builder did not reach the real pending response gate"
            page.wait_for_timeout(100)
        active_room = api("/rooms/" + room_id)
        assert active_room["status"] == "running"
        active_update = "Builder is writing acceptance.txt through the native filesystem tool."
        assert len([message for message in active_room["messages"] if message.get("kind") == "agent" and message.get("text") == active_update]) == 1
        expect(conversation.get_by_text(active_update, exact=True)).to_have_count(1, timeout=10000)
        assert abs(panel.locator("[data-conversation-scroll]").evaluate("element => element.scrollTop") - reading_top) <= 2
        expect(discussion.locator('.sc-avatar-stack button[data-active="true"]')).to_have_count(1)
        expect(discussion.get_by_role("status")).to_contain_text("Builder working")
        panel.locator("[data-conversation-scroll]").evaluate("element => element.scrollTop = element.scrollHeight")
        page.wait_for_timeout(250)
        page.screenshot(path=str(qa_root / "live-agent-conversation.png"), full_page=True)
        panel.locator("[data-conversation-scroll]").evaluate("element => element.scrollTop = 0")
        page.wait_for_timeout(250)
        control("/__qa/release-progress", {})
        completed = wait_room(room_id, "completed", timeout=90000)
        expect(panel.locator(".sc-discussion-toggle").last).to_contain_text("Team conversation", timeout=10000)
        board = panel.get_by_role("complementary", name="Task board", exact=True)
        page.locator('.sc-header-controls').get_by_role("button", name=re.compile("^Tasks")).click()
        expect(board.get_by_text("1/1 done", exact=True)).to_be_visible()
        expect(board.get_by_role("article", name="Create and independently verify acceptance.txt", exact=True).get_by_text("done", exact=True)).to_be_visible()
        assert abs(panel.locator("[data-conversation-scroll]").evaluate("element => element.scrollTop") - reading_top) <= 2, "Incoming team messages moved the reader away from earlier messages"
        assert_room_layout(panel)
        assert (workspace / "acceptance.txt").read_text() == expected_content
        task = completed["tasks"][0]
        assert task["status"] == "done"
        assert task["review"]["verdict"] == "pass"
        assert task["review"]["memberId"] != task["ownerId"]
        assert task["evidence"] and task["review"]["evidence"]
        evidence = control("/__qa/state")
        assert not evidence["fixtureErrors"], evidence["fixtureErrors"]
        assert completed["usage"]["calls"] == len(evidence["transcript"]), "Room call accounting missed or double-counted a model request"
        assert all(row.get("reasoningEffort") == "high" for row in evidence["transcript"] if row["model"] == "fixture-lead"), "The selected lead effort did not reach the model requests"
        public_updates = [row["publicText"] for row in evidence["transcript"] if row.get("publicText")]
        assert len(public_updates) == 3, public_updates
        for text in public_updates:
            assert len([message for message in completed["messages"] if message.get("kind") == "agent" and message.get("text") == text]) == 1, text
            expect(conversation.get_by_text(text, exact=True)).to_have_count(1)
        returned = "\n".join(result for row in evidence["transcript"] for result in row["receivedToolResults"] + row.get("verifiedResults", []))
        assert "SUPERCODE_WRITE_OK" in returned, "No real successful filesystem write result reached the model"
        assert "SUPERCODE_READ_OK" in returned, "No real independent read result reached the model"
        journal = qa_root / "harness" / "supercode" / "rooms" / (room_id + ".jsonl")
        assert journal.is_file() and journal.stat().st_size > 0, "Separate SuperCode room journal is missing"
        events = [json.loads(line) for line in journal.read_text().splitlines() if line]
        assert [event["seq"] for event in events] == list(range(len(events))), "Room journal lost its append sequence"
        assert "supercode_review" in [event["kind"] for event in events]
        assert "supercode_finish" in [event["kind"] for event in events]
        policies = control("/__qa/policies", {"sessionIds": [member["sessionId"] for member in completed["members"]]})
        lead = next(member for member in completed["members"] if member["id"] == completed["leadId"])
        for policy in policies:
            assert policy["sandboxes"][-1] == "workspace-write", policy
            if policy["id"] == lead["sessionId"]:
                assert policy["presets"][-1] == "workspace-write", policy
            else:
                assert policy["header"]["parentSession"] == lead["sessionId"], policy
                assert policy["approvals"][-1] == "never", policy
        qa_root.joinpath("native-session-policies.json").write_text(json.dumps(policies, indent=2))
        page.screenshot(path=str(qa_root / "03-completed-board.png"), full_page=True)
        page.locator('.sc-header-controls').get_by_role("button", name=re.compile("^Tasks")).click()
        toggle.click()
        expect(discussion.locator(".sc-discussion-body")).not_to_be_visible()
        result = conversation.locator(".sc-message.is-result")
        expect(result).to_have_count(1)
        result.scroll_into_view_if_needed()
        result.get_by_role("button", name="Copy response", exact=True).click()
        assert page.evaluate("navigator.clipboard.readText()") == completed["messages"][-1]["text"]
        page.screenshot(path=str(qa_root / "lead-result.png"), full_page=True)
        toggle.click()
        expect(discussion.locator(".sc-discussion-body")).to_be_visible()
        page.locator('.sc-header-controls').get_by_role("button", name=re.compile("^Tasks")).click()
        print("PASS: native write, independent native read/review, lead acceptance, completed board, separate durable journal", flush=True)

        page.set_viewport_size({"width": 650, "height": 900})
        expect(board).to_be_visible()
        overflow = panel.evaluate("""element => ({width:element.clientWidth, scroll:element.scrollWidth, bad:[...element.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>element.getBoundingClientRect().right+2).map(e=>({tag:e.tagName,cls:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right})).slice(0,20)})""")
        qa_root.joinpath("narrow-overflow.json").write_text(json.dumps(overflow, indent=2))
        assert overflow["scroll"] <= overflow["width"] + 1, overflow
        page.screenshot(path=str(qa_root / "04-narrow-board.png"), full_page=True)
        page.locator('.sc-header-controls').get_by_role("button", name=re.compile("^Tasks")).click()
        expect(conversation).to_be_visible()
        expect(board).to_have_count(0)
        page.set_viewport_size({"width": 1440, "height": 1000})
        panel.locator('[data-composer-card] [contenteditable=true]').fill("What changed, and who checked it?")
        panel.get_by_role("button", name="Send message", exact=True).click()
        expect(conversation.get_by_text("Discussion answer: the builder wrote acceptance.txt and the reviewer independently checked it.", exact=True)).to_be_visible(timeout=30000)
        answered = wait_room(room_id, "completed")
        assert answered["runId"] == completed["runId"] and answered["goal"] == completed["goal"]
        assert answered["tasks"] == completed["tasks"] and not answered["history"]
        assert not (workspace / "discussion-must-not-write.txt").exists()
        print("PASS: completed-chat follow-up answers without another goal, plan, or write grant", flush=True)
        before_models = len(control("/__qa/state")["transcript"])
        panel.get_by_role("button", name="Models", exact=True).click()
        model_editor = panel.get_by_role("dialog", name="Group agents", exact=True)
        expect(model_editor).to_be_visible()
        model_editor.get_by_role("combobox", name="Team model", exact=True).select_option(json.dumps(["fixture", "fixture-reviewer"], separators=(",", ":")))
        for name, model in [("Lead", "fixture-lead"), ("Builder", "fixture-builder"), ("Reviewer", "fixture-builder")]:
            model_editor.get_by_role("region", name="Configure " + name, exact=True).get_by_label(re.compile("^Model")).select_option(json.dumps(["fixture", model], separators=(",", ":")))
        model_editor.get_by_role("button", name="Save models", exact=True).click()
        expect(model_editor).not_to_be_visible()
        pending_team = api("/rooms/" + room_id)
        assert [member["model"] for member in pending_team["members"]] == [member["model"] for member in completed["members"]]
        assert [member["model"] for member in pending_team["nextTeam"]["members"]] == ["fixture-lead", "fixture-builder", "fixture-builder"]
        assert len(control("/__qa/state")["transcript"]) == before_models
        expect(panel.get_by_role("button", name="Replan with selected models", exact=True)).to_be_visible()
        print("PASS: existing-chat model choices save without dispatch or historical model replacement", flush=True)
        # Ordinary drafts and native workspace rows remain independent.
        native_chat_id = completed["chatSessionId"]
        before_followup = len(control("/__qa/state")["transcript"])
        page.get_by_role("button", name="New session", exact=True).first.click()
        ordinary = page.locator('[data-composer-input]')
        ordinary.fill("Unsaved ordinary chat draft")
        expect(panel.locator(".sc-native-transcript")).to_have_count(0)
        row = page.locator('[data-row-key="session:' + native_chat_id + '"]')
        expect(row).to_have_count(1)
        row.click()
        expect(panel).to_be_visible()
        assert len(control("/__qa/state")["transcript"]) == before_followup
        page.get_by_role("button", name="New session", exact=True).first.click()
        expect(ordinary).to_have_text("Unsaved ordinary chat draft")
        row.click()
        expect(panel).to_be_visible()
        panel.get_by_role("button", name="New goal", exact=True).click()
        panel.locator('[data-composer-card] [contenteditable=true]').fill("SUPERCODE_PAUSE_FIXTURE: investigate the workspace, then wait for further direction.")
        panel.get_by_role("button", name="Send message", exact=True).click()
        deadline = time.monotonic() + 30
        while not any(row["response"] == "held-for-user-pause" for row in control("/__qa/state")["transcript"]):
            assert time.monotonic() < deadline, "No actual follow-up model request started"
            page.wait_for_timeout(100)
        paused = api("/rooms/" + room_id)
        assert paused["chatSessionId"] == native_chat_id
        assert len(api("/bootstrap")["rooms"]) == 1
        assert len(paused["history"]) == 1
        assert paused["history"][0]["leadId"] == completed["leadId"]
        assert next(member for member in paused["members"] if member["id"] == "reviewer")["model"] == "fixture-builder"
        assert next(member for member in paused["history"][0]["members"] if member["id"] == "reviewer")["model"] == "fixture-reviewer"
        assert any(item["model"] == "fixture-builder" and "Member: Reviewer (" in item["prompt"] for item in control("/__qa/state")["transcript"][before_followup:]), "The reviewer's selected replacement model was not dispatched"
        expect(row).to_have_count(1)
        before_restart = len(control("/__qa/state")["transcript"])
        replacement = control("/__qa/restart", {"crash": True})
        open_app(replacement["hostURL"], launch=False)
        page.locator('[data-row-key="session:' + native_chat_id + '"]').click()
        panel = page.locator(".wSkVaW_root")
        expect(panel.get_by_role("button", name="Continue", exact=True)).to_be_visible(timeout=15000)
        restored = api("/rooms/" + room_id)
        assert restored["status"] == "paused"
        assert restored["runId"] == paused["runId"]
        assert restored["chatSessionId"] == native_chat_id
        assert restored["usage"]["calls"] == paused["usage"]["calls"]
        page.wait_for_timeout(2500)
        assert len(control("/__qa/state")["transcript"]) == before_restart
        assert (workspace / "acceptance.txt").read_text() == expected_content
        page.screenshot(path=str(qa_root / "05-restored-native-chat.png"), full_page=True)
        panel.get_by_role("button", name="Continue", exact=True).click()
        expect(panel.get_by_role("button", name="Stop generating", exact=True)).to_be_visible()
        deadline = time.monotonic() + 20
        while len([item for item in control("/__qa/state")["transcript"][before_restart:] if item["response"] == "held-for-user-pause"]) < 2:
            assert time.monotonic() < deadline, "Explicit continuation did not dispatch teammates"
            page.wait_for_timeout(100)
        # Repeated abrupt restarts exercise persistence before the parent's
        # discovery catalog necessarily reaches disk. Native member identities
        # must survive, and each continuation still requires an explicit click.
        member_sessions = {member["id"]: member.get("sessionId") for member in api("/rooms/" + room_id)["members"]}
        for _ in range(2):
            before_crash = len(control("/__qa/state")["transcript"])
            replacement = control("/__qa/restart", {"crash": True})
            open_app(replacement["hostURL"], launch=False)
            page.locator('[data-row-key="session:' + native_chat_id + '"]').click()
            expect(panel.get_by_role("button", name="Continue", exact=True)).to_be_visible(timeout=15000)
            current = api("/rooms/" + room_id)
            assert current["status"] == "paused"
            assert {member["id"]: member.get("sessionId") for member in current["members"]} == member_sessions
            assert len(control("/__qa/state")["transcript"]) == before_crash
            panel.get_by_role("button", name="Continue", exact=True).click()
            deadline = time.monotonic() + 30
            while len([item for item in control("/__qa/state")["transcript"][before_crash:] if item["response"] == "held-for-user-pause"]) < 2:
                assert time.monotonic() < deadline, "Repeated crash recovery failed to resume the original teammates"
                page.wait_for_timeout(100)
        print("PASS: three abrupt restarts preserve teammate identities and require explicit continuation", flush=True)
        # A regular app quit must also drain and persist a paused room, not
        # classify upstream cancellation as a fresh provider failure.
        before_quit = len(control("/__qa/state")["transcript"])
        replacement = control("/__qa/restart", {"crash": False})
        open_app(replacement["hostURL"], launch=False)
        page.locator('[data-row-key="session:' + native_chat_id + '"]').click()
        expect(panel.get_by_role("button", name="Continue", exact=True)).to_be_visible(timeout=15000)
        assert api("/rooms/" + room_id)["status"] == "paused"
        page.wait_for_timeout(2500)
        assert len(control("/__qa/state")["transcript"]) == before_quit
        panel.get_by_role("button", name="Continue", exact=True).click()
        deadline = time.monotonic() + 20
        while len([item for item in control("/__qa/state")["transcript"][before_quit:] if item["response"] == "held-for-user-pause"]) < 2:
            assert time.monotonic() < deadline, "Continuation after graceful quit did not dispatch"
            page.wait_for_timeout(100)
        resumed = api("/rooms/" + room_id)
        panel.get_by_role("button", name="Stop generating", exact=True).click()
        deadline = time.monotonic() + 30
        while api("/rooms/" + room_id)["status"] != "stopped":
            assert time.monotonic() < deadline, "Cancel did not drain the native response"
            page.wait_for_timeout(100)
        stopped = api("/rooms/" + room_id)
        expect(panel.locator('[data-composer-card] [contenteditable=true]')).to_be_enabled()
        after_stop = len(control("/__qa/state")["transcript"])
        page.wait_for_timeout(2500)
        assert len(control("/__qa/state")["transcript"]) == after_stop
        expect(page.locator('[data-row-key="session:' + native_chat_id + '"]')).to_have_count(1)
        page.screenshot(path=str(qa_root / "06-native-chat-cancelled.png"), full_page=True)
        print("PASS: native workspace sidebar, ordinary draft isolation, same-chat follow-up, paused restart and composer cancellation", flush=True)
        assert not errors, errors
        qa_root.joinpath("acceptance-result.json").write_text(json.dumps({
            "ok": True, "completedRoom": completed, "restoredPausedRoom": restored,
            "stoppedRoom": stopped,
            "layout": layout, "publicUpdates": public_updates,
            "toolbarIcons": toolbar_icons,
            "primaryButton": primary_button,
            "primaryButtonHover": primary_button_hover,
            "modelRequests": len(control("/__qa/state")["transcript"]), "pageErrors": errors,
        }, indent=2))
    finally:
        qa_root.joinpath("final-dom.txt").write_text(page.locator("body").inner_text())
        qa_root.joinpath("page-errors.json").write_text(json.dumps(errors, indent=2))
        qa_root.joinpath("console-errors.json").write_text(json.dumps(console_errors, indent=2))
        page.screenshot(path=str(qa_root / "final.png"), full_page=True)
        print("SUPERCODE_ARTIFACTS:", qa_root, flush=True)
        browser.close()
