"""Questions are captured once, split when numbered, and closed by what answers them."""

from __future__ import annotations

from daybook_collect import questions as Q

ME = "Alex Example"
SAM = "Sam Reviewer"
CHAT = "chat-1"


def mine(mid: str, html: str, at: str = "2026-11-09T07:00:00Z", **kw) -> Q.Message:
    return {"id": mid, "chat_id": CHAT, "from_name": ME, "to": SAM, "at": at, "html": html,
            "url": f"https://chat.example/l/message/{CHAT}/{mid}?context=x", **kw}


def theirs(mid: str, html: str, at: str = "2026-11-09T09:00:00Z", **kw) -> Q.Message:
    return {"id": mid, "chat_id": CHAT, "from_name": SAM, "at": at, "html": html, **kw}


def test_the_same_message_read_twice_gives_one_entry():
    qs: list[Q.Question] = []
    m = mine("1001", "<p>Hi Sam, one question on PROJ-228: should search cover archived notes?</p>")
    assert Q.merge(qs, [m], ME)["added"] == 1
    assert Q.merge(qs, [m], ME)["added"] == 0
    assert len(qs) == 1 and qs[0]["id"] == "1001" and qs[0]["tickets"] == ["PROJ-228"]
    assert qs[0]["status"] == "waiting"


def test_three_numbered_questions_become_three_entries():
    html = ("<p>Hi Sam, three questions on PROJ-227:</p><ol>"
            "<li>Which folder should new notes go to by default?</li>"
            "<li>Should sharing wait until PROJ-232 is done?</li>"
            "<li>Do we add a word count (needs your OK)</li></ol>")
    qs: list[Q.Question] = []
    Q.merge(qs, [mine("2001", html)], ME)
    assert [q["id"] for q in qs] == ["2001#1", "2001#2", "2001#3"]
    assert qs[1]["tickets"] == ["PROJ-232"] and qs[0]["tickets"] == ["PROJ-227"]


def test_a_quoting_reply_closes_its_question():
    qs: list[Q.Question] = []
    Q.merge(qs, [mine("3001", "<p>Can guests still comment on PROJ-236?</p>")], ME)
    Q.merge(qs, [theirs("3002", "<p>Yes, keep it.</p>", quotes=["3001"])], ME)
    assert qs[0]["status"] == "answered" and qs[0]["answer_source"] == "teams-quote"
    assert qs[0]["answer"] == "Yes, keep it." and qs[0]["answered_by"] == SAM


def test_a_reply_naming_the_ticket_closes_it_and_others_stay_open():
    qs: list[Q.Question] = []
    Q.merge(qs, [mine("4001", "<p>Is PROJ-221 export done in the background?</p>"),
                 mine("4002", "<p>Should PROJ-233 limits be settings?</p>")], ME)
    Q.merge(qs, [theirs("4003", "<p>PROJ-233: yes, settings.</p>")], ME)
    assert [q["status"] for q in qs] == ["waiting", "answered"]


def test_a_reply_before_the_question_answers_nothing():
    qs: list[Q.Question] = []
    Q.merge(qs, [mine("5001", "<p>Is PROJ-221 export done in the background?</p>", at="2026-11-09T10:00:00Z"),
                 theirs("5000", "<p>About PROJ-221, see the ticket.</p>", at="2026-11-09T08:00:00Z")], ME)
    assert qs[0]["status"] == "waiting"


def test_fyi_short_and_ignored_messages_are_not_questions():
    rules = {"ignore_prefixes": ["Ticket updates to be done"]}
    qs: list[Q.Question] = []
    Q.merge(qs, [mine("6001", "<p>FYI, the PR is up. Anything else?</p>"),
                 mine("6002", "<p>call?</p>"),
                 mine("6003", "<p>Ticket updates to be done in the tracker sheet: is this right?</p>"),
                 mine("6004", "<p>No question here, just a status line for the day.</p>")], ME, rules)
    assert qs == []


def test_an_override_survives_the_next_merge():
    qs: list[Q.Question] = []
    Q.merge(qs, [mine("7001", "<p>Is PROJ-243 drag and drop in scope?</p>")], ME)
    qs[0]["override"] = {"status": "not_question"}
    Q.merge(qs, [theirs("7002", "<p>PROJ-243: yes.</p>", quotes=["7001"])], ME)
    assert qs[0]["status"] == "waiting" and qs[0]["override"] == {"status": "not_question"}


def test_a_jira_decided_block_closes_an_open_question():
    qs: list[Q.Question] = []
    Q.merge(qs, [mine("8001", "<p>How long are PROJ-233 deleted notes kept?</p>", at="2026-11-06T11:00:00Z")], ME)
    decided = {"PROJ-233": [("2026-11-05", "too early"), ("2026-11-07", "30 days in the trash")]}
    Q.merge(qs, [], ME, decided=lambda k: decided.get(k, []))
    assert qs[0]["status"] == "answered" and qs[0]["answer"] == "30 days in the trash"
    assert qs[0]["answer_source"] == "jira"


def test_older_entries_adopt_their_message_id_from_the_link():
    old: Q.Question = {"id": "abc123", "topic": "PROJ-221 export format", "status": "waiting",
                       "asked_at": "2026-11-04T10:00:00Z", "to": SAM, "chat_id": CHAT,
                       "url": f"https://chat.example/l/message/{CHAT}/9001234567?context=x"}
    qs = [old]
    Q.merge(qs, [mine("9001234567", "<p>Which PROJ-221 export format comes first?</p>", at="2026-11-04T10:00:00Z")], ME)
    assert len(qs) == 1 and qs[0]["id"] == "9001234567"


def test_a_sent_draft_becomes_waiting_instead_of_a_second_entry():
    qs: list[Q.Question] = [{"id": "d1", "status": "to_send", "to": SAM,
                             "text": "Should PROJ-228 search include note titles only?"}]
    Q.merge(qs, [mine("1101", "<p>Hi Sam, should PROJ-228 search include note titles only? "
                              "It changes the index.</p>")], ME)
    assert len(qs) == 1 and qs[0]["status"] == "waiting" and qs[0]["message_id"] == "1101"


def test_decided_blocks_are_read_from_ticket_text():
    text = "Decided (2026-11-07): admins only, up and down buttons.\nOther text"
    assert Q.decided_blocks(text)[0] == ("2026-11-07", "admins only, up and down buttons. Other text")


def test_items_are_numbered_through_the_message_so_two_lists_never_share_an_id():
    html = ("<p>Two groups:</p><ol><li>Is PROJ-1 ready for review today?</li><li>Is PROJ-2 ready for review today?</li></ol>"
            "<p>And:</p><ol><li>Is PROJ-3 ready for review today?</li></ol>")
    qs: list[Q.Question] = []
    Q.merge(qs, [mine("1201", html)], ME)
    assert [q["id"] for q in qs] == ["1201#1", "1201#2", "1201#3"]
    assert qs[2]["tickets"] == ["PROJ-3"]


def test_when_the_opening_asks_the_lists_below_are_content():
    html = ("<p>Could you tell me whom I should send these to?</p>"
            "<ol><li>Ops: is the PROJ-295 backup bucket set?</li><li>Privacy: is 30 days right?</li></ol>")
    qs: list[Q.Question] = []
    Q.merge(qs, [mine("1301", html)], ME)
    assert [q["id"] for q in qs] == ["1301"]


def test_a_message_already_listed_is_not_re_split():
    qs: list[Q.Question] = [{"id": "1401", "message_id": "1401", "topic": "two asks", "status": "waiting",
                             "chat_id": CHAT, "to": SAM, "asked_at": "2026-11-09T07:00:00Z"}]
    html = "<ol><li>Is PROJ-1 ready for review today?</li><li>Is PROJ-2 ready for review today?</li></ol>"
    assert Q.merge(qs, [mine("1401", html)], ME)["added"] == 0
    assert len(qs) == 1


def test_a_question_asked_of_someone_else_closes_when_the_relay_names_its_ticket():
    qs: list[Q.Question] = [{"id": "po1", "topic": "PROJ-243 drag and drop", "status": "waiting", "to": "Product owner",
                             "tickets": ["PROJ-243"], "asked_at": "2026-11-02T00:00Z"}]
    Q.merge(qs, [theirs("1501", "<p>PROJ-243: drag and drop is in, desktop only.</p>", at="2026-11-07T15:39:00Z")],
            ME, relay=SAM)
    assert qs[0]["status"] == "answered" and qs[0]["answered_by"] == SAM


def test_without_a_relay_the_same_reply_closes_nothing():
    qs: list[Q.Question] = [{"id": "po1", "topic": "PROJ-243 drag and drop", "status": "waiting", "to": "Product owner",
                             "tickets": ["PROJ-243"], "asked_at": "2026-11-02T00:00Z"}]
    Q.merge(qs, [theirs("1501", "<p>PROJ-243: drag and drop is in.</p>", at="2026-11-07T15:39:00Z")], ME)
    assert qs[0]["status"] == "waiting"


def test_older_entries_take_their_chat_from_the_link():
    qs: list[Q.Question] = [{"id": "x", "topic": "PROJ-221 export format", "status": "waiting", "to": SAM,
                             "tickets": ["PROJ-221"], "asked_at": "2026-11-04T08:00:00Z",
                             "url": "https://chat.example/l/message/19%3achat-1/1793780899785"}]
    Q.merge(qs, [{**theirs("1601", "<p>PROJ-221: yes, in the background.</p>"), "chat_id": "19:chat-1"}], ME)
    assert qs[0]["chat_id"] == "19:chat-1" and qs[0]["status"] == "answered"


def test_a_decision_block_naming_who_decided_counts_too():
    text = "Decision (Sam, 2026-11-07): drag and drop is in, desktop only."
    assert Q.decided_blocks(text)[0][0] == "2026-11-07"


def test_one_reply_answers_a_marked_question_and_a_ticket_named_one():
    qs: list[Q.Question] = []
    Q.merge(qs, [mine("1701", "<p>The PROJ-221 export runs in a task. Does that work for you?</p>"),
                 mine("1702", "<p>Is the PROJ-211 autosave interval settled?</p>")], ME)
    Q.merge(qs, [theirs("1703", "<p>PROJ-211: settled. And the export: fine.</p>", answers=["1701"])], ME)
    assert [q["status"] for q in qs] == ["answered", "answered"]
