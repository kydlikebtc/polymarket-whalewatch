#!/usr/bin/env python3
"""核查候选地址:是否为合约 + 近期日志的 topic0 分布与取样。

策略:小块(100 区块)从最新往回扫,一旦发现日志即停。
活跃合约第一块命中;不活跃的回扫上限 max_window 仍无 → 判定近期无事件。
"""

import json
import sys
from collections import Counter

from pm_chain import rpc, hexint

ADDRS = {
    "A_docs_negrisk_v2": "0xe2222d279d744050d28e00520010520000310F59",
    "B_scan_labeled_negrisk": "0xC5d563A36AE78145C45a50134d48A1215220f80a",
    "V2_ctf_exchange": "0xE111180000d2663C0091e4f400237545B87B996B",
}


def get_logs_recent(addr, latest, max_window=20000, chunk=100):
    logs = []
    end = latest
    floor = latest - max_window
    first_hit = None
    while end > floor and len(logs) < 30:
        start = max(floor, end - chunk + 1)
        try:
            part = rpc(
                "eth_getLogs",
                [{"fromBlock": hex(start), "toBlock": hex(end), "address": addr}],
            )
            if part and first_hit is None:
                first_hit = end
            logs.extend(part)
        except Exception as e:  # noqa: BLE001
            print(f"  [getLogs {start}-{end}] ERROR {e}", flush=True)
        end = start - 1
    scanned_from = end + 1
    return logs, scanned_from, first_hit


def main():
    latest = hexint(rpc("eth_blockNumber", []))
    print(f"latestBlock={latest}\n", flush=True)
    summary = {}
    for name, addr in ADDRS.items():
        code = rpc("eth_getCode", [addr, "latest"])
        is_contract = isinstance(code, str) and len(code) > 4
        code_len = (len(code) - 2) // 2 if isinstance(code, str) else 0
        print(f"### {name}  {addr}", flush=True)
        print(f"  isContract={is_contract} codeBytes={code_len}", flush=True)
        logs, scanned_from, first_hit = get_logs_recent(addr, latest)
        blocks_back = (latest - first_hit) if first_hit else None
        print(
            f"  scanned down to {scanned_from}  logsFound={len(logs)} "
            f"firstHitBlock={first_hit} (~{blocks_back} blocks back)",
            flush=True,
        )
        dict_logs = [l for l in logs if isinstance(l, dict)]
        bad = [l for l in logs if not isinstance(l, dict)]
        if bad:
            print(
                f"  WARN non-dict log elements: {len(bad)} e.g. {bad[0]!r}", flush=True
            )
        c = Counter((l.get("topics") or ["NO_TOPIC"])[0] for l in dict_logs)
        for t0, n in c.most_common():
            print(f"    topic0 {t0}  x{n}", flush=True)
        samples = {}
        for l in dict_logs:
            t0 = (l.get("topics") or ["NO_TOPIC"])[0]
            samples.setdefault(t0, l)
        summary[name] = {
            "addr": addr,
            "isContract": is_contract,
            "codeBytes": code_len,
            "firstHitBlock": first_hit,
            "topic0_counts": dict(c),
            "samples": samples,
        }
        print(flush=True)
    with open("probe_result.json", "w") as f:
        json.dump(summary, f, indent=2)
    print("written probe_result.json", flush=True)


if __name__ == "__main__":
    main()
