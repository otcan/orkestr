#!/usr/bin/python3
"""Synthetic native peer for the capacity fallback. No provider or credentials.

`capacity-mode` in the working directory selects what each turn does:
clean   - turn 1 is overloaded before any tool call; later turns answer.
tool    - turn 1 runs a command, then is overloaded.
persist - every turn is overloaded.
stall   - turn 1 stays silent (as in a long 429 Retry-After sleep) until
          Runtime interrupts it; later turns answer.
busy    - turn 1 starts reasoning at once, then answers after 2.5 s.
stall-stop - as stall, but the interrupt is answered only once the test
          creates `release-stop` (an owner Stop arrives meanwhile).
"""
import json
import os
from pathlib import Path
import sys
import time

NATIVE = "synthetic-capacity-native"
OVERLOADED = {"message": "Selected model is at capacity. Please try a different model.",
              "codexErrorInfo": "serverOverloaded", "additionalDetails": None}
trace = Path.cwd() / "synthetic-peer.jsonl"
mode = (Path.cwd() / "capacity-mode").read_text().strip()
turn = 0


def record(kind, **fields):
    with trace.open("a") as stream:
        stream.write(json.dumps({"kind": kind, "pid": os.getpid(), **fields}) + "\n")


def emit(value):
    print(json.dumps(value), flush=True)


def notify(method, **params):
    emit({"method": method, "params": {"threadId": NATIVE, **params}})


record("spawn")
for line in sys.stdin:
    frame = json.loads(line)
    method = frame["method"]
    if method == "initialize":
        emit({"id": frame["id"], "result": {"userAgent": "synthetic", "platformFamily": "unix",
                                            "platformOs": "linux", "codexHome": "synthetic-private"}})
    elif method == "account/read":
        emit({"id": frame["id"], "result": {"requiresOpenaiAuth": True, "account": {"type": "chatgpt"}}})
    elif method == "thread/start":
        emit({"id": frame["id"], "result": {
            "modelProvider": "openai", "cwd": os.getcwd(), "model": "gpt-6.1-sol",
            "thread": {"modelProvider": "openai", "id": NATIVE, "ephemeral": False, "cwd": os.getcwd()},
            "approvalPolicy": "never", "sandbox": {"type": "readOnly"}}})
        record("ready")
    elif method == "turn/start":
        turn += 1
        params = frame["params"]
        record("turn", number=turn, model=params.get("model"), text=params["input"][0]["text"],
               message=params["clientUserMessageId"])
        tid = f"synthetic-capacity-turn-{turn}"
        emit({"id": frame["id"], "result": {"turn": {"id": tid, "status": "inProgress"}}})
        if params.get("model"):
            notify("thread/settings/updated",
                   threadSettings={"model": params["model"], "modelProvider": "openai"})
        notify("turn/started", turn={"id": tid, "status": "inProgress"})
        notify("item/started", turnId=tid, item={"type": "userMessage", "id": f"u{turn}"})
        if mode not in ("stall", "stall-stop", "busy") or turn > 1:
            notify("item/started", turnId=tid, item={"type": "reasoning", "id": f"r{turn}"})
        overloaded = mode in ("clean", "tool", "persist") and (mode == "persist" or turn == 1)
        if mode in ("stall", "stall-stop") and turn == 1:
            interrupt = json.loads(sys.stdin.readline())
            assert interrupt["method"] == "turn/interrupt", interrupt
            assert interrupt["params"] == {"threadId": NATIVE, "turnId": tid}
            record("interrupt")
            deadline = time.monotonic() + 15
            while mode == "stall-stop" and not Path("release-stop").exists():
                assert time.monotonic() < deadline
                time.sleep(0.01)
            emit({"id": interrupt["id"], "result": {}})
            notify("turn/completed", turn={"id": tid, "status": "interrupted"})
        elif mode == "busy" and turn == 1:
            notify("item/started", turnId=tid, item={"type": "reasoning", "id": "busy"})
            time.sleep(2.5)
            notify("item/completed", turnId=tid, item={
                "type": "agentMessage", "id": "a1", "text": "synthetic slow answer",
                "phase": "final_answer"})
            notify("turn/completed", turn={"id": tid, "status": "completed"})
        elif overloaded:
            if mode == "tool":
                notify("item/started", turnId=tid, item={"type": "commandExecution", "id": "c1"})
                notify("item/completed", turnId=tid, item={"type": "commandExecution", "id": "c1"})
            notify("error", turnId=tid, willRetry=False, error=OVERLOADED)
            notify("turn/completed", turn={"id": tid, "status": "failed", "error": OVERLOADED})
        else:
            notify("item/completed", turnId=tid, item={
                "type": "agentMessage", "id": f"a{turn}", "text": "synthetic fallback answer",
                "phase": "final_answer"})
            notify("turn/completed", turn={"id": tid, "status": "completed"})
    else:
        assert method == "initialized"
