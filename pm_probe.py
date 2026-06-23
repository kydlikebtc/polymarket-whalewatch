#!/usr/bin/env python3
"""核查候选地址:是否为合约 + 近期日志的 topic0 分布与取样。"""

import json
from collections import Counter

from pm_chain import rpc, hexint

ADDRS = {
    "A_docs_negrisk_v2": "0xe2222d279d744050d28e00520010520000310F59",
    "B_scan_labeled_negrisk": "0xC5d563A36AE78145C45a50134d48A1215220f80a",
    "V2_ctf_exchange": "0xE111180000d2663C0091e4f400237545B87B996B",
}


def get_logs_recent(addr, latest, window=12000, chunk=1000):
    """从 latest 往回扫 window 个区块,分块避免范围/结果超限。
    返回 (logs, scanned_from, scanned_to)。"""
    logs = []
    end = latest
    start_floor = latest - window
    while end > start_floor:
        start = max(start_floor, end - chunk + 1)
        try:
            part = rpc(
                "eth_getLogs",
                [
                    {
                        "fromBlock": hex(start),
                        "toBlock": hex(end),
                        "address": addr,
                    }
                ],
            )
            logs.extend(part)
        except Exception as e:  # noqa: BLE001
            print(f"  [getLogs {start}-{end}] ERROR {e}")
        end = start - 1
        # 已经拿到足够样本就停
        if len(logs) >= 60:
            break
    return logs, start, latest


def main():
    latest = hexint(rpc("eth_blockNumber", []))
    print(f"latestBlock={latest}\n")
    summary = {}
    for name, addr in ADDRS.items():
        code = rpc("eth_getCode", [addr, "latest"])
        is_contract = code not in ("0x", "0x0", None)
        code_len = (len(code) - 2) // 2 if isinstance(code, str) else 0
        print(f"### {name}  {addr}")
        print(f"  isContract={is_contract} codeBytes={code_len}")
        logs, scanned_from, scanned_to = get_logs_recent(addr, latest)
        print(f"  scanned blocks {scanned_from}..{scanned_to}  logsFound={len(logs)}")
        c = Counter(l["topics"][0] if l["topics"] else "NO_TOPIC" for l in logs)
        for t0, n in c.most_common():
            print(f"    topic0 {t0}  x{n}")
        # 保存每个 distinct topic0 的一个样本
        samples = {}
        for l in logs:
            t0 = l["topics"][0] if l["topics"] else "NO_TOPIC"
            if t0 not in samples:
                samples[t0] = l
        summary[name] = {
            "addr": addr,
            "isContract": is_contract,
            "codeBytes": code_len,
            "topic0_counts": dict(c),
            "samples": samples,
        }
        print()
    with open("probe_result.json", "w") as f:
        json.dump(summary, f, indent=2)
    print("written probe_result.json")


if __name__ == "__main__":
    main()
