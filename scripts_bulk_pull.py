#!/usr/bin/env python3
"""
Batch pull mails for all accounts from local Outlook-Mail-Manager API.

- Loads all accounts via /api/accounts (paginated)
- Pulls INBOX/Junk per account via /api/mails/fetch
- Runs in batches to reduce pressure
- Writes per-account results to JSONL
"""

from __future__ import annotations

import argparse
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Any

import requests


@dataclass
class PullConfig:
    base_url: str
    page_size: int
    batch_size: int
    workers: int
    mailboxes: List[str]
    timeout: int
    retries: int
    retry_sleep: float
    resume_batch: int
    max_batches: int
    output: Path
    top: int


def _session() -> requests.Session:
    s = requests.Session()
    s.trust_env = False  # ignore proxy env
    return s


def api_get(session: requests.Session, url: str, params: Dict[str, Any], timeout: int, retries: int, retry_sleep: float) -> Dict[str, Any]:
    last_err = None
    for i in range(retries + 1):
        try:
            r = session.get(url, params=params, timeout=timeout)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            last_err = e
            if i < retries:
                time.sleep(retry_sleep * (i + 1))
    raise RuntimeError(f"GET {url} failed: {last_err}")


def api_post(session: requests.Session, url: str, payload: Dict[str, Any], timeout: int, retries: int, retry_sleep: float) -> Dict[str, Any]:
    last_err = None
    for i in range(retries + 1):
        try:
            r = session.post(url, json=payload, timeout=timeout)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            last_err = e
            if i < retries:
                time.sleep(retry_sleep * (i + 1))
    raise RuntimeError(f"POST {url} failed: {last_err}")


def load_accounts(cfg: PullConfig) -> List[Dict[str, Any]]:
    session = _session()
    accounts: List[Dict[str, Any]] = []
    page = 1
    while True:
        data = api_get(
            session,
            f"{cfg.base_url}/api/accounts",
            {"page": page, "pageSize": cfg.page_size},
            cfg.timeout,
            cfg.retries,
            cfg.retry_sleep,
        )
        items = data.get("data", {}).get("list", [])
        if not items:
            break
        accounts.extend(items)
        if len(items) < cfg.page_size:
            break
        page += 1
    return accounts


def pull_one(account: Dict[str, Any], cfg: PullConfig) -> Dict[str, Any]:
    session = _session()
    account_id = account["id"]
    result = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "account_id": account_id,
        "email": account.get("email", ""),
        "status": "ok",
        "mailboxes": {},
        "error": None,
    }

    try:
        for box in cfg.mailboxes:
            data = api_post(
                session,
                f"{cfg.base_url}/api/mails/fetch",
                {"account_id": account_id, "mailbox": box, "top": cfg.top},
                cfg.timeout,
                cfg.retries,
                cfg.retry_sleep,
            )
            d = data.get("data", {})
            result["mailboxes"][box] = {
                "total": d.get("total", 0),
                "protocol": d.get("protocol", ""),
                "cached": bool(d.get("cached", False)),
            }
    except Exception as e:
        result["status"] = "error"
        result["error"] = str(e)

    return result


def chunked(seq: List[Any], n: int) -> List[List[Any]]:
    return [seq[i : i + n] for i in range(0, len(seq), n)]


def run(cfg: PullConfig) -> None:
    cfg.output.parent.mkdir(parents=True, exist_ok=True)

    print(f"[*] Loading accounts from {cfg.base_url} ...")
    accounts = load_accounts(cfg)
    total_accounts = len(accounts)
    if total_accounts == 0:
        print("[!] No accounts found.")
        return

    batches = chunked(accounts, cfg.batch_size)
    total_batches = len(batches)
    start_idx = max(cfg.resume_batch - 1, 0)
    end_idx = total_batches if cfg.max_batches <= 0 else min(total_batches, start_idx + cfg.max_batches)

    print(f"[*] Accounts: {total_accounts}, batch_size: {cfg.batch_size}, total_batches: {total_batches}")
    print(f"[*] Running batches: {start_idx + 1} -> {end_idx}")
    print(f"[*] Output: {cfg.output}")

    with cfg.output.open("a", encoding="utf-8") as f:
        for bi in range(start_idx, end_idx):
            batch_no = bi + 1
            batch_accounts = batches[bi]
            print(f"\n=== Batch {batch_no}/{total_batches} (accounts={len(batch_accounts)}) ===")

            ok_count = 0
            err_count = 0
            inbox_sum = 0
            junk_sum = 0

            t0 = time.time()
            with ThreadPoolExecutor(max_workers=cfg.workers) as ex:
                futures = [ex.submit(pull_one, acc, cfg) for acc in batch_accounts]
                for fu in as_completed(futures):
                    r = fu.result()
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
                    f.flush()

                    if r["status"] == "ok":
                        ok_count += 1
                        inbox_sum += r["mailboxes"].get("INBOX", {}).get("total", 0)
                        junk_sum += r["mailboxes"].get("Junk", {}).get("total", 0)
                    else:
                        err_count += 1

            dt = time.time() - t0
            print(
                f"[batch {batch_no}] ok={ok_count}, err={err_count}, "
                f"inbox_total={inbox_sum}, junk_total={junk_sum}, elapsed={dt:.1f}s"
            )

    print("\n[✓] Batch run completed.")


def parse_args() -> PullConfig:
    ap = argparse.ArgumentParser(description="Batch pull mails from Outlook-Mail-Manager API")
    ap.add_argument("--base-url", default="http://127.0.0.1:3000")
    ap.add_argument("--page-size", type=int, default=200)
    ap.add_argument("--batch-size", type=int, default=50)
    ap.add_argument("--workers", type=int, default=5)
    ap.add_argument("--mailboxes", default="INBOX,Junk", help="comma separated, e.g. INBOX,Junk")
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument("--retries", type=int, default=1)
    ap.add_argument("--retry-sleep", type=float, default=1.5)
    ap.add_argument("--resume-batch", type=int, default=1)
    ap.add_argument("--max-batches", type=int, default=1, help="0 means run all")
    ap.add_argument("--output", default="/mnt/c/Users/Jason/Desktop/hotmai/bulk_pull_results.jsonl")
    ap.add_argument("--top", type=int, default=10000, help="max mails to fetch per mailbox/account; use large value for all")
    args = ap.parse_args()

    return PullConfig(
        base_url=args.base_url.rstrip('/'),
        page_size=args.page_size,
        batch_size=args.batch_size,
        workers=args.workers,
        mailboxes=[x.strip() for x in args.mailboxes.split(',') if x.strip()],
        timeout=args.timeout,
        retries=args.retries,
        retry_sleep=args.retry_sleep,
        resume_batch=args.resume_batch,
        max_batches=args.max_batches,
        output=Path(args.output),
        top=args.top,
    )


if __name__ == "__main__":
    # hard-disable proxy inheritance for safety
    for k in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]:
        os.environ.pop(k, None)

    cfg = parse_args()
    run(cfg)
